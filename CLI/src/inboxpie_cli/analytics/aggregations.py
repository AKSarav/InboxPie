from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from inboxpie_cli.models import MessageRecord

MB = 1024 * 1024

SIZE_BUCKETS = [
    {"key": "25mb-plus", "title": "> 25 MB", "min": 25 * MB, "max": float("inf")},
    {"key": "10-25mb", "title": "10-25 MB", "min": 10 * MB, "max": 25 * MB},
    {"key": "5-10mb", "title": "5-10 MB", "min": 5 * MB, "max": 10 * MB},
    {"key": "1-5mb", "title": "1-5 MB", "min": MB, "max": 5 * MB},
    {"key": "under-1mb", "title": "< 1 MB", "min": 1, "max": MB},
]


@dataclass
class Analytics:
    total: int = 0
    unread: int = 0
    unique_senders: int = 0
    unique_domains: int = 0
    total_size: int = 0
    
    by_domain: list[dict[str, Any]] = field(default_factory=list)
    by_sender: list[dict[str, Any]] = field(default_factory=list)
    by_year: list[dict[str, Any]] = field(default_factory=list)
    by_month: list[dict[str, Any]] = field(default_factory=list)
    by_folder: list[dict[str, Any]] = field(default_factory=list)
    
    size_buckets: list[dict[str, Any]] = field(default_factory=list)
    heavy_senders: list[dict[str, Any]] = field(default_factory=list)
    heavy_domains: list[dict[str, Any]] = field(default_factory=list)
    
    pie_tree: dict[str, Any] = field(default_factory=dict)
    
    records: list[MessageRecord] = field(default_factory=list)


def build_analytics(records: list[MessageRecord]) -> Analytics:
    analytics = Analytics()
    analytics.records = records
    analytics.total = len(records)
    analytics.unread = sum(1 for r in records if not r.read)
    
    # Group by sender
    by_sender: dict[str, list[MessageRecord]] = defaultdict(list)
    for r in records:
        by_sender[r.senderEmail].append(r)
    
    analytics.unique_senders = len(by_sender)
    
    def build_sender_year_breakdown(msgs: list[MessageRecord]) -> list[dict]:
        """Build year → month breakdown for a sender."""
        by_year: dict[int, list[MessageRecord]] = defaultdict(list)
        for m in msgs:
            by_year[m.year].append(m)
        
        result = []
        for year in sorted(by_year.keys(), reverse=True):
            year_msgs = by_year[year]
            by_month: dict[int, list[MessageRecord]] = defaultdict(list)
            for m in year_msgs:
                by_month[m.month].append(m)
            
            months = []
            for month in sorted(by_month.keys(), reverse=True):
                month_msgs = by_month[month]
                months.append({
                    "month": month,
                    "monthName": month_msgs[0].monthName,
                    "count": len(month_msgs),
                    "unread": sum(1 for m in month_msgs if not m.read),
                })
            
            result.append({
                "year": year,
                "count": len(year_msgs),
                "unread": sum(1 for m in year_msgs if not m.read),
                "months": months,
            })
        return result
    
    analytics.by_sender = [
        {
            "email": email,
            "name": msgs[0].senderName,
            "domain": msgs[0].domain,
            "count": len(msgs),
            "unread": sum(1 for m in msgs if not m.read),
            "size": sum(m.size for m in msgs),
            "byYear": build_sender_year_breakdown(msgs),
        }
        for email, msgs in sorted(by_sender.items(), key=lambda x: len(x[1]), reverse=True)
    ][:50]
    
    # Group by domain
    by_domain: dict[str, list[MessageRecord]] = defaultdict(list)
    for r in records:
        by_domain[r.domain].append(r)
    
    analytics.unique_domains = len(by_domain)
    analytics.by_domain = [
        {
            "domain": domain,
            "count": len(msgs),
            "unread": sum(1 for m in msgs if not m.read),
            "senders": len(set(m.senderEmail for m in msgs)),
            "size": sum(m.size for m in msgs),
        }
        for domain, msgs in sorted(by_domain.items(), key=lambda x: len(x[1]), reverse=True)
    ][:30]
    
    # Group by year
    by_year: dict[int, list[MessageRecord]] = defaultdict(list)
    for r in records:
        by_year[r.year].append(r)
    
    analytics.by_year = [
        {
            "year": year,
            "count": len(msgs),
            "unread": sum(1 for m in msgs if not m.read),
        }
        for year, msgs in sorted(by_year.items(), reverse=True)
    ]
    
    # Group by month (YYYY-MM)
    by_month: dict[str, list[MessageRecord]] = defaultdict(list)
    for r in records:
        key = f"{r.year}-{r.month:02d}"
        by_month[key].append(r)
    
    analytics.by_month = [
        {
            "month": month,
            "label": f"{msgs[0].monthName} {msgs[0].year}",
            "count": len(msgs),
            "unread": sum(1 for m in msgs if not m.read),
        }
        for month, msgs in sorted(by_month.items())
    ]
    
    # Group by folder
    by_folder: dict[str, list[MessageRecord]] = defaultdict(list)
    for r in records:
        by_folder[r.folder].append(r)
    
    analytics.by_folder = [
        {
            "folder": folder,
            "count": len(msgs),
            "unread": sum(1 for m in msgs if not m.read),
        }
        for folder, msgs in sorted(by_folder.items(), key=lambda x: len(x[1]), reverse=True)
    ]
    
    # Size analytics
    analytics.total_size = sum(r.size for r in records)
    
    # Size buckets
    bucket_msgs: dict[str, list[MessageRecord]] = {b["key"]: [] for b in SIZE_BUCKETS}
    for r in records:
        if r.size > 0:
            for bucket in SIZE_BUCKETS:
                if bucket["min"] <= r.size < bucket["max"]:
                    bucket_msgs[bucket["key"]].append(r)
                    break
    
    analytics.size_buckets = [
        {
            "key": b["key"],
            "title": b["title"],
            "count": len(bucket_msgs[b["key"]]),
            "size": sum(m.size for m in bucket_msgs[b["key"]]),
        }
        for b in SIZE_BUCKETS
        if bucket_msgs[b["key"]]
    ]
    
    # Heavy senders by size
    analytics.heavy_senders = sorted(
        [s for s in analytics.by_sender if s["size"] > 0],
        key=lambda x: x["size"],
        reverse=True,
    )[:10]
    
    # Heavy domains by size
    analytics.heavy_domains = sorted(
        [d for d in analytics.by_domain if d["size"] > 0],
        key=lambda x: x["size"],
        reverse=True,
    )[:10]
    
    # Build pie tree (year -> month -> domain)
    pie_tree: dict[str, dict[str, dict[str, int]]] = {}
    for r in records:
        year = str(r.year)
        month = r.monthName
        domain = r.domain
        
        if year not in pie_tree:
            pie_tree[year] = {}
        if month not in pie_tree[year]:
            pie_tree[year][month] = {}
        if domain not in pie_tree[year][month]:
            pie_tree[year][month][domain] = 0
        pie_tree[year][month][domain] += 1
    
    analytics.pie_tree = pie_tree
    
    return analytics
