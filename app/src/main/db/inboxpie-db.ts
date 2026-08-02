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

export interface GraphNode {
  id:        string;
  label:     string;
  type:      string;   // PERSON | ORG | PRODUCT | TOPIC | PLACE | EVENT | DATE | AMOUNT | Entity
  frequency: number;
  folderIds?: number[];
}

export interface GraphEdge {
  id:            string;
  subjectNodeId: string;
  predicate:     string;
  objectNodeId:  string;
  weight:        number;
}

export interface Triplet {
  subject:   string;
  predicate: string;
  object:    string;
}

export interface MailInsert {
  id:            string;
  mailboxId:     string;
  folderId:      number;
  sender:        string;
  domain:        string;
  size:          number;
  subject:       string;
  date:          string;
  provider?:     string;        // NEW: mail provider ('apple-mail', 'thunderbird', etc.)
  identifier_id?: string | null; // NEW: provider-native ID (ROWID for Apple, message key for TB)
}

export interface PendingMail {
  id:        string;
  subject:   string;
  mailboxId: string;
  folderId:  number;
  sender:    string;
  bodyText:  string | null;
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
  mail_provider  TEXT NOT NULL DEFAULT 'apple-mail',
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
  indexed          TEXT NOT NULL DEFAULT 'todo'
                   CHECK (indexed IN ('todo','inprogress','complete')),
  indexed_meta     TEXT NOT NULL DEFAULT 'no',  -- 'yes' once subject/sender/domain embedded
  indexed_body     TEXT NOT NULL DEFAULT 'no',  -- 'yes' once email body text embedded
  graph_indexed    TEXT NOT NULL DEFAULT 'todo'
                   CHECK (graph_indexed IN ('todo','inprogress','complete')),
  category         TEXT,
  created_at       TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'Entity',
  frequency  INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id              TEXT PRIMARY KEY,
  subject_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
  predicate       TEXT NOT NULL,
  object_node_id  TEXT NOT NULL REFERENCES graph_nodes(id),
  weight          REAL NOT NULL DEFAULT 1.0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS graph_mail_nodes (
  mail_id    TEXT    NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
  folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  mailbox_id TEXT    NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  node_id    TEXT    NOT NULL REFERENCES graph_nodes(id),
  PRIMARY KEY (mail_id, node_id)
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
CREATE INDEX IF NOT EXISTS idx_gmn_node      ON graph_mail_nodes(node_id);
CREATE INDEX IF NOT EXISTS idx_gmn_folder    ON graph_mail_nodes(folder_id);
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
    // Add mail_provider column to existing mailboxes tables
    try {
      const mbCols = this.db.prepare("PRAGMA table_info(mailboxes)").all() as Array<{ name: string }>;
      if (!mbCols.some((c) => c.name === "mail_provider")) {
        this.db.exec("ALTER TABLE mailboxes ADD COLUMN mail_provider TEXT NOT NULL DEFAULT 'apple-mail'");
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
    // Add graph_indexed tracking column to existing mails tables.
    // NOTE: idx_mails_graph_indexed is intentionally NOT in SCHEMA because for existing
    // installs the mails table already exists without the column; running CREATE INDEX
    // before ALTER TABLE would throw "no such column" and abort db.exec(SCHEMA).
    try {
      const mailColsG = this.db.prepare("PRAGMA table_info(mails)").all() as Array<{ name: string }>;
      if (!mailColsG.some((c) => c.name === "graph_indexed")) {
        this.db.exec("ALTER TABLE mails ADD COLUMN graph_indexed TEXT NOT NULL DEFAULT 'todo'");
      }
      // Always create the index (IF NOT EXISTS handles both new and existing installs)
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_mails_graph_indexed ON mails(graph_indexed)");
    } catch { /* ignore — fresh install gets the column from SCHEMA */ }
    // Drop subject_entities / body_entities — data lives in graph_nodes/graph_mail_nodes
    try {
      const mailColsDrop = this.db.prepare("PRAGMA table_info(mails)").all() as Array<{ name: string }>;
      if (mailColsDrop.some((c) => c.name === "subject_entities")) {
        this.db.exec("ALTER TABLE mails DROP COLUMN subject_entities");
      }
      if (mailColsDrop.some((c) => c.name === "body_entities")) {
        this.db.exec("ALTER TABLE mails DROP COLUMN body_entities");
      }
    } catch { /* ignore — column may not exist or SQLite version too old */ }
    // Add include_for_index column for Virtual Box selective indexing
    try {
      const mailColsV = this.db.prepare("PRAGMA table_info(mails)").all() as Array<{ name: string }>;
      if (!mailColsV.some((c) => c.name === "include_for_index")) {
        this.db.exec("ALTER TABLE mails ADD COLUMN include_for_index TEXT NOT NULL DEFAULT 'no'");
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_mails_include ON mails(include_for_index)");
    } catch { /* ignore — fresh install gets the column from SCHEMA */ }
    // Add body_text column for Virtual Box content display
    try {
      const mailColsB = this.db.prepare("PRAGMA table_info(mails)").all() as Array<{ name: string }>;
      if (!mailColsB.some((c) => c.name === "body_text")) {
        this.db.exec("ALTER TABLE mails ADD COLUMN body_text TEXT");
      }
    } catch { /* ignore — fresh install gets the column from SCHEMA */ }
    // Add category column for smart categorization
    try {
      const mailColsCat = this.db.prepare("PRAGMA table_info(mails)").all() as Array<{ name: string }>;
      if (!mailColsCat.some((c) => c.name === "category")) {
        this.db.exec("ALTER TABLE mails ADD COLUMN category TEXT");
      }
    } catch { /* ignore — fresh install gets the column from SCHEMA */ }
    // Add provider and identifier_id columns for multi-provider content fetching (Phase 2)
    try {
      const mailColsId = this.db.prepare("PRAGMA table_info(mails)").all() as Array<{ name: string }>;
      if (!mailColsId.some((c) => c.name === "provider")) {
        this.db.exec("ALTER TABLE mails ADD COLUMN provider TEXT NOT NULL DEFAULT 'apple-mail'");
      }
      if (!mailColsId.some((c) => c.name === "identifier_id")) {
        this.db.exec("ALTER TABLE mails ADD COLUMN identifier_id TEXT");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_mails_identifier ON mails(identifier_id)");
      }
      // Backfill identifier_id from mails.id if it looks like a ROWID (all digits)
      try {
        this.db.prepare(`
          UPDATE mails
          SET identifier_id = id
          WHERE identifier_id IS NULL
            AND provider = 'apple-mail'
            AND id REGEXP '^[0-9]+$'
        `).run();
      } catch {
        // Regex not supported; try simpler approach with CAST
        try {
          this.db.prepare(`
            UPDATE mails
            SET identifier_id = id
            WHERE identifier_id IS NULL
              AND provider = 'apple-mail'
              AND typeof(id) = 'text'
              AND id NOT LIKE '%-%'
          `).run();
        } catch { /* ignore */ }
      }
    } catch { /* ignore — fresh install gets the columns from SCHEMA */ }
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

  upsertMailbox(id: string, name: string, sourceDbPath?: string, mailProvider = "apple-mail"): void {
    // Extract the UUID from the prefixed ID. For Apple Mail (am_<uuid>), store the UUID in apple_id.
    // For Thunderbird (tb_<serverKey>), leave apple_id null.
    let appleId: string | null = null;
    if (mailProvider === "apple-mail" && id.startsWith("am_")) {
      appleId = id.slice(3); // Extract UUID from "am_<uuid>"
    }

    this.get().prepare(`
      INSERT INTO mailboxes(id, name, source_db_path, apple_id, mail_provider, updated_at)
      VALUES(?,?,?,?,?,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name           = excluded.name,
        source_db_path = COALESCE(excluded.source_db_path, source_db_path),
        mail_provider  = excluded.mail_provider,
        updated_at     = excluded.updated_at
    `).run(id, name, sourceDbPath ?? null, appleId, mailProvider);
  }

  getMailboxes(): Array<{ id: string; name: string; sourceDbPath: string | null; mailProvider: string }> {
    return (this.get().prepare("SELECT id, name, source_db_path, mail_provider FROM mailboxes").all() as any[])
      .map(r => ({ id: r.id, name: r.name, sourceDbPath: r.source_db_path, mailProvider: r.mail_provider }));
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
   * Stores provider and identifier_id for deferred content fetching during indexing.
   * Returns the number of newly inserted rows.
   */
  insertMails(mails: MailInsert[]): number {
    if (!mails.length) return 0;
    const db = this.get();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO mails
        (id, mailbox_id, folder_id, sender, domain, size, subject, indexed, created_at, provider, identifier_id)
      VALUES (?,?,?,?,?,?,?,'todo',?,?,?)
    `);

    let inserted = 0;
    db.exec("BEGIN");
    try {
      for (const m of mails) {
        const provider = m.provider || "apple-mail";
        const identifier_id = m.identifier_id || null;
        const result = stmt.run(
          m.id, m.mailboxId, m.folderId, m.sender, m.domain, m.size, m.subject, m.date,
          provider, identifier_id
        ) as any;
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
    _subjectEntities: NamedEntity[],
    _bodyEntities?: NamedEntity[],
  ): void {
    const db = this.get();
    db.prepare(
      "UPDATE mails SET indexed='complete', updated_at=datetime('now') WHERE id = ?"
    ).run(id);
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
      "UPDATE mails SET indexed='todo', updated_at=datetime('now')"
    ).run();
  }

  // ── Mails — graph index tracking ─────────────────────────────────────────────

  getPendingGraphMails(limit = 50, folderIds?: number[], virtualBoxOnly = false): PendingMail[] {
    const vbClause = virtualBoxOnly ? " AND include_for_index='yes'" : "";
    if (folderIds && folderIds.length) {
      const ph = folderIds.map(() => "?").join(",");
      return this.get().prepare(`
        SELECT id, subject, mailbox_id AS mailboxId, folder_id AS folderId, sender, body_text AS bodyText
        FROM mails
        WHERE graph_indexed = 'todo' AND folder_id IN (${ph})${vbClause}
        ORDER BY created_at ASC
        LIMIT ?
      `).all(...folderIds, limit) as unknown as PendingMail[];
    }
    return this.get().prepare(`
      SELECT id, subject, mailbox_id AS mailboxId, folder_id AS folderId, sender, body_text AS bodyText
      FROM mails
      WHERE graph_indexed = 'todo'${vbClause}
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as unknown as PendingMail[];
  }

  markMailGraphIndexing(id: string): void {
    this.get().prepare(
      "UPDATE mails SET graph_indexed = 'inprogress', updated_at = datetime('now') WHERE id = ?"
    ).run(id);
  }

  markMailGraphComplete(id: string, nodeIds: string[], folderId: number, mailboxId: string): void {
    const db = this.get();
    db.prepare(
      "UPDATE mails SET graph_indexed = 'complete', updated_at = datetime('now') WHERE id = ?"
    ).run(id);
    if (nodeIds.length) {
      const stmt = db.prepare(
        "INSERT OR IGNORE INTO graph_mail_nodes(mail_id, folder_id, mailbox_id, node_id) VALUES(?,?,?,?)"
      );
      db.exec("BEGIN");
      try {
        for (const nid of nodeIds) stmt.run(id, folderId, mailboxId, nid);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  markMailGraphFailed(id: string): void {
    this.get().prepare(
      "UPDATE mails SET graph_indexed = 'todo', updated_at = datetime('now') WHERE id = ?"
    ).run(id);
  }

  upsertGraphNode(id: string, label: string, type: string): void {
    this.get().prepare(`
      INSERT INTO graph_nodes(id, label, type, frequency, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        frequency  = frequency + 1,
        type       = CASE WHEN excluded.type != 'Entity' THEN excluded.type ELSE type END,
        updated_at = datetime('now')
    `).run(id, label, type);
  }

  upsertGraphEdge(id: string, subjectId: string, predicate: string, objectId: string): void {
    this.get().prepare(`
      INSERT INTO graph_edges(id, subject_node_id, predicate, object_node_id, weight, updated_at)
      VALUES (?, ?, ?, ?, 1.0, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        weight     = weight + 1.0,
        updated_at = datetime('now')
    `).run(id, subjectId, predicate, objectId);
  }

  saveMailCategories(entries: Array<{ id: string; category: string }>): void {
    if (!entries.length) return;
    const db = this.get();
    const stmt = db.prepare("UPDATE mails SET category=?, updated_at=datetime('now') WHERE id=?");
    db.exec("BEGIN");
    try {
      for (const e of entries) stmt.run(e.category, e.id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  getEmailsForNode(nodeId: string, limit = 100): Array<{
    mailId: string; subject: string | null; sender: string | null;
    domain: string | null; date: string | null; category: string | null; folderName: string;
  }> {
    return this.get().prepare(`
      SELECT m.id         AS mailId,
             m.subject,
             m.sender,
             m.domain,
             m.created_at AS date,
             m.category,
             f.name       AS folderName
      FROM mails m
      JOIN graph_mail_nodes gmn ON gmn.mail_id = m.id
      JOIN folders f            ON f.id = m.folder_id
      WHERE gmn.node_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(nodeId, limit) as any[];
  }

  getKnowledgeGraphData(limit = 500): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    stats: { totalNodes: number; totalEdges: number; graphIndexed: number; total: number };
    folders: { id: number; name: string }[];
  } {
    const db = this.get();
    const nodes = db.prepare(
      "SELECT id, label, type, frequency FROM graph_nodes ORDER BY frequency DESC LIMIT ?"
    ).all(limit) as unknown as GraphNode[];

    const gStats = this.getGraphIndexStats();
    const totalNodes = (db.prepare("SELECT COUNT(*) AS n FROM graph_nodes").get() as any)?.n ?? 0;
    const totalEdges = (db.prepare("SELECT COUNT(*) AS n FROM graph_edges").get() as any)?.n ?? 0;
    const stats = { totalNodes, totalEdges, graphIndexed: gStats.complete, total: gStats.total };

    if (!nodes.length) return { nodes: [], edges: [], stats, folders: [] };

    // Folders that have graph-indexed mails
    const folders = db.prepare(`
      SELECT DISTINCT f.id, f.name
      FROM graph_mail_nodes gmn
      JOIN folders f ON f.id = gmn.folder_id
      ORDER BY f.name
    `).all() as Array<{ id: number; name: string }>;

    // Node → folder membership (single batched query)
    const nodeIds = nodes.map((n) => n.id);
    const ph = nodeIds.map(() => "?").join(",");
    const nodeFolderRows = db.prepare(
      `SELECT DISTINCT node_id, folder_id FROM graph_mail_nodes WHERE node_id IN (${ph})`
    ).all(...nodeIds) as Array<{ node_id: string; folder_id: number }>;

    const nodeToFolders: Record<string, number[]> = {};
    for (const row of nodeFolderRows) {
      (nodeToFolders[row.node_id] ??= []).push(row.folder_id);
    }
    const nodesWithFolders = nodes.map((n) => ({ ...n, folderIds: nodeToFolders[n.id] ?? [] }));

    const edges = db.prepare(`
      SELECT e.id,
             e.subject_node_id AS subjectNodeId,
             e.predicate,
             e.object_node_id  AS objectNodeId,
             e.weight
      FROM graph_edges e
      WHERE e.subject_node_id IN (SELECT id FROM graph_nodes ORDER BY frequency DESC LIMIT ?)
        AND e.object_node_id  IN (SELECT id FROM graph_nodes ORDER BY frequency DESC LIMIT ?)
    `).all(limit, limit) as unknown as GraphEdge[];

    return { nodes: nodesWithFolders, edges, stats, folders };
  }

  getGraphIndexStats(folderIds?: number[], virtualBoxOnly = false): { total: number; todo: number; inprogress: number; complete: number } {
    const vbClause = virtualBoxOnly ? " AND include_for_index='yes'" : "";
    let row: any;
    if (folderIds && folderIds.length) {
      const ph = folderIds.map(() => "?").join(",");
      row = this.get().prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(graph_indexed = 'todo')       AS todo,
          SUM(graph_indexed = 'inprogress') AS inprogress,
          SUM(graph_indexed = 'complete')   AS complete
        FROM mails WHERE folder_id IN (${ph})${vbClause}
      `).get(...folderIds) as any;
    } else {
      row = this.get().prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(graph_indexed = 'todo')       AS todo,
          SUM(graph_indexed = 'inprogress') AS inprogress,
          SUM(graph_indexed = 'complete')   AS complete
        FROM mails WHERE 1=1${vbClause}
      `).get() as any;
    }
    return {
      total:      row?.total      ?? 0,
      todo:       row?.todo       ?? 0,
      inprogress: row?.inprogress ?? 0,
      complete:   row?.complete   ?? 0,
    };
  }

  resetGraphIndex(): void {
    const db = this.get();
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM graph_mail_nodes");
      db.exec("DELETE FROM graph_edges");
      db.exec("DELETE FROM graph_nodes");
      db.prepare("UPDATE mails SET graph_indexed = 'todo', updated_at = datetime('now')").run();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  resetVectorFlags(): void {
    const db = this.get();
    db.prepare("UPDATE mails SET indexed_meta='no', indexed_body='no', updated_at=datetime('now')").run();
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
    id: number; name: string; mailboxId: string; mailboxName: string; mailProvider: string;
    indexed: FolderIndexStatus; readMode: "metadata" | "content";
    mailCount: number; lastScanned: string | null;
    indexedMetaCount: number; indexedBodyCount: number; graphIndexedCount: number;
  }> {
    return (this.get().prepare(`
      SELECT f.id, f.name, f.indexed, f.read_mode AS readMode, f.mailbox_id AS mailboxId,
             mb.name AS mailboxName, mb.mail_provider AS mailProvider,
             COUNT(m.id) AS mailCount,
             SUM(CASE WHEN m.indexed_meta = 'yes' THEN 1 ELSE 0 END)        AS indexedMetaCount,
             SUM(CASE WHEN m.indexed_body = 'yes' THEN 1 ELSE 0 END)        AS indexedBodyCount,
             SUM(CASE WHEN m.graph_indexed = 'complete' THEN 1 ELSE 0 END)  AS graphIndexedCount,
             (SELECT MAX(sa.completed_at) FROM scan_audit sa
              WHERE sa.folder_id = f.id AND sa.status = 'success') AS lastScanned
      FROM folders f
      JOIN mailboxes mb ON f.mailbox_id = mb.id
      LEFT JOIN mails m ON m.folder_id = f.id
      GROUP BY f.id
      ORDER BY mailCount DESC
    `).all() as any[]).map((r) => ({
      id:                r.id,
      name:              r.name,
      mailboxId:         r.mailboxId,
      mailboxName:       r.mailboxName,
      mailProvider:      r.mailProvider ?? "apple-mail",
      indexed:           r.indexed as FolderIndexStatus,
      readMode:          (r.readMode === "content" ? "content" : "metadata") as "metadata" | "content",
      mailCount:         r.mailCount ?? 0,
      indexedMetaCount:  r.indexedMetaCount ?? 0,
      indexedBodyCount:  r.indexedBodyCount ?? 0,
      graphIndexedCount: r.graphIndexedCount ?? 0,
      lastScanned:       r.lastScanned ?? null,
    }));
  }

  /** Set a folder's AI read mode (by folder ID, which is globally unique). */
  setFolderReadMode(folderId: number | string, mode: "metadata" | "content"): void {
    // Accept both number and string for flexibility (frontend may pass as string from data attribute)
    const id = typeof folderId === "string" ? parseInt(folderId, 10) : folderId;
    this.get().prepare(
      "UPDATE folders SET read_mode = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(mode, id);
  }

  /** Map of folder ID → read mode for the given folder IDs (default metadata). */
  getFolderReadModes(folderIds: (string | number)[]): Record<string, "metadata" | "content"> {
    const out: Record<string, "metadata" | "content"> = {};
    if (!folderIds.length) return out;
    const placeholders = folderIds.map(() => "?").join(",");
    const ids = folderIds.map((id) => (typeof id === "string" ? parseInt(id, 10) : id));
    const rows = this.get().prepare(
      `SELECT id, read_mode FROM folders WHERE id IN (${placeholders})`
    ).all(...ids) as any[];
    for (const r of rows) out[String(r.id)] = r.read_mode === "content" ? "content" : "metadata";
    // Folders with no row yet default to metadata
    for (const id of folderIds) if (!(String(id) in out)) out[String(id)] = "metadata";
    return out;
  }

  /** Map of folder ID → folder name for the given folder IDs. */
  getFolderNames(folderIds: (string | number)[]): Record<string, string> {
    const out: Record<string, string> = {};
    if (!folderIds.length) return out;
    const placeholders = folderIds.map(() => "?").join(",");
    const ids = folderIds.map((id) => (typeof id === "string" ? parseInt(id, 10) : id));
    const rows = this.get().prepare(
      `SELECT id, name FROM folders WHERE id IN (${placeholders})`
    ).all(...ids) as any[];
    for (const r of rows) out[String(r.id)] = r.name;
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
  resetAllData(): { mails: number; folders: number; mailboxes: number } {
    const db = this.get();
    const mailCount     = (db.prepare("SELECT COUNT(*) AS n FROM mails").get()     as any)?.n ?? 0;
    const folderCount   = (db.prepare("SELECT COUNT(*) AS n FROM folders").get()   as any)?.n ?? 0;
    const mailboxCount  = (db.prepare("SELECT COUNT(*) AS n FROM mailboxes").get() as any)?.n ?? 0;

    try {
      // Temporarily disable FK constraints to allow clean deletion
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("BEGIN");

      // Delete in dependency order (doesn't matter with FK off, but clear for intent):
      // 1. Audit logs (reference mailboxes/folders)
      db.exec("DELETE FROM index_audit");
      db.exec("DELETE FROM scan_audit");
      // 2. Graph tables (reference mails/folders/mailboxes)
      db.exec("DELETE FROM graph_mail_nodes");
      db.exec("DELETE FROM graph_edges");
      db.exec("DELETE FROM graph_nodes");
      // 3. Mail data (mails → folders → mailboxes)
      db.exec("DELETE FROM mails");
      db.exec("DELETE FROM folders");
      db.exec("DELETE FROM mailboxes");

      // 3. Clear app/scan state preferences, but KEEP AI configuration
      //    Keeps: ai_key_*, ai_model_*, ai_provider
      //    Clears: active_mail_provider, app_ready, index_*, is_*, categories_seeded, sandbox_ready
      const keysToDelete = [
        "active_mail_provider",
        "app_ready",
        "index_mode",
        "index_ongoing",
        "index_paused",
        "index_paused_folders",
        "is_packages_downloaded",
        "is_permissions_granted",
        "categories_seeded",
        "sandbox_ready",
      ];
      for (const key of keysToDelete) {
        db.prepare("DELETE FROM preferences WHERE key = ?").run(key);
      }

      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      // Re-enable FK constraints
      db.exec("PRAGMA foreign_keys = ON");
    }

    return { mails: mailCount, folders: folderCount, mailboxes: mailboxCount };
  }

  // ── Virtual Box — selective intelligence indexing ────────────────────────────

  isSelectiveIndexingEnabled(): boolean {
    return this.getPreference("selective_indexing_enabled") === "yes";
  }

  enableSelectiveIndexing(): void {
    this.setPreference("selective_indexing_enabled", "yes");
  }

  getInclusionRules(): { domains: string[]; senders: string[]; mailIds: string[] } {
    const parse = (key: string): string[] => {
      try { const v = JSON.parse(this.getPreference(key, "[]") ?? "[]"); return Array.isArray(v) ? v.map(String) : []; }
      catch { return []; }
    };
    return {
      domains: parse("index_inclusion_domains"),
      senders: parse("index_inclusion_senders"),
      mailIds: parse("index_inclusion_mail_ids"),
    };
  }

  addInclusionDomain(domain: string): void {
    const rules = this.getInclusionRules();
    if (!rules.domains.includes(domain)) rules.domains.push(domain);
    this.setPreference("index_inclusion_domains", JSON.stringify(rules.domains));
    this.get().prepare("UPDATE mails SET include_for_index='yes' WHERE LOWER(domain)=LOWER(?)").run(domain);
    this.enableSelectiveIndexing();
  }

  removeInclusionDomain(domain: string): void {
    const rules = this.getInclusionRules();
    rules.domains = rules.domains.filter((d) => d !== domain);
    this.setPreference("index_inclusion_domains", JSON.stringify(rules.domains));
    this.syncInclusionFlags();
  }

  addInclusionSender(sender: string): void {
    const rules = this.getInclusionRules();
    if (!rules.senders.includes(sender)) rules.senders.push(sender);
    this.setPreference("index_inclusion_senders", JSON.stringify(rules.senders));
    this.get().prepare("UPDATE mails SET include_for_index='yes' WHERE LOWER(sender)=LOWER(?)").run(sender);
    this.enableSelectiveIndexing();
  }

  removeInclusionSender(sender: string): void {
    const rules = this.getInclusionRules();
    rules.senders = rules.senders.filter((s) => s !== sender);
    this.setPreference("index_inclusion_senders", JSON.stringify(rules.senders));
    this.syncInclusionFlags();
  }

  addInclusionMails(mailIds: string[]): void {
    if (!mailIds.length) return;
    const rules = this.getInclusionRules();
    const existing = new Set(rules.mailIds);
    for (const id of mailIds) existing.add(id);
    rules.mailIds = [...existing];
    this.setPreference("index_inclusion_mail_ids", JSON.stringify(rules.mailIds));
    const ph = mailIds.map(() => "?").join(",");
    this.get().prepare(`UPDATE mails SET include_for_index='yes' WHERE id IN (${ph})`).run(...mailIds);
    this.enableSelectiveIndexing();
  }

  removeInclusionMails(mailIds: string[]): void {
    if (!mailIds.length) return;
    const rules = this.getInclusionRules();
    const removeSet = new Set(mailIds);
    rules.mailIds = rules.mailIds.filter((id) => !removeSet.has(id));
    this.setPreference("index_inclusion_mail_ids", JSON.stringify(rules.mailIds));
    const ph = mailIds.map(() => "?").join(",");
    this.get().prepare(`UPDATE mails SET include_for_index='no' WHERE id IN (${ph})`).run(...mailIds);
    // Re-apply domain/sender rules in case any removed mail still matches a rule
    this.syncInclusionFlags();
  }

  syncInclusionFlags(): void {
    const db = this.get();
    const rules = this.getInclusionRules();
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE mails SET include_for_index='no'").run();
      for (const d of rules.domains)  db.prepare("UPDATE mails SET include_for_index='yes' WHERE LOWER(domain)=LOWER(?)").run(d);
      for (const s of rules.senders)  db.prepare("UPDATE mails SET include_for_index='yes' WHERE LOWER(sender)=LOWER(?)").run(s);
      if (rules.mailIds.length) {
        const ph = rules.mailIds.map(() => "?").join(",");
        db.prepare(`UPDATE mails SET include_for_index='yes' WHERE id IN (${ph})`).run(...rules.mailIds);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  getVirtualBoxMailsForIndexing(limit = 10000): Array<Record<string, unknown>> {
    return this.get().prepare(`
      SELECT m.id,
             m.subject,
             m.sender        AS sender_email,
             m.domain,
             m.size,
             m.created_at   AS date,
             m.indexed_meta,
             f.name         AS folder
      FROM mails m
      JOIN folders f ON f.id = m.folder_id
      WHERE m.include_for_index = 'yes'
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(limit) as any[];
  }

  getVirtualBoxMails(limit = 20000): Array<{
    id: string; subject: string; sender: string; domain: string;
    size: number; created_at: string;
    indexed_meta: string; indexed_body: string; graph_indexed: string;
    folder_id: number; body_text: string | null;
  }> {
    return this.get().prepare(`
      SELECT id, subject, sender, domain, size, created_at,
             indexed_meta, indexed_body, graph_indexed, folder_id, body_text
      FROM mails
      WHERE include_for_index = 'yes'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as any[];
  }

  getIndexRunHistory(limit = 30): Array<{
    id: number; status: string;
    indexed_count: number; failed_count: number;
    error: string | null; started_at: string; completed_at: string | null; folders: string | null;
  }> {
    try {
      return this.get().prepare(
        "SELECT id, status, indexed_count, failed_count, error, started_at, completed_at, folders FROM index_audit ORDER BY id DESC LIMIT ?"
      ).all(limit) as any[];
    } catch { return []; }
  }

  saveBodyTexts(records: Array<{ id: string; body_text: string }>): void {
    const db   = this.get();
    const stmt = db.prepare("UPDATE mails SET body_text = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const r of records) {
        if (r.body_text) stmt.run(r.body_text, r.id);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  getVirtualBoxStats(): { total: number; vectorDone: number; graphDone: number } {
    const row = this.get().prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN indexed_meta='yes' THEN 1 ELSE 0 END) AS vectorDone,
             SUM(CASE WHEN graph_indexed='complete' THEN 1 ELSE 0 END) AS graphDone
      FROM mails WHERE include_for_index='yes'
    `).get() as any;
    return { total: row?.total ?? 0, vectorDone: row?.vectorDone ?? 0, graphDone: row?.graphDone ?? 0 };
  }

  setAllFoldersContentMode(): void {
    this.get().prepare("UPDATE folders SET read_mode = 'content'").run();
  }

  clearAllInclusions(): void {
    const db = this.get();
    db.prepare("UPDATE mails SET include_for_index='no'").run();
    for (const key of ["index_inclusion_domains", "index_inclusion_senders", "index_inclusion_mail_ids", "selective_indexing_enabled"]) {
      db.prepare("DELETE FROM preferences WHERE key=?").run(key);
    }
  }

  /**
   * Get nodes (typed entities) for a list of mail IDs.
   * Reverse of getEmailsForNode: for each mail, return all nodes linked to it.
   */
  getNodesForMails(mailIds: string[]): Array<{
    mailId: string;
    label: string;
    type: "ORG" | "PERSON" | "PRODUCT" | "TOPIC" | "PLACE" | "EVENT" | "DATE" | "AMOUNT";
  }> {
    if (!mailIds.length) return [];
    const db = this.get();
    const ph = mailIds.map(() => "?").join(",");
    return (
      db.prepare(`
        SELECT gmn.mail_id AS mailId, gn.label, gn.type
        FROM graph_mail_nodes gmn
        JOIN graph_nodes gn ON gn.id = gmn.node_id
        WHERE gmn.mail_id IN (${ph})
        ORDER BY gmn.mail_id, gn.frequency DESC
      `).all(...mailIds) as any[]
    ).map((r) => ({
      mailId: String(r.mailId),
      label: String(r.label),
      type: r.type as any,
    }));
  }

  /**
   * Get email bodies by mail IDs.
   */
  getBodiesByIds(mailIds: string[]): Array<{ id: string; body_text: string | null }> {
    if (!mailIds.length) return [];
    const db = this.get();
    const ph = mailIds.map(() => "?").join(",");
    return (
      db.prepare(`
        SELECT id, body_text
        FROM mails
        WHERE id IN (${ph})
      `).all(...mailIds) as any[]
    ).map((r) => ({
      id: String(r.id),
      body_text: r.body_text ? String(r.body_text) : null,
    }));
  }

  /**
   * Get per-type node statistics for the graph schema block.
   * Returns counts + example labels per entity type.
   */
  getGraphTypeProfile(): Record<
    string,
    { count: number; examples: string[] }
  > {
    const db = this.get();
    const types = ["ORG", "PERSON", "PRODUCT", "TOPIC", "PLACE", "EVENT", "DATE", "AMOUNT"];
    const result: Record<string, { count: number; examples: string[] }> = {};

    for (const type of types) {
      const countRow = db.prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE type = ?").get(type) as any;
      const count = countRow?.n ?? 0;

      let examples: string[] = [];
      if (count > 0) {
        const exampleRows = db.prepare(`
          SELECT label FROM graph_nodes WHERE type = ? ORDER BY frequency DESC LIMIT 5
        `).all(type) as Array<{ label: string }>;
        examples = exampleRows.map((r) => r.label);
      }

      result[type] = { count, examples };
    }

    return result;
  }

  // ── Provider & Identifier Tracking (Phase 2: Multi-provider content fetching) ──

  /**
   * Get provider and identifier_id for a single mail.
   * Returns null if mail not found.
   */
  getMailProviderInfo(mailId: string): { provider: string; identifier_id: string | null } | null {
    const row = this.get().prepare(
      "SELECT provider, identifier_id FROM mails WHERE id = ?"
    ).get(mailId) as any;
    if (!row) return null;
    return {
      provider: row.provider || "apple-mail",
      identifier_id: row.identifier_id || null,
    };
  }

  /**
   * Get provider and identifier_id for multiple mails.
   * Returns a map of mailId → {provider, identifier_id}.
   */
  getMailsProviderInfo(mailIds: string[]): Record<string, { provider: string; identifier_id: string | null }> {
    if (!mailIds.length) return {};
    const db = this.get();
    const ph = mailIds.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT id, provider, identifier_id FROM mails WHERE id IN (${ph})
    `).all(...mailIds) as any[];

    const result: Record<string, { provider: string; identifier_id: string | null }> = {};
    for (const row of rows) {
      result[row.id] = {
        provider: row.provider || "apple-mail",
        identifier_id: row.identifier_id || null,
      };
    }
    return result;
  }

  /**
   * Update provider and identifier_id for a mail.
   * Used after scanning to store the provider-native ID for deferred content fetching.
   */
  setMailProviderInfo(mailId: string, provider: string, identifier_id: string | null): void {
    this.get().prepare(
      "UPDATE mails SET provider = ?, identifier_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(provider, identifier_id, mailId);
  }

  /**
   * Bulk update provider and identifier_id for multiple mails.
   * Each entry is {mailId, provider, identifier_id}.
   */
  setMailsProviderInfo(entries: Array<{ mailId: string; provider: string; identifier_id: string | null }>): void {
    if (!entries.length) return;
    const db = this.get();
    const stmt = db.prepare(
      "UPDATE mails SET provider = ?, identifier_id = ?, updated_at = datetime('now') WHERE id = ?"
    );
    db.exec("BEGIN");
    try {
      for (const e of entries) {
        stmt.run(e.provider, e.identifier_id, e.mailId);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

}

export const inboxPieDb = new InboxPieDB();
