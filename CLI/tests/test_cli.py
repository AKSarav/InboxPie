from pathlib import Path

from typer.testing import CliRunner

from inboxpie_cli.cli import app


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
