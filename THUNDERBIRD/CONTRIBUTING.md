# Contributing

Thank you for considering a contribution to InboxPie.

## Project Goals

InboxPie should remain:

- Local-first and privacy-respecting
- Clear about every mailbox action before it happens
- Lightweight, with no unnecessary dependencies
- Useful for real inbox cleanup workflows

## Development Setup

1. Clone the repository.
2. Open Thunderbird.
3. Go to **Tools -> Developer Tools -> Debug Add-ons** or open `about:debugging`.
4. Load `manifest.json` as a temporary add-on.
5. Click the InboxPie toolbar icon and test the dashboard.

## Code Guidelines

- Do not add remote scripts, external fonts, telemetry, or analytics.
- Avoid reading email bodies unless there is a clear user-facing reason and the permission/privacy text is updated first.
- Keep destructive actions behind review and confirmation UI.
- Escape mailbox-derived data before rendering it as HTML.
- Prefer small, focused changes over broad rewrites.

## Testing Checklist

Before opening a pull request:

- Run JavaScript syntax checks:

  ```bash
  node --check dashboard/dashboard.js
  node --check background.js
  ```

- Reload the temporary add-on in Thunderbird.
- Scan at least one test account.
- Verify PieView, By Sender, By Domain, By Size, Timeline, Review Selected, Move to Folder, and Move to Trash.
- Test both light and dark themes.

## Pull Requests

Please include:

- What changed
- Why it changed
- Manual test steps
- Screenshots for UI changes
- Any permission/privacy impact

## Security and Privacy Changes

If your change affects permissions, message access, storage, or network behavior, update `README.md`, `PRIVACY.md`, and `RELEASE_CHECKLIST.md`.
