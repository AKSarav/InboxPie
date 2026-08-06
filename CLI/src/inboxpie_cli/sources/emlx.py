from __future__ import annotations

import email
import html as html_lib
import plistlib
import re
from datetime import datetime, timedelta, timezone
from email.header import decode_header
from email.utils import parsedate_to_datetime
from pathlib import Path

from inboxpie_cli.models import MessageRecord

UNKNOWN_EMAIL = "unknown@local"


def _find_mail_root(base: Path) -> Path:
    if (base / "MailData").is_dir():
        return base
    versions = sorted(base.glob("V*"), key=lambda p: p.name, reverse=True)
    for v in versions:
        if (v / "MailData").is_dir():
            return v
    raise FileNotFoundError(f"No Mail version folder found under {base}")


def _decode_header_value(value: object) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    text = value.strip()
    if not text:
        return ""
    try:
        parts: list[str] = []
        for chunk, charset in decode_header(text):
            if isinstance(chunk, bytes):
                parts.append(chunk.decode(charset or "utf-8", errors="replace"))
            else:
                parts.append(str(chunk))
        return " ".join(parts).strip()
    except Exception:
        return text


def _decode_part(part: email.message.Message) -> str:
    """Decode a single MIME part's payload to a string (best effort)."""
    try:
        payload = part.get_payload(decode=True)
        if payload:
            charset = part.get_content_charset() or "utf-8"
            return payload.decode(charset, errors="replace")
    except Exception:
        pass
    return ""


def _html_to_text(raw_html: str) -> str:
    """Strip HTML to readable text (stdlib only) — for HTML-only emails."""
    if not raw_html:
        return ""
    # Drop script/style blocks entirely
    raw_html = re.sub(r"(?is)<(script|style)\b[^>]*>.*?</\1>", " ", raw_html)
    # Turn block-level boundaries into line breaks so words don't run together
    raw_html = re.sub(r"(?i)<(br|/p|/div|/tr|/li|/h[1-6]|/table)\b[^>]*>", "\n", raw_html)
    # Remove all remaining tags
    raw_html = re.sub(r"(?s)<[^>]+>", " ", raw_html)
    # Decode HTML entities (&amp; &rupee; &nbsp; …)
    return html_lib.unescape(raw_html)


def _extract_body_text(msg: email.message.Message, max_chars: int = 4000) -> str:
    """Extract readable body text, preferring text/plain, falling back to HTML.

    Many transactional emails (bank/MF receipts) are HTML-only — without the HTML
    fallback their body comes back empty and Full-content indexing has nothing to read.
    """
    plain = ""
    html = ""

    if msg.is_multipart():
        for part in msg.walk():
            disp = str(part.get("Content-Disposition") or "").lower()
            if "attachment" in disp:
                continue
            ctype = part.get_content_type()
            if ctype == "text/plain" and not plain:
                plain = _decode_part(part)
            elif ctype == "text/html" and not html:
                html = _decode_part(part)
    else:
        ctype = msg.get_content_type()
        if ctype == "text/plain":
            plain = _decode_part(msg)
        elif ctype == "text/html":
            html = _decode_part(msg)

    text = plain if plain.strip() else _html_to_text(html)
    return " ".join(text.split())[:max_chars]


def _parse_emlx(path: Path, include_body: bool = False) -> tuple[dict[str, str], dict[str, object], str]:
    """Parse an emlx file, returning (headers_dict, plist_dict, body_preview)."""
    raw = path.read_bytes()

    newline_idx = raw.find(b"\n")
    if newline_idx == -1:
        raise ValueError("Invalid emlx: no newline found")

    try:
        byte_count = int(raw[:newline_idx].strip())
    except ValueError:
        byte_count = len(raw)

    message_start = newline_idx + 1
    message_end = message_start + byte_count
    message_bytes = raw[message_start:message_end]

    msg = email.message_from_bytes(message_bytes)
    headers = {
        "from": _decode_header_value(msg.get("From", "")),
        "subject": _decode_header_value(msg.get("Subject", "")),
        "date": _decode_header_value(msg.get("Date", "")),
    }

    plist_data: dict[str, object] = {}
    plist_start = raw.find(b"<?xml", message_end)
    if plist_start != -1:
        try:
            plist_data = plistlib.loads(raw[plist_start:])
        except Exception:
            pass

    body_preview = _extract_body_text(msg) if include_body else ""
    return headers, plist_data, body_preview


def _parse_author(author: object) -> tuple[str, str]:
    text = _decode_header_value(author)
    if not text:
        return "Unknown", UNKNOWN_EMAIL

    bracket = re.search(r"<([^>]+)>", text)
    if bracket:
        email_addr = bracket.group(1).strip().lower()
        name = text[: bracket.start()].strip().strip('"')
        if not name and "@" in email_addr:
            name = email_addr.split("@", 1)[0]
        if "@" in email_addr:
            return name or "Unknown", email_addr
        return name or "Unknown", UNKNOWN_EMAIL

    bare = text.strip().strip('"')
    if "@" in bare and " " not in bare:
        local = bare.split("@", 1)[0]
        return local or "Unknown", bare.lower()

    return bare or "Unknown", UNKNOWN_EMAIL


def _parse_date(date_str: str, plist_date: object) -> datetime:
    if isinstance(plist_date, (int, float)) and plist_date > 0:
        return datetime(2001, 1, 1) + timedelta(seconds=float(plist_date))

    if isinstance(plist_date, datetime):
        dt = plist_date
        return dt.replace(tzinfo=None) if dt.tzinfo else dt

    if date_str:
        try:
            dt = parsedate_to_datetime(date_str)
            if dt.tzinfo is not None:
                dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
            return dt
        except (TypeError, ValueError, OverflowError):
            pass

    return datetime.now()


def _folder_type(folder: str) -> str:
    lower = (folder or "").lower()
    if "inbox" in lower:
        return "inbox"
    if "sent" in lower:
        return "sent"
    if "trash" in lower or "deleted" in lower:
        return "trash"
    if "junk" in lower or "spam" in lower:
        return "junk"
    if "archive" in lower:
        return "archives"
    if "draft" in lower:
        return "drafts"
    return "custom"


def _extract_folder_account(path: Path, mail_root: Path) -> tuple[str, str, str]:
    """Extract folder name, account ID, and account name from path."""
    try:
        rel = path.relative_to(mail_root)
    except ValueError:
        return "Unknown", "unknown", "Apple Mail"

    parts = rel.parts
    account_id = parts[0] if parts else "unknown"

    folder = "Unknown"
    for part in parts:
        if part.endswith(".mbox") or part.endswith(".imapmbox"):
            folder = part.replace(".imapmbox", "").replace(".mbox", "")
            break

    return folder, account_id, account_id


def _folder_matches(folder_name: str, filters: set[str]) -> bool:
    if not filters:
        return True
    haystack = folder_name.lower()
    return any(fragment.lower() in haystack for fragment in filters)


def _record_from_emlx(emlx_path: Path, mail_root: Path, include_body: bool = False) -> MessageRecord | None:
    folder, account_id, account = _extract_folder_account(emlx_path, mail_root)
    headers, plist, body_preview = _parse_emlx(emlx_path, include_body=include_body)

    sender_name, sender_email = _parse_author(headers.get("from", ""))
    domain = sender_email.split("@", 1)[1] if "@" in sender_email else "unknown"
    dt = _parse_date(headers.get("date", ""), plist.get("date-sent"))

    flags = plist.get("flags", 0)
    if isinstance(flags, int):
        is_read = bool(flags & 1)
        is_flagged = bool(flags & (1 << 4))
    else:
        is_read = False
        is_flagged = False

    return MessageRecord(
        id=emlx_path.stem,
        subject=headers.get("subject", "") or "(No Subject)",
        author=headers.get("from", "") or "Unknown",
        senderName=sender_name,
        senderEmail=sender_email,
        domain=domain,
        date=dt.isoformat(),
        year=dt.year,
        month=dt.month,
        monthName=dt.strftime("%b"),
        read=is_read,
        flagged=is_flagged,
        folder=folder,
        folderType=_folder_type(folder),
        account=account,
        accountId=account_id,
        tags=[],
        size=emlx_path.stat().st_size,
        body_preview=body_preview,
    )


def scan_emlx(mail_root: Path, folders: set[str] | None = None, include_body: bool = False) -> list[MessageRecord]:
    """Scan all .emlx files under mail_root."""
    root = _find_mail_root(mail_root)
    filter_folders = folders or set()
    records: list[MessageRecord] = []

    for emlx_path in root.rglob("*.emlx"):
        if ".partial.emlx" in emlx_path.name:
            continue

        folder, _, _ = _extract_folder_account(emlx_path, root)
        if not _folder_matches(folder, filter_folders):
            continue

        try:
            record = _record_from_emlx(emlx_path, root, include_body=include_body)
        except Exception:
            continue

        if record is not None:
            records.append(record)

    return records
