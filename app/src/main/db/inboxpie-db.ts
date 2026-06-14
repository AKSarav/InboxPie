/**
 * InboxPieDB — unified persistent store for InboxPie Desktop.
 *
 * Single SQLite file at ~/.inboxpie/inboxpie.db that tracks every mail
 * account, folder, and message scanned on this device. Entity extraction
 * (LLM NER) results are written back into this same DB so the graph layer
 * (FalkorDB Lite) can be rebuilt from it at any time.
 *
 * Tables:
 *   mailboxes   — Apple Mail accounts (keyed by UUID from Envelope Index)
 *   folders     — Folders per account, with indexing status
 *   mails       — One row per message; NER entities written by indexer (body never stored)
 *   preferences — User settings (read_content, read_subject)
 *   scan_audit  — History of scan operations
 *   index_audit — History of entity-extraction (indexing) operations
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync as Database } from "node:sqlite";

// ── Paths ──────────────────────────────────────────────────────────────────────

const DB_DIR  = path.join(os.homedir(), ".inboxpie");
const DB_PATH = path.join(DB_DIR, "inboxpie.db");

// ── Types ──────────────────────────────────────────────────────────────────────

export type FolderIndexStatus = "todo" | "inprogress" | "complete" | "failed";
export type MailIndexStatus   = "todo" | "inprogress" | "complete";
export type AuditStatus       = "inprogress" | "success" | "failed";

export interface MailInsert {
  id:        string;
  mailboxId: string;
  folderId:  number;
  sender:    string;
  domain:    string;
  size:      number;
  subject:   string;
  date:      string;
}

export interface PendingMail {
  id:        string;
  subject:   string;
  mailboxId: string;
  folderId:  number;
  sender:    string;
}

export interface NamedEntity {
  text:  string;
  label: string; // PER | ORG | LOC | MISC
}

export interface IndexStats {
  total:    number;
  todo:     number;
  inprogress: number;
  complete: number;
}

export interface SenderRow {
  sender: string;
  domain: string;
  count:  number;
  size:   number;
}

export interface DomainRow {
  domain: string;
  senders: number;
  count:   number;
  size:    number;
}

// ── Schema ─────────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mailboxes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  source_db_path TEXT,
  apple_id       TEXT UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  indexed    TEXT NOT NULL DEFAULT 'todo'
             CHECK (indexed IN ('todo','inprogress','complete','failed')),
  read_mode  TEXT NOT NULL DEFAULT 'metadata'
             CHECK (read_mode IN ('metadata','content')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mailbox_id, name)
);

CREATE TABLE IF NOT EXISTS mails (
  id               TEXT PRIMARY KEY,
  mailbox_id       TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  folder_id        INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  sender           TEXT,
  domain           TEXT,
  size             INTEGER DEFAULT 0,
  subject          TEXT,
  subject_entities TEXT,   -- JSON [{text,label}] — extracted by LLM NER, body never stored
  body_entities    TEXT,   -- JSON [{text,label}] — populated only when ReadContent=yes
  indexed          TEXT NOT NULL DEFAULT 'todo'
                   CHECK (indexed IN ('todo','inprogress','complete')),
  indexed_meta     TEXT NOT NULL DEFAULT 'no',  -- 'yes' once subject/sender/domain embedded
  indexed_body     TEXT NOT NULL DEFAULT 'no',  -- 'yes' once email body text embedded
  created_at       TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preferences (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Intelligence categories (name → keywords[]) used for Knowledge Map grouping.
-- Built-in defaults are seeded with builtin=1 (editable); user categories are builtin=0
-- and take precedence in classification.
CREATE TABLE IF NOT EXISTS categories (
  name       TEXT PRIMARY KEY,
  keywords   TEXT NOT NULL DEFAULT '[]',
  icon       TEXT NOT NULL DEFAULT '🏷️',
  builtin    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scan_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id   TEXT    REFERENCES mailboxes(id) ON DELETE SET NULL,
  folder_id    INTEGER REFERENCES folders(id)   ON DELETE SET NULL,
  status       TEXT NOT NULL CHECK (status IN ('inprogress','success','failed')),
  mail_count   INTEGER DEFAULT 0,
  error        TEXT,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scan_audit_folder ON scan_audit(folder_id);

CREATE TABLE IF NOT EXISTS index_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id    TEXT REFERENCES mailboxes(id),
  folders       TEXT,
  status        TEXT NOT NULL CHECK (status IN ('inprogress','success','failed')),
  indexed_count INTEGER DEFAULT 0,
  failed_count  INTEGER DEFAULT 0,
  error         TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_mails_mailbox ON mails(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_mails_folder  ON mails(folder_id);
CREATE INDEX IF NOT EXISTS idx_mails_indexed ON mails(indexed);
CREATE INDEX IF NOT EXISTS idx_mails_sender  ON mails(sender);
CREATE INDEX IF NOT EXISTS idx_mails_domain  ON mails(domain);
CREATE INDEX IF NOT EXISTS idx_folders_mb    ON folders(mailbox_id);
`;

// ── DB class ───────────────────────────────────────────────────────────────────

export class InboxPieDB {
  private db: Database | null = null;

  open(): void {
    if (this.db) return;
    fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH) as Database;
    // Migrate: drop old scan_audit that used a JSON `folders` TEXT column
    // (it was never populated so there is no history to preserve)
    try {
      const cols = this.db.prepare("PRAGMA table_info(scan_audit)").all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "folders") && !cols.some((c) => c.name === "folder_id")) {
        this.db.exec("DROP TABLE IF EXISTS scan_audit");
      }
    } catch { /* table may not exist yet — SCHEMA will create it */ }
    this.db.exec(SCHEMA);
    // Add indexed_meta / indexed_body tracking columns to existing mails tables
    try {
      const mailCols = this.db.prepare("PRAGMA table_info(mails)").all() as Array<{ name: string }>;
      if (!mailCols.some((c) => c.name === "indexed_meta")) {
        this.db.exec("ALTER TABLE mails ADD COLUMN indexed_meta TEXT NOT NULL DEFAULT 'no'");
      }
      if (!mailCols.some((c) => c.name === "indexed_body")) {
        this.db.exec("ALTER TABLE mails ADD COLUMN indexed_body TEXT NOT NULL DEFAULT 'no'");
      }
    } catch { /* ignore — fresh install gets the columns from SCHEMA */ }
    // Add per-folder read_mode to existing folders tables
    try {
      const folderCols = this.db.prepare("PRAGMA table_info(folders)").all() as Array<{ name: string }>;
      if (!folderCols.some((c) => c.name === "read_mode")) {
        this.db.exec("ALTER TABLE folders ADD COLUMN read_mode TEXT NOT NULL DEFAULT 'metadata'");
      }
    } catch { /* ignore — fresh install gets the column from SCHEMA */ }
    // Add icon / builtin columns to an existing categories table
    try {
      const catCols = this.db.prepare("PRAGMA table_info(categories)").all() as Array<{ name: string }>;
      if (catCols.length) {
        if (!catCols.some((c) => c.name === "icon"))    this.db.exec("ALTER TABLE categories ADD COLUMN icon TEXT NOT NULL DEFAULT '🏷️'");
        if (!catCols.some((c) => c.name === "builtin")) this.db.exec("ALTER TABLE categories ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0");
      }
    } catch { /* ignore — fresh install gets columns from SCHEMA */ }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private get(): Database {
    this.open();
    return this.db!;
  }

  // ── Preferences ─────────────────────────────────────────────────────────────

  getPreference(key: string, defaultVal: string | null = null): string | null {
    const row = this.get().prepare("SELECT value FROM preferences WHERE key = ?").get(key) as any;
    return row?.value ?? defaultVal;
  }

  setPreference(key: string, value: string): void {
    this.get().prepare(
      "INSERT INTO preferences(key, value, updated_at) VALUES(?,?,datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    ).run(key, value);
  }

  /** true if ReadContent preference is set to 'yes'. */
  get readContent(): boolean { return this.getPreference("read_content") === "yes"; }
  /** true if ReadSubject preference is set to 'yes' (default yes). */
  get readSubject(): boolean { return this.getPreference("read_subject", "yes") !== "no"; }

  // ── User-defined categories (name → keywords[]) ───────────────────────────────

  getCategories(): Array<{ name: string; keywords: string[]; icon: string; builtin: boolean }> {
    // Built-ins first (seeded), then user categories, then by recency.
    return (this.get().prepare("SELECT name, keywords, icon, builtin FROM categories ORDER BY builtin DESC, created_at").all() as any[])
      .map((r) => {
        let kw: string[] = [];
        try { const p = JSON.parse(r.keywords); if (Array.isArray(p)) kw = p.map(String); } catch { /* ignore */ }
        return { name: String(r.name), keywords: kw, icon: String(r.icon ?? "🏷️"), builtin: !!r.builtin };
      });
  }

  /** Upsert a category's keywords; preserves icon/builtin on existing rows. New rows are user (builtin=0). */
  upsertCategory(name: string, keywords: string[]): void {
    this.get().prepare(
      "INSERT INTO categories(name, keywords, icon, builtin) VALUES(?,?,'🏷️',0) " +
      "ON CONFLICT(name) DO UPDATE SET keywords=excluded.keywords"
    ).run(name, JSON.stringify(keywords ?? []));
  }

  deleteCategory(name: string): void {
    this.get().prepare("DELETE FROM categories WHERE name = ?").run(name);
  }

  /** Seed built-in categories once (guarded by a preference flag so deleted ones stay gone). */
  seedDefaultCategories(defaults: Array<{ name: string; icon: string; keywords: string[] }>): void {
    if (this.getPreference("categories_seeded") === "1") return;
    const stmt = this.get().prepare(
      "INSERT OR IGNORE INTO categories(name, keywords, icon, builtin) VALUES(?,?,?,1)"
    );
    for (const d of defaults) stmt.run(d.name, JSON.stringify(d.keywords), d.icon);
    this.setPreference("categories_seeded", "1");
  }

  // ── Mailboxes ────────────────────────────────────────────────────────────────

  upsertMailbox(id: string, name: string, sourceDbPath?: string): void {
    this.get().prepare(`
      INSERT INTO mailboxes(id, name, source_db_path, apple_id, updated_at)
      VALUES(?,?,?,?,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name           = excluded.name,
        source_db_path = COALESCE(excluded.source_db_path, source_db_path),
        updated_at     = excluded.updated_at
    `).run(id, name, sourceDbPath ?? null, id);
  }

  getMailboxes(): Array<{ id: string; name: string; sourceDbPath: string | null }> {
    return (this.get().prepare("SELECT id, name, source_db_path FROM mailboxes").all() as any[])
      .map(r => ({ id: r.id, name: r.name, sourceDbPath: r.source_db_path }));
  }

  // ── Folders ──────────────────────────────────────────────────────────────────

  /**
   * Insert or update a folder. Returns the folder's row ID.
   * Idempotent — safe to call on every scan.
   */
  upsertFolder(mailboxId: string, name: string): number {
    const db = this.get();
    db.prepare(`
      INSERT INTO folders(mailbox_id, name, indexed, updated_at)
      VALUES(?,?,'todo',datetime('now'))
      ON CONFLICT(mailbox_id, name) DO NOTHING
    `).run(mailboxId, name);
    const row = db.prepare("SELECT id FROM folders WHERE mailbox_id = ? AND name = ?").get(mailboxId, name) as any;
    return row.id as number;
  }

  setFolderStatus(folderId: number, status: FolderIndexStatus): void {
    this.get().prepare(
      "UPDATE folders SET indexed = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, folderId);
  }

  // ── Mails — scan phase ───────────────────────────────────────────────────────

  /**
   * Bulk-insert mails from a scan result.
   * Ignores duplicates (IGNORE on conflict) so rescans are safe.
   * Returns the number of newly inserted rows.
   */
  insertMails(mails: MailInsert[]): number {
    if (!mails.length) return 0;
    const db = this.get();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO mails
        (id, mailbox_id, folder_id, sender, domain, size, subject, indexed, created_at)
      VALUES (?,?,?,?,?,?,?,'todo',?)
    `);

    let inserted = 0;
    db.exec("BEGIN");
    try {
      for (const m of mails) {
        const result = stmt.run(m.id, m.mailboxId, m.folderId, m.sender, m.domain, m.size, m.subject, m.date) as any;
        inserted += result.changes as number;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return inserted;
  }

  getMailCount(mailboxId?: string): number {
    if (mailboxId) {
      const r = this.get().prepare("SELECT COUNT(*) AS n FROM mails WHERE mailbox_id = ?").get(mailboxId) as any;
      return r?.n ?? 0;
    }
    const r = this.get().prepare("SELECT COUNT(*) AS n FROM mails").get() as any;
    return r?.n ?? 0;
  }

  // ── Mails — vector index tracking ───────────────────────────────────────────

  /**
   * Mark a batch of mails as vector-indexed.
   * Mode 'metadata' sets indexed_meta=yes; mode 'content' sets both indexed_meta and indexed_body.
   */
  markMailsVectorIndexed(ids: string[], mode: "metadata" | "content"): void {
    if (!ids.length) return;
    const db = this.get();
    const placeholders = ids.map(() => "?").join(",");
    if (mode === "content") {
      db.prepare(
        `UPDATE mails SET indexed_meta='yes', indexed_body='yes', updated_at=datetime('now') WHERE id IN (${placeholders})`
      ).run(...ids);
    } else {
      db.prepare(
        `UPDATE mails SET indexed_meta='yes', updated_at=datetime('now') WHERE id IN (${placeholders})`
      ).run(...ids);
    }
  }

  /** Counts mails by vector index status. */
  getVectorIndexStats(): { total: number; indexedMeta: number; indexedBody: number } {
    const db = this.get();
    const r = db.prepare(
      "SELECT COUNT(*) AS total, SUM(indexed_meta='yes') AS meta, SUM(indexed_body='yes') AS body FROM mails"
    ).get() as any;
    return { total: r?.total ?? 0, indexedMeta: r?.meta ?? 0, indexedBody: r?.body ?? 0 };
  }

  // ── Mails — NER enrichment phase ─────────────────────────────────────────────

  /**
   * Returns up to `limit` mails that have not yet been indexed.
   * Body is null at this stage unless it was populated by a previous index run.
   */
  getPendingMails(limit = 100): PendingMail[] {
    return this.get().prepare(`
      SELECT id, subject, mailbox_id AS mailboxId, folder_id AS folderId, sender
      FROM mails
      WHERE indexed = 'todo'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as unknown as PendingMail[];
  }

  markMailIndexing(id: string): void {
    this.get().prepare(
      "UPDATE mails SET indexed = 'inprogress', updated_at = datetime('now') WHERE id = ?"
    ).run(id);
  }

  /**
   * Store extracted entities and mark mail as indexed=complete.
   * Body is never persisted — only the NER results from it are stored.
   * After updating, syncs the parent folder's indexed status.
   */
  updateMailEntities(
    id: string,
    subjectEntities: NamedEntity[],
    bodyEntities?: NamedEntity[],
  ): void {
    const db = this.get();
    db.prepare(`
      UPDATE mails SET
        subject_entities = ?,
        body_entities    = ?,
        indexed          = 'complete',
        updated_at       = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(subjectEntities),
      bodyEntities ? JSON.stringify(bodyEntities) : null,
      id,
    );
    // Sync folder status derived from its mail rows
    this._syncFolderStatus(id, db);
  }

  /**
   * Derives and writes folder.indexed from its current mail statuses.
   * todo     → at least one mail still needs indexing
   * inprogress → at least one mail is currently being indexed
   * complete → every mail is done
   * Called automatically after each mail update so folder status never drifts.
   */
  private _syncFolderStatus(mailId: string, db: Database): void {
    const folderRow = db.prepare("SELECT folder_id FROM mails WHERE id = ?").get(mailId) as any;
    if (!folderRow) return;
    const folderId: number = folderRow.folder_id;

    const counts = db.prepare(`
      SELECT
        SUM(indexed = 'todo')       AS todo,
        SUM(indexed = 'inprogress') AS inprogress,
        SUM(indexed = 'complete')   AS complete
      FROM mails WHERE folder_id = ?
    `).get(folderId) as any;

    let status: FolderIndexStatus = "complete";
    if ((counts?.inprogress ?? 0) > 0) status = "inprogress";
    else if ((counts?.todo ?? 0) > 0)  status = "todo";

    db.prepare("UPDATE folders SET indexed = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, folderId);
  }

  markMailFailed(id: string): void {
    this.get().prepare(
      "UPDATE mails SET indexed = 'todo', updated_at = datetime('now') WHERE id = ?"
    ).run(id);
  }

  getIndexStats(): IndexStats {
    const row = this.get().prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(indexed = 'todo')       AS todo,
        SUM(indexed = 'inprogress') AS inprogress,
        SUM(indexed = 'complete')   AS complete
      FROM mails
    `).get() as any;
    return {
      total:      row?.total      ?? 0,
      todo:       row?.todo       ?? 0,
      inprogress: row?.inprogress ?? 0,
      complete:   row?.complete   ?? 0,
    };
  }

  /** Reset all mails back to indexed=todo (for re-indexing). */
  resetIndexing(): void {
    this.get().prepare(
      "UPDATE mails SET indexed='todo', subject_entities=NULL, body_entities=NULL, updated_at=datetime('now')"
    ).run();
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  /** Aggregated sender stats, ordered by message count descending. */
  getSenderStats(limit = 200): SenderRow[] {
    return this.get().prepare(`
      SELECT sender, domain,
             COUNT(*)  AS count,
             SUM(size) AS size
      FROM mails
      WHERE sender IS NOT NULL
      GROUP BY sender
      ORDER BY count DESC
      LIMIT ?
    `).all(limit) as unknown as SenderRow[];
  }

  /** Aggregated domain stats, ordered by message count descending. */
  getDomainStats(limit = 50): DomainRow[] {
    return this.get().prepare(`
      SELECT domain,
             COUNT(DISTINCT sender) AS senders,
             COUNT(*) AS count,
             SUM(size) AS size
      FROM mails
      WHERE domain IS NOT NULL
      GROUP BY domain
      ORDER BY count DESC
      LIMIT ?
    `).all(limit) as unknown as DomainRow[];
  }

  /** IDs and subjects of mails matching an entity name (full-text scan of JSON). */
  getMailsWithEntity(entityName: string, limit = 200): Array<{ id: string; sender: string; subject: string }> {
    const pattern = `%${entityName}%`;
    return this.get().prepare(`
      SELECT id, sender, subject FROM mails
      WHERE (subject_entities LIKE ? OR body_entities LIKE ?)
        AND indexed = 'complete'
      LIMIT ?
    `).all(pattern, pattern, limit) as any[];
  }

  /** All entity names for a given sender (from subject_entities). */
  getEntitiesForSender(senderEmail: string): NamedEntity[] {
    const rows = this.get().prepare(`
      SELECT subject_entities, body_entities FROM mails
      WHERE LOWER(sender) = LOWER(?) AND indexed = 'complete'
    `).all(senderEmail) as any[];

    const seen = new Set<string>();
    const result: NamedEntity[] = [];
    for (const row of rows) {
      for (const blob of [row.subject_entities, row.body_entities]) {
        if (!blob) continue;
        try {
          for (const e of JSON.parse(blob) as NamedEntity[]) {
            const key = `${e.label}:${e.text.toLowerCase()}`;
            if (!seen.has(key)) { seen.add(key); result.push(e); }
          }
        } catch { /* skip malformed */ }
      }
    }
    return result;
  }

  // ── Audit ────────────────────────────────────────────────────────────────────

  startScanAudit(mailboxId: string | null, folderId: number): number {
    const result = this.get().prepare(
      "INSERT INTO scan_audit(mailbox_id, folder_id, status) VALUES(?,?,'inprogress')"
    ).run(mailboxId, folderId) as any;
    return result.lastInsertRowid as number;
  }

  completeScanAudit(id: number, mailCount: number): void {
    this.get().prepare(
      "UPDATE scan_audit SET status='success', mail_count=?, completed_at=datetime('now') WHERE id=?"
    ).run(mailCount, id);
  }

  failScanAudit(id: number, error: string): void {
    this.get().prepare(
      "UPDATE scan_audit SET status='failed', error=?, completed_at=datetime('now') WHERE id=?"
    ).run(error, id);
  }

  startIndexAudit(mailboxId: string | null, folders: string[]): number {
    const result = this.get().prepare(
      "INSERT INTO index_audit(mailbox_id, folders, status) VALUES(?,?,'inprogress')"
    ).run(mailboxId, JSON.stringify(folders)) as any;
    return result.lastInsertRowid as number;
  }

  completeIndexAudit(id: number, indexed: number, failed: number): void {
    this.get().prepare(
      "UPDATE index_audit SET status='success', indexed_count=?, failed_count=?, completed_at=datetime('now') WHERE id=?"
    ).run(indexed, failed, id);
  }

  failIndexAudit(id: number, error: string): void {
    this.get().prepare(
      "UPDATE index_audit SET status='failed', error=?, completed_at=datetime('now') WHERE id=?"
    ).run(error, id);
  }

  getFolderStats(): Array<{
    id: number; name: string; mailboxId: string; mailboxName: string;
    indexed: FolderIndexStatus; readMode: "metadata" | "content";
    mailCount: number; lastScanned: string | null;
    indexedMetaCount: number; indexedBodyCount: number;
  }> {
    return (this.get().prepare(`
      SELECT f.id, f.name, f.indexed, f.read_mode AS readMode, f.mailbox_id AS mailboxId,
             mb.name AS mailboxName,
             COUNT(m.id) AS mailCount,
             SUM(CASE WHEN m.indexed_meta = 'yes' THEN 1 ELSE 0 END) AS indexedMetaCount,
             SUM(CASE WHEN m.indexed_body = 'yes' THEN 1 ELSE 0 END) AS indexedBodyCount,
             (SELECT MAX(sa.completed_at) FROM scan_audit sa
              WHERE sa.folder_id = f.id AND sa.status = 'success') AS lastScanned
      FROM folders f
      JOIN mailboxes mb ON f.mailbox_id = mb.id
      LEFT JOIN mails m ON m.folder_id = f.id
      GROUP BY f.id
      ORDER BY mailCount DESC
    `).all() as any[]).map((r) => ({
      id:               r.id,
      name:             r.name,
      mailboxId:        r.mailboxId,
      mailboxName:      r.mailboxName,
      indexed:          r.indexed as FolderIndexStatus,
      readMode:         (r.readMode === "content" ? "content" : "metadata") as "metadata" | "content",
      mailCount:        r.mailCount ?? 0,
      indexedMetaCount: r.indexedMetaCount ?? 0,
      indexedBodyCount: r.indexedBodyCount ?? 0,
      lastScanned:      r.lastScanned ?? null,
    }));
  }

  /** Set a folder's AI read mode (by folder name, across mailboxes). */
  setFolderReadMode(name: string, mode: "metadata" | "content"): void {
    this.get().prepare(
      "UPDATE folders SET read_mode = ?, updated_at = datetime('now') WHERE name = ?"
    ).run(mode, name);
  }

  /** Map of folder name → read mode for the given folder names (default metadata). */
  getFolderReadModes(names: string[]): Record<string, "metadata" | "content"> {
    const out: Record<string, "metadata" | "content"> = {};
    if (!names.length) return out;
    const placeholders = names.map(() => "?").join(",");
    const rows = this.get().prepare(
      `SELECT name, read_mode FROM folders WHERE name IN (${placeholders})`
    ).all(...names) as any[];
    for (const r of rows) out[r.name] = r.read_mode === "content" ? "content" : "metadata";
    // Folders with no row yet default to metadata
    for (const n of names) if (!(n in out)) out[n] = "metadata";
    return out;
  }

  getLastScanAudit(): { folderId: number | null; mailCount: number; startedAt: string; status: string } | null {
    return this.get().prepare(
      "SELECT folder_id, mail_count, started_at, status FROM scan_audit ORDER BY id DESC LIMIT 1"
    ).get() as any ?? null;
  }

  getLastIndexAudit(): { indexedCount: number; failedCount: number; startedAt: string; status: string } | null {
    return this.get().prepare(
      "SELECT indexed_count, failed_count, started_at, status FROM index_audit ORDER BY id DESC LIMIT 1"
    ).get() as any ?? null;
  }

  /**
   * Remove specific folders entirely — their mails, scan history and folder rows.
   * (LanceDB vectors are cleared separately by the caller.) Folders re-appear on
   * the next scan. Returns counts removed.
   */
  deleteFolders(names: string[]): { mails: number; folders: number } {
    if (!names.length) return { mails: 0, folders: 0 };
    const db = this.get();
    const ph = names.map(() => "?").join(",");
    const folderIds = (db.prepare(`SELECT id FROM folders WHERE name IN (${ph})`).all(...names) as any[])
      .map((r) => r.id as number);
    if (!folderIds.length) return { mails: 0, folders: 0 };
    const idPh = folderIds.map(() => "?").join(",");

    let mails = 0;
    db.exec("BEGIN");
    try {
      mails = (db.prepare(`SELECT COUNT(*) AS n FROM mails WHERE folder_id IN (${idPh})`).get(...folderIds) as any)?.n ?? 0;
      db.prepare(`DELETE FROM scan_audit WHERE folder_id IN (${idPh})`).run(...folderIds);
      db.prepare(`DELETE FROM mails      WHERE folder_id IN (${idPh})`).run(...folderIds);
      db.prepare(`DELETE FROM folders    WHERE id        IN (${idPh})`).run(...folderIds);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { mails, folders: folderIds.length };
  }

  /**
   * Wipe all scan/index data so the user can rebuild from scratch.
   * Clears mails, folders, and both audit tables. Keeps mailboxes (account
   * identities) and preferences. Returns counts of what was removed.
   */
  resetAllData(): { mails: number; folders: number } {
    const db = this.get();
    const mailCount   = (db.prepare("SELECT COUNT(*) AS n FROM mails").get()   as any)?.n ?? 0;
    const folderCount = (db.prepare("SELECT COUNT(*) AS n FROM folders").get() as any)?.n ?? 0;
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM index_audit");
      db.exec("DELETE FROM scan_audit");
      db.exec("DELETE FROM mails");
      db.exec("DELETE FROM folders");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { mails: mailCount, folders: folderCount };
  }

}

export const inboxPieDb = new InboxPieDB();
