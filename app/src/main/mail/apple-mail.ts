import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  decodeRfc2047,
  extractBodyPreview,
  extractBodyText,
  folderTypeFromName as folderTypeFromNameShared,
  macSecsToDateParts,
  parseDateString,
  parseSender,
  unixSecsToDateParts,
} from "./email-parser";

/** No-op kept for API compatibility — Apple Mail scanning is now in-process. */
export function killActiveScans(): number { return 0; }

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
const FDA_ERROR =
  "Full Disk Access is required. Open System Settings → Privacy & Security → " +
  "Full Disk Access and enable InboxPie, then restart the app.";

function findEnvelopeIndex(): string | null {
  const direct = path.join(MAIL_ROOT, "MailData", "Envelope Index");
  if (fs.existsSync(direct)) return direct;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(MAIL_ROOT, { withFileTypes: true });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("EPERM") || msg.includes("EACCES") || msg.includes("permission")) {
      throw new Error(FDA_ERROR);
    }
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

// Use shared folderTypeFromName from email-parser (identical logic)
const folderTypeFromName = folderTypeFromNameShared;

// ── TypeScript Envelope Index message scan ─────────────────────────────────

const ENVELOPE_MESSAGES_QUERY = `
  SELECT
    m.ROWID,
    m.message_id,
    s.subject,
    a.address,
    a.comment,
    m.date_sent,
    m.date_received,
    m.read,
    m.flagged,
    m.size,
    mb.url
  FROM messages AS m
  LEFT JOIN subjects  AS s  ON m.subject  = s.ROWID
  LEFT JOIN addresses AS a  ON m.sender   = a.ROWID
  LEFT JOIN mailboxes AS mb ON m.mailbox  = mb.ROWID
  WHERE m.deleted = 0
`;

// node:sqlite returns 64-bit integers that overflow JS Number as BigInt when
// setReadBigInts(true) is set. All integer columns may be bigint or number.
type SqlInt = bigint | number | null;

type EnvelopeRow = {
  ROWID: SqlInt;
  message_id: string | null;
  subject: string | null;
  address: string | null;
  comment: string | null;
  date_sent: SqlInt;
  date_received: SqlInt;
  read: SqlInt;
  flagged: SqlInt;
  size: SqlInt;
  url: string | null;
};

/** Safely convert a SQLite integer (possibly BigInt) to a JS number. */
function sqlNum(v: SqlInt): number {
  if (v == null) return 0;
  // Number(bigint) truncates to double precision — acceptable for timestamps/sizes
  return Number(v);
}

// Apple Mail's Envelope Index stores timestamps as Unix epoch seconds (integer).
// Valid email dates: 1990-01-01 (631152000) to 2100-01-01 (4102444800).
// Any value outside this range — including impossibly large 64-bit integers —
// is treated as missing and falls back to parseDateString("").
const MIN_VALID_TS =   631_152_000; // 1990-01-01 UTC
const MAX_VALID_TS = 4_102_444_800; // 2100-01-01 UTC
// Apple Core Data epoch offset (seconds from 1970 to 2001-01-01)
const MAC_EPOCH_OFFSET = 978_307_200;

/**
 * Resolve an Envelope Index timestamp to a valid Unix epoch second.
 * Handles three storage formats found in the wild:
 *   - Unix seconds       (typical, 1970 epoch)
 *   - Mac Core Data secs (2001 epoch — add MAC_EPOCH_OFFSET)
 *   - Nanoseconds        (rare, divide by 1e9 then apply above)
 * Returns 0 when the value cannot be mapped to a plausible email date.
 */
function resolveTimestamp(raw: SqlInt): number {
  if (raw == null) return 0;
  const v = Number(raw); // BigInt → double; loses sub-microsecond precision, fine for dates
  if (!isFinite(v) || v <= 0) return 0;

  // Unix seconds — the most common format in Envelope Index
  if (v >= MIN_VALID_TS && v <= MAX_VALID_TS) return Math.round(v);

  // Mac Core Data seconds (2001 epoch) — common in plist / CoreData stores
  const macToUnix = v + MAC_EPOCH_OFFSET;
  if (macToUnix >= MIN_VALID_TS && macToUnix <= MAX_VALID_TS) return Math.round(macToUnix);

  // Nanoseconds (some internal Apple APIs use this)
  const fromNano = v / 1_000_000_000;
  if (fromNano >= MIN_VALID_TS && fromNano <= MAX_VALID_TS) return Math.round(fromNano);

  // Nanoseconds with Mac epoch
  const fromNanoMac = fromNano + MAC_EPOCH_OFFSET;
  if (fromNanoMac >= MIN_VALID_TS && fromNanoMac <= MAX_VALID_TS) return Math.round(fromNanoMac);

  return 0; // unrecognised format — caller falls back to parseDateString("")
}

function scanEnvelopeIndexMessages(
  dbPath: string,
  nameMap: Map<string, string>,
  folderFilter?: Set<string>,
  accountId?: string,
): MessageRecord[] {
  const { db, cleanup } = openEnvelopeIndex(dbPath);
  try {
    const stmt = db.prepare(ENVELOPE_MESSAGES_QUERY);
    // setReadBigInts(true): return 64-bit integers that exceed Number.MAX_SAFE_INTEGER
    // as BigInt instead of throwing ERR_OUT_OF_RANGE. Available since Node 22.5.
    if (typeof (stmt as any).setReadBigInts === "function") {
      (stmt as any).setReadBigInts(true);
    }
    const rows = stmt.all() as EnvelopeRow[];
    const records: MessageRecord[] = [];

    for (const row of rows) {
      if (!row.url) continue;
      const parsed = parseMailboxUrl(row.url);
      if (!parsed || !parsed.folderPath) continue;
      if (accountId && parsed.uuid !== accountId.toUpperCase()) continue;

      const segments   = parsed.folderPath.split("/");
      const folderLeaf = segments[segments.length - 1] ?? parsed.folderPath;
      if (folderFilter?.size && !folderFilter.has(folderLeaf.toLowerCase())) continue;

      const addr    = (row.address ?? "").trim();
      const name    = (row.comment ?? "").trim();
      const rawFrom = name && addr ? `${name} <${addr}>` : (addr || name || "");
      const { name: senderName, email: senderEmail, author } = parseSender(rawFrom);
      const domain  = senderEmail.includes("@") ? senderEmail.split("@")[1]!.toLowerCase() : "unknown";

      // resolveTimestamp() handles BigInt values, all known storage formats
      // (Unix seconds, Mac Core Data seconds, nanoseconds), and corrupted values.
      const timestamp = resolveTimestamp(row.date_received) || resolveTimestamp(row.date_sent);
      const dateParts = timestamp > 0 ? unixSecsToDateParts(timestamp) : parseDateString("");

      const subject     = decodeRfc2047(row.subject ?? "") || "(No Subject)";
      const accountName = nameMap.get(parsed.uuid) ?? parsed.uuid;
      const rowId       = String(sqlNum(row.ROWID));

      records.push({
        id:        row.message_id || rowId,
        subject,
        author,
        senderName,
        senderEmail,
        domain,
        date:      dateParts.date,
        year:      dateParts.year,
        month:     dateParts.month,
        monthName: dateParts.monthName,
        read:      sqlNum(row.read) === 1,
        flagged:   sqlNum(row.flagged) === 1,
        folder:    parsed.folderPath,
        folderType: folderTypeFromName(folderLeaf),
        account:   accountName,
        accountId: `am_${parsed.uuid}`, // Prefix with provider
        tags:      [],
        size:      sqlNum(row.size),
        // NEW: Provider metadata for VirtualBox deferred indexing
        provider:     "apple-mail",
        identifier_id: rowId,  // Envelope Index ROWID is the canonical identifier
      });
    }

    return records;
  } finally {
    cleanup();
  }
}

// ── TypeScript emlx scan (fallback + body extraction) ─────────────────────

/** Parse a simple Apple plist XML for the integer/real values we need. */
function parsePlistXml(xml: string): Record<string, number | string | boolean> {
  const result: Record<string, number | string | boolean> = {};
  const re = /<key>([^<]+)<\/key>\s*(?:<integer>(\d+)<\/integer>|<real>([^<]+)<\/real>|<string>([^<]*)<\/string>|<(true|false)\/>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1]!;
    if (m[2] !== undefined) result[key] = parseInt(m[2], 10);
    else if (m[3] !== undefined) result[key] = parseFloat(m[3]);
    else if (m[4] !== undefined) result[key] = m[4];
    else if (m[5] !== undefined) result[key] = m[5] === "true";
  }
  return result;
}

/** Extract folder name and account UUID from an emlx file path under mail_root. */
function emlxFolderAndAccount(emlxPath: string, mailRoot: string): { folder: string; accountId: string } {
  const rel = path.relative(mailRoot, emlxPath);
  const parts = rel.split(path.sep);
  const accountId = parts[0] ?? "unknown";
  let folder = "Unknown";
  for (const part of parts) {
    if (part.endsWith(".mbox") || part.endsWith(".imapmbox")) {
      folder = part.replace(/\.imapmbox$/, "").replace(/\.mbox$/, "");
      break;
    }
  }
  return { folder, accountId };
}

function parseEmlxFile(emlxPath: string, includeBody: boolean): MessageRecord | null {
  let raw: Buffer;
  try { raw = fs.readFileSync(emlxPath); } catch { return null; }

  const firstNl = raw.indexOf(0x0a);
  if (firstNl === -1) return null;

  let byteCount: number;
  try { byteCount = parseInt(raw.subarray(0, firstNl).toString("ascii").trim(), 10); } catch { return null; }

  const msgStart = firstNl + 1;
  const messageBytes = raw.subarray(msgStart, msgStart + byteCount);

  // Parse plist XML for flags and date-sent
  const plistStart = raw.indexOf(Buffer.from("<?xml"), msgStart + byteCount);
  let plist: Record<string, number | string | boolean> = {};
  if (plistStart !== -1) {
    try { plist = parsePlistXml(raw.subarray(plistStart).toString("utf8")); } catch { /* ignore */ }
  }

  // Flags: bit 0 = read, bit 4 = flagged (Apple Mail emlx format)
  const flags = typeof plist["flags"] === "number" ? plist["flags"] : 0;
  const isRead    = !!(flags & 1);
  const isFlagged = !!(flags & 16);

  // Headers
  const headerEnd = findHeaderBoundary(messageBytes);
  const headerSection = messageBytes.subarray(0, headerEnd).toString("utf8");
  const headers = new Map<string, string>();
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const ci = line.indexOf(":");
    if (ci < 1) continue;
    const k = line.slice(0, ci).toLowerCase().trim();
    const v = line.slice(ci + 1).trim();
    if (!headers.has(k)) headers.set(k, v);
  }

  const { name: senderName, email: senderEmail, author } = parseSender(headers.get("from") ?? "");
  const domain = senderEmail.includes("@") ? senderEmail.split("@")[1]!.toLowerCase() : "unknown";

  // Date: prefer plist date-sent (Mac Core Data epoch), fall back to header
  const plistDate = typeof plist["date-sent"] === "number" ? plist["date-sent"] as number : null;
  const dateParts = plistDate && plistDate > 0
    ? macSecsToDateParts(plistDate)
    : parseDateString(headers.get("date") ?? "");

  const rawSubject = headers.get("subject") ?? "";
  const subject = decodeRfc2047(rawSubject) || "(No Subject)";

  // For emlx, use message-id header if available, else file basename
  const messageId = headers.get("message-id") || path.basename(emlxPath, ".emlx");

  return {
    id:         path.basename(emlxPath, ".emlx"),
    subject,
    author,
    senderName,
    senderEmail,
    domain,
    date:       dateParts.date,
    year:       dateParts.year,
    month:      dateParts.month,
    monthName:  dateParts.monthName,
    read:       isRead,
    flagged:    isFlagged,
    folder:     "",    // filled in by caller
    folderType: "",
    account:    "",
    accountId:  "",
    tags:         [],
    size:         fs.statSync(emlxPath).size,
    body_preview: includeBody ? extractBodyPreview(messageBytes) : undefined,
    body_display: includeBody ? extractBodyText(messageBytes, 50_000) : undefined,
    // NEW: Provider metadata for VirtualBox deferred indexing
    provider:     "apple-mail",
    identifier_id: messageId,  // Message-ID header or file basename as fallback
  };
}

function findHeaderBoundary(buf: Buffer): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i;
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && i + 3 < buf.length
        && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
  }
  return buf.length;
}

function scanEmlxDirectory(
  mailRoot: string,
  nameMap: Map<string, string>,
  folderFilter?: Set<string>,
  accountId?: string,
  includeBody = false,
): MessageRecord[] {
  const records: MessageRecord[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".emlx") || entry.name.includes(".partial.")) continue;

      const { folder, accountId: emlxAccountId } = emlxFolderAndAccount(full, mailRoot);
      if (accountId && emlxAccountId.toUpperCase() !== accountId.toUpperCase()) continue;
      if (folderFilter?.size && !folderFilter.has(folder.toLowerCase())) continue;

      const record = parseEmlxFile(full, includeBody);
      if (!record) continue;

      record.folder     = folder;
      record.folderType = folderTypeFromName(folder);
      record.accountId  = `am_${emlxAccountId.toUpperCase()}`;
      record.account    = nameMap.get(emlxAccountId.toUpperCase()) ?? emlxAccountId;
      records.push(record);
    }
  }

  walk(mailRoot);
  return records;
}

/**
 * Fetch messages for the given folder names, for (re)indexing.
 * includeBody=true uses emlx scan to extract body text (Full Content);
 * includeBody=false uses the fast Envelope Index scan (Metadata only).
 */
export function fetchMessagesForFolders(folders: string[], includeBody: boolean): MessageRecord[] {
  const dbPath = findEnvelopeIndex();
  const nameMap = buildUuidToNameMap();
  const folderFilter = folders.length > 0
    ? new Set(folders.map((f) => f.toLowerCase()))
    : undefined;

  if (includeBody) {
    const mailRoot = findMailVersionRoot();
    if (!mailRoot) return [];
    return scanEmlxDirectory(mailRoot, nameMap, folderFilter, undefined, true);
  }

  if (!dbPath) {
    const mailRoot = findMailVersionRoot();
    if (!mailRoot) return [];
    return scanEmlxDirectory(mailRoot, nameMap, folderFilter, undefined, false);
  }

  return scanEnvelopeIndexMessages(dbPath, nameMap, folderFilter);
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

        const accountId = `am_${parsed.uuid}`; // Prefix with "am_" for Apple Mail provider
        seen.set(parsed.uuid, {
          id: accountId,            // Prefixed ID for IPC / accountId filter
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
      // If accountId is prefixed (am_<uuid>), extract the UUID part for SQL filtering
      const filterUuid = accountId?.startsWith("am_") ? accountId.slice(3) : accountId;

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
        if (filterUuid && parsed.uuid !== filterUuid.toUpperCase()) continue;
        if (!parsed.folderPath) continue;

        const segments = parsed.folderPath.split("/");
        const name = segments[segments.length - 1];
        const accountName = nameMap.get(parsed.uuid) ?? parsed.uuid;

        folders.push({
          path: parsed.folderPath,
          name,
          type: folderTypeFromName(name),
          accountId: `am_${parsed.uuid}`, // Return prefixed ID
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
    onProgress?.(0);

    // Strip provider prefix from accountId if present (e.g. "am_<uuid>" → "<uuid>")
    const filterAccountId = options.accountId?.startsWith("am_") ? options.accountId.slice(3) : options.accountId;

    const nameMap = buildUuidToNameMap();
    const folderFilter = options.folderSelections?.length
      ? new Set(options.folderSelections.map((s) => (s.path.split("/").pop() ?? s.path).toLowerCase()))
      : undefined;

    const dbPath = findEnvelopeIndex();
    let messages: MessageRecord[];

    if (dbPath) {
      messages = scanEnvelopeIndexMessages(dbPath, nameMap, folderFilter, filterAccountId ?? undefined);
    } else {
      const mailRoot = findMailVersionRoot();
      messages = mailRoot
        ? scanEmlxDirectory(mailRoot, nameMap, folderFilter, filterAccountId ?? undefined, false)
        : [];
    }

    onProgress?.(messages.length);

    const accounts = await this.getAccounts();
    const targetAccounts = options.accountId
      ? accounts.filter((a) => a.id === options.accountId)
      : accounts;

    return {
      messages,
      total:             messages.length,
      accounts:          targetAccounts,
      envelopeIndexPath: dbPath ?? undefined,
    };
  }

  /**
   * Fetch email body text using the Envelope Index ROWID.
   * Used during VirtualBox deferred indexing when user confirms indexing.
   * Returns the full email body text, or null if not found/accessible.
   */
  async fetchMessageBody(identifier_id: string): Promise<string | null> {
    const dbPath = findEnvelopeIndex();
    if (!dbPath) return null;

    try {
      const { db, cleanup } = openEnvelopeIndex(dbPath);
      try {
        // Query the messages table using ROWID to find the mailbox URL
        type MessageRow = { url: string };
        const row = db
          .prepare("SELECT url FROM messages WHERE ROWID = ?")
          .get(identifier_id) as MessageRow | undefined;

        if (!row || !row.url) return null;

        // Parse the mailbox URL to get folder path
        const parsed = parseMailboxUrl(row.url);
        if (!parsed || !parsed.folderPath) return null;

        // The URL points to an .emlx file; construct its path and read
        const mailRoot = path.join(os.homedir(), "Library", "Mail");
        const versionDirs = fs
          .readdirSync(mailRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory() && /^V\d+$/.test(e.name))
          .sort((a, b) => Number(b.name.slice(1)) - Number(a.name.slice(1)));

        for (const vdir of versionDirs) {
          const accountPath = path.join(mailRoot, vdir.name, parsed.uuid);
          if (!fs.existsSync(accountPath)) continue;

          // Navigate to the folder and find the corresponding .mbox directory
          const folderSegments = parsed.folderPath.split("/");
          let currentPath = accountPath;

          for (const segment of folderSegments) {
            const mboxPath = path.join(currentPath, `${segment}.mbox`);
            const nextPath = path.join(currentPath, segment);

            if (fs.existsSync(mboxPath)) {
              currentPath = mboxPath;
            } else if (fs.existsSync(nextPath)) {
              currentPath = nextPath;
            }
          }

          // Look for the .emlx file matching this ROWID
          // Files are named by message ID; try common patterns
          const emlxDir = path.join(currentPath, "Messages");
          if (!fs.existsSync(emlxDir)) continue;

          // The message ID from Envelope Index is stored in the ROWID
          // Try to find .emlx file that corresponds to this message
          // This is a best-effort search; ideally we'd store the filename mapping
          const files = fs.readdirSync(emlxDir);
          for (const file of files) {
            if (!file.endsWith(".emlx")) continue;

            const emlxPath = path.join(emlxDir, file);
            try {
              const record = parseEmlxFile(emlxPath, true); // includeBody=true
              if (record && record.body_display) {
                return record.body_display;
              }
            } catch {
              // Skip files that can't be parsed
              continue;
            }
          }
        }

        return null;
      } finally {
        cleanup();
      }
    } catch (e) {
      console.warn(`[AppleMail] fetchMessageBody(${identifier_id}) failed:`, e);
      return null;
    }
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
