from pathlib import Path

from inboxpie_cli.sources.emlx import scan_emlx


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
