import { ipcMain, shell, safeStorage, app, type BrowserWindow } from "electron";
import fs   from "node:fs";
import path from "node:path";

import type { ProgressEvent, RpcAction } from "../../../shared/message-record";
import { checkOllama, runAgentQuery, checkCloudProvider } from "../agent/nlp-agent";
import { checkEmbeddingModel }        from "../agent/embeddings";
import { buildVectorIndex }           from "../agent/indexer";
import { lanceStore }                 from "../db/lance-store";
import { renderWidget }               from "../agent/widget-renderer";
import { enrichmentDb }               from "../db/enrichment";
import { inboxPieDb }                 from "../db/inboxpie-db";
import { mailProviders }              from "../mail";
import { debugAccountResolution, fetchMessagesForFolders, killActiveScans } from "../mail/apple-mail";

// ── Semantic cluster definitions ───────────────────────────────────────────────

const CLUSTERS: Array<{ label: string; icon: string; keywords: string[] }> = [
  { label: "Finance",      icon: "💰", keywords: ["payment","invoice","bill","bank","credit","debit","statement","transaction","balance","money","fund","investment","loan","tax","emi","nps","mutual"] },
  { label: "Shopping",     icon: "🛍️", keywords: ["order","purchase","delivery","shipping","amazon","cart","shop","buy","receipt","product","item","refund","return","track"] },
  { label: "Travel",       icon: "✈️", keywords: ["flight","hotel","booking","ticket","reservation","travel","trip","journey","airline","airport","itinerary","visa"] },
  { label: "Work",         icon: "💼", keywords: ["meeting","project","deadline","team","report","schedule","task","office","manager","sprint","standup","review","jira","slack"] },
  { label: "Newsletters",  icon: "📰", keywords: ["newsletter","unsubscribe","weekly","digest","subscribe","edition","substack","mailchimp","campaign","edition"] },
  { label: "Social",       icon: "👥", keywords: ["friend","follow","comment","like","mention","invite","connect","profile","network","notification","twitter","linkedin","facebook"] },
  { label: "Tech",         icon: "⚙️", keywords: ["update","release","version","feature","bug","security","software","app","github","deploy","patch","vulnerability","upgrade"] },
  { label: "Healthcare",   icon: "🏥", keywords: ["appointment","prescription","doctor","health","medical","clinic","hospital","insurance","lab","test","report","consultation"] },
  { label: "Food",         icon: "🍔", keywords: ["restaurant","food","delivery","menu","zomato","swiggy","meal","doordash","order","cuisine","dining"] },
  { label: "Utilities",    icon: "⚡", keywords: ["electricity","water","gas","internet","phone","broadband","utility","provider","bill","recharge","dth","telecom"] },
  { label: "Real Estate",  icon: "🏠", keywords: ["property","rent","lease","apartment","house","mortgage","tenant","landlord","flat","listing","pg","hostel"] },
  { label: "Other",        icon: "📨", keywords: [] },
];

type Cluster = { label: string; icon: string; keywords: string[] };

/** The built-in defaults seeded into the categories table (everything except "Other"). */
const DEFAULT_CATEGORIES = CLUSTERS.slice(0, -1).map((c) => ({ name: c.label, icon: c.icon, keywords: c.keywords }));

/**
 * Build the active cluster list from the categories table: USER categories first (they take
 * precedence in classification), then the (editable) built-ins, then "Other" last.
 * Falls back to the code defaults if the table is somehow empty.
 */
function buildClusters(): Cluster[] {
  let cats: Cluster[] = [];
  try {
    const all     = inboxPieDb.getCategories().filter((c) => c.name && c.keywords.length);
    const user    = all.filter((c) => !c.builtin);
    const builtin = all.filter((c) =>  c.builtin);
    cats = [...user, ...builtin].map((c) => ({ label: c.name, icon: c.icon, keywords: c.keywords.map((k) => k.toLowerCase()) }));
  } catch { /* categories optional */ }
  if (!cats.length) return CLUSTERS.slice();        // not seeded yet → code defaults
  return [...cats, CLUSTERS[CLUSTERS.length - 1]!]; // append "Other"
}

function classifyEmail(text: string, clusters: Cluster[]): number {
  const lower = text.toLowerCase();
  for (let i = 0; i < clusters.length - 1; i++) {
    if (clusters[i]!.keywords.some((kw) => lower.includes(kw))) return i;
  }
  return clusters.length - 1; // "Other"
}

// ── API key encryption (safeStorage — main-process only) ──────────────────────

function encryptKey(raw: string): string {
  if (!safeStorage.isEncryptionAvailable()) return Buffer.from(raw).toString("base64");
  return safeStorage.encryptString(raw).toString("base64");
}

function decryptKey(enc: string): string {
  if (!safeStorage.isEncryptionAvailable()) return Buffer.from(enc, "base64").toString("utf8");
  return safeStorage.decryptString(Buffer.from(enc, "base64"));
}

function maskKey(raw: string): string {
  if (raw.length <= 8) return "••••••••";
  return raw.slice(0, 4) + "••••••••" + raw.slice(-4);
}

// ── Index log writer ───────────────────────────────────────────────────────────

interface IndexLogEntry {
  mode: "metadata" | "content";
  mailboxId: string | null;
  folders: string[];
  total: number;
  indexed: number;
  errors: number;
  durationMs: number;
  error?: string;
}

function writeIndexLog(entry: IndexLogEntry): void {
  try {
    const logsDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = path.join(logsDir, `index-${ts}.json`);
    const payload = {
      timestamp: new Date().toISOString(),
      ...entry,
      skipped: entry.total - entry.indexed - entry.errors,
    };
    fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf-8");
    console.log(`[index-log] Written to ${logPath}`);
  } catch (e) {
    console.warn("[index-log] Failed to write log:", (e as Error).message);
  }
}

/**
 * Index a set of folders honouring each folder's own read_mode (folder-level modes).
 * Folders resolve to metadata or content from the `folders` table; metadata folders
 * are embedded from envelope data, content folders are re-fetched via .emlx for body text.
 * Keeping each folder single-mode also avoids the envelope-id vs emlx-id duplicate trap.
 *
 *   incremental=false → wipe the folders' existing vectors first, then rebuild
 *   incremental=true  → keep existing vectors; buildVectorIndex skips already-indexed ids
 *
 * `metaMessages` (optional) lets the scan flow reuse already-fetched metadata instead of
 * re-scanning; when omitted (Settings reindex) messages are fetched server-side.
 */
async function runFolderIndexJob(
  folders: string[],
  incremental: boolean,
  getMainWindow: () => BrowserWindow | null,
  metaMessages?: Record<string, unknown>[],
): Promise<{ indexed: number; errors: number; total: number }> {
  const emit = (action: string, payload: Record<string, unknown> = {}) =>
    getMainWindow()?.webContents.send("inboxpie:event", { action, ...payload });

  // Bail before any (subprocess-spawning) fetch if this job was cancelled while queued.
  if (indexCancelRequested) return { indexed: 0, errors: 0, total: 0 };

  const modes = inboxPieDb.getFolderReadModes(folders);
  const metaFolders    = folders.filter((f) => modes[f] !== "content");
  const contentFolders = folders.filter((f) => modes[f] === "content");

  // Resolve messages per mode, then group by folder so we can index ONE folder at a
  // time — that makes progress events per-folder (drives the per-row progress bars).
  const byFolder = new Map<string, { mode: "metadata" | "content"; msgs: Record<string, unknown>[] }>();

  if (metaFolders.length) {
    const set = new Set(metaFolders);
    const metaMsgs = (metaMessages && metaMessages.length)
      ? metaMessages.filter((m: any) => set.has(m.folder))
      : await fetchMessagesForFolders(metaFolders, false) as unknown as Record<string, unknown>[];
    for (const f of metaFolders) byFolder.set(f, { mode: "metadata", msgs: metaMsgs.filter((m: any) => m.folder === f) });
  }
  if (contentFolders.length) {
    const contentMsgs = await fetchMessagesForFolders(contentFolders, true) as unknown as Record<string, unknown>[];
    for (const f of contentFolders) byFolder.set(f, { mode: "content", msgs: contentMsgs.filter((m: any) => m.folder === f) });
  }

  const grandTotal = [...byFolder.values()].reduce((s, v) => s + v.msgs.length, 0);
  emit("vectorIndexStarted", { total: grandTotal });

  // Full rebuild clears the folders' existing vectors + SQLite flags up front.
  if (!incremental && folders.length) {
    await lanceStore.deleteByFolders(folders);
    try {
      const db = inboxPieDb["get"]();
      const ph = folders.map(() => "?").join(",");
      db.prepare(`UPDATE mails SET indexed_meta='no', indexed_body='no', updated_at=datetime('now')
                  WHERE folder_id IN (SELECT id FROM folders WHERE name IN (${ph}))`).run(...folders);
    } catch { /* non-fatal */ }
  }

  let indexed = 0, errors = 0;
  for (const [folder, { mode, msgs }] of byFolder) {
    if (indexCancelRequested) break;
    if (!msgs.length) continue;
    const res = await buildVectorIndex(msgs, mode, (p) => {
      emit("vectorIndexProgress", { folder, done: p.done, total: p.total, indexed: p.indexed, errors: p.errors });
    }, () => indexCancelRequested);
    try { inboxPieDb.markMailsVectorIndexed(res.indexedIds, mode); } catch { /* non-fatal */ }
    indexed += res.indexed;
    errors  += res.errors;
  }

  return { indexed, errors, total: grandTotal };
}

// ── Background index job manager ─────────────────────────────────────────────
//
// Index jobs are serialized through a single promise chain so two scans/reindexes
// can never run their (CPU-heavy) embedding loops concurrently. `indexCancelRequested`
// is checked between batches so a reload/quit stops the running job promptly.

let indexChain: Promise<unknown> = Promise.resolve();
let indexCancelRequested = false;

function enqueueIndexJob(fn: () => Promise<void>): void {
  indexCancelRequested = false; // a freshly-requested job clears any stale cancel
  indexChain = indexChain.then(() => fn()).catch((e) => {
    console.error("[index] job failed:", (e as Error)?.message ?? e);
  });
}

/** Stop all background work: abort chat, cancel indexing, kill scan subprocesses. */
export function cancelBackgroundWork(): void {
  indexCancelRequested = true;
  try { currentChatAbort?.abort(); } catch { /* ignore */ }
  const killed = killActiveScans();
  if (killed) console.log(`[inboxpie] cancelBackgroundWork: killed ${killed} scan process(es)`);
}

// ── IPC handlers ───────────────────────────────────────────────────────────────

let currentChatAbort: AbortController | null = null;

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  // Seed the built-in categories once so they appear as editable rows in Settings.
  try { inboxPieDb.seedDefaultCategories(DEFAULT_CATEGORIES); } catch { /* non-fatal */ }

  ipcMain.handle("inboxpie:rpc", async (_event, message: RpcAction) => {
    const provider = mailProviders.getActive();

    switch (message.action) {
      // ── Discovery ─────────────────────────────────────────────────────────────

      case "getAccounts":
        return provider.getAccounts();

      case "listFoldersForScan": {
        const folders = await provider.getFolders(message.accountId ?? null);
        // Merge scan/index status from SQLite so the UI can show which folders
        // have already been scanned and whether metadata or body was indexed.
        const dbStats = inboxPieDb.getFolderStats();
        const dbByKey = new Map(dbStats.map((s) => [`${s.mailboxId}||${s.name}`, s]));
        return folders.map((f) => {
          const db = dbByKey.get(`${f.accountId}||${f.name}`);
          return {
            ...f,
            isScanned:        !!db && db.mailCount > 0,
            isIndexedMeta:    !!db && db.indexedMetaCount > 0,
            isIndexedBody:    !!db && db.indexedBodyCount > 0,
            lastScanned:      db?.lastScanned ?? null,
            indexedMetaCount: db?.indexedMetaCount ?? 0,
            indexedBodyCount: db?.indexedBodyCount ?? 0,
            mailCount:        db?.mailCount ?? f.totalCount ?? 0,
          };
        });
      }

      case "listFolders": {
        const folders = await provider.getFolders(message.accountId);
        return folders.map((f) => ({
          path:        f.path,
          name:        f.name,
          accountId:   f.accountId,
          displayPath: `${f.accountName} — ${f.path}`,
        }));
      }

      // ── Scan ──────────────────────────────────────────────────────────────────

      case "fetchAllMail": {
        const mainWindow = getMainWindow();
        const result = await provider.fetchMessages(message.options ?? {}, (count) => {
          emitProgress(mainWindow, { action: "progress", count });
        });

        setImmediate(() => {
          try {
            populateScanDB(result.messages, message.options ?? {}, result.envelopeIndexPath);
          } catch (e) {
            console.error("[inboxpie-db] scan persist failed:", e);
          }
        });

        return result;
      }

      // ── Actions ───────────────────────────────────────────────────────────────

      case "deleteMessages": {
        const mainWindow = getMainWindow();
        const result = await provider.deleteMessages(message.messageIds);
        if (result.success && result.count != null && result.total != null) {
          emitProgress(mainWindow, { action: "deleteProgress", moved: result.count, total: result.total });
        }
        return result;
      }

      case "moveMessagesToFolder": {
        const mainWindow = getMainWindow();
        const result = await provider.moveMessagesToFolder(
          message.messageIds,
          message.accountId,
          message.folderPath,
          (moved, total) => { emitProgress(mainWindow, { action: "moveProgress", moved, total }); },
        );
        return result;
      }

      case "openMessage":
        return provider.openMessage(message.messageId);

      case "getTrashFolder":
        return null;

      // ── Provider management ───────────────────────────────────────────────────

      case "setActiveProvider":
        mailProviders.setActive(message.providerId);
        return { success: true };

      case "getAccountsForProvider": {
        const p = mailProviders.get(message.providerId);
        if (!p) throw new Error(`Unknown provider: ${message.providerId}`);
        return p.getAccounts();
      }

      case "getFoldersForAccount": {
        const p = mailProviders.get(message.providerId);
        if (!p) throw new Error(`Unknown provider: ${message.providerId}`);
        return p.getFolders(message.accountId ?? null);
      }

      case "debugAccountResolution":
        return debugAccountResolution();

      // ── Enrichment ────────────────────────────────────────────────────────────

      case "enrichMessages": {
        const msgs = (message as any).messages ?? [];
        const win  = getMainWindow();
        win?.webContents.send("inboxpie:event", { action: "enrichmentStarted", total: msgs.length });
        setImmediate(() => {
          try {
            const stats = enrichmentDb.populate(msgs);
            getMainWindow()?.webContents.send("inboxpie:event", {
              action: "enrichmentDone",
              senders: stats.senders, domains: stats.domains, edges: stats.edges,
              indexedMessages: stats.indexedMessages, totalMessages: msgs.length,
            });
          } catch (e) { console.error("[enrichment] populate failed:", e); }
        });
        return { queued: true };
      }

      case "searchSenders":
        return enrichmentDb.searchSenders((message as any).query ?? "", (message as any).limit ?? 200);

      case "topDomains":
        return enrichmentDb.topDomains((message as any).limit ?? 50);

      // ── SmartSearch chat ──────────────────────────────────────────────────────

      case "checkOllama":
        return checkOllama();

      case "chatQuery": {
        const { userMessage, history, model, provider, folders, mode } = message as any;
        const win = getMainWindow();
        currentChatAbort?.abort();
        currentChatAbort = new AbortController();
        const { signal } = currentChatAbort;

        // Decrypt API key for cloud providers — key never leaves the main process
        const activeProvider: string = provider || inboxPieDb.getPreference("ai_provider", "ollama") || "ollama";
        let apiKey: string | undefined;
        if (activeProvider !== "ollama") {
          const enc = inboxPieDb.getPreference(`ai_key_${activeProvider}`, null);
          if (enc) apiKey = decryptKey(enc);
        }

        // Resolve model: explicit from message, then stored override, then passed model
        const storedModel = inboxPieDb.getPreference(`ai_model_${activeProvider}`, null);
        const resolvedModel = model || storedModel || "";

        try {
          const response = await runAgentQuery(
            userMessage,
            history ?? [],
            resolvedModel,
            folders,
            (ev) => { emitProgress(win, ev as any); },
            mode ?? "fast",
            signal,
            activeProvider,
            apiKey,
          );
          // html_widget → pass the model's raw HTML through for sandboxed-iframe rendering.
          // Everything else → server-rendered templated widget HTML.
          if (response.response_type === "html_widget" && response.widget_html) {
            return { ...response, htmlWidget: response.widget_html };
          }
          const widgetHtml = renderWidget(response);
          return { ...response, widgetHtml };
        } finally {
          currentChatAbort = null;
        }
      }

      case "cancelChatQuery": {
        currentChatAbort?.abort();
        return { cancelled: true };
      }

      // ── AI provider settings (BYOK) ───────────────────────────────────────────

      case "getAISettings": {
        const activeProvider = inboxPieDb.getPreference("ai_provider", "ollama") || "ollama";
        const providers: Record<string, { hasKey: boolean; maskedKey: string; model: string }> = {};
        for (const p of ["openai", "anthropic", "google"]) {
          const enc   = inboxPieDb.getPreference(`ai_key_${p}`, null);
          const model = inboxPieDb.getPreference(`ai_model_${p}`, null) || "";
          let maskedKey = "";
          if (enc) {
            try { maskedKey = maskKey(decryptKey(enc)); } catch { maskedKey = "••••••••"; }
          }
          providers[p] = { hasKey: !!enc, maskedKey, model };
        }
        return { activeProvider, providers };
      }

      case "saveAISettings": {
        const { provider: p, model: m, apiKey: k } = message as any;
        if (p) inboxPieDb.setPreference("ai_provider", p);
        if (m && p) inboxPieDb.setPreference(`ai_model_${p}`, m);
        if (k && p && p !== "ollama") inboxPieDb.setPreference(`ai_key_${p}`, encryptKey(k));
        return { success: true };
      }

      case "clearProviderKey": {
        const { provider: p } = message as any;
        if (p && p !== "ollama") {
          inboxPieDb.setPreference(`ai_key_${p}`, "");
          // If this was the active provider, fall back to ollama
          if (inboxPieDb.getPreference("ai_provider", "ollama") === p) {
            inboxPieDb.setPreference("ai_provider", "ollama");
          }
        }
        return { success: true };
      }

      case "validateProviderKey": {
        const { provider: p, apiKey: k } = message as any;
        return checkCloudProvider(p, k);
      }

      // ── Embedding / vector index ──────────────────────────────────────────────

      case "checkEmbedding":
        return checkEmbeddingModel();

      case "getVectorIndexStats":
        return lanceStore.getStats();

      case "buildVectorIndex": {
        // Triggered after a scan. Indexes each scanned folder in ITS OWN read_mode
        // (folder-level). Incremental — only new mail is embedded on re-scans.
        const { messages: msgs } = message as any;
        const initialMsgs: Record<string, unknown>[] = msgs ?? [];
        const folders = [...new Set(initialMsgs.map((m: any) => m.folder).filter(Boolean))] as string[];

        const auditId = inboxPieDb.startIndexAudit(null, folders);
        const startedAt = Date.now();

        getMainWindow()?.webContents.send("inboxpie:event", {
          action: "vectorIndexStarted", total: initialMsgs.length,
        });

        enqueueIndexJob(async () => {
          try {
            const result = await runFolderIndexJob(folders, /* incremental */ true, getMainWindow, initialMsgs);
            inboxPieDb.completeIndexAudit(auditId, result.indexed, result.errors);
            writeIndexLog({
              mode: "metadata", mailboxId: null, folders,
              total: result.total, indexed: result.indexed, errors: result.errors,
              durationMs: Date.now() - startedAt,
            });
            const stats = await lanceStore.getStats();
            getMainWindow()?.webContents.send("inboxpie:event", { action: "vectorIndexComplete", ...stats });
          } catch (e) {
            const errMsg = (e as Error).message;
            inboxPieDb.failIndexAudit(auditId, errMsg);
            writeIndexLog({
              mode: "metadata", mailboxId: null, folders,
              total: initialMsgs.length, indexed: 0, errors: initialMsgs.length,
              durationMs: Date.now() - startedAt, error: errMsg,
            });
            getMainWindow()?.webContents.send("inboxpie:event", { action: "vectorIndexError", error: errMsg });
          }
        });
        return { queued: true, total: initialMsgs.length };
      }

      case "resetVectorIndex":
        await lanceStore.reset();
        return { success: true };

      case "resetAllData": {
        // Full clean slate: wipe vector index + SQLite scan/index data (incl. per-folder
        // read_mode, since folders rows are deleted). Apple Mail itself is untouched.
        await lanceStore.reset();
        const removed = inboxPieDb.resetAllData();
        console.log(`[inboxpie] resetAllData: cleared ${removed.mails} mails, ${removed.folders} folders, vector index`);
        return { success: true, ...removed };
      }

      case "setFolderReadMode": {
        const { folder, mode: fMode } = message as any;
        const resolved: "metadata" | "content" = fMode === "content" ? "content" : "metadata";
        if (folder) inboxPieDb.setFolderReadMode(folder, resolved);
        return { success: true };
      }

      case "deleteFolders": {
        // Remove folders entirely: their vectors + mails + scan history + folder rows.
        const { folders: delFolders } = message as any;
        const names = (delFolders as string[]) ?? [];
        if (!names.length) return { success: true, mails: 0, folders: 0 };
        await lanceStore.deleteByFolders(names);
        const removed = inboxPieDb.deleteFolders(names);
        console.log(`[inboxpie] deleteFolders: removed ${removed.folders} folder(s), ${removed.mails} mail(s)`);
        return { success: true, ...removed };
      }

      case "reindexFolders": {
        // (Re)index folders from Settings, honouring each folder's own read_mode.
        // Self-sufficient: fetches messages server-side, so it works without a renderer scan.
        //   full        → wipe the folders' vectors, then rebuild
        //   incremental → keep existing vectors, embed only not-yet-indexed mail
        const { folders: targetFolders, incremental } = message as any;
        const isIncremental = !!incremental;
        const auditFolders = (targetFolders as string[]) ?? [];

        const auditId  = inboxPieDb.startIndexAudit(null, auditFolders);
        const startedAt = Date.now();

        getMainWindow()?.webContents.send("inboxpie:event", {
          action: "vectorIndexStarted", total: 0,
        });

        enqueueIndexJob(async () => {
          try {
            const result = await runFolderIndexJob(auditFolders, isIncremental, getMainWindow);
            inboxPieDb.completeIndexAudit(auditId, result.indexed, result.errors);
            writeIndexLog({
              mode: "metadata", mailboxId: null, folders: auditFolders,
              total: result.total, indexed: result.indexed, errors: result.errors,
              durationMs: Date.now() - startedAt,
            });
            const stats = await lanceStore.getStats();
            getMainWindow()?.webContents.send("inboxpie:event", { action: "vectorIndexComplete", ...stats });
          } catch (e) {
            const errMsg = (e as Error).message;
            inboxPieDb.failIndexAudit(auditId, errMsg);
            getMainWindow()?.webContents.send("inboxpie:event", { action: "vectorIndexError", error: errMsg });
          }
        });
        return { queued: true };
      }

      // ── Intelligence Dashboard ────────────────────────────────────────────────

      case "getFolderStats":
        return inboxPieDb.getFolderStats();

      case "getIndexingStats": {
        const stats   = await lanceStore.getStats();
        const folders = await lanceStore.getFolderStats();
        return { total: stats.total, folders };
      }

      case "getFolderIndexBreakdown":
        return await lanceStore.getFolderBreakdown();

      case "getSemanticClusters": {
        const rows = await lanceStore.getAllRows();
        if (!rows.length) return [];

        const clusters = buildClusters();
        const counts:      number[]        = new Array(clusters.length).fill(0);
        const topSubjects: string[][]      = clusters.map(() => []);

        for (const row of rows) {
          const text = `${row.subject} ${row.domain} ${row.sender_email}`;
          const idx  = classifyEmail(text, clusters);
          counts[idx]!++;
          if (topSubjects[idx]!.length < 3 && row.subject.trim()) {
            topSubjects[idx]!.push(row.subject.trim());
          }
        }

        return clusters
          .map((c, i) => ({ label: c.label, icon: c.icon, count: counts[i]!, topSubjects: topSubjects[i]! }))
          .filter((c) => c.count > 0)
          .sort((a, b) => b.count - a.count);
      }

      case "getClusterEmails": {
        const { label } = message as any as { label: string };
        const rows = await lanceStore.getAllRows();
        console.log(`[getClusterEmails] label="${label}" totalRows=${rows.length}`);
        const clusters  = buildClusters();
        const targetIdx = clusters.findIndex((c) => c.label === label);
        if (targetIdx === -1) { console.warn(`[getClusterEmails] unknown label: ${label}`); return []; }
        const matched = rows.filter((row) => classifyEmail(`${row.subject} ${row.domain} ${row.sender_email}`, clusters) === targetIdx);
        console.log(`[getClusterEmails] matched ${matched.length} emails for "${label}"`);
        return matched
          .sort((a, b) => (b.date_unix || 0) - (a.date_unix || 0))
          .slice(0, 300)
          .map((r) => ({
            subject:      r.subject,
            sender_name:  r.sender_name,
            sender_email: r.sender_email,
            domain:       r.domain,
            folder:       r.folder,
            date_unix:    r.date_unix,
            size:         r.size,
            is_read:      r.is_read,
          }));
      }

      // ── Preferences ───────────────────────────────────────────────────────────

      case "getPreference": {
        const { key, defaultVal } = message as any;
        return { value: inboxPieDb.getPreference(key, defaultVal ?? null) };
      }

      case "getCategories":
        return inboxPieDb.getCategories();

      case "saveCategory": {
        const { name, keywords } = message as any;
        const cleanName = String(name ?? "").trim();
        if (!cleanName) return { success: false, error: "Name required" };
        const kws = (Array.isArray(keywords) ? keywords : [])
          .map((k: unknown) => String(k).trim()).filter(Boolean);
        inboxPieDb.upsertCategory(cleanName, kws);
        return { success: true };
      }

      case "deleteCategory": {
        const { name } = message as any;
        if (name) inboxPieDb.deleteCategory(String(name));
        return { success: true };
      }

      case "setPreference": {
        const { key, value } = message as any;
        inboxPieDb.setPreference(key, value);
        return { success: true };
      }

      default:
        throw new Error(`Unknown action: ${(message as { action: string }).action}`);
    }
  });

  ipcMain.handle("inboxpie:openPrivacySettings", async () => {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    );
  });

  ipcMain.handle("inboxpie:getProviders", () => mailProviders.list());
}

function emitProgress(window: BrowserWindow | null, event: ProgressEvent): void {
  window?.webContents.send("inboxpie:event", event);
}

// ── populateScanDB ─────────────────────────────────────────────────────────────

function populateScanDB(
  messages: import("../../../shared/message-record").MessageRecord[],
  _options: import("../../../shared/message-record").FetchMailOptions,
  envelopeIndexPath?: string,
): void {
  if (!messages.length) return;

  const mailboxMap = new Map<string, string>();
  for (const m of messages) {
    if (m.accountId && !mailboxMap.has(m.accountId)) {
      mailboxMap.set(m.accountId, m.account || m.accountId);
    }
  }
  for (const [id, name] of mailboxMap) {
    inboxPieDb.upsertMailbox(id, name, envelopeIndexPath);
  }

  const folderKey = (mb: string, f: string) => `${mb}||${f}`;
  const folderIdMap = new Map<string, number>();
  const folderSet   = new Map<string, { mailboxId: string; name: string }>();
  for (const m of messages) {
    if (!m.accountId || !m.folder) continue;
    const k = folderKey(m.accountId, m.folder);
    if (!folderSet.has(k)) folderSet.set(k, { mailboxId: m.accountId, name: m.folder });
  }
  for (const [k, { mailboxId, name }] of folderSet) {
    const id = inboxPieDb.upsertFolder(mailboxId, name);
    folderIdMap.set(k, id);
  }

  const mailboxIds    = [...mailboxMap.keys()];
  const auditMailboxId = mailboxIds.length === 1 ? mailboxIds[0] : null;
  const folderAuditIds = new Map<number, number>();
  for (const folderId of folderIdMap.values()) {
    const auditId = inboxPieDb.startScanAudit(auditMailboxId, folderId);
    folderAuditIds.set(folderId, auditId);
  }

  const inserts = messages.map((m) => ({
    id:        String(m.id),
    mailboxId: m.accountId,
    folderId:  folderIdMap.get(folderKey(m.accountId, m.folder)) ?? 0,
    sender:    m.senderEmail || m.author || "",
    domain:    m.domain || "",
    size:      m.size ?? 0,
    subject:   m.subject || "",
    date:      m.date || "",
  })).filter((r) => r.mailboxId && r.folderId > 0);

  const mailCountByFolder = new Map<number, number>();
  for (const ins of inserts) {
    mailCountByFolder.set(ins.folderId, (mailCountByFolder.get(ins.folderId) ?? 0) + 1);
  }

  try {
    const inserted = inboxPieDb.insertMails(inserts);
    for (const [folderId, auditId] of folderAuditIds) {
      inboxPieDb.completeScanAudit(auditId, mailCountByFolder.get(folderId) ?? 0);
    }
    console.log(`[inboxpie-db] scan persisted: ${inserted} new mails (${messages.length} total)`);
  } catch (e) {
    for (const [, auditId] of folderAuditIds) {
      inboxPieDb.failScanAudit(auditId, (e as Error).message);
    }
    throw e;
  }
}
