# InboxPie — Thunderbird Mail Organizer

InboxPie is a local-first Thunderbird extension for visualizing and cleaning up your business email inbox. 

It scans message metadata, turns the inbox into visual summaries, and lets you review selected messages before you can take the call to action to move them to Trash or another folder. 

No Personal Data is collected or stored. It is a local-first extension that runs inside Thunderbird with no external service, API key, telemetry, or cloud upload.

![InboxPie Screenshot](docs/screenshots/Pieview.png)
![InboxPie Screenshot](docs/screenshots/BySender.png)
![InboxPie Screenshot](docs/screenshots/Timeline.png)

The extension is designed for people who want to answer questions like:

- Which senders or domains create most of my mail?
- Which unread messages are old or noisy?
- Which messages take the most storage?
- What exactly am I about to move before I take action?

## Features

- **PieView** — Interactive sunburst visualization by Year -> Month -> Domain. Click chart segments to drill down and hover for details.
- **By Sender** — Rank senders by volume, expand a sender into years and months, then select specific groups for cleanup.
- **By Domain** — Group messages by sender domain and expand each domain to inspect individual senders.
- **By Size** — Find storage-heavy messages, senders, domains, and size buckets.
- **Timeline** — Explore message volume over time with range controls, zoom, month selection, and cleanup insight cards.
- **Review Selected** — Before moving anything, review selected messages in a mini inbox table with subject, sender, folder, account, date, and size.
- **Move to Trash** — Safely move reviewed messages to Trash rather than permanently deleting them.
- **Move to Folder** — Move reviewed messages into another Thunderbird folder.
- **Multi-account support** — Scan all connected accounts or focus on one account.
- **Local-first** — Runs inside Thunderbird with no external service, API key, telemetry, or cloud upload.

## Privacy

InboxPie processes mailbox information locally in Thunderbird.

- It does **not** send mailbox data to any server.
- It does **not** use analytics or telemetry.
- It does **not** read or display full email bodies.
- It uses message metadata needed for organization: sender, subject, date, folder, account, read status, tags, and size when Thunderbird exposes it.
- Selected messages are moved only after the user reviews and confirms the action.

> Why should you believe this ? - that's why InboxPie is OpenSource and you can review the code yourself.

## Permissions

| Permission | Why it is needed |
|---|---|
| `accountsRead` | List Thunderbird accounts and folders so the user can choose what to scan and where to move messages. |
| `messagesRead` | Read message metadata for charts, tables, search, review, and cleanup insights. |
| `messagesMove` | Move reviewed messages to a user-selected folder. |
| `messagesDelete` | Move reviewed messages to Trash. The extension does not permanently delete messages. |

## Usage

1. Click the **InboxPie** toolbar icon in Thunderbird.
2. Choose an account or keep **All Accounts** selected.
3. Click **Scan Mailbox**.
4. Explore the views:
   - **PieView** for a visual year/month/domain overview.
   - **By Sender** to find and drill into noisy senders.
   - **By Domain** to identify domains producing the most mail.
   - **By Size** to recover mailbox storage.
   - **Timeline** to review message volume and cleanup opportunities over time.
5. Select rows or insight groups.
6. Click **Review Selected**.
7. Inspect the selected messages, search/filter the review list, unselect exceptions, then choose **Move to Trash** or **Move to Folder**.

## Folder Scanning

By default, InboxPie scans Inbox, Sent, Archives, and Junk folders. Trash and Drafts are excluded from the initial scan.

## Development Installation

1. Open Thunderbird.
2. Go to **Tools -> Developer Tools -> Debug Add-ons** or open `about:debugging`.
3. Click **Load Temporary Add-on...**.
4. Select this repository's `manifest.json`.
5. Click the InboxPie toolbar icon to open the dashboard.

Temporary add-ons are removed when Thunderbird restarts.

## Packaging

For a release build, package only the active extension files:

```bash
zip -r app@inboxpie.com.xpi manifest.json background.js dashboard/ icons/
```

Do not include development notes, old prototype files, screenshots, or unrelated workspace files in the XPI.

## Requirements

- Thunderbird 115 or later.
- Works with Thunderbird accounts supported by the MailExtension APIs, including IMAP, POP3, and local folders.

## Notes for Add-on Review

- No remote JavaScript or third-party runtime libraries are used.
- No external network calls are required for the extension's core functionality.
- The extension uses Thunderbird MailExtension APIs and stores only the local theme preference in `localStorage`.
- The review screen is intentionally placed before bulk actions so users can inspect message metadata before moving messages.

## Open Source ❤️

InboxPie is available as open source under the MIT License. See the [LICENSE](LICENSE) file for details.

## Creator and Contact

InboxPie is created and maintained by AKSarav. Follow me on LinkedIn [@aksarav](https://www.linkedin.com/in/aksarav/) 