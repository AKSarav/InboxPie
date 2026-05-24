from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse
import sqlite3

from inboxpie_cli.models import MessageRecord

ENVELOPE_QUERY = """
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
LEFT JOIN subjects AS s ON m.subject = s.ROWID
LEFT JOIN addresses AS a ON m.sender = a.ROWID
LEFT JOIN mailboxes AS mb ON m.mailbox = mb.ROWID
WHERE m.deleted = 0
"""


def _find_index_db(mail_root: Path) -> Path:
    direct = mail_root / "MailData" / "Envelope Index"
    if direct.is_file():
        return direct

    matches = sorted(mail_root.glob("V*/MailData/Envelope Index"))
    if matches:
        return matches[0]

    raise FileNotFoundError(
        f"Could not locate Envelope Index under {mail_root}. "
        "Expected MailData/Envelope Index or V*/MailData/Envelope Index"
    )


def _parse_timestamp(value: object | None) -> datetime:
    """Parse Unix epoch timestamp from Envelope Index."""
    if value is None:
        return datetime.now(tz=timezone.utc).replace(tzinfo=None)
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return datetime.now(tz=timezone.utc).replace(tzinfo=None)
    if seconds <= 0:
        return datetime.now(tz=timezone.utc).replace(tzinfo=None)
    
    # Envelope Index uses Unix epoch (seconds since 1970-01-01)
    try:
        dt = datetime.fromtimestamp(seconds, tz=timezone.utc)
        return dt.replace(tzinfo=None)
    except (ValueError, OSError):
        return datetime.now(tz=timezone.utc).replace(tzinfo=None)


def _format_author(address: str | None, comment: str | None) -> str:
    addr = (address or "").strip()
    name = (comment or "").strip()
    if name and addr:
        return f"{name} <{addr}>"
    return addr or name or "Unknown"


def _parse_sender(address: str | None, comment: str | None) -> tuple[str, str]:
    author = _format_author(address, comment)
    if "<" in author and ">" in author:
        name = author.split("<", 1)[0].strip().strip('"')
        email = author.split("<", 1)[1].split(">", 1)[0].strip().lower()
        return name or email.split("@")[0], email
    email = author.strip().lower()
    return email.split("@")[0] if "@" in email else email, email


def _parse_mailbox_url(url: str | None) -> tuple[str, str]:
    if not url:
        return "Apple Mail", "Unknown"

    decoded = unquote(url.strip())
    if "://" in decoded:
        parsed = urlparse(decoded)
        account = parsed.netloc or parsed.hostname or "Apple Mail"
        segments = [segment for segment in parsed.path.split("/") if segment]
        folder = segments[-1] if segments else "Unknown"
        return account, folder

    parts = decoded.rstrip("/").split("/")
    return "Apple Mail", parts[-1] if parts else "Unknown"


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


def _folder_matches(folder_name: str, filters: set[str]) -> bool:
    if not filters:
        return True
    haystack = folder_name.lower()
    return any(fragment.lower() in haystack for fragment in filters)


def scan_envelope_index(mail_root: Path, folders: set[str] | None = None) -> list[MessageRecord]:
    db_path = _find_index_db(mail_root)
    uri = f"file:{db_path.as_posix()}?mode=ro&immutable=1"

    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.OperationalError as exc:
        msg = str(exc).lower()
        if "not authorized" in msg or "authorization denied" in msg or "permission denied" in msg:
            raise PermissionError(
                "Apple Mail Envelope Index access denied. Grant Full Disk Access to your terminal/Python app "
                "in System Settings > Privacy & Security > Full Disk Access."
            ) from exc
        raise

    filter_folders = folders or set()
    records: list[MessageRecord] = []

    with conn:
        cursor = conn.cursor()
        try:
            cursor.execute(ENVELOPE_QUERY)
        except sqlite3.OperationalError as exc:
            raise RuntimeError(
                "Envelope Index schema not recognized. Expected messages/subjects/addresses/mailboxes tables."
            ) from exc

        for row in cursor.fetchall():
            (
                rowid,
                message_id,
                subject,
                address,
                comment,
                date_sent,
                date_received,
                is_read,
                is_flagged,
                size,
                mailbox_url,
            ) = row

            account, folder_name = _parse_mailbox_url(mailbox_url)
            if not _folder_matches(folder_name, filter_folders):
                continue

            sender_name, sender_email = _parse_sender(address, comment)
            author = _format_author(address, comment)
            domain = sender_email.split("@", 1)[1] if "@" in sender_email else "unknown"
            timestamp = date_received if date_received and float(date_received) > 0 else date_sent
            dt = _parse_timestamp(timestamp)

            records.append(
                MessageRecord(
                    id=message_id or rowid,
                    subject=subject or "(No Subject)",
                    author=author,
                    senderName=sender_name,
                    senderEmail=sender_email,
                    domain=domain,
                    date=dt.isoformat(),
                    year=dt.year,
                    month=dt.month,
                    monthName=dt.strftime("%b"),
                    read=bool(is_read),
                    flagged=bool(is_flagged),
                    folder=folder_name,
                    folderType=_folder_type(folder_name),
                    account=account,
                    accountId=account,
                    tags=[],
                    size=int(size or 0),
                )
            )

    return records
