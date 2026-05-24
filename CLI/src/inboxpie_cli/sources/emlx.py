from __future__ import annotations

import email
import plistlib
import re
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

from inboxpie_cli.models import MessageRecord

MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _find_mail_root(base: Path) -> Path:
    if (base / "MailData").is_dir():
        return base
    versions = sorted(base.glob("V*"), key=lambda p: p.name, reverse=True)
    for v in versions:
        if (v / "MailData").is_dir():
            return v
    raise FileNotFoundError(f"No Mail version folder found under {base}")


def _parse_emlx(path: Path) -> tuple[dict[str, str], dict[str, object]]:
    """Parse an emlx file, returning (headers_dict, plist_dict)."""
    raw = path.read_bytes()
    
    # First line is byte count
    newline_idx = raw.find(b"\n")
    if newline_idx == -1:
        raise ValueError("Invalid emlx: no newline found")
    
    try:
        byte_count = int(raw[:newline_idx].strip())
    except ValueError:
        byte_count = len(raw)
    
    # Extract message portion
    message_start = newline_idx + 1
    message_end = message_start + byte_count
    message_bytes = raw[message_start:message_end]
    
    # Parse headers only (stop at blank line)
    msg = email.message_from_bytes(message_bytes)
    headers = {
        "from": msg.get("From", ""),
        "subject": msg.get("Subject", ""),
        "date": msg.get("Date", ""),
    }
    
    # Parse plist footer
    plist_data: dict[str, object] = {}
    plist_start = raw.find(b"<?xml", message_end)
    if plist_start != -1:
        try:
            plist_data = plistlib.loads(raw[plist_start:])
        except Exception:
            pass
    
    return headers, plist_data


def _parse_author(author: str) -> tuple[str, str]:
    author = (author or "Unknown").strip()
    # Handle "Name <email>" format
    match = re.match(r'(?:"?([^"<]*)"?\s*)?<?([^>]*)>?', author)
    if match:
        name = (match.group(1) or "").strip()
        email_addr = (match.group(2) or "").strip().lower()
        if not name and email_addr:
            name = email_addr.split("@")[0]
        return name, email_addr
    return author, author.lower()


def _parse_date(date_str: str, plist_date: object) -> datetime:
    # Try plist date first (Apple epoch: 2001-01-01)
    if isinstance(plist_date, (int, float)) and plist_date > 0:
        from datetime import timedelta
        return datetime(2001, 1, 1) + timedelta(seconds=float(plist_date))
    
    if isinstance(plist_date, datetime):
        return plist_date
    
    # Try parsing RFC 2822 date
    if date_str:
        try:
            return parsedate_to_datetime(date_str)
        except (TypeError, ValueError):
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
    
    # Find .mbox or .imapmbox folder
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


def scan_emlx(mail_root: Path, folders: set[str] | None = None) -> list[MessageRecord]:
    """Scan all .emlx files under mail_root."""
    try:
        root = _find_mail_root(mail_root)
    except FileNotFoundError as e:
        raise FileNotFoundError(str(e))
    
    filter_folders = folders or set()
    records: list[MessageRecord] = []
    
    for emlx_path in root.rglob("*.emlx"):
        # Skip partial files
        if ".partial.emlx" in emlx_path.name:
            continue
        
        folder, account_id, account = _extract_folder_account(emlx_path, root)
        
        if not _folder_matches(folder, filter_folders):
            continue
        
        try:
            headers, plist = _parse_emlx(emlx_path)
        except Exception:
            continue
        
        sender_name, sender_email = _parse_author(headers.get("from", ""))
        domain = sender_email.split("@")[1] if "@" in sender_email else "unknown"
        
        dt = _parse_date(headers.get("date", ""), plist.get("date-sent"))
        
        # Parse flags from plist
        flags = plist.get("flags", 0)
        if isinstance(flags, int):
            is_read = bool(flags & 1)
            is_flagged = bool(flags & (1 << 4))
        else:
            is_read = False
            is_flagged = False
        
        msg_id = emlx_path.stem
        size = emlx_path.stat().st_size
        
        records.append(
            MessageRecord(
                id=msg_id,
                subject=headers.get("subject", "") or "(No Subject)",
                author=headers.get("from", "") or "Unknown",
                senderName=sender_name,
                senderEmail=sender_email,
                domain=domain,
                date=dt.isoformat(),
                year=dt.year,
                month=dt.month,
                monthName=MONTH_NAMES[dt.month - 1],
                read=is_read,
                flagged=is_flagged,
                folder=folder,
                folderType=_folder_type(folder),
                account=account,
                accountId=account_id,
                tags=[],
                size=size,
            )
        )
    
    return records
