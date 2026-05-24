# InboxPie — Privacy First Thunderbird Mail Organizer

InboxPie is a local-first Thunderbird extension for visualizing and cleaning up your business email inbox. 

**Privacy-first email inbox analytics and cleanup tools.**

InboxPie helps you visualize, analyze, and clean up your email inbox — all locally, with no cloud, no telemetry, and no data leaving your machine.

![PieView](docs/screenshots/Pieview.png)


## What's in this repo

| Project | Description | Platform |
|---------|-------------|----------|
| [**Thunderbird Extension**](THUNDERBIRD/) | Interactive dashboard for Thunderbird with PieView, Timeline, By Sender/Domain/Size views, and bulk cleanup actions | Thunderbird 115+ |
| [**CLI**](CLI/) | Command-line tool to scan Apple Mail and generate reports (terminal, CSV, JSON, HTML) | macOS / Python 3.10+ |

---

## Screenshots

### PieView — Year → Month → Domain sunburst
![PieView](docs/screenshots/Pieview.png)

### By Sender — Drill down into senders by year and month
![By Sender](docs/screenshots/BySender.png)

### Timeline — Monthly volume with cleanup insights
![Timeline](docs/screenshots/Timeline.png)

---

## Key Features

- **5 visualization views** — PieView (sunburst), By Sender, By Domain, By Size, Timeline
- **Review before action** — Inspect selected messages before moving to Trash or another folder
- **Privacy Mode** — Mask emails/domains on-screen for screenshots and demos
- **Folder selection** — Pick exactly which folders and subfolders to scan
- **Export to CSV/JSON** — Keep records of what you reviewed and moved
- **100% local** — No servers, no APIs, no telemetry, no cloud upload

---

## Quick Start

### Thunderbird Extension

1. Download the latest `.xpi` from [Releases](https://github.com/AKSarav/InboxPie/releases) or build from source
2. In Thunderbird: **Tools → Add-ons and Themes → ⚙️ → Install Add-on From File**
3. Click the **InboxPie** toolbar icon to open the dashboard

For development:

```bash
cd THUNDERBIRD
# Load as temporary add-on in Thunderbird (about:debugging)
```

See [THUNDERBIRD/README.md](THUNDERBIRD/README.md) for full documentation.

### CLI (Apple Mail)

```bash
cd CLI
python3 -m venv .venv
source .venv/bin/activate
pip install -e .

# Scan and show terminal summary
inboxpie scan --source apple-mail

# Generate all reports
inboxpie scan --source apple-mail --output all --report-dir ./reports
```

See [CLI/README.md](CLI/README.md) for full documentation.

---

## Privacy

InboxPie reads only **message metadata** (sender, subject, date, folder, read status, size). It never reads or stores email body content.

| What InboxPie does | What InboxPie does NOT do |
|---|---|
| Reads message headers and metadata | Read email bodies |
| Stores UI preferences locally | Send data to any server |
| Exports reports to your local files | Use analytics or telemetry |
| Moves messages on your explicit action | Delete messages permanently |

See [THUNDERBIRD/PRIVACY.md](THUNDERBIRD/PRIVACY.md) and [CLI/PRIVACY.md](CLI/PRIVACY.md) for detailed privacy policies.

---

## Project Structure

```
InboxPie/
├── THUNDERBIRD/           # Thunderbird MailExtension
│   ├── manifest.json
│   ├── background.js
│   ├── dashboard/
│   │   ├── popup.html
│   │   ├── dashboard.js
│   │   └── styles.css
│   └── icons/
├── CLI/                   # Python CLI for Apple Mail
│   ├── pyproject.toml
│   ├── src/inboxpie_cli/
│   └── tests/
├── docs/
│   └── screenshots/
└── README.md              # You are here
```

---

## Contributing

Contributions are welcome! Please read [THUNDERBIRD/CONTRIBUTING.md](THUNDERBIRD/CONTRIBUTING.md) before submitting PRs.

- **Thunderbird extension**: JavaScript, Thunderbird MailExtension APIs
- **CLI**: Python 3.10+, Typer, Rich, Jinja2

---

## License

MIT License. See [THUNDERBIRD/LICENSE](THUNDERBIRD/LICENSE).

---

## Author

Created by [AKSarav](https://www.linkedin.com/in/aksarav/)

---

## Support

If you find InboxPie useful, consider:
- Starring this repo ⭐
- [Sponsoring on GitHub](https://github.com/sponsors/AKSarav)
- Sharing with others who might benefit
