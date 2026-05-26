from pathlib import Path

import pytest
from typer.testing import CliRunner

from inboxpie_cli.cli import app
from inboxpie_cli.sources.emlx import _parse_author, scan_emlx
from inboxpie_cli.sources.scan import scan_apple_mail

runner = CliRunner()


def test_version_command() -> None:
    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert "inboxpie-cli 0.1.0" in result.stdout


def test_scan_json_output(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail" / "V10"
    inbox = mail_root / "AccountA" / "INBOX.mbox" / "Messages"
    inbox.mkdir(parents=True)
    (mail_root / "MailData").mkdir()

    fixture = Path(__file__).parent / "fixtures" / "sample.emlx"
    (inbox / "1.emlx").write_bytes(fixture.read_bytes())

    with runner.isolated_filesystem(temp_dir=tmp_path):
        result = runner.invoke(
            app,
            [
                "scan",
                "--source", "apple-mail",
                "--mode", "emlx",
                "--mail-root", str(mail_root),
                "--output", "json",
            ],
        )
        assert result.exit_code == 0
        assert Path("mail-audit-report.json").exists()


def test_scan_csv_output(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail" / "V10"
    inbox = mail_root / "AccountA" / "INBOX.mbox" / "Messages"
    inbox.mkdir(parents=True)
    (mail_root / "MailData").mkdir()

    fixture = Path(__file__).parent / "fixtures" / "sample.emlx"
    (inbox / "1.emlx").write_bytes(fixture.read_bytes())

    with runner.isolated_filesystem(temp_dir=tmp_path):
        result = runner.invoke(
            app,
            [
                "scan",
                "--source", "apple-mail",
                "--mode", "emlx",
                "--mail-root", str(mail_root),
                "--output", "csv",
            ],
        )
        assert result.exit_code == 0
        assert Path("mail-audit-report.csv").exists()


def test_auto_mode_falls_back_to_emlx(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail" / "V10"
    inbox = mail_root / "AccountA" / "INBOX.mbox" / "Messages"
    inbox.mkdir(parents=True)
    (mail_root / "MailData").mkdir()

    fixture = Path(__file__).parent / "fixtures" / "sample.emlx"
    (inbox / "1.emlx").write_bytes(fixture.read_bytes())

    records, engine = scan_apple_mail(mail_root=mail_root, folders=set(), mode="auto")
    assert engine == "emlx"
    assert len(records) == 1


def test_invalid_mode_rejected(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        ["scan", "--mode", "sqlite", "--mail-root", str(tmp_path / "Mail")],
    )
    assert result.exit_code != 0
    assert "auto, index, or emlx" in f"{result.stdout}{result.stderr}"
