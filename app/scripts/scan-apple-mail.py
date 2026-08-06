#!/usr/bin/env python3
"""Scan Apple Mail and emit MessageRecord JSON for the Electron app."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _bootstrap_cli_path() -> None:
    repo_cli_src = Path(__file__).resolve().parents[2] / "CLI" / "src"
    if repo_cli_src.is_dir():
        sys.path.insert(0, str(repo_cli_src))


def main() -> int:
    _bootstrap_cli_path()

    try:
        from inboxpie_cli.config import DEFAULT_MAIL_ROOT
        from inboxpie_cli.sources.scan import scan_apple_mail
    except ImportError as exc:
        print(
            json.dumps(
                {
                    "error": (
                        "inboxpie CLI package not found. Install with "
                        "'pip install inboxpie' or run from the InboxPie repo."
                    ),
                    "detail": str(exc),
                }
            ),
            file=sys.stderr,
        )
        return 1

    parser = argparse.ArgumentParser(description="Scan Apple Mail for InboxPie Electron")
    parser.add_argument("--mail-root", default=str(DEFAULT_MAIL_ROOT))
    parser.add_argument(
        "--folders",
        default="",
        help="Comma-separated folder name filters (substring match)",
    )
    parser.add_argument("--mode", default="auto", choices=["auto", "index", "emlx"])
    parser.add_argument(
        "--include-body",
        action="store_true",
        default=False,
        help="Extract body preview from each email (forces emlx mode; slower)",
    )
    parser.add_argument(
        "--account-id",
        default="",
        help="Optional account id filter (UUID folder name under Mail/V*)",
    )
    args = parser.parse_args()

    folders = {part.strip() for part in args.folders.split(",") if part.strip()}

    try:
        records, engine = scan_apple_mail(
            mail_root=Path(args.mail_root),
            folders=folders,
            mode=args.mode,  # type: ignore[arg-type]
            include_body=args.include_body,
        )
    except (PermissionError, FileNotFoundError, RuntimeError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2

    messages = [record.to_dict() for record in records]
    if args.account_id:
        messages = [m for m in messages if m.get("accountId") == args.account_id]

    payload = {
        "engine": engine,
        "messages": messages,
        "total": len(messages),
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
