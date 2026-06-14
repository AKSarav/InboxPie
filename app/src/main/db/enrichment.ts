/**
 * EnrichmentDB — ADR 002
 *
 * Separate SQLite database at ~/.inboxpie/enrichment.db.
 * Stores aggregated sender/domain stats and relationship edges derived from
 * scan results. Never stores email bodies, subjects, or raw message content.
 *
 * Built asynchronously after each scan (ADR 001: progressive enrichment).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DatabaseSync as Database } from "node:sqlite";

export interface SenderStat {
  sender: string;
  domain: string;
  messageCount: number;
  unreadCount: number;
  totalSize: number;
  firstEmailDate: string;
  lastEmailDate: string;
}

export interface DomainStat {
  domain: string;
  senderCount: number;
  messageCount: number;
  totalSize: number;
}

export interface RelationshipEdge {
  entityAId: string; // sender email (normalized)
  entityBId: string;
  strength: number; // co-occurrence count (shared domain)
}

/** Minimal message shape needed for enrichment (subset of MessageRecord). */
interface MessageInput {
  id: string | number;
  senderEmail: string;
  domain: string;
  date: string;
  read: boolean;
  size?: number;
}

const DB_DIR = path.join(os.homedir(), ".inboxpie");
const DB_PATH = path.join(DB_DIR, "enrichment.db");

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sender_stats (
  sender           TEXT PRIMARY KEY,
  domain           TEXT NOT NULL,
  message_count    INTEGER DEFAULT 0,
  unread_count     INTEGER DEFAULT 0,
  total_size       INTEGER DEFAULT 0,
  first_email_date TEXT,
  last_email_date  TEXT,
  updated_at       TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS domain_stats (
  domain         TEXT PRIMARY KEY,
  sender_count   INTEGER DEFAULT 0,
  message_count  INTEGER DEFAULT 0,
  total_size     INTEGER DEFAULT 0,
  updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS relationships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_a_id  TEXT NOT NULL,
  entity_b_id  TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'emailed_with',
  strength     INTEGER DEFAULT 1,
  UNIQUE(entity_a_id, entity_b_id, type)
);

CREATE INDEX IF NOT EXISTS idx_sender_domain  ON sender_stats(domain);
CREATE INDEX IF NOT EXISTS idx_rel_entity_a   ON relationships(entity_a_id);
CREATE INDEX IF NOT EXISTS idx_rel_entity_b   ON relationships(entity_b_id);
`;

// ── EnrichmentDB class ───────────────────────────────────────────────────────

export class EnrichmentDB {
  private db: Database | null = null;

  open(): void {
    if (this.db) return;
    fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH) as Database;
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * Populate sender_stats, domain_stats, and relationships from scan output.
   * Replaces existing data for a clean rebuild.
   */
  populate(messages: MessageInput[]): { senders: number; domains: number; edges: number; indexedMessages: number } {
    this.open();
    const db = this.db!;

    // Aggregate in JS first — cheaper than N individual upserts
    const senderMap = new Map<
      string,
      { domain: string; count: number; unread: number; size: number; first: string; last: string }
    >();

    for (const m of messages) {
      const email = (m.senderEmail || "").toLowerCase().trim();
      const domain = (m.domain || "unknown").toLowerCase().trim();
      if (!email) continue;

      const prev = senderMap.get(email);
      if (!prev) {
        senderMap.set(email, {
          domain,
          count: 1,
          unread: m.read ? 0 : 1,
          size: m.size ?? 0,
          first: m.date ?? "",
          last: m.date ?? "",
        });
      } else {
        prev.count++;
        if (!m.read) prev.unread++;
        prev.size += m.size ?? 0;
        if (m.date && m.date < prev.first) prev.first = m.date;
        if (m.date && m.date > prev.last) prev.last = m.date;
      }
    }

    // Wrap in a transaction for speed
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM sender_stats");
      db.exec("DELETE FROM domain_stats");
      db.exec("DELETE FROM relationships");

      const insertSender = db.prepare(`
        INSERT INTO sender_stats
          (sender, domain, message_count, unread_count, total_size, first_email_date, last_email_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [email, s] of senderMap) {
        insertSender.run(email, s.domain, s.count, s.unread, s.size, s.first, s.last);
      }

      // Domain rollup
      const domainMap = new Map<string, { senders: Set<string>; count: number; size: number }>();
      for (const [email, s] of senderMap) {
        const d = domainMap.get(s.domain);
        if (!d) {
          domainMap.set(s.domain, { senders: new Set([email]), count: s.count, size: s.size });
        } else {
          d.senders.add(email);
          d.count += s.count;
          d.size += s.size;
        }
      }

      const insertDomain = db.prepare(`
        INSERT INTO domain_stats (domain, sender_count, message_count, total_size)
        VALUES (?, ?, ?, ?)
      `);
      for (const [domain, d] of domainMap) {
        insertDomain.run(domain, d.senders.size, d.count, d.size);
      }

      // Build org-cluster relationships: senders sharing a domain are "emailed_with"
      // Cap at 5 peers per sender to avoid O(n²) explosion on large domains
      const insertRel = db.prepare(`
        INSERT OR IGNORE INTO relationships (entity_a_id, entity_b_id, strength)
        VALUES (?, ?, ?)
      `);

      let edgeCount = 0;
      for (const [domain, d] of domainMap) {
        const peers = [...d.senders];
        if (peers.length < 2 || peers.length > 200) continue; // skip huge domains (gmail etc.)
        for (let i = 0; i < Math.min(peers.length, 10); i++) {
          for (let j = i + 1; j < Math.min(peers.length, 10); j++) {
            const a = peers[i] < peers[j] ? peers[i] : peers[j];
            const b = peers[i] < peers[j] ? peers[j] : peers[i];
            insertRel.run(a, b, 1);
            edgeCount++;
          }
        }
      }

      db.exec("COMMIT");
      db.prepare("INSERT OR REPLACE INTO meta VALUES ('last_scan', datetime('now'))").run();

      // Count total messages that made it into the index (excludes rows with missing sender)
      const indexedMessages = Array.from(senderMap.values()).reduce((sum, s) => sum + s.count, 0);
      return { senders: senderMap.size, domains: domainMap.size, edges: edgeCount, indexedMessages };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Return top senders matching an optional text filter, ordered by count desc. */
  searchSenders(query: string, limit = 200): SenderStat[] {
    this.open();
    const q = `%${query.toLowerCase()}%`;
    return (this.db!.prepare(`
      SELECT sender, domain, message_count, unread_count, total_size,
             first_email_date, last_email_date
      FROM sender_stats
      WHERE LOWER(sender) LIKE ? OR LOWER(domain) LIKE ?
      ORDER BY message_count DESC
      LIMIT ?
    `).all(q, q, limit) as any[]).map((r) => ({
      sender: r.sender,
      domain: r.domain,
      messageCount: r.message_count,
      unreadCount: r.unread_count,
      totalSize: r.total_size,
      firstEmailDate: r.first_email_date,
      lastEmailDate: r.last_email_date,
    }));
  }

  /** Return top domains by message count. */
  topDomains(limit = 50): DomainStat[] {
    this.open();
    return (this.db!.prepare(`
      SELECT domain, sender_count, message_count, total_size
      FROM domain_stats
      ORDER BY message_count DESC
      LIMIT ?
    `).all(limit) as any[]).map((r) => ({
      domain: r.domain,
      senderCount: r.sender_count,
      messageCount: r.message_count,
      totalSize: r.total_size,
    }));
  }

  /** Execute an arbitrary read-only SELECT and return raw rows. */
  query(sql: string): Record<string, unknown>[] {
    this.open();
    try {
      return (this.db!.prepare(sql).all() as Record<string, unknown>[]) ?? [];
    } catch (e) {
      throw new Error(`EnrichmentDB query failed: ${(e as Error).message}`);
    }
  }

  /** Summary counts used by the NLP agent system prompt. */
  getSummaryStats(): { senders: number; domains: number; messages: number } {
    try {
      this.open();
      const s = this.db!.prepare("SELECT COUNT(*) AS n, SUM(message_count) AS t FROM sender_stats").get() as any;
      const d = this.db!.prepare("SELECT COUNT(*) AS n FROM domain_stats").get() as any;
      return {
        senders: s?.n ?? 0,
        domains: d?.n ?? 0,
        messages: s?.t ?? 0,
      };
    } catch {
      return { senders: 0, domains: 0, messages: 0 };
    }
  }

  /** Check if the DB has been populated. */
  isPopulated(): boolean {
    try {
      this.open();
      const row = this.db!.prepare("SELECT COUNT(*) AS n FROM sender_stats").get() as any;
      return row.n > 0;
    } catch {
      return false;
    }
  }
}

// Singleton used by IPC handlers
export const enrichmentDb = new EnrichmentDB();
