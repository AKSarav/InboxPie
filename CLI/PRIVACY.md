# Privacy Policy — InboxPie CLI

InboxPie CLI is designed as a local-first command line tool for macOS.

## Data Processed

InboxPie CLI reads message metadata needed to generate reports:

- Sender name and email address
- Subject
- Message date
- Folder and account
- Read/unread status
- Message size

**InboxPie CLI does not read or store full email body content.**

## Scan Modes

InboxPie CLI supports three scan modes. The default is **`auto`**.

### Default: `--mode auto`

1. Opens Apple Mail's **Envelope Index** SQLite database in read-only mode.
2. If the index cannot be read (permissions, missing file, schema mismatch), falls back to walking `.emlx` files.

This keeps scans fast in the common case while remaining resilient when the index is unavailable.

### `--mode index`

Opens Apple Mail's `Envelope Index` SQLite database in **read-only** mode. It queries:

- `messages` table (dates, flags, foreign keys)
- `subjects` table (subject text)
- `addresses` table (sender email and name)
- `mailboxes` table (folder URLs)

No writes are made to the database.

### `--mode emlx`

Walks `.emlx` files under `~/Library/Mail/V*/`. For each file, it reads:

- The RFC 5322 headers (From, Subject, Date)
- The XML plist footer (read/flagged flags)

It does **not** parse or store the message body. Individual malformed files are skipped so one bad message does not stop the scan.

## Data Storage

InboxPie CLI does not maintain a remote database. All data is processed in memory and output to local files (CSV, JSON, HTML) that you control.

## Data Sharing

InboxPie CLI does not:

- Send mailbox data to any external server
- Use analytics or telemetry
- Require an API key or cloud account

## Privacy Mode

The `--privacy` flag masks email addresses and domains in terminal and HTML output (e.g., `john@example.com` → `j***@e***.com`). CSV and JSON exports always contain the real data.

## Full Disk Access

On modern macOS, accessing `~/Library/Mail/` requires Full Disk Access for the application hosting your terminal (Terminal, Cursor, VS Code, iTerm, etc.) — not for the `inboxpie` command itself. macOS applies that permission to the entire host app: any command run in the same terminal inherits the access until you revoke it in System Settings.

## Contact

For privacy questions, open an issue in the project repository.
