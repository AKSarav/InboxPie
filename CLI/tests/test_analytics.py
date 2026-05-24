from inboxpie_cli.analytics import build_analytics
from inboxpie_cli.models import MessageRecord


def _make_record(
    sender_email: str = "test@example.com",
    domain: str = "example.com",
    year: int = 2024,
    month: int = 1,
    read: bool = True,
    size: int = 1000,
) -> MessageRecord:
    return MessageRecord(
        id="1",
        subject="Test",
        author=f"Test <{sender_email}>",
        senderName="Test",
        senderEmail=sender_email,
        domain=domain,
        date="2024-01-15T10:00:00",
        year=year,
        month=month,
        monthName="Jan",
        read=read,
        flagged=False,
        folder="INBOX",
        folderType="inbox",
        account="Test Account",
        accountId="test",
        tags=[],
        size=size,
    )


def test_build_analytics_counts() -> None:
    records = [
        _make_record(sender_email="a@foo.com", domain="foo.com", read=True),
        _make_record(sender_email="b@foo.com", domain="foo.com", read=False),
        _make_record(sender_email="c@bar.com", domain="bar.com", read=False),
    ]
    
    analytics = build_analytics(records)
    
    assert analytics.total == 3
    assert analytics.unread == 2
    assert analytics.unique_senders == 3
    assert analytics.unique_domains == 2


def test_build_analytics_by_domain() -> None:
    records = [
        _make_record(domain="foo.com"),
        _make_record(domain="foo.com"),
        _make_record(domain="bar.com"),
    ]
    
    analytics = build_analytics(records)
    
    assert len(analytics.by_domain) == 2
    assert analytics.by_domain[0]["domain"] == "foo.com"
    assert analytics.by_domain[0]["count"] == 2
    assert analytics.by_domain[1]["domain"] == "bar.com"
    assert analytics.by_domain[1]["count"] == 1


def test_build_analytics_size_buckets() -> None:
    records = [
        _make_record(size=500),       # < 1MB
        _make_record(size=2_000_000), # 1-5MB
        _make_record(size=30_000_000), # > 25MB
    ]
    
    analytics = build_analytics(records)
    
    # Should have 3 buckets with messages
    bucket_keys = {b["key"] for b in analytics.size_buckets}
    assert "under-1mb" in bucket_keys
    assert "1-5mb" in bucket_keys
    assert "25mb-plus" in bucket_keys
