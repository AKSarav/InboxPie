import { ipcMain, shell, safeStorage, app, type BrowserWindow } from "electron";
import fs   from "node:fs";
import os   from "node:os";
import path from "node:path";

import type { ProgressEvent, RpcAction } from "../../../shared/message-record";
import { checkOllama, runAgentQuery, checkCloudProvider } from "../agent/nlp-agent";
import { checkEmbeddingModel, isEmbeddingReady } from "../agent/embeddings";
import { buildVectorIndex }           from "../agent/indexer";
import { lanceStore }                 from "../db/lance-store";
import { renderWidget }               from "../agent/widget-renderer";
import { enrichmentDb }               from "../db/enrichment";
import { inboxPieDb }                 from "../db/inboxpie-db";
import { mailProviders }              from "../mail";
import { debugAccountResolution, fetchMessagesForFolders, killActiveScans } from "../mail/apple-mail";
import { isThunderbirdInstalled } from "../mail/thunderbird";

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
  folderIds: string[],
  incremental: boolean,
  getMainWindow: () => BrowserWindow | null,
  metaMessages?: Record<string, unknown>[],
): Promise<{ indexed: number; errors: number; total: number }> {
  const emit = (action: string, payload: Record<string, unknown> = {}) =>
    getMainWindow()?.webContents.send("inboxpie:event", { action, ...payload });

  // Bail before any (subprocess-spawning) fetch if this job was cancelled while queued.
  if (indexCancelRequested) return { indexed: 0, errors: 0, total: 0 };

  // Convert folder IDs to folder names for fetch operations
  const idToName = inboxPieDb.getFolderNames(folderIds);
  const modes = inboxPieDb.getFolderReadModes(folderIds);
  const metaFolderIds    = folderIds.filter((id) => modes[id] !== "content");
  const contentFolderIds = folderIds.filter((id) => modes[id] === "content");
  const metaFolderNames    = metaFolderIds.map((id) => idToName[id]).filter(Boolean);
  const contentFolderNames = contentFolderIds.map((id) => idToName[id]).filter(Boolean);

  // Resolve messages per mode, then group by folder name so we can index ONE folder at a
  // time — that makes progress events per-folder (drives the per-row progress bars).
  const byFolderName = new Map<string, { mode: "metadata" | "content"; msgs: Record<string, unknown>[] }>();

  if (metaFolderNames.length) {
    const set = new Set(metaFolderNames);
    const metaMsgs = (metaMessages && metaMessages.length)
      ? metaMessages.filter((m: any) => set.has(m.folder))
      : await fetchMessagesForFolders(metaFolderNames, false) as unknown as Record<string, unknown>[];
    for (const f of metaFolderNames) byFolderName.set(f, { mode: "metadata", msgs: metaMsgs.filter((m: any) => m.folder === f) });
  }
  if (contentFolderNames.length) {
    const contentMsgs = await fetchMessagesForFolders(contentFolderNames, true) as unknown as Record<string, unknown>[];
    for (const f of contentFolderNames) byFolderName.set(f, { mode: "content", msgs: contentMsgs.filter((m: any) => m.folder === f) });
  }

  const grandTotal = [...byFolderName.values()].reduce((s, v) => s + v.msgs.length, 0);
  emit("vectorIndexStarted", { total: grandTotal });

  // Full rebuild clears the folders' existing vectors + SQLite flags up front.
  if (!incremental && folderIds.length) {
    const folderNames = folderIds.map((id) => idToName[id]).filter(Boolean);
    await lanceStore.deleteByFolders(folderNames);
    try {
      const db = inboxPieDb["get"]();
      const ph = folderIds.map(() => "?").join(",");
      db.prepare(`UPDATE mails SET indexed_meta='no', indexed_body='no', updated_at=datetime('now')
                  WHERE folder_id IN (${ph})`).run(...folderIds.map((id) => parseInt(id, 10)));
    } catch { /* non-fatal */ }
  }

  let indexed = 0, errors = 0;
  for (const [folder, { mode, msgs }] of byFolderName) {
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
let _currentIndexFolders: string[] = [];   // tracked for pause support
// In-memory flag: blocks auto-indexing that fires after every scan.
// Set to true on every app start so indexing is never auto-resumed on restart.
// Cleared only when user explicitly triggers indexing from Settings.
let _autoIndexBlocked = true;

function enqueueIndexJob(fn: () => Promise<void>): void {
  indexCancelRequested = false; // a freshly-requested job clears any stale cancel
  indexChain = indexChain.then(async () => {
    try { inboxPieDb.setPreference("index_ongoing", "yes"); } catch { /* non-fatal */ }
    try {
      await fn();
    } finally {
      try { inboxPieDb.setPreference("index_ongoing", "no"); } catch { /* non-fatal */ }
    }
  }).catch((e) => {
    try { inboxPieDb.setPreference("index_ongoing", "no"); } catch { /* ignore */ }
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
  // Reset any stale indexing flag from a previous session (covers crash-mid-index case).
  try { inboxPieDb.setPreference("index_ongoing", "no"); } catch { /* non-fatal */ }
  // Seed the built-in categories once so they appear as editable rows in Settings.
  try { inboxPieDb.seedDefaultCategories(DEFAULT_CATEGORIES); } catch { /* non-fatal */ }
  // Restore the active mail provider from the last session.
  try {
    const saved = inboxPieDb.getPreference("active_mail_provider", null);
    if (saved) mailProviders.setActive(saved);
  } catch { /* unknown provider or first run — keep default */ }

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
            populateScanDB(result.messages, message.options ?? {}, result.envelopeIndexPath, provider.id);
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
        inboxPieDb.setPreference("active_mail_provider", message.providerId);
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

      case "checkEmbedding": {
        const status = await checkEmbeddingModel();
        return { ...status, ready: isEmbeddingReady() };
      }

      // ── First-run setup status ────────────────────────────────────────────────
      // Returns the state of all setup prerequisites so the setup screen can poll.

      case "getSetupStatus": {
        const embStatus = await checkEmbeddingModel();

        // Check Full Disk Access by attempting to stat the Mail envelope index
        const mailDir = path.join(os.homedir(), "Library", "Mail");
        let permsOk = false;
        let permsDetail = "Grant access in System Settings → Privacy & Security → Full Disk Access";
        try {
          fs.accessSync(mailDir, fs.constants.R_OK);
          permsOk = true;
          permsDetail = "Full Disk Access granted";
          inboxPieDb.setPreference("is_permissions_granted", "yes");
        } catch {
          permsOk = inboxPieDb.getPreference("is_permissions_granted", null) === "yes";
          if (permsOk) permsDetail = "Full Disk Access granted";
        }

        // Update embedding flag in prefs
        if (embStatus.cached) inboxPieDb.setPreference("is_embedding_downloaded", "yes");

        const appReady = inboxPieDb.getPreference("app_ready", null) === "yes";

        return {
          appReady,
          tasks: [
            {
              id:      "embedding",
              label:   "AI Embedding Model",
              status:  isEmbeddingReady() ? "done" : embStatus.cached ? "done" : "active",
              pct:     (isEmbeddingReady() || embStatus.cached) ? 100 : (embStatus.totalMB > 0 ? Math.min(99, Math.round((embStatus.downloadedMB / embStatus.totalMB) * 100)) : 0),
              detail:  isEmbeddingReady()
                ? "bge-large-en-v1.5 loaded in memory"
                : embStatus.cached
                  ? `Cached (${embStatus.downloadedMB} MB) — will load on first search`
                  : `Downloading… ${embStatus.downloadedMB}/${embStatus.totalMB} MB`,
              required: true,
            },
            {
              id:      "perms",
              label:   "Full Disk Access",
              status:  permsOk ? "done" : "warn",
              pct:     permsOk ? 100 : 0,
              detail:  permsDetail,
              required: false,
            },
          ],
        };
      }

      case "markAppReady": {
        inboxPieDb.setPreference("app_ready", "yes");
        return { ok: true };
      }

      case "pauseIndexing": {
        // Stop the running embedding loop between batches and record which folders
        // were in progress so the user can resume from Settings.
        inboxPieDb.setPreference("index_paused",         "yes");
        inboxPieDb.setPreference("index_paused_folders", JSON.stringify(_currentIndexFolders));
        indexCancelRequested = true;   // stops embedBatch loop at next batch boundary
        return { ok: true };
      }

      case "resumeIndexing": {
        // Re-index only the folders that were paused, incremental so already-indexed
        // emails are skipped and only the remaining ones are embedded.
        const pausedFolders = JSON.parse(
          inboxPieDb.getPreference("index_paused_folders", null) ?? "[]"
        ) as string[];
        inboxPieDb.setPreference("index_paused",         "no");
        inboxPieDb.setPreference("index_paused_folders", "[]");
        if (!pausedFolders.length) return { ok: true, skipped: true };
        _currentIndexFolders = pausedFolders;
        _autoIndexBlocked = false;  // user explicitly resuming
        const rAuditId  = inboxPieDb.startIndexAudit(null, pausedFolders);
        const rStartedAt = Date.now();
        getMainWindow()?.webContents.send("inboxpie:event", { action: "vectorIndexStarted", total: 0 });
        enqueueIndexJob(async () => {
          try {
            const result = await runFolderIndexJob(pausedFolders, /* incremental */ true, getMainWindow);
            inboxPieDb.completeIndexAudit(rAuditId, result.indexed, result.errors);
            writeIndexLog({ mode: "metadata", mailboxId: null, folders: pausedFolders,
              total: result.total, indexed: result.indexed, errors: result.errors,
              durationMs: Date.now() - rStartedAt });
            const stats = await lanceStore.getStats();
            getMainWindow()?.webContents.send("inboxpie:event", { action: "vectorIndexComplete", ...stats });
          } catch (e) {
            const errMsg = (e as Error).message;
            inboxPieDb.failIndexAudit(rAuditId, errMsg);
            getMainWindow()?.webContents.send("inboxpie:event", { action: "vectorIndexError", error: errMsg });
          }
        });
        return { ok: true };
      }

      case "getIndexingStatus": {
        const ongoing       = inboxPieDb.getPreference("index_ongoing", null) === "yes";
        const paused        = inboxPieDb.getPreference("index_paused",  null) === "yes";
        const pausedFolders = JSON.parse(inboxPieDb.getPreference("index_paused_folders", null) ?? "[]") as string[];
        return { ongoing, paused, pausedFolders };
      }

      case "getVectorIndexStats":
        return lanceStore.getStats();

      case "buildVectorIndex": {
        // If user explicitly paused indexing, skip the auto-restart that happens
        // after every scan. The user must resume manually from Settings.
        // Also blocked on every fresh app start (_autoIndexBlocked) so restarting
        // the app never auto-resumes an interrupted index.
        const isPaused = inboxPieDb.getPreference("index_paused", null) === "yes";
        if (isPaused || _autoIndexBlocked) {
          return { queued: false, paused: isPaused, blocked: _autoIndexBlocked };
        }

        // Triggered after a scan. Indexes each scanned folder in ITS OWN read_mode
        // (folder-level). Incremental — only new mail is embedded on re-scans.
        const { messages: msgs } = message as any;
        const initialMsgs: Record<string, unknown>[] = msgs ?? [];
        const folders = [...new Set(initialMsgs.map((m: any) => m.folder).filter(Boolean))] as string[];
        _currentIndexFolders = folders;

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
        // Full clean slate: wipe all scan data (mailboxes, folders, mails),
        // vector index, audit logs, and app state preferences.
        // KEEPS: AI provider settings (keys, models, provider selection).
        // Mail clients themselves are untouched.
        await lanceStore.reset();
        const removed = inboxPieDb.resetAllData();
        console.log(
          `[inboxpie] resetAllData: cleared ${removed.mailboxes} mailbox(es), ` +
          `${removed.folders} folder(s), ${removed.mails} mail(s), vector index, app state (kept AI config)`
        );
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
        _currentIndexFolders = auditFolders;
        // Explicit reindex from Settings clears any existing pause AND unblocks auto-index
        _autoIndexBlocked = false;
        inboxPieDb.setPreference("index_paused", "no");
        inboxPieDb.setPreference("index_paused_folders", "[]");

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

      case "getCluster2D": {
        // Cap at 500 for graph quality — denser, more beautiful layout
        const vrows = await lanceStore.getVectorRows(500);
        if (vrows.length < 4) return { points: [], clusters: [] };

        const dim = vrows[0]!.vector.length;
        const N   = vrows.length;

        // ── K-means++ on 768-dim vectors ────────────────────────────────────────
        const K = Math.min(10, Math.max(4, Math.round(Math.sqrt(N / 8))));

        function cosDist(a: number[], b: number[]): number {
          let dot = 0, na = 0, nb = 0;
          for (let i = 0; i < dim; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
          return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
        }

        const centroidIdx: number[] = [Math.floor(Math.random() * N)];
        while (centroidIdx.length < K) {
          const dists = vrows.map((r) => {
            let minD = Infinity;
            for (const ci of centroidIdx) minD = Math.min(minD, cosDist(r.vector, vrows[ci]!.vector));
            return minD;
          });
          const total = dists.reduce((s, d) => s + d, 0);
          let rnd = Math.random() * total;
          for (let i = 0; i < N; i++) { rnd -= dists[i]!; if (rnd <= 0) { centroidIdx.push(i); break; } }
          if (centroidIdx.length < centroidIdx.length + 1) centroidIdx.push(Math.floor(Math.random() * N));
        }
        let centroids: number[][] = centroidIdx.map((i) => [...vrows[i]!.vector]);
        let labels = new Array(N).fill(0);

        for (let iter = 0; iter < 30; iter++) {
          const newLabels = vrows.map((r) => {
            let best = 0, bestD = Infinity;
            for (let k = 0; k < K; k++) { const d = cosDist(r.vector, centroids[k]!); if (d < bestD) { bestD = d; best = k; } }
            return best;
          });
          if (newLabels.every((l, i) => l === labels[i])) break;
          labels = newLabels;
          const sums = Array.from({ length: K }, () => new Array(dim).fill(0) as number[]);
          const cnts = new Array(K).fill(0) as number[];
          for (let i = 0; i < N; i++) { const k = labels[i]!; cnts[k]++; for (let d = 0; d < dim; d++) sums[k]![d]! += vrows[i]!.vector[d]!; }
          centroids = sums.map((s, k) => cnts[k] > 0 ? s.map((v) => v / cnts[k]!) : centroids[k]!);
        }

        // ── Auto-label clusters: sender name + distinguishing subject keyword ────
        // Strategy: primary = most-common sender display name (cleaned);
        //           secondary = top subject keyword that is SPECIFIC to this cluster.
        // Specificity score = freq_in_cluster / (1 + freq_in_other_clusters) —
        // words that appear a lot in THIS cluster but rarely elsewhere rank highest.

        // Step 1: gather per-cluster word frequencies and a global word-in-cluster count
        const LABEL_STOP = new Set([
          "re","fwd","fw","the","a","an","in","on","for","of","to","and","is","with","your","you",
          "have","has","from","this","that","are","will","can","we","our","new","get","how","all",
          "any","please","dear","hello","hi","hey","thanks","thank","been","not","but","they","their",
          "them","just","about","also","here","more","use","via","see","its","it","was","were","be",
          "do","did","done","so","if","at","by","or","as","up","out","into","over","than","then",
          "when","where","which","who","what","received","sent","went","made","got","come","came",
          "going","send","receive","read","click","view","check","confirm","verify","sign","open",
          "close","found","find","know","need","want","take","give","show","tell","help","try",
          "keep","let","back","today","tomorrow","yesterday","week","month","year","now","soon",
          "already","still","always","never","details","information","info","message","mail","email",
          "update","alert","notification","reminder","important","regarding","attached","link","below",
          "above","kindly","hereby","herewith","number","days","hours","one","two","three","per",
          "would","should","could","may","might","shall","dear","sincerely","regards","team",
        ]);

        // Build per-cluster bigram/trigram frequencies for phrase-based labels.
        // After stopword removal, adjacent content words form meaningful phrases:
        // "nps contribution", "sip payment", "savings goal" vs. single words like "DAY".
        const phraseClusterSet: Record<string, Set<number>> = {};
        const clusterPhraseFreq: Array<Record<string, number>> = Array.from({ length: K }, () => ({}));
        const wordClusterSet: Record<string, Set<number>> = {};
        const clusterWordFreq: Array<Record<string, number>> = Array.from({ length: K }, () => ({}));

        for (let i = 0; i < N; i++) {
          const k = labels[i]!;
          const tokens = vrows[i]!.subject.toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 3 && !LABEL_STOP.has(w) && !/^\d+$/.test(w));

          // Single-word freq (fallback)
          for (const w of tokens) {
            clusterWordFreq[k]![w] = (clusterWordFreq[k]![w] ?? 0) + 1;
            if (!wordClusterSet[w]) wordClusterSet[w] = new Set();
            wordClusterSet[w]!.add(k);
          }
          // Bigrams and trigrams
          for (let j = 0; j < tokens.length; j++) {
            if (j + 1 < tokens.length) {
              const bi = `${tokens[j]} ${tokens[j + 1]}`;
              clusterPhraseFreq[k]![bi] = (clusterPhraseFreq[k]![bi] ?? 0) + 1;
              if (!phraseClusterSet[bi]) phraseClusterSet[bi] = new Set();
              phraseClusterSet[bi]!.add(k);
            }
            if (j + 2 < tokens.length) {
              const tri = `${tokens[j]} ${tokens[j + 1]} ${tokens[j + 2]}`;
              clusterPhraseFreq[k]![tri] = (clusterPhraseFreq[k]![tri] ?? 0) + 1;
              if (!phraseClusterSet[tri]) phraseClusterSet[tri] = new Set();
              phraseClusterSet[tri]!.add(k);
            }
          }
        }

        const toTitleCase = (s: string) =>
          s.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

        const clusterLabels: string[] = Array.from({ length: K }, (_, k) => {
          const members = vrows.filter((_, i) => labels[i] === k);
          if (!members.length) return `Cluster ${k + 1}`;

          // Primary: most common sender display name, cleaned up
          const nameFreq: Record<string, number> = {};
          for (const m of members) {
            const name = (m.sender_name || "").split(/\s*[-|•·:_<]/)[0]!.trim().slice(0, 20);
            if (name.length > 1) nameFreq[name] = (nameFreq[name] ?? 0) + 1;
          }
          const namesSorted = Object.entries(nameFreq).sort((a, b) => b[1] - a[1]);
          const topName = namesSorted[0]?.[0] ?? "";
          const secondName = namesSorted[1] && namesSorted[1][1] >= namesSorted[0]![1] * 0.40
            ? namesSorted[1][0] : null;

          if (namesSorted.length > 1 && secondName) {
            return `${topName} · ${secondName}`;
          }

          // Secondary: best cluster-specific phrase (bigram/trigram), title-cased
          const pf = clusterPhraseFreq[k]!;
          const bestPhrase = Object.entries(pf)
            .map(([ph, cnt]) => ({ ph, score: cnt / (phraseClusterSet[ph]!.size) }))
            .sort((a, b) => b.score - a.score)[0]?.ph ?? "";

          if (bestPhrase) {
            return topName ? `${topName} · ${toTitleCase(bestPhrase)}` : toTitleCase(bestPhrase);
          }

          // Fallback: single best word if no bigram found
          const wf = clusterWordFreq[k]!;
          const bestWord = Object.entries(wf)
            .map(([w, cnt]) => ({ w, score: cnt / (wordClusterSet[w]!.size) }))
            .sort((a, b) => b.score - a.score)[0]?.w ?? "";

          if (topName && bestWord) return `${topName} · ${toTitleCase(bestWord)}`;
          if (topName) return topName;
          return toTitleCase(bestWord) || `Cluster ${k + 1}`;
        });

        // ── PCA to 2D (initial positions for force layout) ───────────────────────
        const mean = new Array(dim).fill(0) as number[];
        for (const r of vrows) for (let d = 0; d < dim; d++) mean[d]! += r.vector[d]!;
        for (let d = 0; d < dim; d++) mean[d]! /= N;
        const centered = vrows.map((r) => r.vector.map((v, d) => v - mean[d]!));

        function powerIter(data: number[][], deflate?: number[]): number[] {
          let v = new Array(dim).fill(0) as number[];
          for (let d = 0; d < dim; d++) v[d] = Math.random() - 0.5;
          if (deflate) { let dot = 0; for (let d = 0; d < dim; d++) dot += v[d]! * deflate[d]!; for (let d = 0; d < dim; d++) v[d]! -= dot * deflate[d]!; }
          let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
          v = v.map((x) => x / norm);
          for (let iter = 0; iter < 20; iter++) {
            const Xv = data.map((row) => row.reduce((s, x, d) => s + x * v[d]!, 0));
            const newV = new Array(dim).fill(0) as number[];
            for (let i = 0; i < N; i++) for (let d = 0; d < dim; d++) newV[d]! += data[i]![d]! * Xv[i]!;
            if (deflate) { let dot = 0; for (let d = 0; d < dim; d++) dot += newV[d]! * deflate[d]!; for (let d = 0; d < dim; d++) newV[d]! -= dot * deflate[d]!; }
            norm = Math.sqrt(newV.reduce((s, x) => s + x * x, 0));
            v = norm > 0 ? newV.map((x) => x / norm) : v;
          }
          return v;
        }

        const pc1 = powerIter(centered);
        const pc2 = powerIter(centered, pc1);
        const raw2d = centered.map((row) => [
          row.reduce((s, x, d) => s + x * pc1[d]!, 0),
          row.reduce((s, x, d) => s + x * pc2[d]!, 0),
        ] as [number, number]);

        const xs = raw2d.map((p) => p[0]), ys = raw2d.map((p) => p[1]);
        const xRange = (Math.max(...xs) - Math.min(...xs)) || 1;
        const yRange = (Math.max(...ys) - Math.min(...ys)) || 1;
        const xMin = Math.min(...xs), yMin = Math.min(...ys);

        const points = raw2d.map(([px, py], i) => ({
          // Compress into [-0.5, 0.5] so force layout has room to breathe
          x: (((px - xMin) / xRange) - 0.5) * 0.8,
          y: (((py - yMin) / yRange) - 0.5) * 0.8,
          k: labels[i]!,
          subject:      vrows[i]!.subject,
          sender_email: vrows[i]!.sender_email,
          sender_name:  vrows[i]!.sender_name,
          domain:       vrows[i]!.domain,
          folder:       vrows[i]!.folder,
        }));

        // GitNexus palette — same semantic colours used in their node-type legend.
        // "Muted" effect comes from tiny node sizes + low edge alpha, not dark hues.
        const PALETTE = ["#818cf8","#10b981","#f59e0b","#f43f5e","#14b8a6","#a855f7","#f97316","#3b82f6","#ec4899","#60a5fa"];
        const clusters2d = Array.from({ length: K }, (_, k) => ({
          k,
          label: clusterLabels[k]!,
          color: PALETTE[k % PALETTE.length]!,
          count: labels.filter((l) => l === k).length,
        })).filter((c) => c.count > 0).sort((a, b) => b.count - a.count);

        // ── Separate within-cluster and cross-cluster k-NN (20D random projection) ─
        // Adaptive k: small graphs need fewer edges to avoid geometric mesh patterns.
        // Rule: within-cluster k = N/25 capped at 4; cross k = N/60 capped at 2.
        const RP = 20;
        const WITHIN_K = Math.max(2, Math.min(4, Math.round(N / 25)));
        const CROSS_K  = Math.max(1, Math.min(2, Math.round(N / 60)));
        const rpMatrix = Array.from({ length: RP }, () =>
          Array.from({ length: dim }, () => (Math.random() * 2 - 1) / Math.sqrt(RP))
        );
        const proj = vrows.map((r) =>
          rpMatrix.map((w) => w.reduce((s, wi, d) => s + wi * r.vector[d]!, 0))
        );
        const withinEdges: Array<{ s: number; t: number }> = [];
        const crossEdges:  Array<{ s: number; t: number }> = [];
        for (let i = 0; i < N; i++) {
          const pi = proj[i]!, ki = labels[i]!;
          const wd: Array<[number, number]> = [], cd: Array<[number, number]> = [];
          for (let j = 0; j < N; j++) {
            if (j === i) continue;
            let d2 = 0;
            const pj = proj[j]!;
            for (let r = 0; r < RP; r++) { const diff = pi[r]! - pj[r]!; d2 += diff * diff; }
            if (labels[j] === ki) wd.push([j, d2]);
            else                  cd.push([j, d2]);
          }
          wd.sort((a, b) => a[1]! - b[1]!);
          for (let ki2 = 0; ki2 < WITHIN_K && ki2 < wd.length; ki2++) {
            const j = wd[ki2]![0]!;
            if (i < j) withinEdges.push({ s: i, t: j });
          }
          cd.sort((a, b) => a[1]! - b[1]!);
          for (let ki2 = 0; ki2 < CROSS_K && ki2 < cd.length; ki2++) {
            const j = cd[ki2]![0]!;
            if (i < j) crossEdges.push({ s: i, t: j });
          }
        }

        return { points, clusters: clusters2d, withinEdges, crossEdges };
      }

      case "getSubscriptionStats": {
        const rows = await lanceStore.getAllRows();
        if (!rows.length) return [];

        // Group by domain — same company always uses the same domain
        const byDomain = new Map<string, { dates: number[]; subjects: string[]; senders: Set<string>; size: number }>();
        for (const r of rows) {
          if (!r.domain || !r.date_unix) continue;
          if (!byDomain.has(r.domain)) byDomain.set(r.domain, { dates: [], subjects: [], senders: new Set(), size: 0 });
          const g = byDomain.get(r.domain)!;
          g.dates.push(r.date_unix);
          if (r.subject) g.subjects.push(r.subject.toLowerCase());
          if (r.sender_email) g.senders.add(r.sender_email);
          g.size += r.size ?? 0;
        }

        const results: Array<{
          domain: string; email_count: number; sender_count: number;
          avg_interval_days: number; frequency: string; is_newsletter: boolean;
          last_date_unix: number; size_bytes: number; sample_subjects: string[];
        }> = [];

        for (const [domain, g] of byDomain) {
          if (g.dates.length < 3) continue; // need at least 3 to establish pattern
          g.dates.sort((a, b) => a - b);

          // Average interval between consecutive emails (in days)
          let totalGap = 0;
          for (let i = 1; i < g.dates.length; i++) totalGap += (g.dates[i]! - g.dates[i - 1]!) / 86400;
          const avgDays = totalGap / (g.dates.length - 1);

          let frequency: string;
          if (avgDays <= 1.5)       frequency = "Daily";
          else if (avgDays <= 4)    frequency = "Every few days";
          else if (avgDays <= 10)   frequency = "Weekly";
          else if (avgDays <= 25)   frequency = "Bi-weekly";
          else if (avgDays <= 55)   frequency = "Monthly";
          else if (avgDays <= 100)  frequency = "Quarterly";
          else                      frequency = "Occasional";

          // Newsletters: recurring + "unsubscribe" keyword appears in subjects
          const hasUnsubscribe = g.subjects.some(s => s.includes("unsubscribe"));

          results.push({
            domain,
            email_count:       g.dates.length,
            sender_count:      g.senders.size,
            avg_interval_days: Math.round(avgDays * 10) / 10,
            frequency,
            is_newsletter:     hasUnsubscribe,
            last_date_unix:    g.dates[g.dates.length - 1]!,
            size_bytes:        g.size,
            sample_subjects:   [...new Set(g.subjects.slice(-5).map(s => s.slice(0, 60)))].slice(0, 3),
          });
        }

        return results
          .filter(r => r.frequency !== "Occasional")
          .sort((a, b) => b.email_count - a.email_count);
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

  ipcMain.handle("inboxpie:getProviders", () =>
    mailProviders.list().map((p) => ({
      ...p,
      detected: p.id === "apple-mail"
        ? fs.existsSync(path.join(os.homedir(), "Library", "Mail"))
        : p.id === "thunderbird"
          ? isThunderbirdInstalled()
          : true,
    })),
  );
}

function emitProgress(window: BrowserWindow | null, event: ProgressEvent): void {
  window?.webContents.send("inboxpie:event", event);
}

// ── populateScanDB ─────────────────────────────────────────────────────────────

function populateScanDB(
  messages: import("../../../shared/message-record").MessageRecord[],
  _options: import("../../../shared/message-record").FetchMailOptions,
  envelopeIndexPath?: string,
  mailProvider = "apple-mail",
): void {
  if (!messages.length) return;

  const mailboxMap = new Map<string, string>();
  for (const m of messages) {
    if (m.accountId && !mailboxMap.has(m.accountId)) {
      mailboxMap.set(m.accountId, m.account || m.accountId);
    }
  }
  for (const [id, name] of mailboxMap) {
    inboxPieDb.upsertMailbox(id, name, envelopeIndexPath, mailProvider);
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
