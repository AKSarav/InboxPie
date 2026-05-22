# InboxPie — Privacy First Thunderbird Mail Organizer

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
- **Review Selected** — Before moving anything, review selected messages in a mini inbox table with subject, sender, folder, account, date, and size. Click a subject to open the message in Thunderbird. Export the selection as CSV for record-keeping.
- **Move to Trash** — Safely move reviewed messages to Trash rather than permanently deleting them.
- **Move to Folder** — Move reviewed messages into another Thunderbird folder.
- **Privacy Mode** — Toggle email masking to hide emails and domains on-screen for screenshots, demos, or screen sharing (e.g., `john@example.com` → `j***@l***.com`). Exports always use real addresses.
- **Folder Selection** — Choose exactly which folders and subfolders to scan from your real mailbox tree. Selection persists across sessions.
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
5. Select rows or insight groups. Click the **Selected for Action** stat card to quickly open the review modal.
6. Click **Review Selected** (or the stat card).
7. Inspect the selected messages, search/filter the review list, click a subject to open it in Thunderbird, unselect exceptions, export to CSV if needed, then choose **Move to Trash** or **Move to Folder**.

**Privacy Mode:** Click the eye icon in the header to toggle on-screen email and domain masking — useful for screenshots or screen sharing. CSV exports are never masked.

## Folder Scanning

Click the **Folders** button in the header to load your mailbox tree and choose which folders and subfolders to scan.

- Folders are loaded from Thunderbird when you open the dropdown.
- Subfolders appear indented under their parent folders.
- Defaults match the previous behavior: Inbox, Sent, Archives, Junk, and their subfolders.
- Your selection is saved and persists across sessions.
- Use **All** or **None** for quick bulk selection.

## Changelog

### 1.0.2

**Private Mode Enhancement and Bug Fixes** (`6263f5e`)

- Extended privacy masking to domains, account names, and PieView detail panels.
- Fixed stale unmasked content when toggling privacy mode on PieView drill-down.
- Fixed PieView domain detail **Select** button via delegated click handling.

**Open Emails with Hyperlink** (`be4b585`)

- Review Selected subjects are clickable links that open the message in a Thunderbird tab.
- Folder picker now loads your real mailbox tree, including subfolders, instead of only standard folder types.
- Scan uses the exact folders you select, not just folder-type filters.
- Account change resets the dashboard and refreshes the folder list when the picker is open.

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
- The extension uses Thunderbird MailExtension APIs and stores only local UI preferences in `localStorage`: theme, privacy mask toggle, and folder scan selection.
- Opening a message from Review Selected uses `messageDisplay.open` on user click only; the extension does not read message bodies.
- The review screen is intentionally placed before bulk actions so users can inspect message metadata before moving messages.

## Open Source ❤️

InboxPie is available as open source under the MIT License. See the [LICENSE](LICENSE) file for details.

## Creator and Contact

InboxPie is created and maintained by AKSarav. Follow me on LinkedIn [@aksarav](https://www.linkedin.com/in/aksarav/) 
