from __future__ import annotations

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from inboxpie_cli.analytics.aggregations import Analytics
from inboxpie_cli.privacy import mask_domain, mask_email

console = Console()


def _format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    if size < 1024 * 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    return f"{size / (1024 * 1024 * 1024):.2f} GB"


def print_terminal_summary(analytics: Analytics, privacy: bool = False) -> None:
    # Stats panel
    stats = f"""[bold]Total:[/bold] {analytics.total:,} emails
[bold]Unread:[/bold] {analytics.unread:,}
[bold]Unique Senders:[/bold] {analytics.unique_senders:,}
[bold]Unique Domains:[/bold] {analytics.unique_domains:,}
[bold]Total Size:[/bold] {_format_bytes(analytics.total_size)}"""
    
    console.print(Panel(stats, title="[bold blue]InboxPie Scan Results[/bold blue]", border_style="blue"))
    console.print()
    
    # Top domains table
    if analytics.by_domain:
        table = Table(title="Top Domains", show_header=True, header_style="bold cyan")
        table.add_column("Domain", style="dim")
        table.add_column("Count", justify="right")
        table.add_column("Unread", justify="right")
        table.add_column("Senders", justify="right")
        
        for d in analytics.by_domain[:15]:
            domain = mask_domain(d["domain"]) if privacy else d["domain"]
            table.add_row(domain, f"{d['count']:,}", f"{d['unread']:,}", f"{d['senders']:,}")
        
        console.print(table)
        console.print()
    
    # Top senders table
    if analytics.by_sender:
        table = Table(title="Top Senders", show_header=True, header_style="bold green")
        table.add_column("Email", style="dim")
        table.add_column("Name")
        table.add_column("Count", justify="right")
        table.add_column("Unread", justify="right")
        
        for s in analytics.by_sender[:15]:
            email = mask_email(s["email"]) if privacy else s["email"]
            table.add_row(email, s["name"][:30], f"{s['count']:,}", f"{s['unread']:,}")
        
        console.print(table)
        console.print()
    
    # Timeline (recent months)
    if analytics.by_month:
        table = Table(title="Recent Months", show_header=True, header_style="bold yellow")
        table.add_column("Month")
        table.add_column("Count", justify="right")
        table.add_column("Unread", justify="right")
        
        for m in analytics.by_month[-12:]:
            table.add_row(m["label"], f"{m['count']:,}", f"{m['unread']:,}")
        
        console.print(table)
        console.print()
    
    # Folders
    if analytics.by_folder:
        table = Table(title="Folders", show_header=True, header_style="bold magenta")
        table.add_column("Folder")
        table.add_column("Count", justify="right")
        table.add_column("Unread", justify="right")
        
        for f in analytics.by_folder[:10]:
            table.add_row(f["folder"], f"{f['count']:,}", f"{f['unread']:,}")
        
        console.print(table)
