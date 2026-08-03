/**
 * Thunderbird mail provider — reads mbox files directly in Node.js.
 * No Python subprocess. No external npm dependencies.
 *
 * Discovery:  ~/Library/Thunderbird/profiles.ini → prefs.js → mail directories
 * Scanning:   mbox file parser (RFC 2822 headers + optional MIME body)
 * Actions:    all stubs (open Thunderbird to manage messages)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  FetchMailOptions,
  FetchMailResult,
  FolderInfo,
  MailAccount,
  MessageRecord,
  MoveDeleteResult,
} from "../../../shared/message-record";
import type { MailProvider } from "./provider";
import {
  decodeRfc2047,
  extractBodyPreview,
  folderTypeFromName,
  parseDateString,
  parseSender,
  unixSecsToDateParts,
} from "./email-parser";

// ── Thunderbird paths ──────────────────────────────────────────────────────

const TB_ROOT        = path.join(os.homedir(), "Library", "Thunderbird");
const TB_PROFILES_INI = path.join(TB_ROOT, "profiles.ini");

/** Returns true when Thunderbird has been installed (profiles.ini exists). */
export function isThunderbirdInstalled(): boolean {
  return fs.existsSync(TB_PROFILES_INI);
}

// ── profiles.ini parser ────────────────────────────────────────────────────

interface TbProfile {
  name:      string;
  path:      string;   // resolved absolute path
  isDefault: boolean;
}

function buildProfile(kv: Record<string, string>): TbProfile | null {
  const profilePath = kv["Path"];
  if (!profilePath) return null;
  const isRelative   = kv["IsRelative"] !== "0";
  const resolvedPath = isRelative ? path.join(TB_ROOT, profilePath) : profilePath;
  return {
    name:      kv["Name"]    ?? "default",
    path:      resolvedPath,
    isDefault: kv["Default"] === "1",
  };
}

interface ParsedIni {
  profiles: TbProfile[];
  /** Path from [InstallXXXX] Default= — the locked active profile for Thunderbird 78+ */
  installDefault: string | null;
}

function parseProfilesIni(): ParsedIni {
  let content: string;
  try {
    content = fs.readFileSync(TB_PROFILES_INI, "utf8");
  } catch {
    return { profiles: [], installDefault: null };
  }

  const profiles: TbProfile[] = [];
  let installDefault: string | null = null;

  // Parse INI line by line; track current section
  let sectionKv: Record<string, string> = {};
  let sectionHeader = "";

  function flushSection(): void {
    if (/^\[Profile\d+\]$/i.test(sectionHeader)) {
      const p = buildProfile(sectionKv);
      if (p) profiles.push(p);
    } else if (/^\[Install/i.test(sectionHeader)) {
      // [InstallXXXX] Default= points to the currently locked active profile path
      const raw = sectionKv["Default"];
      if (raw) {
        const isRelative = sectionKv["Locked"] !== undefined || !path.isAbsolute(raw);
        installDefault = isRelative ? path.join(TB_ROOT, raw) : raw;
      }
    }
    sectionKv = {};
    sectionHeader = "";
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      flushSection();
      sectionHeader = line;
    } else {
      const eq = line.indexOf("=");
      if (eq > 0) sectionKv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  flushSection();

  return { profiles, installDefault };
}

function detectThunderbirdProfile(): string | null {
  const { profiles, installDefault } = parseProfilesIni();

  // Priority 1: [InstallXXXX] Default= — most reliable on Thunderbird 78+
  if (installDefault && fs.existsSync(installDefault)) return installDefault;

  // Priority 2: [Profile] with Default=1
  const byDefault = profiles.find((p) => p.isDefault && fs.existsSync(p.path));
  if (byDefault) return byDefault.path;

  // Priority 3: first non-empty profile (has prefs.js)
  const withPrefs = profiles.find((p) => fs.existsSync(path.join(p.path, "prefs.js")));
  if (withPrefs) return withPrefs.path;

  return null;
}

// ── prefs.js parser ────────────────────────────────────────────────────────

interface TbServerInfo {
  serverKey:   string;
  hostname:    string;
  type:        string;
  userName:    string;
  prettyName:  string;
  directory:   string;
}

interface TbAccountInfo {
  accountKey: string;
  serverKey:  string;
  server:     TbServerInfo;
}

function parsePrefsJs(profileDir: string): TbAccountInfo[] {
  const prefsPath = path.join(profileDir, "prefs.js");
  let content: string;
  try {
    content = fs.readFileSync(prefsPath, "utf8");
  } catch {
    return [];
  }

  // Extract only quoted-string values — all fields we need are strings
  const prefMap = new Map<string, string>();
  const re = /user_pref\("([^"]+)",\s*"([^"]*)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    prefMap.set(m[1], m[2]);
  }

  const accountKeys = (prefMap.get("mail.accountmanager.accounts") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const accounts: TbAccountInfo[] = [];
  for (const accountKey of accountKeys) {
    const serverKey = prefMap.get(`mail.account.${accountKey}.server`);
    if (!serverKey) continue;

    let directory = prefMap.get(`mail.server.${serverKey}.directory`) ?? "";
    // Resolve profile-relative paths like [ProfD]ImapMail/imap.gmail.com
    if (directory.startsWith("[ProfD]")) {
      directory = path.join(profileDir, directory.slice("[ProfD]".length));
    }
    // Fallback: directory-rel when absolute directory is absent (Thunderbird 78+)
    if (!directory) {
      const rel = prefMap.get(`mail.server.${serverKey}.directory-rel`) ?? "";
      if (rel.startsWith("[ProfD]")) {
        directory = path.join(profileDir, rel.slice("[ProfD]".length));
      } else if (rel) {
        directory = path.join(profileDir, rel);
      }
    }
    if (!directory) continue;

    const hostname   = prefMap.get(`mail.server.${serverKey}.hostname`)  ?? "";
    const userName   = prefMap.get(`mail.server.${serverKey}.userName`)   ?? "";
    const prettyName = prefMap.get(`mail.server.${serverKey}.name`) ?? (hostname || userName);
    const type       = prefMap.get(`mail.server.${serverKey}.type`)       ?? "imap";

    accounts.push({
      accountKey,
      serverKey,
      server: { serverKey, hostname, type, userName, prettyName, directory },
    });
  }

  return accounts;
}

// ── mbox directory walker ──────────────────────────────────────────────────

interface MboxEntry {
  folderName: string;
  fsPath:     string;
  depth:      number;
}

function walkMboxDir(mailDir: string, prefix = "", depth = 0): MboxEntry[] {
  const results: MboxEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(mailDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const ext = path.extname(entry.name);
    if (ext === ".msf") continue;

    if (entry.isDirectory() && ext === ".sbd") {
      const parentName  = path.basename(entry.name, ".sbd");
      const childPrefix = prefix ? `${prefix}/${parentName}` : parentName;
      results.push(...walkMboxDir(path.join(mailDir, entry.name), childPrefix, depth + 1));
    } else if (entry.isFile() && ext === "") {
      const folderName = prefix ? `${prefix}/${entry.name}` : entry.name;
      results.push({ folderName, fsPath: path.join(mailDir, entry.name), depth });
    }
  }

  return results;
}

// ── mbox message parser ────────────────────────────────────────────────────


/**
 * Parse one mbox message chunk into a MessageRecord (or null to skip).
 * `chunk` may be headers-only; pass `declaredSize` for the true message byte count
 * when the body was not buffered (metadata-only scan).
 */
function parseMboxMessage(
  chunk: Buffer,
  idx: number,
  folderName: string,
  accountName: string,
  accountId: string,
  includeBody: boolean,
  declaredSize?: number,
): MessageRecord | null {
  // Skip "From ..." envelope line
  const firstNl = chunk.indexOf(0x0a);
  if (firstNl === -1) return null;
  const messageBytes = chunk.slice(firstNl + 1);

  const headerSection = extractHeaderSection(messageBytes);
  const headers = parseRawHeaders(headerSection);

  // X-Mozilla-Status bitmask: 0x0001=read, 0x0004=flagged, 0x0008=expunged
  const statusHex = headers.get("x-mozilla-status") ?? "0000";
  let statusBits = 0;
  try { statusBits = parseInt(statusHex, 16); } catch { /* ignore */ }
  if (statusBits & 0x0008) return null; // expunged (deleted-not-compacted)

  const isRead    = !!(statusBits & 0x0001);
  const isFlagged = !!(statusBits & 0x0004);

  const { name: senderName, email: senderEmail, author } = parseSender(headers.get("from") ?? "");
  const domain = senderEmail.includes("@") ? senderEmail.split("@")[1]!.toLowerCase() : "unknown";

  const dateParts = parseDateString(headers.get("date") ?? "");

  const rawSubject = headers.get("subject") ?? "";
  const subject    = decodeRfc2047(rawSubject) || "(No Subject)";

  const rawMsgId = (headers.get("message-id") ?? "").replace(/^<|>$/g, "").trim();
  const msgId    = rawMsgId || `tb:${accountId}:${folderName}:${idx}`;

  const bodyPreview = includeBody ? extractBodyPreview(messageBytes) : "";

  return {
    id:          msgId,
    subject,
    author,
    senderName,
    senderEmail,
    domain,
    date:        dateParts.date,
    year:        dateParts.year,
    month:       dateParts.month,
    monthName:   dateParts.monthName,
    read:        isRead,
    flagged:     isFlagged,
    folder:      folderName,
    folderType:  folderTypeFromName(folderName.split("/").pop() ?? folderName),
    account:     accountName,
    accountId,
    tags:        [],
    size:        declaredSize ?? messageBytes.length,
  };
}

/**
 * Return the byte offset immediately after the header-body blank line
 * (\n\n or \r\n\r\n), or -1 if not yet found.
 */
function findHeaderBoundary(buf: Buffer): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i + 2;
    if (
      buf[i] === 0x0d && buf[i + 1] === 0x0a &&
      i + 3 < buf.length &&
      buf[i + 2] === 0x0d && buf[i + 3] === 0x0a
    ) return i + 4;
  }
  return -1;
}

/** Extract the header section (everything before the first blank line). */
function extractHeaderSection(msg: Buffer): string {
  // Look for \n\n (LF only) or \r\n\r\n (CRLF)
  for (let i = 0; i < msg.length - 1; i++) {
    if (msg[i] === 0x0a && msg[i + 1] === 0x0a) {
      return msg.slice(0, i).toString("utf8");
    }
    if (msg[i] === 0x0d && msg[i + 1] === 0x0a && msg[i + 2] === 0x0d && msg[i + 3] === 0x0a) {
      return msg.slice(0, i).toString("utf8");
    }
  }
  return msg.toString("utf8"); // no body
}

/** Parse RFC 2822 headers with folding support, returns Map<lowercase-name, value>. */
function parseRawHeaders(headerText: string): Map<string, string> {
  const headers = new Map<string, string>();
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = line.slice(0, colon).toLowerCase().trim();
    const val = line.slice(colon + 1).trim();
    if (!headers.has(key)) headers.set(key, val);
  }
  return headers;
}

/** Yield every N messages to keep the event loop alive during large mbox scans. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const MBOX_SEP_BUF = Buffer.from("\nFrom ");

/**
 * Count messages in an mbox file by scanning "From " separator lines in 64KB chunks.
 * Works for any file size (even >2GB) — streams in 64KB chunks without loading into memory.
 * Returns undefined only for permission/access errors.
 */
function countMboxMessages(fsPath: string): number | undefined {
  let fd: number;
  let size: number;
  try {
    const stat = fs.statSync(fsPath);
    size = stat.size;
    if (size === 0) return 0;
    fd = fs.openSync(fsPath, "r");
  } catch {
    return undefined;
  }

  const CHUNK = 65536;
  const overlap = MBOX_SEP_BUF.length - 1; // 5 bytes
  const buf = Buffer.allocUnsafe(CHUNK);
  const tail = Buffer.allocUnsafe(overlap);
  let count = 0;
  let fileOffset = 0;
  let tailLen = 0;

  try {
    // Check if file starts with "From " (first message in mbox)
    const head = Buffer.allocUnsafe(5);
    fs.readSync(fd, head, 0, 5, 0);
    if (head.toString("ascii", 0, 5) === "From ") count = 1;

    while (fileOffset < size) {
      const toRead = Math.min(CHUNK, size - fileOffset);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, fileOffset);
      if (bytesRead === 0) break;
      fileOffset += bytesRead;

      // Search in [tail(overlap) + chunk] to catch separators split across chunks
      const window = Buffer.concat([tail.subarray(0, tailLen), buf.subarray(0, bytesRead)]);
      let pos = 0;
      while (pos < window.length) {
        const idx = window.indexOf(MBOX_SEP_BUF, pos);
        if (idx === -1) break;
        count++;
        pos = idx + MBOX_SEP_BUF.length;
      }

      // Preserve last `overlap` bytes for next iteration
      tailLen = Math.min(overlap, bytesRead);
      buf.copy(tail, 0, bytesRead - tailLen, bytesRead);
    }
  } catch {
    return undefined;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }

  return count;
}

/**
 * Scan an mbox file using a streaming reader so files of any size work.
 *
 * For metadata-only scans (includeBody=false) we buffer only the header section
 * of each message (up to the first blank line) and count body bytes without
 * storing them. This keeps per-message memory to ~a few KB regardless of
 * attachment size.
 *
 * For indexing scans (includeBody=true) the full message is buffered so the
 * body preview can be extracted.
 */
async function scanMboxFile(
  fsPath: string,
  folderName: string,
  accountName: string,
  accountId: string,
  includeBody: boolean,
  onProgress?: (count: number) => void,
): Promise<MessageRecord[]> {
  const OVERLAP = MBOX_SEP_BUF.length - 1; // 5 bytes — detect separators that straddle chunk boundaries

  const records: MessageRecord[] = [];
  let msgIdx = 0;

  // Per-message accumulation state
  let msgParts: Buffer[] = [];  // header bytes (+ full body when includeBody=true)
  let headerDone = false;       // true once \n\n / \r\n\r\n found in current message
  let totalMsgBytes = 0;        // running byte count for current message (header + body)

  const flushMsg = async () => {
    if (msgParts.length === 0 && totalMsgBytes === 0) return;
    const buf = Buffer.concat(msgParts);
    const size = totalMsgBytes;
    msgParts = [];
    headerDone = false;
    totalMsgBytes = 0;
    if (buf.length === 0) return;
    try {
      // Pass declaredSize so parseMboxMessage reports the true size even when
      // buf contains only the header section.
      const r = parseMboxMessage(buf, msgIdx, folderName, accountName, accountId, includeBody, size);
      if (r) records.push(r);
    } catch { /* skip malformed */ }
    msgIdx++;
    if (msgIdx % 200 === 0) { await yieldToEventLoop(); onProgress?.(records.length); }
  };

  /**
   * Add bytes from the current chunk window to the per-message accumulator.
   * When !includeBody and headers are already complete, bytes are counted only.
   */
  const addBytes = (bytes: Buffer) => {
    if (bytes.length === 0) return;
    totalMsgBytes += bytes.length;

    if (includeBody || !headerDone) {
      msgParts.push(bytes);

      // Check if we just crossed the header-body boundary (\n\n or \r\n\r\n).
      // We only need to do this for metadata scans; once found, body bytes are
      // counted but not stored.
      if (!includeBody && !headerDone) {
        const combined = Buffer.concat(msgParts);
        const boundary = findHeaderBoundary(combined);
        if (boundary !== -1) {
          headerDone = true;
          // Discard body bytes already buffered — keep only the header portion.
          msgParts = [combined.subarray(0, boundary)];
        }
      }
    }
    // else: headerDone && !includeBody → byte already counted in totalMsgBytes; don't store
  };

  let stream: import("fs").ReadStream;
  try {
    stream = fs.createReadStream(fsPath, { highWaterMark: 256 * 1024 });
  } catch {
    return [];
  }

  // Carry the last OVERLAP bytes from each chunk into the next iteration
  // so that a "\nFrom " separator straddling a chunk boundary is detected.
  let carry = Buffer.alloc(0);
  let started = false;

  try {
    for await (const raw of stream) {
      const chunk: Buffer = carry.length ? Buffer.concat([carry, raw as Buffer]) : raw as Buffer;
      carry = Buffer.alloc(0);

      let pos = 0;

      if (!started) {
        if (chunk.length >= 5 && chunk.subarray(0, 5).toString("ascii") === "From ") {
          started = true;
        } else {
          const idx = chunk.indexOf(MBOX_SEP_BUF);
          if (idx === -1) {
            carry = Buffer.from(chunk.length >= OVERLAP ? chunk.subarray(-OVERLAP) : chunk);
            continue;
          }
          pos = idx + 1; // skip the leading \n; next message starts at "From "
          started = true;
        }
      }

      // Scan the chunk for message separators
      while (true) {
        const idx = chunk.indexOf(MBOX_SEP_BUF, pos);
        if (idx === -1) {
          // No separator in this chunk — buffer safe bytes and carry the tail
          const safeEnd = Math.max(pos, chunk.length - OVERLAP);
          addBytes(chunk.subarray(pos, safeEnd));
          carry = Buffer.from(chunk.subarray(safeEnd));
          break;
        }
        // Separator found: everything from pos to idx belongs to the current message
        addBytes(chunk.subarray(pos, idx));
        await flushMsg();
        pos = idx + 1; // skip \n; next message starts at "From "
      }
    }
  } catch {
    return records;
  }

  // Flush carry bytes and the last message
  if (carry.length) addBytes(carry);
  await flushMsg();

  return records;
}

// ── Provider ───────────────────────────────────────────────────────────────

export class ThunderbirdProvider implements MailProvider {
  readonly id   = "thunderbird";
  readonly name = "Thunderbird";

  // Lazy-initialised per app session
  private _profileDir: string | null | undefined = undefined;
  private _accounts: TbAccountInfo[] | undefined = undefined;

  private getProfileDir(): string | null {
    if (this._profileDir === undefined) this._profileDir = detectThunderbirdProfile();
    return this._profileDir;
  }

  private getTbAccounts(): TbAccountInfo[] {
    if (this._accounts === undefined) {
      const dir = this.getProfileDir();
      this._accounts = dir ? parsePrefsJs(dir) : [];
    }
    return this._accounts;
  }

  async getAccounts(): Promise<MailAccount[]> {
    return this.getTbAccounts().map((a) => ({
      id:   `tb_${a.serverKey}`, // Prefix with "tb_" for Thunderbird provider
      name: a.server.prettyName || a.server.userName || a.server.hostname,
      type: a.server.type,
    }));
  }

  async getFolders(accountId?: string | null): Promise<FolderInfo[]> {
    // If accountId is prefixed (tb_<serverKey>), extract the serverKey part for filtering
    const filterServerKey = accountId?.startsWith("tb_") ? accountId.slice(3) : accountId;

    const accounts = filterServerKey
      ? this.getTbAccounts().filter((a) => a.serverKey === filterServerKey)
      : this.getTbAccounts();

    const folders: FolderInfo[] = [];

    for (const acct of accounts) {
      const { directory } = acct.server;
      if (!directory || !fs.existsSync(directory)) continue;

      const accountName = acct.server.prettyName || acct.server.userName || acct.server.hostname;

      for (const { folderName, fsPath, depth } of walkMboxDir(directory)) {
        const namePart = folderName.split("/").pop() ?? folderName;
        folders.push({
          path:        folderName,
          name:        namePart,
          type:        folderTypeFromName(namePart),
          accountId:   `tb_${acct.serverKey}`, // Return prefixed ID
          accountName,
          depth,
          totalCount:  countMboxMessages(fsPath),
          unreadCount: undefined,
        });
      }
    }

    return folders.sort((a, b) => {
      const byAcct = a.accountName.localeCompare(b.accountName);
      return byAcct !== 0 ? byAcct : a.path.localeCompare(b.path);
    });
  }

  async fetchMessages(
    options: FetchMailOptions,
    onProgress?: (count: number) => void,
  ): Promise<FetchMailResult> {
    // Strip provider prefix from accountId if present (e.g. "tb_<serverKey>" → "<serverKey>")
    const filterServerKey = options.accountId?.startsWith("tb_") ? options.accountId.slice(3) : options.accountId;

    const accounts = filterServerKey
      ? this.getTbAccounts().filter((a) => a.serverKey === filterServerKey)
      : this.getTbAccounts();

    // Build folder name filter set (by last path segment, case-insensitive)
    let folderFilter: Set<string> | undefined;
    if (options.folderSelections?.length) {
      folderFilter = new Set(
        options.folderSelections.map((s) => (s.path.split("/").pop() ?? s.path).toLowerCase()),
      );
    }

    const records: MessageRecord[] = [];
    onProgress?.(0);

    for (const acct of accounts) {
      const { directory } = acct.server;
      if (!directory || !fs.existsSync(directory)) continue;

      const accountName = acct.server.prettyName || acct.server.userName || acct.server.hostname;
      const mboxEntries = walkMboxDir(directory);

      for (const { folderName, fsPath } of mboxEntries) {
        const leaf = (folderName.split("/").pop() ?? folderName).toLowerCase();
        if (folderFilter && !folderFilter.has(leaf)) continue;

        // Pass prefixed serverKey so scanMboxFile includes prefix in returned records
        const msgs = await scanMboxFile(fsPath, folderName, accountName, `tb_${acct.serverKey}`, false, onProgress);
        records.push(...msgs);
        onProgress?.(records.length);
      }
    }

    const mailAccounts = await this.getAccounts();
    const targetAccounts = options.accountId
      ? mailAccounts.filter((a) => a.id === options.accountId)
      : mailAccounts;

    return { messages: records, total: records.length, accounts: targetAccounts };
  }

  /**
   * Fetch email body text using the Thunderbird message key (mbox file path + message offset).
   * Used during VirtualBox deferred indexing when user confirms indexing.
   * Returns the full email body text, or null if not found/accessible.
   *
   * For Thunderbird, identifier_id is expected to be in format: "folder_path|message_offset"
   */
  async fetchMessageBody(identifier_id: string): Promise<string | null> {
    // TODO: Implement Thunderbird body fetching
    // For now, return null as Thunderbird full-text body extraction is complex
    // and requires parsing mbox format with MIME headers.
    // The identifier_id format for Thunderbird needs to be defined (folder path + offset)
    console.warn(`[Thunderbird] fetchMessageBody not yet implemented for ${identifier_id}`);
    return null;
  }

  async deleteMessages(_ids: Array<string | number>): Promise<MoveDeleteResult> {
    return { success: false, error: "Open Thunderbird to delete messages." };
  }

  async moveMessagesToFolder(
    _ids: Array<string | number>, _accountId: string, _folderPath: string,
  ): Promise<MoveDeleteResult> {
    return { success: false, error: "Open Thunderbird to move messages." };
  }

  async openMessage(_id: string | number): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: "Open Thunderbird to view this message." };
  }
}

export const thunderbirdProvider = new ThunderbirdProvider();

// ── Body-only scan (used by vector indexer via fetchMessagesForFolders) ────

/**
 * Scan specific Thunderbird folders with body extraction enabled.
 * Called by the indexer for content-mode (Full Content) indexing.
 */
export async function fetchThunderbirdMessagesForFolders(
  folders: string[],
  includeBody: boolean,
): Promise<MessageRecord[]> {
  const options: FetchMailOptions = {
    folderSelections: folders.map((f) => ({ accountId: "", path: f })),
  };
  const result = await thunderbirdProvider.fetchMessages(options);
  if (!includeBody) return result.messages;

  // Re-scan with body extraction for content-mode indexing
  const provider = thunderbirdProvider as ThunderbirdProvider;
  const accounts = (provider as any).getTbAccounts() as TbAccountInfo[];
  const folderSet = new Set(folders.map((f) => f.toLowerCase()));
  const records: MessageRecord[] = [];

  for (const acct of accounts) {
    const { directory } = acct.server;
    if (!directory || !fs.existsSync(directory)) continue;
    const accountName = acct.server.prettyName || acct.server.userName || acct.server.hostname;

    for (const { folderName, fsPath } of walkMboxDir(directory)) {
      const leaf = (folderName.split("/").pop() ?? folderName).toLowerCase();
      if (!folderSet.has(leaf) && !folderSet.has(folderName.toLowerCase())) continue;
      const msgs = await scanMboxFile(fsPath, folderName, accountName, acct.serverKey, true);
      records.push(...msgs);
    }
  }

  return records;
}
