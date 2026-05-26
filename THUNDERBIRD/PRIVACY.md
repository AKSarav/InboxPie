# Privacy Policy

InboxPie is designed as a local-first Thunderbird extension.

## Data Processed

InboxPie reads message metadata needed to organize and visualize your mailbox:

- Sender name and email address
- Subject
- Message date
- Folder and account
- Read/unread status
- Tags, when Thunderbird exposes them
- Message size, when Thunderbird exposes it

InboxPie does not read or display full email body content.

## Data Storage

InboxPie does not maintain a remote database. Scanned mailbox metadata is held in memory in the extension dashboard while you use it. It is not written to disk by the extension.

The extension stores only local UI preferences in `localStorage`:

| Key | Purpose |
|---|---|
| `mail-audit-theme` | Light or dark dashboard theme |
| `mail-audit-privacy-mask` | Whether on-screen email/domain masking is enabled |
| `mail-audit-folder-selections` | Which folders you chose to scan |

No mailbox content or message metadata is persisted to `localStorage`.

## Privacy Mode

InboxPie includes an optional privacy mode that masks email addresses and domains on screen (for example, `john@example.com` → `j***@l***.com`).

- Masking applies only to what is shown in the dashboard UI.
- CSV exports always contain the real sender addresses and metadata.
- Privacy mode does not change what Thunderbird stores or what is sent anywhere; it is a display-only preference.

## Data Sharing

InboxPie does not:

- Send mailbox data to any external server
- Use analytics or telemetry
- Sell, rent, or share user data
- Require an API key or cloud account

## Message Actions

InboxPie can move messages only after you select and review them.

- **Move to Trash** moves reviewed messages to Thunderbird's Trash where supported.
- **Move to Folder** moves reviewed messages to a folder you choose.
- **Open in Thunderbird** — In Review Selected, you can click a subject to open that message in a Thunderbird tab. This is user-initiated; InboxPie does not read the message body through this action.
- **Export CSV** — Exports selected message metadata to a file on your device. The export stays local; InboxPie does not upload it.

InboxPie does not permanently delete messages.

## Network Access

InboxPie does not require external network access for its core functionality.

## Contact

For privacy questions or issues, open an issue in the project repository.
