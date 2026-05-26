# Release Checklist

Use this checklist before publishing InboxPie to addons.thunderbird.net or GitHub releases.

## Code Readiness

- [ ] Run syntax checks:

  ```bash
  node --check dashboard/dashboard.js
  node --check background.js
  ```

- [ ] Load the extension as a temporary Thunderbird add-on.
- [ ] Scan a test account.
- [ ] Verify PieView, By Sender, By Domain, By Size, and Timeline.
- [ ] Verify Review Selected, Unselect, Unselect Matches, Clear Selection, Move to Folder, and Move to Trash.
- [ ] Verify light and dark themes.
- [ ] Confirm no mailbox-derived values are rendered unsafely.

## Privacy and Permissions

- [ ] Confirm `manifest.json` permissions are still required.
- [ ] Confirm `README.md` permission descriptions are accurate.
- [ ] Confirm `PRIVACY.md` matches actual behavior.
- [ ] Confirm no telemetry, analytics, external API calls, or remote scripts were added.

## Packaging

Package only active extension files:

```bash
zip -r app@inboxpie.com.xpi manifest.json background.js dashboard/ icons/
```

Do not include:

- Old prototypes
- Development-only files
- Screenshots or marketing images not used by the extension
- Agent transcripts or local workspace files
- Test data with private mailbox information

## ATN Listing

- [ ] Add a concise product summary.
- [ ] Explain that processing is local.
- [ ] Explain that the extension reads metadata, not full message bodies.
- [ ] Explain Move to Trash and Move to Folder behavior.
- [ ] Include screenshots that do not expose private mailbox data.
- [ ] Confirm the support/contact URL is correct.

## Versioning

- [ ] Update `manifest.json` version.
- [ ] Create release notes.
- [ ] Tag the release in Git after final validation.
