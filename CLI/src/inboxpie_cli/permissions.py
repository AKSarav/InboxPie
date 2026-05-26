"""macOS Full Disk Access detection and System Settings helpers."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from rich.console import Console

_FDA_SETTINGS_URLS = (
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
)

_TERM_PROGRAM_NAMES = {
    "Apple_Terminal": "Terminal",
    "iTerm.app": "iTerm",
    "vscode": "Visual Studio Code",
    "Cursor": "Cursor",
    "WarpTerminal": "Warp",
}

# macOS .app bundle path → name shown in Full Disk Access list
_APPLICATIONS_PATH_NAMES: tuple[tuple[str, str], ...] = (
    ("/Applications/Cursor.app", "Cursor"),
    ("/Applications/Visual Studio Code.app", "Visual Studio Code"),
    ("/Applications/Terminal.app", "Terminal"),
    ("/Applications/iTerm.app", "iTerm"),
    ("/Applications/Warp.app", "Warp"),
    ("/Applications/Alacritty.app", "Alacritty"),
    ("/Applications/Ghostty.app", "Ghostty"),
)

_SHELL_NAMES = frozenset({"zsh", "bash", "sh", "fish", "dash", "ksh", "Python", "python", "python3"})


@dataclass(frozen=True)
class HostAppInfo:
    """The macOS app that must be granted Full Disk Access."""

    name: str
    confident: bool


def is_macos() -> bool:
    return sys.platform == "darwin"


def detect_host_app() -> HostAppInfo:
    """Identify the app hosting this terminal session (needs FDA, not inboxpie)."""
    term_program = os.environ.get("TERM_PROGRAM", "").strip()
    if term_program:
        return HostAppInfo(_TERM_PROGRAM_NAMES.get(term_program, term_program), True)

    if is_macos():
        from_tree = _host_app_from_process_tree()
        if from_tree is not None:
            return HostAppInfo(from_tree, True)

    return HostAppInfo(
        "the app where you ran this command (Terminal, iTerm, Cursor, or VS Code)",
        False,
    )


def guess_host_app_name() -> str:
    """Backward-compatible display name for the host app."""
    return detect_host_app().name


def _host_app_from_process_tree() -> str | None:
    pid = os.getpid()
    for _ in range(25):
        command = _process_command(pid)
        if command:
            app_name = _app_name_from_command(command)
            if app_name:
                return app_name

        comm = _process_comm(pid)
        if comm and comm not in _SHELL_NAMES and not comm.endswith("inboxpie"):
            if comm.endswith(".app"):
                return comm.removesuffix(".app")
            if comm not in {"Cursor", "Code", "iTerm2", "Warp"}:
                pass
            else:
                return {"iTerm2": "iTerm", "Code": "Visual Studio Code"}.get(comm, comm)

        ppid = _process_ppid(pid)
        if ppid is None or ppid <= 1:
            break
        pid = ppid

    return None


def _app_name_from_command(command: str) -> str | None:
    for path_fragment, display_name in _APPLICATIONS_PATH_NAMES:
        if path_fragment in command:
            return display_name

    match = re.search(r"/Applications/([^/]+)\.app/", command)
    if match:
        return match.group(1).replace("%20", " ")

    return None


def _process_command(pid: int) -> str | None:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True,
            text=True,
            check=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = result.stdout.strip()
    return value or None


def _process_comm(pid: int) -> str | None:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "comm="],
            capture_output=True,
            text=True,
            check=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = result.stdout.strip()
    return value or None


def _process_ppid(pid: int) -> int | None:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "ppid="],
            capture_output=True,
            text=True,
            check=True,
            timeout=2,
        )
        return int(result.stdout.strip())
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def mail_library_access_denied(mail_root: Path) -> bool:
    """Return True when macOS is blocking reads under the Mail library."""
    if not is_macos() or not mail_root.exists():
        return False

    try:
        with os.scandir(mail_root):
            pass
    except PermissionError:
        return True
    except OSError as exc:
        return exc.errno in {1, 13}  # EPERM, EACCES

    return False


def open_full_disk_access_settings() -> bool:
    """Open System Settings at Privacy & Security → Full Disk Access."""
    if not is_macos():
        return False

    for url in _FDA_SETTINGS_URLS:
        try:
            result = subprocess.run(
                ["open", url],
                capture_output=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0:
            return True

    return False


def print_fda_guidance(console: Console, *, mail_root: Path | None = None) -> None:
    host = detect_host_app()
    console.print("\n[bold]Full Disk Access required[/bold]")

    if mail_root is not None:
        console.print(f"macOS blocked read access to [cyan]{mail_root}[/cyan]")

    if host.confident:
        console.print(
            f"\nYou ran InboxPie from [bold]{host.name}[/bold]. "
            f"\nIn System Settings, turn on Full Disk Access for [bold]{host.name}[/bold] exactly "
            f"\n(look for that name in the list, or use + to add it from Applications)."
        )
    else:
        console.print(
            "\nTurn on Full Disk Access for whichever app is hosting this terminal "
            "(the app in your menu bar / window title — e.g. Terminal, iTerm, Cursor, VS Code)."
        )
        console.print(
            "[dim]Could not detect the app name automatically; match the app you used to open this terminal.[/dim]"
        )

    console.print("\n[bold]Steps[/bold]")
    console.print(
        "1. Run [cyan]inboxpie privacy-settings[/cyan] to open System Settings → Full Disk Access"
    )
    console.print("2. System Settings → Privacy & Security → Full Disk Access")
    if host.confident:
        console.print(f"3. Enable [bold]{host.name}[/bold]")
        console.print(
            f"4. Quit [bold]{host.name}[/bold] completely (Cmd+Q), reopen it, then run [cyan]inboxpie scan[/cyan]"
        )
    else:
        console.print("3. Enable the terminal app you used for this command")
        console.print("4. Quit and reopen that app, then run [cyan]inboxpie scan[/cyan]")

    console.print("\n[bold]Security note[/bold]")
    console.print(
        "Full Disk Access applies to the [italic]whole[/italic] host app, not directly to inboxpie. "
        "Revoke the permission in System Settings when you are done scanning."
    )


def run_privacy_settings(console: Console) -> bool:
    """Open FDA settings and print which host app to enable."""
    if not is_macos():
        return False

    host = detect_host_app()
    if host.confident:
        console.print(
            f"Opening Full Disk Access settings. Enable [bold]{host.name}[/bold] "
            f"— the app where you run inboxpie."
        )
    else:
        console.print(
            "Opening Full Disk Access settings. Enable the terminal app you use to run inboxpie."
        )

    if not open_full_disk_access_settings():
        console.print("[red]Could not open System Settings.[/red]")
        return False

    console.print("[green]Opened System Settings → Full Disk Access.[/green]")
    if host.confident:
        console.print(f"Enable [bold]{host.name}[/bold], quit and reopen it, then run [cyan]inboxpie scan[/cyan].")
    else:
        console.print("Enable your terminal app, quit and reopen it, then run [cyan]inboxpie scan[/cyan].")
    return True


def handle_full_disk_access_failure(
    console: Console,
    *,
    mail_root: Path | None = None,
) -> None:
    print_fda_guidance(console, mail_root=mail_root)
