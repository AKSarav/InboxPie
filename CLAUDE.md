# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**InboxPie** is a privacy-first email inbox analysis tool with three independent products:

1. **CLI** (Python) — Command-line scanner for Apple Mail metadata (Envelope Index + `.emlx` fallback), generates HTML/CSV/JSON/terminal reports
2. **Thunderbird Extension** (JavaScript/WebExtension) — Interactive dashboard inside Thunderbird; shows PieView, sender/domain/size/timeline views, selection + bulk move/trash
3. **Electron Desktop App** (TypeScript/Node.js) — Port of the Thunderbird dashboard UI to a native macOS app, backed by the CLI scan engine

All three read **metadata only** (sender, subject, date, folder, read status, size) — never message bodies. No cloud, no telemetry, no data leaving the device.

---

## Development Setup

### CLI (Python)
```bash
cd CLI
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

**Test:** `pytest` (runs tests in `CLI/tests/`)

**Single test:** `pytest tests/test_file.py::test_function`

**Build & publish:** `./build-publish.sh` (Homebrew + PyPI)

### Thunderbird Extension
```bash
# Development: Load via about:debugging
# Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on → select manifest.json
```

**Package release:** `zip -r app@inboxpie.com.xpi manifest.json background.js dashboard/ icons/`

### Electron Desktop App
```bash
cd app
npm install
npm run dev      # Watch mode with hot reload
npm run build    # Compile TypeScript
npm run pack     # Unpacked app
npm run dist     # Signed/notarized DMG (requires Apple cert)
npm run typecheck
```

---

## Architecture at a Glance

### CLI Data Flow
```
Apple Mail (~Library/Mail/)
  ↓
Scan engine (auto: Envelope Index → fallback to .emlx)
  ↓
models.MessageRecord (dataclass)
  ↓
analytics/aggregations.py (pivot tables, time series)
  ↓
Output drivers (terminal, CSV, JSON, HTML)
```

**Key modules:**
- `sources/scan.py` — Orchestrates index + emlx, returns MessageRecord list
- `sources/envelope_index.py` — SQLite Envelope Index reader
- `sources/emlx.py` — `.emlx` file parser (plist + mailbox format)
- `analytics/aggregations.py` — Domain/sender/size/time pivots
- `output/` — Four output drivers (terminal/CSV/JSON/HTML)

### Thunderbird Extension Structure
```
THUNDERBIRD/
├── manifest.json          # Extension metadata
├── background.js          # Thunderbird API handlers (accounts, messages, moves)
└── dashboard/
    ├── popup.html         # UI root
    ├── dashboard.js       # Interactive charts + table logic (d3.js sunburst)
    └── styles.css
```

**Key entry points:**
- `background.js:getAccounts()` — List mailbox accounts
- `background.js:fetchAllMail()` — Scan + aggregate messages
- `background.js:moveMessagesToFolder()`, `deleteMessages()` — Bulk actions
- `dashboard.js` — Renders charts, handles drill-down, search, and exports

### Electron App Structure
```
app/
├── src/
│   ├── main/
│   │   ├── index.ts           # Electron main (window, IPC listeners)
│   │   ├── mail/
│   │   │   ├── provider.ts    # Abstract mail provider interface
│   │   │   └── apple-mail.ts  # AppleMailProvider (spawns Python script)
│   │   └── ipc/
│   │       └── handlers.ts    # IPC handler functions
│   ├── preload/
│   │   └── index.ts           # browser.runtime shim for dashboard.js
│   └── renderer/
│       ├── index.html         # Window root
│       ├── public/dashboard.js # Shared UI from Thunderbird
│       └── styles.css
├── scripts/
│   └── scan-apple-mail.py    # Calls CLI inboxpie_cli.sources.scan
└── shared/
    └── types.ts              # MessageRecord TypeScript type
```

**Architecture:** Renderer (dashboard.js) → Preload (RPC shim) → Main (IPC handlers) → Mail provider (Apple Mail Python script)

---

## Key Design Patterns

### Shared UI Between Thunderbird & Electron
The dashboard UI (`dashboard.js`, `styles.css`) is **copied** into both `THUNDERBIRD/dashboard/` and `app/src/renderer/public/`. Changes must be synchronized in both places. The Preload layer in Electron emulates Thunderbird's `browser.runtime` API so the same dashboard code works unchanged.

### Python Subprocess in Electron
The Electron app calls `scripts/scan-apple-mail.py` (which wraps the CLI) to perform scans. Output is streamed back as progress events over IPC.

### Import Compatibility (Shared Analytics)
The analytics module (`CLI/src/inboxpie_cli/analytics/aggregations.py`) is shared between CLI and Electron. The Electron build includes the `inboxpie_cli` package so Python scans use the same aggregation logic.

---

## Critical Files & Responsibilities

| File | Purpose |
|------|---------|
| `CLI/src/inboxpie_cli/models.py` | `MessageRecord` dataclass — canonical message schema for all three products |
| `CLI/src/inboxpie_cli/analytics/aggregations.py` | Domain/sender/size/time pivots — duplicated in `dashboard.js` (should be deduplicated) |
| `THUNDERBIRD/background.js` | Mail API handlers for Thunderbird; IPC surface replicated in Electron `app/src/main/ipc/handlers.ts` |
| `THUNDERBIRD/dashboard/dashboard.js` | Interactive UI (d3.js, charts, search, export); shared with Electron |
| `app/src/preload/index.ts` | Exposes `browser.runtime` API surface to renderer so dashboard.js runs unchanged |

---

## Common Tasks

### Add a New Report Format
1. Create a new output driver in `CLI/src/inboxpie_cli/output/` (e.g. `my_format.py`)
2. Implement the `def write(records, output_path)` interface
3. Register in `CLI/src/inboxpie_cli/cli.py:handle_output()`
4. Add test in `CLI/tests/test_outputs/`

### Add a New Scan Source (e.g., Gmail, O365)
1. Create a provider in `CLI/src/inboxpie_cli/sources/my_provider.py`
2. Return a list of `MessageRecord` objects
3. Register in `CLI/src/inboxpie_cli/sources/scan.py:get_scan_source()`
4. For Electron, add a provider in `app/src/main/mail/` that spawns the Python module via subprocess

### Sync Dashboard UI Changes
The `dashboard.js` and `styles.css` files are maintained in `THUNDERBIRD/dashboard/` and copied to `app/src/renderer/public/`. When modifying:
1. Update the Thunderbird version first
2. Test in Thunderbird via `about:debugging`
3. Copy the updated files to `app/src/renderer/public/`
4. Rebuild and test the Electron app

### Apple Mail Full Disk Access
CLI scans require **Full Disk Access** for the host application (Terminal/Cursor/VSCode), not inboxpie. Run `inboxpie privacy-settings` to open System Preferences, then enable the detected app. For Electron, FDA must be granted to the Electron app executable.

---

## Testing Strategy

### CLI
- Unit tests in `CLI/tests/` cover models, parsers, and aggregations
- Run all: `pytest`
- Run one file: `pytest tests/test_scan.py`
- Run one test: `pytest tests/test_scan.py::test_envelope_index_parser`

### Thunderbird & Electron
- No automated tests; UI verified manually via `about:debugging` (Thunderbird) or `npm run dev` (Electron)
- Test checklist in `THUNDERBIRD/RELEASE_CHECKLIST.md`

---

## Dependencies & Constraints

| Component | Language | Key Deps | Notes |
|-----------|----------|----------|-------|
| CLI | Python 3.10+ | `typer`, `rich`, `jinja2` | No external network calls |
| Thunderbird | JavaScript | WebExtension API, `d3.js` (inline) | Requires Thunderbird 115+ |
| Electron | TypeScript/Node 20+ | `electron`, `electron-vite`, `electron-builder` | Requires macOS, Python 3.10+ for CLI calls |

---

## Known Limitations & Future Work

- **Analytics duplication:** `CLI/aggregations.py` logic is duplicated in `dashboard.js`. Should extract shared aggregation as a shared module.
- **Move/delete actions in Electron:** Currently stubs for Apple Mail (Thunderbird has native support via MailExtension APIs).
- **Provider abstraction:** Only Apple Mail is implemented. IMAP / O365 / Thunderbird providers are planned.
- **Python bundling:** Electron currently requires a system Python + `inboxpie` CLI. Bundling a standalone runtime is future work.

---

## Release Process

### CLI
```bash
cd CLI
./build-publish.sh  # Builds wheel, publishes to PyPI, taps Homebrew
```

### Thunderbird
```bash
zip -r app@inboxpie.com.xpi manifest.json background.js dashboard/ icons/
# Follow THUNDERBIRD/RELEASE_CHECKLIST.md
```

### Electron (macOS)
```bash
cd app
npm run dist  # Requires Apple Developer certificate + signing identity
```
