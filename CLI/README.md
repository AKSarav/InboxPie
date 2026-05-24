# InboxPie CLI

`inboxpie-cli` is a local-first Python command line tool that scans Apple Mail metadata and generates audit analytics compatible with InboxPie.

## Install

```bash
cd CLI
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

## Commands

```bash
inboxpie version

inboxpie scan --source apple-mail [--mode emlx|index] [--mail-root PATH] [--folders "INBOX,Sent"] [--output terminal|csv|json|html|all] [--report-dir DIR] [--privacy]
```

## Scan Modes

- `--mode emlx` (default): walks `~/Library/Mail/V*/**/*.emlx`, parses only headers + plist metadata, and skips message body parsing.
- `--mode index`: opens `MailData/Envelope Index` in read-only SQLite mode. If macOS Full Disk Access is missing, the CLI prints a clear remediation error.

## Outputs

- Terminal summary (`rich` tables)
- CSV report: `mail-audit-report.csv`
- JSON report: `mail-audit-report.json`
- Static HTML report: `--report-dir/inboxpie-report.html`

## Examples

```bash
# Default scan and terminal summary
inboxpie scan --source apple-mail

# Scan only Inbox and Sent folders, emit all report formats
inboxpie scan --folders "INBOX,Sent" --output all --report-dir ./reports

# Use Envelope Index mode (faster, requires Full Disk Access)
inboxpie scan --mode index --output json

# Privacy mode (mask emails in terminal/HTML)
inboxpie scan --privacy --output all --report-dir ./reports
```

## Full Disk Access

For `--mode index` to work, your terminal app needs Full Disk Access:

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Add **Terminal** (or iTerm, VS Code, etc.)
3. Toggle it **on** and restart the terminal

## Privacy

InboxPie CLI reads only message **metadata** (sender, subject, date, folder, read status, size). It never reads or stores email body content. See [PRIVACY.md](PRIVACY.md) for details.

## Development

```bash
pip install -e ".[dev]"
pytest
```
