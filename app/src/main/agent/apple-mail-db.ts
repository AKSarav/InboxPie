/**
 * Apple Mail Envelope Index — read-only SQLite access.
 *
 * The Envelope Index is Apple Mail's internal SQLite database at:
 *   ~/Library/Mail/V{version}/MailData/Envelope Index
 *
 * We open it read-only (WAL mode allows concurrent reads even while Mail.app
 * has it open for writing). Never mutate anything here.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RELEVANT_TABLES = ["messages", "subjects", "addresses", "mailboxes"];

// ── Find the Envelope Index file ──────────────────────────────────────────────

function findEnvelopeIndex(): string {
  const mailRoot = path.join(os.homedir(), "Library", "Mail");

  // Flat layout (older macOS)
  const flat = path.join(mailRoot, "MailData", "Envelope Index");
  if (existsSync(flat)) return flat;

  // Versioned layout: V8, V9, V10… — pick the highest
  let entries: string[] = [];
  try {
    entries = readdirSync(mailRoot).filter((d) => /^V\d+$/.test(d));
  } catch {
    throw new Error(`Cannot read ~/Library/Mail — Full Disk Access may be needed.`);
  }

  const sorted = entries.sort((a, b) => {
    const na = parseInt(a.slice(1), 10);
    const nb = parseInt(b.slice(1), 10);
    return nb - na; // descending: highest version first
  });

  for (const v of sorted) {
    const p = path.join(mailRoot, v, "MailData", "Envelope Index");
    if (existsSync(p)) return p;
  }

  throw new Error(
    "Apple Mail Envelope Index not found. Make sure Apple Mail has been set up on this Mac.",
  );
}

// ── DB class ──────────────────────────────────────────────────────────────────

export class AppleMailDB {
  private db: DatabaseSync | null = null;
  private _schemaCache: string | null = null;

  /** Open the Envelope Index in read-only mode. */
  open(): void {
    if (this.db) return;
    const dbPath = findEnvelopeIndex();
    this.db = new DatabaseSync(dbPath, { readOnly: true });
  }

  /** Return live DDL for the relevant tables + usage annotations for the LLM. */
  getSchema(): string {
    if (this._schemaCache) return this._schemaCache;
    this.open();

    const ddls: string[] = [];
    for (const table of RELEVANT_TABLES) {
      const row = this.db!.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      ).get(table) as { sql: string } | undefined;
      if (row?.sql) ddls.push(row.sql + ";");
    }

    // Grab a few sample rows from messages so the LLM sees real values
    let sampleRows = "";
    try {
      const sample = this.db!.prepare(
        `SELECT m.ROWID, s.subject, a.address, a.comment,
                datetime(m.date_received,'unixepoch','localtime') AS received_at,
                m.read, m.flagged, m.size, mb.url AS mailbox_url
         FROM messages m
         LEFT JOIN subjects s ON m.subject = s.ROWID
         LEFT JOIN addresses a ON m.sender = a.ROWID
         LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
         WHERE m.deleted = 0 LIMIT 3`,
      ).all() as Record<string, unknown>[];
      sampleRows = `\nSAMPLE ROWS (3 of many):\n${JSON.stringify(sample, null, 2)}`;
    } catch {
      // Not critical if this fails
    }

    this._schemaCache = `
APPLE MAIL DATABASE TABLES
===========================
${ddls.join("\n\n")}

KEY NOTES FOR CORRECT QUERIES
==============================
1. dates (date_sent, date_received) are Unix epoch seconds.
   → Readable format: datetime(m.date_sent, 'unixepoch', 'localtime')
   → Today filter:    date(m.date_received,'unixepoch','localtime') = date('now','localtime')
   → Last 30 days:   m.date_received >= unixepoch('now','-30 days')
2. ALWAYS include WHERE m.deleted = 0 to exclude deleted messages.
3. subjects.subject → readable subject string (JOIN ON m.subject = subjects.ROWID)
4. addresses.address → email address; addresses.comment → display name
   (JOIN ON m.sender = addresses.ROWID)
5. mailboxes.url → folder URL like "imap://user@host/INBOX" or "mailbox://..."
   → Last path segment is the folder name.
   → mailboxes.flags: 4=Inbox, 8=Drafts, 16=Sent, 32=Trash, 64=Junk
6. "emails I sent" → no outbox in this DB; query Sent folder instead:
   WHERE mb.flags = 16 OR mb.url LIKE '%Sent%'
7. Domain filter: WHERE a.address LIKE '%@example.com'
   Exact sender:  WHERE a.address = 'name@example.com'

STANDARD JOIN TEMPLATE (use this as the base for most queries):
  FROM messages m
  LEFT JOIN subjects s ON m.subject = s.ROWID
  LEFT JOIN addresses a ON m.sender = a.ROWID
  LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
  WHERE m.deleted = 0

${sampleRows}
`.trim();

    return this._schemaCache;
  }

  /** Run a safe SELECT and return up to maxRows rows. */
  executeSql(sql: string, maxRows = 100): Record<string, unknown>[] {
    this.open();
    const stmt = this.db!.prepare(sql);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.slice(0, maxRows);
  }
}

export const appleMailDb = new AppleMailDB();
