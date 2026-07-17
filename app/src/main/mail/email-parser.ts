/**
 * Shared RFC 2822 / MIME parsing utilities.
 * Used by both AppleMailProvider (emlx) and ThunderbirdProvider (mbox).
 * Zero external dependencies — Node.js built-ins only.
 */

// ── Constants ──────────────────────────────────────────────────────────────

/** Month abbreviations indexed by 1-based month number. */
export const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** Seconds between Unix epoch (1970-01-01) and Mac Core Data epoch (2001-01-01). */
const MAC_EPOCH_OFFSET_SECS = 978307200;

// ── Encoded-word decoder (RFC 2047) ────────────────────────────────────────

/** Decode RFC 2047 encoded words in an email header value. */
export function decodeRfc2047(str: string): string {
  if (!str || !str.includes("=?")) return str;
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (orig, charset: string, encoding: string, text: string) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return Buffer.from(text, "base64").toString(normalizeCharset(charset));
      }
      // Quoted-Printable: underscore = space
      const qpDecoded = text
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(qpDecoded, "binary").toString(normalizeCharset(charset));
    } catch {
      return orig;
    }
  });
}

/** Map IANA charset names to Node.js buffer encoding names. */
function normalizeCharset(charset: string): BufferEncoding {
  const c = charset.toLowerCase().replace(/-/g, "");
  if (c === "utf8" || c === "utf8bom") return "utf8";
  if (c === "latin1" || c === "iso88591") return "latin1";
  if (c === "ascii" || c === "usascii") return "ascii";
  return "utf8"; // safe default
}

// ── RFC 2822 header parser ─────────────────────────────────────────────────

/**
 * Parse the header section of an RFC 2822 message into a Map<lowercase-name, value>.
 * Handles header folding (continuation lines starting with whitespace).
 * Only returns the FIRST occurrence of each header name.
 */
export function parseHeaders(headerSection: string): Map<string, string> {
  const headers = new Map<string, string>();
  // Unfold continuation lines
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 1) continue;
    const key = line.slice(0, colonIdx).toLowerCase().trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  return headers;
}

// ── Author / sender parsing ────────────────────────────────────────────────

export interface ParsedSender {
  name: string;
  email: string;
  /** Raw decoded From: value, e.g. "Name <email>" */
  author: string;
}

/**
 * Parse a From: header value into name, email, and raw author string.
 * Handles:
 *   "Display Name" <addr@example.com>
 *   addr@example.com
 *   Display Name <addr@example.com>  (no quotes)
 */
export function parseSender(fromHeader: string): ParsedSender {
  const decoded = decodeRfc2047(fromHeader || "");
  const author = decoded.trim();

  const angleStart = author.indexOf("<");
  const angleEnd = author.indexOf(">");
  if (angleStart !== -1 && angleEnd > angleStart) {
    const email = author.slice(angleStart + 1, angleEnd).trim().toLowerCase();
    const rawName = author.slice(0, angleStart).trim().replace(/^"|"$/g, "");
    const name = rawName || (email.includes("@") ? email.split("@")[0] : email);
    return { name: name || "Unknown", email: email || "unknown@local", author };
  }

  const bare = author.replace(/^"|"$/g, "").trim();
  if (bare.includes("@") && !bare.includes(" ")) {
    return { name: bare.split("@")[0] || bare, email: bare.toLowerCase(), author };
  }

  return { name: bare || "Unknown", email: "unknown@local", author };
}

// ── Date utilities ─────────────────────────────────────────────────────────

export interface DateParts {
  date: string;       // ISO 8601
  year: number;
  month: number;      // 1-based
  monthName: string;  // "Jan" … "Dec"
}

function dtFromMs(ms: number): DateParts {
  const dt = new Date(ms);
  const month = dt.getUTCMonth() + 1;
  return {
    date:      dt.toISOString(),
    year:      dt.getUTCFullYear(),
    month,
    monthName: MONTH_ABBR[month - 1] ?? "",
  };
}

/** Convert a Unix epoch timestamp (seconds) to DateParts. */
export function unixSecsToDateParts(secs: number): DateParts {
  return dtFromMs(secs * 1000);
}

/** Convert a Mac Core Data timestamp (seconds since 2001-01-01) to DateParts. */
export function macSecsToDateParts(macSecs: number): DateParts {
  return dtFromMs((macSecs + MAC_EPOCH_OFFSET_SECS) * 1000);
}

/** Parse an RFC 2822 / HTTP date string to DateParts. Falls back to now. */
export function parseDateString(dateStr: string): DateParts {
  if (!dateStr) return dtFromMs(Date.now());
  const ms = Date.parse(dateStr);
  return dtFromMs(isNaN(ms) ? Date.now() : ms);
}

// ── Folder type classifier ─────────────────────────────────────────────────

export function folderTypeFromName(name: string): string {
  const lower = (name || "").toLowerCase();
  if (lower.includes("inbox"))                              return "inbox";
  if (lower.includes("sent"))                               return "sent";
  if (lower.includes("trash") || lower.includes("deleted")) return "trash";
  if (lower.includes("junk")  || lower.includes("spam"))    return "junk";
  if (lower.includes("archive"))                            return "archives";
  if (lower.includes("draft"))                              return "drafts";
  return "custom";
}

// ── HTML → plain text ──────────────────────────────────────────────────────

export function htmlToText(raw: string): string {
  return raw
    .replace(/(?:<(script|style)\b[^>]*>)[\s\S]*?(?:<\/\1>)/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(parseInt(n)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ").trim();
}

// ── MIME body extractor ────────────────────────────────────────────────────

/**
 * Extract a plain-text body preview from raw RFC 2822 message bytes.
 * Prefers text/plain; falls back to stripped text/html.
 * Returns empty string when include_body is false (fast path).
 */
export function extractBodyPreview(messageBytes: Buffer, maxChars = 4000): string {
  const raw = messageBytes.toString("binary"); // treat as binary for header parsing

  // Separate headers from body
  const headerEnd = findHeaderEnd(raw);
  if (headerEnd === -1) return "";

  const headersStr = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd + (raw[headerEnd] === "\r" ? 4 : 2)); // skip \r\n\r\n or \n\n

  const headers = parseHeaders(headersStr);
  const contentType = headers.get("content-type") ?? "text/plain";

  const { plain, html } = extractMimeParts(body, contentType, raw);
  const text = plain.trim() || htmlToText(html);
  return text.replace(/\s+/g, " ").slice(0, maxChars);
}

/** Find the position of the blank line separating headers from body. */
function findHeaderEnd(raw: string): number {
  const crlfcrlf = raw.indexOf("\r\n\r\n");
  if (crlfcrlf !== -1) return crlfcrlf;
  const lflf = raw.indexOf("\n\n");
  return lflf; // -1 if not found
}

interface MimeParts { plain: string; html: string }

function extractMimeParts(body: string, contentType: string, fullMessage: string): MimeParts {
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);

  if (boundaryMatch) {
    return parseMultipart(body, boundaryMatch[1].trim(), fullMessage);
  }

  // Single part
  const encoding = extractHeader(fullMessage, "content-transfer-encoding");
  const decoded = decodePart(body, encoding);

  if (/text\/html/i.test(contentType)) return { plain: "", html: decoded };
  return { plain: decoded, html: "" };
}

function parseMultipart(body: string, boundary: string, context: string): MimeParts {
  const delimiter = "--" + boundary;
  const parts = body.split(delimiter);
  let plain = "";
  let html = "";

  for (const part of parts) {
    if (part.startsWith("--") || part.trim() === "") continue; // epilogue

    const partHeaderEnd = findHeaderEnd(part);
    if (partHeaderEnd === -1) continue;

    const partHeaders = parseHeaders(part.slice(0, partHeaderEnd));
    const partBody = part.slice(partHeaderEnd + (part[partHeaderEnd] === "\r" ? 4 : 2));
    const partCT  = partHeaders.get("content-type") ?? "text/plain";
    const partEnc = partHeaders.get("content-transfer-encoding") ?? "";

    if (/text\/plain/i.test(partCT) && !plain) {
      plain = decodePart(partBody, partEnc);
    } else if (/text\/html/i.test(partCT) && !html) {
      html = decodePart(partBody, partEnc);
    } else if (/multipart\//i.test(partCT)) {
      const sub = extractMimeParts(partBody, partCT, context);
      if (!plain) plain = sub.plain;
      if (!html) html = sub.html;
    }

    if (plain && html) break; // found both, stop early
  }

  return { plain, html };
}

function decodePart(raw: string, encoding: string): string {
  const enc = (encoding || "").toLowerCase().trim();
  try {
    if (enc === "base64") {
      return Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
    }
    if (enc === "quoted-printable") {
      return decodeQuotedPrintable(raw);
    }
    // 7bit / 8bit / binary — return as-is (re-interpret as utf8)
    return Buffer.from(raw, "binary").toString("utf8");
  } catch {
    return raw;
  }
}

function decodeQuotedPrintable(raw: string): string {
  return raw
    .replace(/=\r?\n/g, "") // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function extractHeader(text: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*(.+)`, "im");
  const m = text.match(re);
  return m?.[1]?.trim() ?? "";
}
