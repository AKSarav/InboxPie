# InboxPie Desktop (Electron)

Native macOS desktop app porting the **Thunderbird extension** dashboard into Electron, backed by the **CLI scan engine** for Apple Mail.

## Architecture

```text
app/
├── src/
│   ├── main/           # Electron main process (IPC, mail providers)
│   ├── preload/        # browser.runtime shim for dashboard.js
│   └── renderer/       # Thunderbird dashboard UI (HTML/CSS/JS)
├── scripts/            # Python scan helper (uses inboxpie_cli)
└── shared/             # TypeScript types (MessageRecord schema)
```

| Layer | Role |
|-------|------|
| **Renderer** | Thunderbird `dashboard.js` UI — PieView, Timeline, sender/domain/size views, selection + review |
| **Preload** | Exposes `window.browser.runtime` so the extension UI works unchanged |
| **Main** | IPC handlers mirroring `THUNDERBIRD/background.js` actions |
| **Mail provider** | `AppleMailProvider` scans via `scripts/scan-apple-mail.py` |

## Features (port status)

| Feature | Status |
|---------|--------|
| PieView sunburst | ✅ UI ported |
| By Sender / Domain / Size / Timeline | ✅ UI ported |
| Selection + review modal | ✅ UI ported |
| Privacy mode + theme toggle | ✅ UI ported |
| Folder picker + scan | ✅ Apple Mail |
| Export CSV/JSON | ✅ Client-side |
| Move to Trash / Move to Folder | ⏳ Stub (Thunderbird-only today) |
| Open message in client | ⏳ Stub |

## Prerequisites

- **macOS 12 (Monterey) or later** — tested on macOS 13, 14, and 15
- **Node.js 20+**
- **Python 3.10+** with InboxPie CLI available:

> **Account name resolution** reads from three sources in order: the macOS Internet Accounts database (`Accounts3.sqlite`, present on macOS ≤ 12), per-account plists in `~/Library/Mail/` (older IMAP/local accounts), and finally the Envelope Index sent-folder query (works on all versions). On macOS 13+, only the third source is typically available — account emails are inferred from sent mail.

```bash
# From repo (development)
cd CLI && uv sync && uv pip install -e .

# Or from PyPI
pip install inboxpie
```

Grant **Full Disk Access** to Terminal/Cursor (or the Electron app once packaged) so Apple Mail data can be read.

## Development

```bash
cd app
npm install
npm run dev
```

This launches Electron with hot reload for main/preload/renderer.

## Build

```bash
cd app
npm run build    # compile to out/
npm run pack     # unpacked app in release/
npm run dist     # signed/notarized DMG (requires Apple dev cert)
```

## IPC actions (Thunderbird-compatible)

The preload exposes the same RPC surface as `THUNDERBIRD/background.js`:

- `getAccounts`
- `listFoldersForScan`
- `listFolders`
- `fetchAllMail`
- `deleteMessages` (stub for Apple Mail)
- `moveMessagesToFolder` (stub for Apple Mail)
- `openMessage` (stub)

Progress events (`progress`, `deleteProgress`, `moveProgress`) are pushed over `inboxpie:event`.

## Next steps

1. **Mail actions for Apple Mail** — implement move/delete via Mail.app scripting or a safe filesystem layer
2. **Shared analytics module** — deduplicate `dashboard.js` aggregations with `CLI/analytics/aggregations.py`
3. **Provider abstraction** — add IMAP / Thunderbird connector providers
4. **Bundle Python** — ship a standalone runtime or call a bundled `inboxpie` binary for end users

## Related docs

- [THUNDERBIRD/README.md](../THUNDERBIRD/README.md) — extension features reference
- [CLI/README.md](../CLI/README.md) — scan engine and Apple Mail modes
