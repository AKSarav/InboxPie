from __future__ import annotations

import csv
import json
from pathlib import Path

from inboxpie_cli.analytics.aggregations import Analytics
from inboxpie_cli.models import MessageRecord


def write_csv_report(path: Path, records: list[MessageRecord]) -> None:
    """Write all messages to CSV (unmasked)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "Sender Email", "Sender Name", "Domain", "Subject",
            "Date", "Year", "Month", "Read", "Folder", "Account", "Size"
        ])
        
        for r in records:
            writer.writerow([
                r.senderEmail,
                r.senderName,
                r.domain,
                r.subject,
                r.date,
                r.year,
                r.monthName,
                "Yes" if r.read else "No",
                r.folder,
                r.account,
                r.size,
            ])


def write_json_report(path: Path, analytics: Analytics) -> None:
    """Write analytics summary to JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    
    report = {
        "summary": {
            "total": analytics.total,
            "unread": analytics.unread,
            "uniqueSenders": analytics.unique_senders,
            "uniqueDomains": analytics.unique_domains,
            "totalSize": analytics.total_size,
        },
        "byDomain": analytics.by_domain,
        "bySender": analytics.by_sender,
        "byYear": analytics.by_year,
        "byMonth": analytics.by_month,
        "byFolder": analytics.by_folder,
        "sizeBuckets": analytics.size_buckets,
        "heavySenders": analytics.heavy_senders,
        "heavyDomains": analytics.heavy_domains,
    }
    
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
