/**
 * VectorStore — SQLite-backed float32 embedding store.
 *
 * Vectors are stored as raw Float32Array BLOBs. On first search they are loaded
 * into an in-memory cache so subsequent queries are ~instant (dot-product loop
 * over TypedArrays is fast enough for ≤200K emails on a modern Mac).
 *
 * Storage: ~/.inboxpie/vectors.db
 */

import { DatabaseSync as Database } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_DIR  = path.join(os.homedir(), ".inboxpie");
const DB_PATH = path.join(DB_DIR, "vectors.db");

export interface EmailMeta {
  message_id:  string;
  sender_email: string;
  sender_name:  string;
  domain:       string;
  date_unix:    number;   // Unix epoch seconds
  year:         number;
  month:        number;
  folder:       string;
  folder_type:  string;
  is_read:      number;   // 0 | 1
  size:         number;
  text_indexed: string;   // the text that was embedded (for inspection)
}

export interface SearchResult extends EmailMeta {
  score: number;  // cosine similarity 0..1
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function dotProduct(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s);
}

// ── VectorStore class ─────────────────────────────────────────────────────────

export class VectorStore {
  private db: Database;

  /** In-memory cache: loaded on first search, invalidated on upsert. */
  private cache: Array<{ id: string; vec: Float32Array; meta: EmailMeta }> | null = null;

  constructor() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_vectors (
        message_id   TEXT PRIMARY KEY,
        sender_email TEXT,
        sender_name  TEXT,
        domain       TEXT,
        date_unix    INTEGER,
        year         INTEGER,
        month        INTEGER,
        folder       TEXT,
        folder_type  TEXT,
        is_read      INTEGER,
        size         INTEGER,
        text_indexed TEXT,
        vector       BLOB    -- raw Float32Array bytes
      );
      CREATE INDEX IF NOT EXISTS idx_ev_year   ON email_vectors(year);
      CREATE INDEX IF NOT EXISTS idx_ev_domain ON email_vectors(domain);
    `);
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  upsert(meta: EmailMeta, vector: number[]): void {
    const blob = Buffer.from(new Float32Array(vector).buffer);
    this.db.prepare(`
      INSERT OR REPLACE INTO email_vectors VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      meta.message_id, meta.sender_email, meta.sender_name, meta.domain,
      meta.date_unix, meta.year, meta.month, meta.folder, meta.folder_type,
      meta.is_read, meta.size, meta.text_indexed, blob,
    );
    this.cache = null; // invalidate on write
  }

  /** Batch upsert inside a single transaction — much faster for large imports. */
  upsertBatch(entries: Array<{ meta: EmailMeta; vector: number[] }>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO email_vectors VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    this.db.exec("BEGIN");
    try {
      for (const { meta, vector } of entries) {
        const blob = Buffer.from(new Float32Array(vector).buffer);
        stmt.run(
          meta.message_id, meta.sender_email, meta.sender_name, meta.domain,
          meta.date_unix, meta.year, meta.month, meta.folder, meta.folder_type,
          meta.is_read, meta.size, meta.text_indexed, blob,
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.cache = null;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  getStats(): { total: number; domains: number; years: number[] } {
    const total   = (this.db.prepare("SELECT COUNT(*) as n FROM email_vectors").get() as { n: number }).n;
    const domains = (this.db.prepare("SELECT COUNT(DISTINCT domain) as n FROM email_vectors").get() as { n: number }).n;
    const yearRows = this.db.prepare("SELECT DISTINCT year FROM email_vectors ORDER BY year DESC").all() as { year: number }[];
    return { total, domains, years: yearRows.map(r => r.year) };
  }

  hasMessage(messageId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM email_vectors WHERE message_id = ?").get(messageId);
    return !!row;
  }

  /** Return all message IDs already indexed — used for incremental updates. */
  indexedIds(): Set<string> {
    const rows = this.db.prepare("SELECT message_id FROM email_vectors").all() as { message_id: string }[];
    return new Set(rows.map(r => r.message_id));
  }

  // ── Search ────────────────────────────────────────────────────────────────

  private loadCache(): Array<{ id: string; vec: Float32Array; meta: EmailMeta }> {
    if (this.cache) return this.cache;
    const rows = this.db.prepare(
      `SELECT message_id, sender_email, sender_name, domain, date_unix,
              year, month, folder, folder_type, is_read, size, text_indexed, vector
       FROM email_vectors`,
    ).all() as Array<Record<string, unknown>>;

    this.cache = rows.map((r) => ({
      id:  r.message_id as string,
      vec: new Float32Array((r.vector as Buffer).buffer, (r.vector as Buffer).byteOffset, (r.vector as Buffer).byteLength / 4),
      meta: {
        message_id:   r.message_id  as string,
        sender_email: r.sender_email as string,
        sender_name:  r.sender_name  as string,
        domain:       r.domain       as string,
        date_unix:    r.date_unix    as number,
        year:         r.year         as number,
        month:        r.month        as number,
        folder:       r.folder       as string,
        folder_type:  r.folder_type  as string,
        is_read:      r.is_read      as number,
        size:         r.size         as number,
        text_indexed: r.text_indexed as string,
      },
    }));
    return this.cache;
  }

  search(
    queryVec: number[],
    opts: {
      limit?:       number;
      yearFrom?:    number;
      yearTo?:      number;
      domain?:      string;
      folderType?:  string;
      onlyUnread?:  boolean;
    } = {},
  ): SearchResult[] {
    const { limit = 20, yearFrom, yearTo, domain, folderType, onlyUnread } = opts;

    const q    = new Float32Array(queryVec);
    const qNrm = norm(q);
    if (qNrm === 0) return [];

    const entries = this.loadCache();

    // Pre-filter + score in one pass
    const scored: SearchResult[] = [];
    for (const e of entries) {
      const m = e.meta;
      if (yearFrom    && m.year < yearFrom)  continue;
      if (yearTo      && m.year > yearTo)    continue;
      if (domain      && m.domain !== domain) continue;
      if (folderType  && m.folder_type !== folderType) continue;
      if (onlyUnread  && m.is_read === 1)    continue;

      const score = dotProduct(q, e.vec) / (qNrm * norm(e.vec));
      scored.push({ ...m, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // ── Aggregation (no vector math — just SQL on indexed metadata) ──────────────

  topSenders(opts: { limit?: number; domain?: string; yearFrom?: number; yearTo?: number } = {}): Array<Record<string, unknown>> {
    const { limit = 20, domain, yearFrom, yearTo } = opts;
    const conditions = ["1=1"];
    const params: (string | number | null)[] = [];
    if (domain)   { conditions.push("LOWER(domain) = LOWER(?)"); params.push(domain); }
    if (yearFrom) { conditions.push("year >= ?"); params.push(yearFrom); }
    if (yearTo)   { conditions.push("year <= ?"); params.push(yearTo); }
    params.push(limit);
    return this.db.prepare(
      `SELECT sender_email, sender_name, domain,
              COUNT(*) AS email_count,
              SUM(size) AS total_bytes,
              MAX(date_unix) AS last_seen_unix,
              SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) AS unread_count
       FROM email_vectors WHERE ${conditions.join(" AND ")}
       GROUP BY sender_email, sender_name ORDER BY email_count DESC LIMIT ?`,
    ).all(...params) as Array<Record<string, unknown>>;
  }

  topDomains(opts: { limit?: number; yearFrom?: number; yearTo?: number } = {}): Array<Record<string, unknown>> {
    const { limit = 20, yearFrom, yearTo } = opts;
    const conditions = ["1=1"];
    const params: (string | number | null)[] = [];
    if (yearFrom) { conditions.push("year >= ?"); params.push(yearFrom); }
    if (yearTo)   { conditions.push("year <= ?"); params.push(yearTo); }
    params.push(limit);
    return this.db.prepare(
      `SELECT domain,
              COUNT(*) AS email_count,
              COUNT(DISTINCT sender_email) AS sender_count,
              SUM(size) AS total_bytes,
              SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) AS unread_count
       FROM email_vectors WHERE ${conditions.join(" AND ")}
       GROUP BY domain ORDER BY email_count DESC LIMIT ?`,
    ).all(...params) as Array<Record<string, unknown>>;
  }

  countBySender(senderPattern: string): number {
    const p = `%${senderPattern.toLowerCase()}%`;
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM email_vectors
       WHERE LOWER(sender_email) LIKE ? OR LOWER(sender_name) LIKE ? OR LOWER(domain) LIKE ?`,
    ).get(p, p, p) as { n: number };
    return row.n;
  }

  queryByYear(year: number): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT domain, COUNT(*) AS count FROM email_vectors WHERE year=? GROUP BY domain ORDER BY count DESC LIMIT 20`,
    ).all(year) as Array<Record<string, unknown>>;
  }

  reset(): void {
    this.db.exec("DELETE FROM email_vectors");
    this.cache = null;
  }
}

export const vectorStore = new VectorStore();
