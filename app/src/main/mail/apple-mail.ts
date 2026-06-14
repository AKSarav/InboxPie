import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Track live scan subprocesses so they can be killed on reload/quit instead of
// lingering as orphaned CPU hogs (e.g. a 50k-mail .emlx walk).
const activeScans = new Set<ChildProcess>();

/** Kill all in-flight scan subprocesses. Returns how many were terminated. */
export function killActiveScans(): number {
  let n = 0;
  for (const child of activeScans) {
    try { child.kill("SIGTERM"); n++; } catch { /* already gone */ }
  }
  activeScans.clear();
  return n;
}

import type {
  FetchMailOptions,
  FetchMailResult,
  FolderInfo,
  MailAccount,
  MessageRecord,
  MoveDeleteResult,
} from "../../../shared/message-record";
import type { MailProvider } from "./provider";

// ── Mail root ──────────────────────────────────────────────────────────────

const MAIL_ROOT = path.join(os.homedir(), "Library", "Mail");

// ── Locate the Envelope Index SQLite database ──────────────────────────────

/**
 * Apple Mail stores its index at:
 *   ~/Library/Mail/MailData/Envelope Index          (older macOS)
 *   ~/Library/Mail/V10/MailData/Envelope Index      (macOS 10.15+, version # varies)
 */
function findEnvelopeIndex(): string | null {
  const direct = path.join(MAIL_ROOT, "MailData", "Envelope Index");
  if (fs.existsSync(direct)) return direct;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(MAIL_ROOT, { withFileTypes: true });
  } catch {
    return null;
  }

  const versionDirs = entries
    .filter((e) => e.isDirectory() && /^V\d+$/.test(e.name))
    .sort((a, b) => Number(b.name.slice(1)) - Number(a.name.slice(1)));

  for (const dir of versionDirs) {
    const candidate = path.join(MAIL_ROOT, dir.name, "MailData", "Envelope Index");
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Returns the highest-versioned Mail directory (e.g. ~/Library/Mail/V10).
 * This is where per-account UUID directories live.
 */
function findMailVersionRoot(): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(MAIL_ROOT, { withFileTypes: true });
  } catch {
    return null;
  }

  const versionDirs = entries
    .filter((e) => e.isDirectory() && /^V\d+$/.test(e.name))
    .sort((a, b) => Number(b.name.slice(1)) - Number(a.name.slice(1)));

  return versionDirs.length > 0 ? path.join(MAIL_ROOT, versionDirs[0].name) : null;
}

// ── Account name resolution: UUID → human-readable email/name ─────────────

/**
 * Session-level cache for UUID → name resolution.
 * Built once per app launch; cleared to null if you need a refresh.
 */
let _uuidNameCache: Map<string, string> | null = null;

/**
 * Build a Map<UPPERCASE_UUID, email_or_name> from three independent sources,
 * tried in order — each fills in any UUIDs the previous source missed:
 *
 *  1. ~/Library/Accounts/Accounts3.sqlite (or Accounts4.sqlite on macOS 13+)
 *     — macOS Internet Accounts database. Most accurate when present.
 *
 *  2. ~/Library/Mail/V{n}/UUID/*.plist — per-account XML plists.
 *     Covers older IMAP / local accounts on macOS < 12.
 *
 *  3. Envelope Index sent-folder query — sender address of Sent messages is
 *     always the account owner's email. Works on every macOS version because
 *     we always have access to the Envelope Index. This is the guaranteed
 *     fallback when the other two sources are unavailable.
 *
 * All sources run in-process (no subprocesses) so Full Disk Access granted
 * to this Electron app is always inherited correctly.
 */
function buildUuidToNameMap(): Map<string, string> {
  if (_uuidNameCache) return _uuidNameCache;
  const map = new Map<string, string>();
  fromInternetAccountsDb(map);
  fromMailDirectoryPlists(map);
  fromEnvelopeIndexSent(map);   // guaranteed fallback — always works
  _uuidNameCache = map;
  return map;
}

function openDbCopy(dbPath: string): { db: DatabaseSync; cleanup: () => void } | null {
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inboxpie-acct-"));
    const tmpCopy = path.join(tmpDir, path.basename(dbPath));
    fs.copyFileSync(dbPath, tmpCopy);
    const db = new DatabaseSync(tmpCopy);
    return {
      db,
      cleanup() {
        try { db.close(); } catch { /* ignore */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  } catch {
    return null;
  }
}

/** Source 1: macOS Internet Accounts database (handles EWS/Exchange). */
function fromInternetAccountsDb(map: Map<string, string>): void {
  const dbPath = path.join(os.homedir(), "Library", "Accounts", "Accounts3.sqlite");
  console.log("[InboxPie] Accounts3.sqlite path:", dbPath);
  console.log("[InboxPie] Accounts3.sqlite exists:", fs.existsSync(dbPath));
  if (!fs.existsSync(dbPath)) return;

  const handle = openDbCopy(dbPath);
  if (!handle) {
    console.log("[InboxPie] Accounts3.sqlite copy failed (permission?)");
    return;
  }

  const { db, cleanup } = handle;
  try {
    // List all tables first so we can see the actual schema
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      console.log("[InboxPie] Accounts3 tables:", JSON.stringify(tables));
    } catch (e) {
      console.log("[InboxPie] Could not list tables:", e);
    }

    type Row = { ZUNIQUEID: string; ZUSERNAME: string };
    const rows = db
      .prepare(
        "SELECT ZUNIQUEID, ZUSERNAME FROM ZACCOUNT " +
          "WHERE ZUNIQUEID IS NOT NULL AND ZUSERNAME IS NOT NULL AND ZUSERNAME != ''",
      )
      .all() as Row[];

    console.log("[InboxPie] ZACCOUNT rows:", JSON.stringify(rows));

    for (const { ZUNIQUEID, ZUSERNAME } of rows) {
      map.set(ZUNIQUEID.toUpperCase(), ZUSERNAME);
    }

    try {
      type PropRow = { ZUNIQUEID: string; ZVALUE: string };
      const propRows = db
        .prepare(
          "SELECT a.ZUNIQUEID, p.ZVALUE FROM ZACCOUNT a " +
            "JOIN ZACCOUNTPROPERTY p ON p.ZACCOUNT = a.Z_PK " +
            "WHERE p.ZNAME IN ('EmailAddress','email') " +
            "AND p.ZVALUE LIKE '%@%'",
        )
        .all() as PropRow[];

      console.log("[InboxPie] ZACCOUNTPROPERTY email rows:", JSON.stringify(propRows));

      for (const { ZUNIQUEID, ZVALUE } of propRows) {
        if (!map.has(ZUNIQUEID.toUpperCase())) {
          map.set(ZUNIQUEID.toUpperCase(), ZVALUE);
        }
      }
    } catch (e) {
      console.log("[InboxPie] ZACCOUNTPROPERTY query failed:", String(e));
    }
  } catch (e) {
    console.log("[InboxPie] ZACCOUNT query failed:", String(e));
  } finally {
    cleanup();
  }
}

/** Source 2: per-account XML plists in the Mail directory (older IMAP / local). */
function fromMailDirectoryPlists(map: Map<string, string>): void {
  const versionRoot = findMailVersionRoot();
  if (!versionRoot) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(versionRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    if (map.has(entry.name.toUpperCase())) continue;

    // Log what's actually in the UUID dir so we can discover the right file
    const accountDir = path.join(versionRoot, entry.name);
    try {
      const contents = fs.readdirSync(accountDir);
      console.log("[InboxPie] UUID dir", entry.name, "contents:", JSON.stringify(contents));
    } catch { /* permission — skip */ }

    const name = readXmlPlistAccountName(accountDir);
    if (name) map.set(entry.name.toUpperCase(), name);
  }
}

/**
 * Source 3: Query the Envelope Index for senders of messages in Sent folders.
 * The sender of Sent messages = the account owner's email — reliable for
 * Exchange, Gmail, IMAP. Works on every macOS version since we always have
 * read access to the Envelope Index.
 */
function fromEnvelopeIndexSent(map: Map<string, string>): void {
  const dbPath = findEnvelopeIndex();
  if (!dbPath) return;
  const { db, cleanup } = openEnvelopeIndex(dbPath);
  try {
    type Row = { url: string; address: string };
    const rows = db.prepare(`
      SELECT DISTINCT mb.url, a.address
      FROM messages m
      JOIN mailboxes mb ON m.mailbox = mb.ROWID
      JOIN addresses a ON m.sender = a.ROWID
      WHERE a.address LIKE '%@%'
        AND LOWER(mb.url) LIKE '%sent%'
      LIMIT 200
    `).all() as Row[];

    console.log("[InboxPie] Envelope Index sent-folder rows:", rows.length);

    for (const { url, address } of rows) {
      const parsed = parseMailboxUrl(url);
      if (!parsed || map.has(parsed.uuid)) continue;
      map.set(parsed.uuid, address);
    }
  } catch (e) {
    console.log("[InboxPie] Envelope Index sent query failed:", String(e));
  } finally {
    cleanup();
  }
}

/**
 * Try to read AccountName / EmailAddresses from XML plist files.
 * Binary plists return null (those accounts are handled by source 1).
 */
function readXmlPlistAccountName(accountDir: string): string | null {
  const candidates = [
    path.join(accountDir, ".mbox", "Info.plist"),
    path.join(accountDir, "AccountInfo.plist"),
    path.join(accountDir, "Info.plist"),
  ];

  for (const plistPath of candidates) {
    if (!fs.existsSync(plistPath)) continue;
    try {
      const raw = fs.readFileSync(plistPath, "utf8");
      // Only XML plists start with "<?xml" or "<!DOCTYPE"
      if (!raw.trimStart().startsWith("<")) continue;

      const nameMatch = raw.match(/<key>AccountName<\/key>\s*<string>([^<]+)<\/string>/);
      if (nameMatch?.[1]?.trim()) return nameMatch[1].trim();

      const emailMatch = raw.match(
        /<key>EmailAddresses<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
      );
      if (emailMatch?.[1]?.trim()) return emailMatch[1].trim();
    } catch { /* unreadable — try next */ }
  }

  return null;
}

// ── Open the Envelope Index safely ────────────────────────────────────────

/**
 * Copy the Envelope Index to a temp file before opening.
 *
 * Mail.app holds an exclusive write lock on the live database. Opening the
 * copy avoids SQLITE_BUSY / SQLITE_LOCKED errors during discovery queries.
 * The temp directory is deleted in `cleanup()`.
 */
function openEnvelopeIndex(dbPath: string): { db: DatabaseSync; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inboxpie-env-"));
  const tmpCopy = path.join(tmpDir, "Envelope Index");

  try {
    fs.copyFileSync(dbPath, tmpCopy);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const msg = String(err);
    if (msg.includes("EPERM") || msg.includes("EACCES") || msg.includes("permission")) {
      throw new Error(
        "Full Disk Access is required. Open System Settings → Privacy & Security → " +
          "Full Disk Access and enable this app.",
      );
    }
    throw err;
  }

  const db = new DatabaseSync(tmpCopy);

  return {
    db,
    cleanup() {
      try { db.close(); } catch { /* already closed */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ── URL parsing ────────────────────────────────────────────────────────────

/**
 * The mailboxes.url column has the form:
 *   {scheme}://{UUID}/{folder-path}
 *
 * e.g.
 *   ews://D990DE0B-49A8-4F60-8825-4AC63EC506CF/AI-NewsLetter
 *   local://C649E915-45EC-48B4-A36F-990A684BBC33/SendLater
 *   imap://ABCDabc1-2345-6789-ABCD-EF0123456789/INBOX/Subfolder
 */
interface ParsedMailboxUrl {
  /** UUID (uppercase), matches the account directory name on disk. */
  uuid: string;
  /** Protocol scheme normalised to a human-readable type. */
  accountType: string;
  /** Decoded folder path, e.g. "AI-NewsLetter" or "INBOX/Subfolder". */
  folderPath: string;
}

function parseMailboxUrl(url: string): ParsedMailboxUrl | null {
  if (!url) return null;
  try {
    // Parse the raw URL directly — do NOT pre-decode the whole string; spaces
    // in folder names would produce an invalid URL ("Sent Items" has a raw space).
    // The WHATWG URL parser re-encodes path segments, so pathname comes back
    // with %20-encoded spaces. We decode each segment individually afterward.
    const parsed = new URL(url.trim());

    const uuid = parsed.host.toUpperCase();
    if (!uuid) return null;

    // Decode each path segment individually so folder names are human-readable
    // (e.g. "Sent%20Items" → "Sent Items", "AI-NewsLetter" stays as-is).
    const segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map(s => { try { return decodeURIComponent(s); } catch { return s; } });

    const folderPath = segments.join("/");

    return {
      uuid,
      accountType: normalizeScheme(parsed.protocol.replace(/:$/, "")),
      folderPath,
    };
  } catch {
    return null;
  }
}

function normalizeScheme(scheme: string): string {
  switch (scheme.toLowerCase()) {
    case "imap":     return "imap";
    case "pop3":
    case "pop":      return "pop3";
    case "gmail":
    case "gm":       return "gmail";
    case "exchange":
    case "ews":      return "exchange";
    case "local":
    case "mailbox":  return "local";
    default:         return scheme.toLowerCase();
  }
}

function folderTypeFromName(name: string): string {
  const lower = (name || "").toLowerCase();
  if (lower.includes("inbox"))                              return "inbox";
  if (lower.includes("sent"))                              return "sent";
  if (lower.includes("trash") || lower.includes("deleted")) return "trash";
  if (lower.includes("junk")  || lower.includes("spam"))   return "junk";
  if (lower.includes("archive"))                           return "archives";
  if (lower.includes("draft"))                             return "drafts";
  return "custom";
}

// ── Scan script (for fetchMessages) ───────────────────────────────────────

function scanScriptPath(): string {
  const devScript = path.join(app.getAppPath(), "scripts", "scan-apple-mail.py");
  if (fs.existsSync(devScript)) return devScript;
  return path.join(process.resourcesPath, "scripts", "scan-apple-mail.py");
}

function runScanScript(args: string[]): Promise<{ engine: string; messages: MessageRecord[] }> {
  return new Promise((resolve, reject) => {
    const python = process.env["INBOXPIE_PYTHON"] ?? "python3";
    const script = scanScriptPath();
    const child = spawn(python, [script, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeScans.add(child);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => { activeScans.delete(child); reject(err); });
    child.on("close", (code) => {
      activeScans.delete(child);
      if (code !== 0) {
        let message = stderr.trim() || stdout.trim() || `Scan failed with exit code ${code}`;
        try {
          const parsed = JSON.parse(stderr.trim() || stdout.trim());
          if (parsed.error) message = parsed.error;
        } catch { /* keep raw message */ }
        reject(new Error(message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Invalid scan output: ${String(error)}`));
      }
    });
  });
}

function folderFiltersFromSelections(
  folderSelections: FetchMailOptions["folderSelections"],
): string {
  if (!folderSelections?.length) return "";
  const names = folderSelections.map((item) => item.path.split("/").pop() || item.path);
  return [...new Set(names)].join(",");
}

/**
 * Run the scan script in emlx mode with body extraction enabled.
 * Used by the content-mode vector indexer so it gets real email body text.
 * ``folders`` is a list of mailbox folder names to filter (e.g. ["INBOX", "Sent"]).
 */
/**
 * Fetch messages for the given folder names, for (re)indexing.
 * includeBody=true forces emlx mode and extracts body text (Full Content);
 * includeBody=false uses the fast envelope-index scan (Metadata only).
 */
export async function fetchMessagesForFolders(folders: string[], includeBody: boolean): Promise<MessageRecord[]> {
  const args: string[] = includeBody
    ? ["--mode", "emlx", "--include-body"]
    : ["--mode", "auto"];
  if (folders.length > 0) {
    args.push("--folders", [...new Set(folders)].join(","));
  }
  const result = await runScanScript(args);
  return result.messages;
}

// ── Debug helper ──────────────────────────────────────────────────────────

export function debugAccountResolution(): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // 1. Check Accounts3.sqlite
  const acctDbPath = path.join(os.homedir(), "Library", "Accounts", "Accounts3.sqlite");
  result["accounts3_path"]   = acctDbPath;
  result["accounts3_exists"] = fs.existsSync(acctDbPath);

  if (fs.existsSync(acctDbPath)) {
    try {
      const handle = openDbCopy(acctDbPath);
      if (handle) {
        const { db, cleanup } = handle;
        try {
          const rows = db.prepare("SELECT ZUNIQUEID, ZUSERNAME, ZIDENTIFIER FROM ZACCOUNT LIMIT 20").all();
          result["accounts3_rows"] = rows;

          // Check if ZACCOUNTPROPERTY exists
          try {
            const propRows = db.prepare(
              "SELECT a.ZUNIQUEID, p.ZNAME, p.ZVALUE FROM ZACCOUNT a JOIN ZACCOUNTPROPERTY p ON p.ZACCOUNT = a.Z_PK LIMIT 20"
            ).all();
            result["accounts3_property_rows"] = propRows;
          } catch (e) {
            result["accounts3_property_error"] = String(e);
          }
        } finally {
          cleanup();
        }
      }
    } catch (e) {
      result["accounts3_error"] = String(e);
    }
  }

  // 2. Check Mail version root and UUID directories
  const versionRoot = findMailVersionRoot();
  result["mail_version_root"] = versionRoot;

  if (versionRoot) {
    try {
      const entries = fs.readdirSync(versionRoot, { withFileTypes: true });
      const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
      const uuidDirs = entries.filter(e => e.isDirectory() && UUID_RE.test(e.name)).map(e => e.name);
      result["uuid_dirs"] = uuidDirs;

      // Check what files exist inside each UUID dir
      const plistChecks: Record<string, unknown> = {};
      for (const uuid of uuidDirs) {
        const accountDir = path.join(versionRoot, uuid);
        const candidates = [
          path.join(accountDir, ".mbox", "Info.plist"),
          path.join(accountDir, "AccountInfo.plist"),
          path.join(accountDir, "Info.plist"),
        ];
        plistChecks[uuid] = candidates.map(p => ({
          path: p,
          exists: fs.existsSync(p),
        }));
      }
      result["plist_checks"] = plistChecks;
    } catch (e) {
      result["mail_dir_error"] = String(e);
    }
  }

  // 3. Run the actual resolution
  const nameMap = buildUuidToNameMap();
  result["resolved_names"] = Object.fromEntries(nameMap);

  return result;
}

// ── Provider ───────────────────────────────────────────────────────────────

export class AppleMailProvider implements MailProvider {
  readonly id = "apple-mail";
  readonly name = "Apple Mail";

  /**
   * Enumerate accounts by:
   *   1. Querying `mailboxes` in the Envelope Index → distinct UUIDs
   *   2. Resolving each UUID to a human-readable name via Info.plist on disk
   */
  async getAccounts(): Promise<MailAccount[]> {
    const dbPath = findEnvelopeIndex();
    if (!dbPath) return [];

    // Resolve UUID directories → display names before opening the DB copy
    const nameMap = buildUuidToNameMap();

    const { db, cleanup } = openEnvelopeIndex(dbPath);
    try {
      type Row = { url: string };
      const rows = db
        .prepare("SELECT DISTINCT url FROM mailboxes WHERE url IS NOT NULL AND url != ''")
        .all() as Row[];

      const seen = new Map<string, MailAccount>();
      for (const { url } of rows) {
        const parsed = parseMailboxUrl(url);
        if (!parsed || seen.has(parsed.uuid)) continue;

        // Use the resolved display name (email) when available; fall back to UUID
        const displayName = nameMap.get(parsed.uuid) ?? parsed.uuid;

        seen.set(parsed.uuid, {
          id: parsed.uuid,          // UUID used as stable id for IPC / accountId filter
          name: displayName,        // Human-readable: email address or account label
          type: parsed.accountType, // "imap", "exchange", "local", …
        });
      }

      return [...seen.values()];
    } finally {
      cleanup();
    }
  }

  /**
   * List folders for one account (or all accounts when accountId is omitted).
   * Queries the mailboxes table and filters by UUID.
   */
  async getFolders(accountId?: string | null): Promise<FolderInfo[]> {
    const dbPath = findEnvelopeIndex();
    if (!dbPath) return [];

    const nameMap = buildUuidToNameMap();
    const { db, cleanup } = openEnvelopeIndex(dbPath);
    try {
      type Row = { url: string; total_count: number; unread_count: number };
      const rows = db
        .prepare(
          "SELECT url, total_count, unread_count FROM mailboxes WHERE url IS NOT NULL AND url != ''",
        )
        .all() as Row[];

      const folders: FolderInfo[] = [];
      for (const { url, total_count, unread_count } of rows) {
        const parsed = parseMailboxUrl(url);
        if (!parsed) continue;
        if (accountId && parsed.uuid !== accountId.toUpperCase()) continue;
        if (!parsed.folderPath) continue;

        const segments = parsed.folderPath.split("/");
        const name = segments[segments.length - 1];
        const accountName = nameMap.get(parsed.uuid) ?? parsed.uuid;

        folders.push({
          path: parsed.folderPath,
          name,
          type: folderTypeFromName(name),
          accountId: parsed.uuid,
          accountName,
          depth: segments.length - 1,
          totalCount: total_count ?? 0,
          unreadCount: unread_count ?? 0,
        });
      }

      return folders.sort((a, b) => {
        const byAccount = a.accountName.localeCompare(b.accountName);
        return byAccount !== 0 ? byAccount : a.path.localeCompare(b.path);
      });
    } finally {
      cleanup();
    }
  }

  async fetchMessages(
    options: FetchMailOptions,
    onProgress?: (count: number) => void,
  ): Promise<FetchMailResult> {
    const args = ["--mode", "auto"];
    if (options.accountId) args.push("--account-id", options.accountId);

    const folderFilter = folderFiltersFromSelections(options.folderSelections);
    if (folderFilter) args.push("--folders", folderFilter);

    onProgress?.(0);
    const result = await runScanScript(args);
    onProgress?.(result.messages.length);

    const accounts = await this.getAccounts();
    const targetAccounts = options.accountId
      ? accounts.filter((a) => a.id === options.accountId)
      : accounts;

    return {
      messages:            result.messages,
      total:               result.messages.length,
      accounts:            targetAccounts,
      envelopeIndexPath:   findEnvelopeIndex() ?? undefined,
    };
  }

  async deleteMessages(_messageIds: Array<string | number>): Promise<MoveDeleteResult> {
    return {
      success: false,
      error:
        "Move to Trash is not yet supported for Apple Mail in the desktop app. " +
        "Use the Thunderbird extension for interactive cleanup, or export your selection as CSV.",
    };
  }

  async moveMessagesToFolder(
    _messageIds: Array<string | number>,
    _accountId: string,
    _folderPath: string,
  ): Promise<MoveDeleteResult> {
    return {
      success: false,
      error:
        "Move to Folder is not yet supported for Apple Mail in the desktop app. " +
          "Use the Thunderbird extension for interactive cleanup.",
    };
  }

  async openMessage(_messageId: string | number): Promise<{ success: boolean; error?: string }> {
    return {
      success: false,
      error: "Opening messages in Mail.app is not yet implemented in the desktop app.",
    };
  }
}

export const appleMailProvider = new AppleMailProvider();
