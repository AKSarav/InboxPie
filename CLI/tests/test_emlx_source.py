from pathlib import Path

import pytest

from inboxpie_cli.sources.emlx import _parse_author, scan_emlx


def test_scan_emlx_parses_fixture(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail" / "V10"
    inbox = mail_root / "AccountA" / "INBOX.mbox" / "Messages"
    inbox.mkdir(parents=True)
    
    # Create MailData so it's recognized as a mail root
    (mail_root / "MailData").mkdir()
    
    fixture = Path(__file__).parent / "fixtures" / "sample.emlx"
    (inbox / "12345.emlx").write_bytes(fixture.read_bytes())
    
    records = scan_emlx(mail_root, folders=set())
    
    assert len(records) == 1
    record = records[0]
    assert record.subject == "Test Email Subject"
    assert record.senderEmail == "john@example.com"
    assert record.senderName == "John Doe"
    assert record.domain == "example.com"
    assert record.folder == "INBOX"
    # Note: flags parsing from plist may vary; just verify record is created


def test_scan_emlx_folder_filter(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail" / "V10"
    inbox = mail_root / "AccountA" / "INBOX.mbox" / "Messages"
    sent = mail_root / "AccountA" / "Sent.mbox" / "Messages"
    inbox.mkdir(parents=True)
    sent.mkdir(parents=True)
    (mail_root / "MailData").mkdir()
    
    fixture = Path(__file__).parent / "fixtures" / "sample.emlx"
    (inbox / "1.emlx").write_bytes(fixture.read_bytes())
    (sent / "2.emlx").write_bytes(fixture.read_bytes())
    
    # Filter to Sent only
    records = scan_emlx(mail_root, folders={"Sent"})
    assert len(records) == 1
    assert records[0].folder == "Sent"


@pytest.mark.parametrize(
    ("author", "expected_name", "expected_email"),
    [
        ("John Doe <john@example.com>", "John Doe", "john@example.com"),
        ("john@example.com", "john", "john@example.com"),
        ("", "Unknown", "unknown@local"),
        ("Marketing Team", "Marketing Team", "unknown@local"),
        ("=?UTF-8?B?Sm9obiBEb2U=?= <john@example.com>", "John Doe", "john@example.com"),
    ],
)
def test_parse_author_handles_edge_cases(author: str, expected_name: str, expected_email: str) -> None:
    name, email = _parse_author(author)
    assert name == expected_name
    assert email == expected_email


def test_scan_emlx_skips_malformed_from_header(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail" / "V10"
    inbox = mail_root / "AccountA" / "INBOX.mbox" / "Messages"
    inbox.mkdir(parents=True)
    (mail_root / "MailData").mkdir()

    fixture = Path(__file__).parent / "fixtures" / "sample.emlx"
    good = fixture.read_bytes()
    bad = good.replace(b"From: John Doe <john@example.com>", b"From: Not An Email Header")

    (inbox / "good.emlx").write_bytes(good)
    (inbox / "bad.emlx").write_bytes(bad)

    records = scan_emlx(mail_root, folders=set())
    assert len(records) == 2
    assert {record.senderEmail for record in records} == {"john@example.com", "unknown@local"}
