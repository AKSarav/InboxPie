from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from typer.testing import CliRunner

from inboxpie_cli.cli import app
from inboxpie_cli.permissions import (
    HostAppInfo,
    detect_host_app,
    guess_host_app_name,
    mail_library_access_denied,
    open_full_disk_access_settings,
    print_fda_guidance,
    run_privacy_settings,
)
from rich.console import Console

runner = CliRunner()


def test_guess_host_app_name_from_term_program(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TERM_PROGRAM", "Apple_Terminal")
    assert guess_host_app_name() == "Terminal"
    host = detect_host_app()
    assert host == HostAppInfo("Terminal", True)


def test_detect_host_app_from_cursor_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TERM_PROGRAM", "Cursor")
    assert detect_host_app() == HostAppInfo("Cursor", True)


def test_fda_guidance_names_host_app(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TERM_PROGRAM", "Cursor")
    console = Console(width=120, record=True)
    print_fda_guidance(console, mail_root=Path("/Users/me/Library/Mail"))
    output = console.export_text()
    assert "Cursor" in output
    assert "inboxpie privacy-settings" in output
    assert "Security note" in output
    assert "whole" in output.lower()


def test_mail_library_access_denied_false_when_readable(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail"
    mail_root.mkdir()
    with patch("inboxpie_cli.permissions.is_macos", return_value=True):
        assert mail_library_access_denied(mail_root) is False


def test_mail_library_access_denied_true_on_permission_error(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail"
    mail_root.mkdir()
    with (
        patch("inboxpie_cli.permissions.is_macos", return_value=True),
        patch("os.scandir", side_effect=PermissionError),
    ):
        assert mail_library_access_denied(mail_root) is True


def test_open_full_disk_access_settings_tries_urls() -> None:
    with (
        patch("inboxpie_cli.permissions.is_macos", return_value=True),
        patch("subprocess.run") as run_mock,
    ):
        run_mock.return_value = MagicMock(returncode=0)
        assert open_full_disk_access_settings() is True
        run_mock.assert_called_once()
        assert run_mock.call_args.args[0][0] == "open"
        assert "Privacy_AllFiles" in run_mock.call_args.args[0][1]


def test_run_privacy_settings_opens_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TERM_PROGRAM", "Cursor")
    console = Console()
    with (
        patch("inboxpie_cli.permissions.is_macos", return_value=True),
        patch("inboxpie_cli.permissions.open_full_disk_access_settings", return_value=True) as open_mock,
    ):
        assert run_privacy_settings(console) is True
        open_mock.assert_called_once()


def test_scan_unreadable_mail_root_skips_typer_readable_error(tmp_path: Path) -> None:
    """Unreadable Mail paths should hit FDA guidance, not Typer's generic 'not readable'."""
    mail_root = tmp_path / "Mail"
    mail_root.mkdir()
    mail_root.chmod(0o000)
    try:
        with patch("inboxpie_cli.cli.is_macos", return_value=True):
            result = runner.invoke(
                app,
                [
                    "scan",
                    "--mail-root",
                    str(mail_root),
                ],
            )
    finally:
        mail_root.chmod(0o755)

    assert result.exit_code == 2
    assert "Full Disk Access required" in result.stdout
    assert "inboxpie privacy-settings" in result.stdout
    assert "Invalid value for '--mail-root'" not in result.stdout
    assert "is not readable" not in result.stdout


def test_scan_preflight_exits_when_mail_library_blocked(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail"
    mail_root.mkdir()
    with patch("inboxpie_cli.cli.mail_library_access_denied", return_value=True):
        result = runner.invoke(
            app,
            [
                "scan",
                "--mail-root",
                str(mail_root),
            ],
        )

    assert result.exit_code == 2
    assert "Full Disk Access required" in result.stdout
    assert "inboxpie privacy-settings" in result.stdout


def test_privacy_settings_command_opens_settings() -> None:
    with (
        patch("inboxpie_cli.cli.is_macos", return_value=True),
        patch("inboxpie_cli.cli.run_privacy_settings", return_value=True) as run_mock,
    ):
        result = runner.invoke(app, ["privacy-settings"])

    assert result.exit_code == 0
    run_mock.assert_called_once()
