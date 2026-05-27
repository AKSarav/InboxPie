

# InboxPie - Visualize and clean your inbox. Private, local, open source.

**See your inbox clearly. Clean up with confidence. Keep everything on your machine.**

InboxPie helps you understand where your email comes from, what is unread or taking space, and what you are about to change — before you act. No cloud, no telemetry, no data leaving your device.

![PieView — Year → Month → Domain sunburst](docs/screenshots/Pieview.png)


## Vision

Most inboxes grow faster than we can manage. Newsletters, alerts, and old unread mail pile up until cleanup feels risky — you are never quite sure what you will delete or move.

InboxPie turns mailbox metadata into visual summaries so you can **explore first, decide second, and act third**. The same analytics mindset powers both products in this repo: understand patterns, focus on what matters, then take action only when you are ready.



## Choose your path

| | [**Thunderbird Extension**](THUNDERBIRD/) | [**CLI**](CLI/) |
|---|---|---|
| **For** | Thunderbird users who want an interactive dashboard inside their mail client | macOS users with Apple Mail who want reports from the terminal |
| **You get** | PieView, Timeline, sender/domain/size views, and bulk cleanup with review | Terminal, CSV, JSON, and HTML reports from a local scan |
| **Best when** | You live in Thunderbird and want to select, review, and move messages | You want offline audits, exports, or Apple Mail analysis without Thunderbird |

Both tools read **metadata only** (sender, subject, date, folder, read status, size). Neither reads email bodies or sends data anywhere.

→ Full docs: [THUNDERBIRD/README.md](THUNDERBIRD/README.md) · [CLI/README.md](CLI/README.md)

> We are currently in progress to bring InboxPie to other mailboxes like O365 and other Clients in the near future. If you are interested in helping us with this, please contribute to the project.

## Shared principles

These apply to **every** InboxPie product — that is why they live here, not repeated in full in each sub-README.

| Principle | What it means |
|---|---|
| **Local-first** | Scanning, charts, and exports run on your machine |
| **Metadata only** | Headers and mailbox fields — never message body content |
| **Review before action** | Extension: inspect selections before move. CLI: read-only reports for informed cleanup |
| **Open source** | Inspect the code, verify the privacy claims yourself |

Detailed privacy policies: [THUNDERBIRD/PRIVACY.md](THUNDERBIRD/PRIVACY.md) · [CLI/PRIVACY.md](CLI/PRIVACY.md)



## Quick start

**Thunderbird** — install the `.xpi`, open the toolbar dashboard, scan, explore, review, then move.

```bash
# Install from Releases, then in Thunderbird:
# Tools → Add-ons and Themes → ⚙️ → Install Add-on From File
```

**CLI (Apple Mail)** — install, scan, generate reports.

```bash
cd CLI && python3 -m venv .venv && source .venv/bin/activate && pip install -e .
inboxpie scan --source apple-mail --output all --report-dir ./reports
```



## Feature matrix

| Feature | Thunderbird | CLI (Apple Mail) |
|---|---|---|
| PieView (year → month → domain sunburst) | ✓ | ✓ (HTML report) |
| By Sender (year / month drill-down) | ✓ | ✓ (HTML report) |
| By Domain | ✓ | ✓ (HTML report) |
| By Size | ✓ | ✓ (HTML report) |
| Timeline (zoom, month focus, insight cards) | ✓ | ✓ (HTML report) |
| Select messages for review | ✓ | ✓ (HTML report) |
| Review selected (search, sort, export CSV) | ✓ | ✓ (read-only) |
| Open message in mail client | ✓ | — |
| Move to Trash / Move to Folder | ✓ | — |
| Privacy Mode (mask emails on screen) | ✓ | ✓ |
| Folder selection (scan or filter) | ✓ | ✓ |
| Multi-account mailboxes | ✓ | ✓ |
| Terminal / JSON / CSV scan exports | — | ✓ |
| Scan modes (Envelope Index + `.emlx` fallback) | — | ✓ |

Setup and usage details: [THUNDERBIRD/README.md](THUNDERBIRD/README.md) · [CLI/README.md](CLI/README.md)



## Contributing

Contributions welcome. See [THUNDERBIRD/CONTRIBUTING.md](THUNDERBIRD/CONTRIBUTING.md).



## License

MIT — see [THUNDERBIRD/LICENSE](THUNDERBIRD/LICENSE).



## Author

Created by [AKSarav](https://www.linkedin.com/in/aksarav/)

If InboxPie helps you, consider starring the repo or [sponsoring on GitHub](https://github.com/sponsors/AKSarav).
