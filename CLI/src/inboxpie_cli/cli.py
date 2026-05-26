from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from inboxpie_cli import __version__
from inboxpie_cli.analytics import build_analytics
from inboxpie_cli.config import (
    DEFAULT_CSV_FILENAME,
    DEFAULT_JSON_FILENAME,
    DEFAULT_MAIL_ROOT,
    DEFAULT_MODE,
    DEFAULT_REPORT_DIR,
)
from inboxpie_cli.output import (
    print_terminal_summary,
    write_csv_report,
    write_html_report,
    write_json_report,
)
from inboxpie_cli.permissions import (
    handle_full_disk_access_failure,
    is_macos,
    mail_library_access_denied,
    run_privacy_settings,
)
from inboxpie_cli.sources import scan_apple_mail

app = typer.Typer(help="InboxPie CLI")
console = Console()

_VALID_MODES = {"auto", "index", "emlx"}

# Typer treats Path options as readable by default; macOS Mail is often unreadable until FDA.
MailRootOption = Annotated[
    Path,
    typer.Option(
        help="Apple Mail root path (default: ~/Library/Mail)",
        exists=False,
        file_okay=False,
        dir_okay=True,
        readable=False,
        resolve_path=True,
    ),
]


@app.command("privacy-settings")
def privacy_settings() -> None:
    """Open macOS System Settings at Full Disk Access."""
    if not is_macos():
        console.print("[yellow]Full Disk Access settings are only available on macOS.[/yellow]")
        raise typer.Exit(code=1)

    if run_privacy_settings(console):
        return

    raise typer.Exit(code=1)


@app.command("scan")
def scan(
    source: str = typer.Option("apple-mail", help="Data source, currently supports apple-mail"),
    mode: str = typer.Option(DEFAULT_MODE, help="Scan mode: auto, index, or emlx"),
    mail_root: MailRootOption = DEFAULT_MAIL_ROOT,
    folders: str = typer.Option("", help="Comma-separated folder filters, e.g. INBOX,Sent"),
    output: str = typer.Option("terminal", help="terminal|csv|json|html|all"),
    report_dir: Path = typer.Option(DEFAULT_REPORT_DIR, help="Directory for html reports"),
    privacy: bool = typer.Option(False, "--privacy", help="Mask sender/domain in terminal and html output"),
) -> None:
    if source != "apple-mail":
        raise typer.BadParameter("Only --source apple-mail is supported right now.")

    normalized_mode = mode.strip().lower()
    if normalized_mode not in _VALID_MODES:
        raise typer.BadParameter("--mode must be auto, index, or emlx")

    selected_folders = {item.strip() for item in folders.split(",") if item.strip()}

    if not mail_root.exists():
        raise typer.BadParameter(
            f"Apple Mail folder not found at {mail_root}. "
            "Set --mail-root if Mail.app uses a different library path."
        )

    if is_macos() and mail_library_access_denied(mail_root):
        console.print(f"[red]Cannot read Apple Mail data at {mail_root}[/red]")
        handle_full_disk_access_failure(console, mail_root=mail_root)
        raise typer.Exit(code=2)

    try:
        records, engine = scan_apple_mail(
            mail_root=mail_root,
            folders=selected_folders,
            mode=normalized_mode,  # type: ignore[arg-type]
        )
    except PermissionError as exc:
        console.print(f"[red]{exc}[/red]")
        handle_full_disk_access_failure(console, mail_root=mail_root)
        raise typer.Exit(code=2) from exc
    except FileNotFoundError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=1) from exc
    except RuntimeError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=1) from exc

    if normalized_mode == "auto" and engine == "emlx":
        console.print(
            "[yellow]Envelope Index unavailable. Fell back to .emlx scan.[/yellow] "
            "Grant Full Disk Access for faster index scans, or use --mode index once access is granted. "
            "Run [cyan]inboxpie privacy-settings[/cyan] to open the Full Disk Access pane."
        )
    elif engine == "index":
        console.print("[dim]Scan engine: Apple Mail Envelope Index[/dim]")

    if not records:
        console.print("[yellow]No messages found.[/yellow]")
        raise typer.Exit(code=0)

    analytics = build_analytics(records)

    outputs = {part.strip().lower() for part in output.split(",") if part.strip()}
    if not outputs:
        outputs = {"terminal"}
    if "all" in outputs:
        outputs = {"terminal", "csv", "json", "html"}

    if "terminal" in outputs:
        print_terminal_summary(analytics, privacy=privacy)

    if "csv" in outputs:
        csv_path = Path.cwd() / DEFAULT_CSV_FILENAME
        write_csv_report(csv_path, records)
        console.print(f"[green]CSV written:[/green] {csv_path}")

    if "json" in outputs:
        json_path = Path.cwd() / DEFAULT_JSON_FILENAME
        write_json_report(json_path, analytics)
        console.print(f"[green]JSON written:[/green] {json_path}")

    if "html" in outputs:
        html_path = write_html_report(report_dir=report_dir, analytics=analytics, privacy=privacy)
        console.print(f"[green]HTML report written:[/green] {html_path}")


@app.command("version")
def version() -> None:
    console.print(f"inboxpie-cli {__version__}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
