from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

from inboxpie_cli import __version__
from inboxpie_cli.analytics import build_analytics
from inboxpie_cli.config import (
    DEFAULT_CSV_FILENAME,
    DEFAULT_JSON_FILENAME,
    DEFAULT_MAIL_ROOT,
    DEFAULT_REPORT_DIR,
)
from inboxpie_cli.output import (
    print_terminal_summary,
    write_csv_report,
    write_html_report,
    write_json_report,
)
from inboxpie_cli.sources import scan_emlx, scan_envelope_index

app = typer.Typer(help="InboxPie CLI")
console = Console()


@app.command("scan")
def scan(
    source: str = typer.Option("apple-mail", help="Data source, currently supports apple-mail"),
    mode: str = typer.Option("emlx", help="Scan mode: emlx or index"),
    mail_root: Path = typer.Option(DEFAULT_MAIL_ROOT, help="Apple Mail root path"),
    folders: str = typer.Option("", help="Comma-separated folder filters, e.g. INBOX,Sent"),
    output: str = typer.Option("terminal", help="terminal|csv|json|html|all"),
    report_dir: Path = typer.Option(DEFAULT_REPORT_DIR, help="Directory for html reports"),
    privacy: bool = typer.Option(False, "--privacy", help="Mask sender/domain in terminal and html output"),
) -> None:
    if source != "apple-mail":
        raise typer.BadParameter("Only --source apple-mail is supported right now.")

    selected_folders = {item.strip() for item in folders.split(",") if item.strip()}

    if mode == "emlx":
        records = scan_emlx(mail_root=mail_root, folders=selected_folders)
    elif mode == "index":
        try:
            records = scan_envelope_index(mail_root=mail_root, folders=selected_folders)
        except PermissionError as exc:
            console.print(f"[red]{exc}[/red]")
            raise typer.Exit(code=2)
        except RuntimeError as exc:
            console.print(f"[red]{exc}[/red]")
            raise typer.Exit(code=1)
    else:
        raise typer.BadParameter("--mode must be either emlx or index")

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
