import * as lancedb from "@lancedb/lancedb";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_NAME, EMBEDDING_DIM } from "../agent/embeddings";

const LANCE_DIR  = path.join(os.homedir(), ".inboxpie", "lancedb");
const TABLE_NAME = "emails";

export interface LanceEmailRecord {
  id:           string;
  vector:       number[];
  subject:      string;
  sender_email: string;
  sender_name:  string;
  domain:       string;
  folder:       string;
  folder_type:  string;
  date_unix:    number;
  year:         number;
  is_read:      number;   // 0 | 1
  size:         number;
  text_indexed: string;
}

export interface SearchResult {
  id:           string;
  subject:      string;
  sender_email: string;
  sender_name:  string;
  domain:       string;
  folder:       string;
  folder_type:  string;
  date_unix:    number;
  year:         number;
  is_read:      number;
  size:         number;
  text_indexed: string;
  score:        number;  // cosine similarity 0..1
}

export interface SearchOptions {
  folder?:      string;
  folderType?:  string;
  domain?:      string;   // exact domain match, e.g. "ppfas.com"
  senderEmail?: string;   // exact sender email match
  limit?:       number;
  yearFrom?:    number;
  yearTo?:      number;
  queryText?:   string;   // raw query — enables hybrid (vector + BM25 full-text) + RRF rerank
}

export interface LanceStats {
  total:   number;
  folders: string[];
  domains: number;
  years:   number[];
}

class LanceStore {
  private db:    lancedb.Connection | null = null;
  private table: lancedb.Table      | null = null;

  /** Path to a small file that records which embedding model built this index. */
  private get _stampPath(): string {
    return path.join(LANCE_DIR, ".embedding-model");
  }

  /** Read the model stamp that was used to build the current LanceDB index. */
  private _readStamp(): string {
    try { return fs.readFileSync(this._stampPath, "utf8").trim(); } catch { return ""; }
  }

  /** Write the current model name so we can detect model changes on next startup. */
  private _writeStamp(): void {
    try { fs.writeFileSync(this._stampPath, MODEL_NAME, "utf8"); } catch { /* ignore */ }
  }

  async open(): Promise<void> {
    if (this.db) return;
    fs.mkdirSync(LANCE_DIR, { recursive: true });
    this.db = await lancedb.connect(LANCE_DIR);
    const names = await this.db.tableNames();

    if (names.includes(TABLE_NAME)) {
      // ── Dimension-mismatch guard ────────────────────────────────────────────
      // If the index was built with a different embedding model the vector column
      // dimension won't match the current EMBEDDING_DIM. Drop and recreate the
      // table so the next indexing run rebuilds it with the correct schema.
      //
      // Two-layer check:
      //   1. Stamp file: model name stored at index-creation time → fast path.
      //   2. Live dim sample: catches databases created before the stamp feature,
      //      or cases where the stamp file was lost (e.g. manual deletion).
      const stamp = this._readStamp();
      let needsDrop = false;

      if (stamp && stamp !== MODEL_NAME) {
        console.log(
          `[lanceStore] Embedding model changed (${stamp} → ${MODEL_NAME}). ` +
          `Dropping stale index — please re-index your folders.`,
        );
        needsDrop = true;
      } else if (!stamp) {
        // No stamp: sample one row and compare vector length against expected dim.
        try {
          const tbl = await this.db.openTable(TABLE_NAME);
          const sample = await (tbl as any).query().limit(1).toArray() as Record<string, unknown>[];
          if (sample.length > 0) {
            const vec = sample[0]?.["vector"] as number[] | undefined;
            const storedDim = Array.isArray(vec) ? vec.length : 0;
            if (storedDim > 0 && storedDim !== EMBEDDING_DIM) {
              console.log(
                `[lanceStore] Vector dim mismatch: stored=${storedDim}, expected=${EMBEDDING_DIM}. ` +
                `Dropping stale index — please re-index your folders.`,
              );
              needsDrop = true;
            } else {
              // Dim matches (or table is empty) — write stamp to baseline future checks.
              this._writeStamp();
            }
          } else {
            this._writeStamp();
          }
        } catch {
          // Can't open or sample — proceed normally; worst case is a search error later.
        }
      }

      if (needsDrop) {
        await this.db.dropTable(TABLE_NAME);
        fs.rmSync(this._stampPath, { force: true });
        this.table = null;
        return;
      }
      this.table = await this.db.openTable(TABLE_NAME);
    }
  }

  private async ensureDb(): Promise<lancedb.Connection> {
    await this.open();
    return this.db!;
  }

  async upsertBatch(records: LanceEmailRecord[]): Promise<void> {
    if (!records.length) return;
    const db = await this.ensureDb();
    const rows = records as unknown as Record<string, unknown>[];
    if (!this.table) {
      this.table = await db.createTable(TABLE_NAME, rows);
      // Stamp the model so we can detect future model upgrades.
      this._writeStamp();
    } else {
      await this.table.add(rows);
    }
    this._hasBodyCache = null; // newly added rows may contain body content
    this._profileCache = null;
    this._ftsReady     = false; // new rows aren't in the FTS index until rebuilt
  }

  // ── Hybrid search support: BM25 full-text index + RRF reranker ───────────────
  private _ftsReady = false;
  private _reranker: any = null;

  /** Ensure a full-text (BM25) index exists on text_indexed. Rebuilt after new rows. */
  async ensureFtsIndex(): Promise<void> {
    if (this._ftsReady || !this.table) return;
    // replace:true rebuilds so newly-added rows are covered by the index.
    await (this.table as any).createIndex("text_indexed", {
      config: lancedb.Index.fts(),
      replace: true,
    });
    this._ftsReady = true;
  }

  private async getReranker(): Promise<any> {
    if (!this._reranker) {
      this._reranker = await (lancedb as any).rerankers.RRFReranker.create();
    }
    return this._reranker;
  }

  async search(queryVec: number[], opts: SearchOptions = {}): Promise<SearchResult[]> {
    await this.open();
    if (!this.table) {
      console.warn("[lanceStore] search: table not open, returning empty");
      return [];
    }

    const limit = opts.limit ?? 25;
    const esc = (s: string) => s.replace(/'/g, "''");
    const filters: string[] = [];
    // Case-insensitive on folder/domain/sender — folder names vary in case across mail
    // sources ("Inbox" stored vs "INBOX" requested), which silently returned 0 results.
    if (opts.folder)      filters.push(`LOWER(folder) = LOWER('${esc(opts.folder)}')`);
    if (opts.folderType)  filters.push(`LOWER(folder_type) = LOWER('${esc(opts.folderType)}')`);
    if (opts.domain)      filters.push(`LOWER(domain) = LOWER('${esc(opts.domain)}')`);
    if (opts.senderEmail) filters.push(`LOWER(sender_email) = LOWER('${esc(opts.senderEmail)}')`);
    if (opts.yearFrom)    filters.push(`year >= ${opts.yearFrom}`);
    if (opts.yearTo)      filters.push(`year <= ${opts.yearTo}`);

    console.log(
      `[lanceStore] search → limit=${limit} filters=[${filters.join(", ") || "none"}]` +
      ` vecDim=${queryVec.length} vecSample=[${queryVec.slice(0, 4).map(v => v.toFixed(4)).join(", ")}…]`,
    );

    try {
      const useHybrid = !!(opts.queryText && opts.queryText.trim());
      let q = (this.table as any).query().nearestTo(queryVec).distanceType("cosine");

      // HYBRID: combine vector similarity with BM25 full-text over the body, fused by RRF.
      // Full-text searches the COMPLETE text_indexed (untruncated), so it catches terms the
      // vector misses (long bodies / keyword matches like "mutual fund", amounts, fund names).
      if (useHybrid) {
        try {
          await this.ensureFtsIndex();
          const reranker = await this.getReranker();
          q = q.fullTextSearch(opts.queryText!.trim()).rerank(reranker);
        } catch (e) {
          console.warn("[lanceStore] hybrid unavailable, vector-only:", (e as Error).message);
        }
      }
      if (filters.length) q = q.where(filters.join(" AND "));
      q = q.limit(limit);
      const rows: Record<string, unknown>[] = await q.toArray();

      console.log(`[lanceStore] search (${useHybrid ? "hybrid" : "vector"}) returned ${rows.length} row(s)`);
      if (rows.length > 0) {
        const top3 = rows.slice(0, 3).map(r =>
          `"${String(r["subject"] ?? "").slice(0, 50)}" dist=${Number(r["_distance"] ?? -1).toFixed(4)}`
        );
        console.log(`[lanceStore] top results:\n  ${top3.join("\n  ")}`);
      }

      return rows.map((r) => ({
        id:           String(r["id"]           ?? ""),
        subject:      String(r["subject"]      ?? ""),
        sender_email: String(r["sender_email"] ?? ""),
        sender_name:  String(r["sender_name"]  ?? ""),
        domain:       String(r["domain"]       ?? ""),
        folder:       String(r["folder"]       ?? ""),
        folder_type:  String(r["folder_type"]  ?? ""),
        date_unix:    Number(r["date_unix"]    ?? 0),
        year:         Number(r["year"]         ?? 0),
        is_read:      Number(r["is_read"]      ?? 0),
        size:         Number(r["size"]         ?? 0),
        text_indexed: String(r["text_indexed"] ?? ""),
        score:        Math.max(0, 1 - Number(r["_distance"] ?? 1)),
      }));
    } catch (e) {
      console.error("[lanceStore] search error:", e);
      return [];
    }
  }

  async indexedIds(): Promise<Set<string>> {
    await this.open();
    if (!this.table) return new Set();
    try {
      const rows = await (this.table as any).query().select(["id"]).toArray();
      return new Set((rows as Record<string, unknown>[]).map((r) => String(r["id"])));
    } catch {
      return new Set();
    }
  }

  /**
   * True when the index actually contains email body text (Full Content mode).
   * buildText() appends the body after a blank line, so a "\n\n" separator in
   * text_indexed means that record carries body content. Cached after first check.
   */
  private _hasBodyCache: boolean | null = null;
  async hasBodyContent(): Promise<boolean> {
    if (this._hasBodyCache !== null) return this._hasBodyCache;
    await this.open();
    if (!this.table) return false;
    try {
      const rows = await (this.table as any)
        .query()
        .select(["text_indexed"])
        .toArray() as Record<string, unknown>[];
      const found = rows.some((r) => String(r["text_indexed"] ?? "").includes("\n\n"));
      this._hasBodyCache = found;
      return found;
    } catch {
      return false;
    }
  }

  /** Invalidate the body-content cache (call after (re)indexing). */
  invalidateBodyCache(): void { this._hasBodyCache = null; this._profileCache = null; }

  /**
   * Compact factual profile of what's actually in the index — top sender domains,
   * folders, and the year range. Injected into the agent prompt so it picks REAL
   * domain/folder filters instead of guessing (e.g. it sees camsonline.com exists
   * for mutual funds rather than inventing icicibank.com). Cached; invalidated on writes.
   */
  private _profileCache: { total: number; years: number[]; folders: Array<{ folder: string; count: number }>; domains: Array<{ domain: string; count: number }> } | null = null;
  async getIndexProfile(topDomains = 30): Promise<NonNullable<typeof this._profileCache>> {
    if (this._profileCache) return this._profileCache;
    await this.open();
    if (!this.table) return { total: 0, years: [], folders: [], domains: [] };
    try {
      const rows = await (this.table as any)
        .query().select(["folder", "domain", "year"]).toArray() as Record<string, unknown>[];
      const fMap = new Map<string, number>();
      const dMap = new Map<string, number>();
      const yearSet = new Set<number>();
      for (const r of rows) {
        const f = String(r["folder"] ?? "");
        const d = String(r["domain"] ?? "").toLowerCase();
        const y = Number(r["year"]);
        if (f) fMap.set(f, (fMap.get(f) ?? 0) + 1);
        if (d && d !== "unknown") dMap.set(d, (dMap.get(d) ?? 0) + 1);
        if (y) yearSet.add(y);
      }
      const sortDesc = (m: Map<string, number>) =>
        [...m.entries()].sort((a, b) => b[1] - a[1]);
      this._profileCache = {
        total: rows.length,
        years: [...yearSet].sort((a, b) => b - a),
        folders: sortDesc(fMap).map(([folder, count]) => ({ folder, count })),
        domains: sortDesc(dMap).slice(0, topDomains).map(([domain, count]) => ({ domain, count })),
      };
      return this._profileCache;
    } catch {
      return { total: 0, years: [], folders: [], domains: [] };
    }
  }

  async getStats(): Promise<LanceStats> {
    await this.open();
    if (!this.table) return { total: 0, folders: [], domains: 0, years: [] };
    try {
      const rows = await (this.table as any).query().select(["folder", "domain", "year"]).toArray() as Record<string, unknown>[];
      const folders = [...new Set(rows.map((r) => String(r["folder"])))];
      const domains = new Set(rows.map((r) => String(r["domain"]))).size;
      const years   = [...new Set(rows.map((r) => Number(r["year"])))].sort((a, b) => b - a);
      return { total: rows.length, folders, domains, years };
    } catch {
      return { total: 0, folders: [], domains: 0, years: [] };
    }
  }

  async getFolderStats(): Promise<Array<{ folder: string; count: number }>> {
    await this.open();
    if (!this.table) return [];
    try {
      const rows = await (this.table as any).query().select(["folder"]).toArray() as Record<string, unknown>[];
      const map  = new Map<string, number>();
      for (const r of rows) {
        const f = String(r["folder"]);
        map.set(f, (map.get(f) ?? 0) + 1);
      }
      return [...map.entries()]
        .map(([folder, count]) => ({ folder, count }))
        .sort((a, b) => b.count - a.count);
    } catch {
      return [];
    }
  }

  /**
   * Per-folder index breakdown straight from LanceDB (the search source of truth).
   * `count` = vectors in that folder, `bodyCount` = those that include body text
   * (Full Content mode — detected via the "\n\n" separator in text_indexed).
   * Use this instead of the SQLite mirror, whose ids don't match across scan modes.
   */
  async getFolderBreakdown(): Promise<Array<{ folder: string; count: number; bodyCount: number }>> {
    await this.open();
    if (!this.table) return [];
    try {
      const rows = await (this.table as any)
        .query().select(["folder", "text_indexed"]).toArray() as Record<string, unknown>[];
      const map = new Map<string, { count: number; bodyCount: number }>();
      for (const r of rows) {
        const f = String(r["folder"] ?? "");
        const e = map.get(f) ?? { count: 0, bodyCount: 0 };
        e.count++;
        if (String(r["text_indexed"] ?? "").includes("\n\n")) e.bodyCount++;
        map.set(f, e);
      }
      return [...map.entries()].map(([folder, v]) => ({ folder, count: v.count, bodyCount: v.bodyCount }));
    } catch {
      return [];
    }
  }

  async getAllRows(): Promise<Array<{
    subject: string; domain: string; folder: string; sender_email: string;
    sender_name: string; date_unix: number; size: number; is_read: number;
  }>> {
    await this.open();
    if (!this.table) return [];
    try {
      const rows = await (this.table as any).query()
        .select(["subject", "domain", "folder", "sender_email", "sender_name", "date_unix", "size", "is_read"])
        .toArray() as Record<string, unknown>[];
      return rows.map((r) => ({
        subject:      String(r["subject"]      ?? ""),
        domain:       String(r["domain"]       ?? ""),
        folder:       String(r["folder"]       ?? ""),
        sender_email: String(r["sender_email"] ?? ""),
        sender_name:  String(r["sender_name"]  ?? ""),
        date_unix:    Number(r["date_unix"]    ?? 0),
        size:         Number(r["size"]         ?? 0),
        is_read:      Number(r["is_read"]      ?? 0),
      }));
    } catch {
      return [];
    }
  }

  async topSenders(opts: { limit?: number; yearFrom?: number; yearTo?: number } = {}): Promise<Array<{
    sender_name: string; sender_email: string; domain: string;
    email_count: number; unread_count: number; last_seen_unix: number; total_bytes: number;
  }>> {
    await this.open();
    if (!this.table) return [];
    try {
      const filters: string[] = [];
      if (opts.yearFrom) filters.push(`year >= ${opts.yearFrom}`);
      if (opts.yearTo)   filters.push(`year <= ${opts.yearTo}`);

      let q = (this.table as any).query().select(["sender_email", "sender_name", "domain", "date_unix", "is_read", "size"]);
      if (filters.length) q = q.where(filters.join(" AND "));
      const rows: Record<string, unknown>[] = await q.toArray();

      const map = new Map<string, { name: string; domain: string; count: number; unread: number; last: number; bytes: number }>();
      for (const r of rows) {
        const email = String(r["sender_email"] ?? "");
        const entry = map.get(email);
        if (entry) {
          entry.count++;
          if (!r["is_read"]) entry.unread++;
          const t = Number(r["date_unix"]);
          if (t > entry.last) entry.last = t;
          entry.bytes += Number(r["size"]) || 0;
        } else {
          map.set(email, {
            name:   String(r["sender_name"] ?? ""),
            domain: String(r["domain"]      ?? ""),
            count:  1,
            unread: r["is_read"] ? 0 : 1,
            last:   Number(r["date_unix"] ?? 0),
            bytes:  Number(r["size"]      ?? 0),
          });
        }
      }
      return [...map.entries()]
        .map(([email, v]) => ({
          sender_email:  email,
          sender_name:   v.name,
          domain:        v.domain,
          email_count:   v.count,
          unread_count:  v.unread,
          last_seen_unix: v.last,
          total_bytes:   v.bytes,
        }))
        .sort((a, b) => b.email_count - a.email_count)
        .slice(0, opts.limit ?? 20);
    } catch {
      return [];
    }
  }

  async topDomains(opts: { limit?: number; yearFrom?: number; yearTo?: number } = {}): Promise<Array<{
    domain: string; email_count: number; sender_count: number; unread_count: number; total_bytes: number;
  }>> {
    await this.open();
    if (!this.table) return [];
    try {
      const filters: string[] = [];
      if (opts.yearFrom) filters.push(`year >= ${opts.yearFrom}`);
      if (opts.yearTo)   filters.push(`year <= ${opts.yearTo}`);

      let q = (this.table as any).query().select(["domain", "sender_email", "is_read", "size"]);
      if (filters.length) q = q.where(filters.join(" AND "));
      const rows: Record<string, unknown>[] = await q.toArray();

      const map = new Map<string, { senders: Set<string>; count: number; unread: number; bytes: number }>();
      for (const r of rows) {
        const domain = String(r["domain"] ?? "");
        if (!domain || domain === "null") continue;
        const entry = map.get(domain);
        if (entry) {
          entry.senders.add(String(r["sender_email"] ?? ""));
          entry.count++;
          if (!r["is_read"]) entry.unread++;
          entry.bytes += Number(r["size"]) || 0;
        } else {
          map.set(domain, {
            senders: new Set([String(r["sender_email"] ?? "")]),
            count:   1,
            unread:  r["is_read"] ? 0 : 1,
            bytes:   Number(r["size"] ?? 0),
          });
        }
      }
      return [...map.entries()]
        .map(([domain, v]) => ({
          domain,
          email_count:  v.count,
          sender_count: v.senders.size,
          unread_count: v.unread,
          total_bytes:  v.bytes,
        }))
        .sort((a, b) => b.email_count - a.email_count)
        .slice(0, opts.limit ?? 20);
    } catch {
      return [];
    }
  }

  /** Delete all vectors whose folder matches one of the given folder names. */
  async deleteByFolders(folders: string[]): Promise<number> {
    if (!folders.length || !this.table) return 0;
    try {
      const escaped = folders.map((f) => `'${f.replace(/'/g, "''")}'`).join(", ");
      const before = await (this.table as any).countRows();
      await (this.table as any).delete(`folder IN (${escaped})`);
      const after = await (this.table as any).countRows();
      this._hasBodyCache = null;
      this._profileCache = null;
      this._ftsReady     = false;
      // Compact: physically remove tombstoned files so indexedIds() and
      // disk usage reflect reality immediately after the wipe.
      try { await (this.table as any).cleanupOldVersions(); } catch { /* non-fatal */ }
      return before - after;
    } catch {
      return 0;
    }
  }

  async reset(): Promise<void> {
    const db = await this.ensureDb();
    try { await db.dropTable(TABLE_NAME); } catch { /* already gone */ }
    this.table = null;
    this._hasBodyCache = null;
    this._profileCache = null;
    this._ftsReady     = false;
  }
}

export const lanceStore = new LanceStore();
