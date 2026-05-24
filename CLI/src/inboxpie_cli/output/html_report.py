from __future__ import annotations

import json
import shutil
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, PackageLoader

from inboxpie_cli.analytics.aggregations import Analytics
from inboxpie_cli.config import DEFAULT_HTML_FILENAME

LOGO_FILENAME = "InboxPieLogo.png"


def _get_template_env() -> Environment:
    try:
        return Environment(loader=PackageLoader("inboxpie_cli", "templates"))
    except Exception:
        templates_dir = Path(__file__).parent.parent / "templates"
        return Environment(loader=FileSystemLoader(str(templates_dir)))


def _logo_asset_path() -> Path:
    return Path(__file__).parent.parent / "static" / LOGO_FILENAME


def _format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    if size < 1024 * 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    return f"{size / (1024 * 1024 * 1024):.2f} GB"


def _serialize_messages(records) -> list[dict]:
    """Convert MessageRecord objects to JSON-serializable dicts."""
    return [
        {
            "id": r.id,
            "subject": r.subject,
            "senderName": r.senderName,
            "senderEmail": r.senderEmail,
            "domain": r.domain,
            "date": r.date,
            "year": r.year,
            "month": r.month,
            "monthName": r.monthName,
            "read": r.read,
            "flagged": r.flagged,
            "folder": r.folder,
            "folderType": r.folderType,
            "account": r.account,
            "size": r.size,
        }
        for r in records
    ]


def write_html_report(report_dir: Path, analytics: Analytics, privacy: bool = False) -> Path:
    """Generate static HTML report."""
    report_dir.mkdir(parents=True, exist_ok=True)
    output_path = report_dir / DEFAULT_HTML_FILENAME
    
    # Build folder list from records
    folders = {}
    for r in analytics.records:
        if r.folder not in folders:
            folders[r.folder] = {"name": r.folder, "type": r.folderType, "count": 0}
        folders[r.folder]["count"] += 1
    folder_list = sorted(folders.values(), key=lambda x: x["count"], reverse=True)
    
    env = _get_template_env()
    template = env.get_template("report.html.j2")
    
    html = template.render(
        total=analytics.total,
        unread=analytics.unread,
        unique_senders=analytics.unique_senders,
        unique_domains=analytics.unique_domains,
        total_size=_format_bytes(analytics.total_size),
        pie_tree_json=json.dumps(analytics.pie_tree),
        by_month_json=json.dumps(analytics.by_month),
        by_sender_json=json.dumps(analytics.by_sender),
        by_domain_json=json.dumps(analytics.by_domain),
        size_buckets_json=json.dumps(analytics.size_buckets),
        heavy_senders_json=json.dumps(analytics.heavy_senders),
        heavy_domains_json=json.dumps(analytics.heavy_domains),
        all_messages_json=json.dumps(_serialize_messages(analytics.records)),
        folders_json=json.dumps(folder_list),
        format_bytes=_format_bytes,
        privacy=privacy,
    )
    
    output_path.write_text(html, encoding="utf-8")

    logo_src = _logo_asset_path()
    if logo_src.is_file():
        shutil.copy2(logo_src, report_dir / LOGO_FILENAME)

    return output_path
