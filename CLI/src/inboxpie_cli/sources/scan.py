from __future__ import annotations

from pathlib import Path
from typing import Literal

from inboxpie_cli.sources.emlx import scan_emlx
from inboxpie_cli.sources.envelope_index import scan_envelope_index

ScanMode = Literal["auto", "index", "emlx"]
ScanEngine = Literal["index", "emlx"]

_INDEX_ERRORS = (PermissionError, FileNotFoundError, RuntimeError)


def scan_apple_mail(
    mail_root: Path,
    folders: set[str] | None = None,
    mode: ScanMode = "auto",
) -> tuple[list, ScanEngine]:
    """Scan Apple Mail using the requested mode.

    ``auto`` (default) reads the Envelope Index first for speed and parity with
    Mail.app, then falls back to walking ``.emlx`` files when the index is
    unavailable or its schema is not recognized.
    """
    if mode == "emlx":
        return scan_emlx(mail_root=mail_root, folders=folders), "emlx"

    if mode == "index":
        return scan_envelope_index(mail_root=mail_root, folders=folders), "index"

    try:
        records = scan_envelope_index(mail_root=mail_root, folders=folders)
        return records, "index"
    except _INDEX_ERRORS:
        return scan_emlx(mail_root=mail_root, folders=folders), "emlx"
