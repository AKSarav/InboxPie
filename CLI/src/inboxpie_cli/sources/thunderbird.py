"""Thunderbird mbox scanner — reads mail from mbox files in the Thunderbird profile."""

from __future__ import annotations

import calendar
import email.header
import email.utils
import mailbox
from datetime import timezone
from pathlib import Path

from inboxpie_cli.models import MessageRecord


def _decode_header(value: object) -> str:
    """Decode an RFC 2047-encoded email header to a plain Unicode string."""
    if not value:
        return ""
    parts = email.header.decode_header(str(value))
    decoded: list[str] = []
    for raw, enc in parts:
        if isinstance(raw, bytes):
            decoded.append(raw.decode(enc or "utf-8", errors="replace"))
        else:
            decoded.append(str(raw))
    return "".join(decoded).strip()


def _folder_type(name: str) -> str:
    lower = name.lower()
    if "inbox"   in lower:                          return "inbox"
    if "sent"    in lower:                          return "sent"
    if "trash"   in lower or "deleted" in lower:   return "trash"
    if "junk"    in lower or "spam"    in lower:   return "junk"
    if "archive" in lower:                          return "archives"
    if "draft"   in lower:                          return "drafts"
    return "custom"


def _extract_text_preview(msg: mailbox.mboxMessage, max_chars: int = 2000) -> str:
    """Return first text/plain MIME part, truncated."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                try:
                    charset = part.get_content_charset() or "utf-8"
                    payload = part.get_payload(decode=True)
                    if isinstance(payload, bytes):
                        return payload.decode(charset, errors="replace")[:max_chars]
                except Exception:
                    pass
    else:
        if msg.get_content_type() == "text/plain":
            try:
                charset = msg.get_content_charset() or "utf-8"
                payload = msg.get_payload(decode=True)
                if isinstance(payload, bytes):
                    return payload.decode(charset, errors="replace")[:max_chars]
            except Exception:
                pass
    return ""


def scan_mbox(
    mbox_path: Path,
    folder_name: str,
    account_name: str,
    account_id: str,
    include_body: bool = False,
) -> list[MessageRecord]:
    """Parse a single Thunderbird mbox file into a list of MessageRecord objects."""
    records: list[MessageRecord] = []
    try:
        box = mailbox.mbox(str(mbox_path), create=False)
    except Exception:
        return records

    folder_type = _folder_type(folder_name)

    for idx, msg in enumerate(box):
        try:
            # X-Mozilla-Status is a 4-hex-digit bitmask:
            #   0x0001 = MSG_FLAG_READ
            #   0x0004 = MSG_FLAG_MARKED (starred/flagged)
            #   0x0008 = MSG_FLAG_EXPUNGED (deleted-but-not-compacted — skip)
            status_raw = msg.get("X-Mozilla-Status", "0000")
            try:
                status = int(str(status_raw), 16)
            except (ValueError, TypeError):
                status = 0
            if status & 0x0008:
                continue

            is_read    = bool(status & 0x0001)
            is_flagged = bool(status & 0x0004)

            from_raw = _decode_header(msg.get("From", ""))
            sender_name, sender_email = email.utils.parseaddr(from_raw)
            if not sender_email:
                sender_email = from_raw.strip()
            domain = sender_email.split("@")[-1].lower() if "@" in sender_email else "unknown"

            date_raw = msg.get("Date", "")
            try:
                dt = email.utils.parsedate_to_datetime(str(date_raw))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                date_str = dt.isoformat()
                year     = dt.year
                month    = dt.month
            except Exception:
                date_str = ""
                year  = 0
                month = 0

            month_name = calendar.month_abbr[month] if 0 < month <= 12 else ""
            subject    = _decode_header(msg.get("Subject", "")) or "(No Subject)"

            msg_id = str(msg.get("Message-ID", "")).strip("<>").strip()
            if not msg_id:
                msg_id = f"tb:{account_id}:{mbox_path.stem}:{idx}"

            try:
                size = len(msg.as_bytes())
            except Exception:
                size = 0

            body_preview = _extract_text_preview(msg) if include_body else ""

            records.append(MessageRecord(
                id=msg_id,
                subject=subject,
                author=from_raw or sender_email,
                senderName=sender_name or sender_email,
                senderEmail=sender_email,
                domain=domain,
                date=date_str,
                year=year,
                month=month,
                monthName=month_name,
                read=is_read,
                flagged=is_flagged,
                folder=folder_name,
                folderType=folder_type,
                account=account_name,
                accountId=account_id,
                tags=[],
                size=size,
                body_preview=body_preview,
            ))
        except Exception:
            continue

    return records


def detect_mboxes(mail_dir: Path, prefix: str = "") -> list[tuple[str, Path]]:
    """
    Walk a Thunderbird mail directory and yield (folder_name, mbox_path) pairs.

    Thunderbird mbox layout:
      - Regular files with no extension → mbox files (Inbox, Sent, Trash, …)
      - Directories ending in .sbd      → sub-folder containers (Inbox.sbd/)
      - Files ending in .msf            → index cache files (skip)
    """
    results: list[tuple[str, Path]] = []
    if not mail_dir.is_dir():
        return results

    try:
        entries = sorted(mail_dir.iterdir())
    except PermissionError:
        return results

    for entry in entries:
        if entry.suffix == ".msf":
            continue
        if entry.is_dir() and entry.suffix == ".sbd":
            parent_name   = entry.stem
            folder_prefix = f"{prefix}/{parent_name}" if prefix else parent_name
            results.extend(detect_mboxes(entry, prefix=folder_prefix))
        elif entry.is_file() and entry.suffix == "":
            folder_name = f"{prefix}/{entry.name}" if prefix else entry.name
            results.append((folder_name, entry))

    return results


def scan_thunderbird(
    mail_dirs: list[str],
    folders: set[str] | None = None,
    include_body: bool = False,
    account_id: str = "",
    account_info: list[dict] | None = None,
) -> tuple[list[MessageRecord], str]:
    """
    Entry point — mirrors scan_apple_mail() signature.

    mail_dirs:    filesystem paths to Thunderbird mail directories (one per account)
    folders:      folder name filters (substring match, case-insensitive); None = all
    include_body: populate body_preview on each MessageRecord
    account_id:   restrict to a single account server key (empty = all)
    account_info: [{id, name, directory}] for account-name resolution
    """
    records: list[MessageRecord] = []

    # Build directory → account metadata lookup
    acct_by_dir: dict[str, dict] = {}
    if account_info:
        for acct in account_info:
            d = str(acct.get("directory", "")).rstrip("/")
            if d:
                acct_by_dir[d] = acct

    for mail_dir_str in mail_dirs:
        mail_dir = Path(mail_dir_str)
        acct = acct_by_dir.get(mail_dir_str.rstrip("/"), {})
        acct_name = str(acct.get("name", mail_dir.name))
        acct_id   = str(acct.get("id",   mail_dir.name))

        if account_id and acct_id != account_id:
            continue

        for folder_name, mbox_path in detect_mboxes(mail_dir):
            if folders:
                name_lower = folder_name.lower()
                if not any(f.lower() in name_lower for f in folders):
                    continue

            records.extend(scan_mbox(
                mbox_path=mbox_path,
                folder_name=folder_name,
                account_name=acct_name,
                account_id=acct_id,
                include_body=include_body,
            ))

    return records, "mbox"
