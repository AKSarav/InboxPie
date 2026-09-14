# InboxPie for Thunderbird — v1.0.4

## 🆕 New: Contacts and Browse pages

- **Contacts** — every unique sender in your scan aggregated into a searchable, A–Z indexed directory. Export the full list as CSV or JSON.
- **Browse** — a flat, virtually-scrolled, searchable table of every scanned email with a checkbox on each row, for manual one-by-one curation without going through an aggregated chart view first.

## 🔁 Selection engine overhaul

Reviewing and acting on selected messages has been rebuilt from the ground up:

- **Review Selected** now uses real per-row checkboxes (plus a header select-all) instead of a per-row *Unselect* button, and is virtually scrolled — no more 500-message display cap.
- New **Exclude checked** / **Keep only checked** bulk actions, plus a built-in guided-tour help button explaining the screen.
- **Move to Folder** / **Move to Trash** now act on exactly the checked+matched set, with counts on the buttons that always match what's actually selected.
- Move/Trash actions show a live, in-modal circular progress ring — driven by real batch-progress events from the background script — instead of a separate bar pinned to the top of the page.
- A floating selection pill (bottom-right, follows you across every view) replaces the old static "Selected for Action" stat card. It live-updates, bumps on change, and opens Review or clears the selection in one click.
- Clicking a slice in **By Sender** / **By Domain** now toggles selection for that sender/domain directly — matching how Categories already worked — independent of the search box.

## ⚡ Faster scans with a date range

When you set a scan date range, InboxPie now asks Thunderbird's own message store to filter by date natively (`browser.messages.query`) instead of fetching every message header first and discarding out-of-range ones afterward. Same results, genuinely less work for large mailboxes.

## 🎨 Other improvements

- Toolbar icon now displays correctly (previously fell back silently to the default puzzle-piece icon).
- Per-page dismissible tip banners on PieView, By Sender, By Domain, By Size, Timeline, Contacts, and Browse.
- Tab bar is now horizontally scrollable with fade-edge arrows once it overflows a narrow window, instead of squeezing or wrapping.
- PieView's sunburst chart resized to ~80% for better proportion.
- Export CSV / Export JSON restyled as plain text links.
- Default folder scan selection changed from Inbox + Sent + Archives + Junk to **Inbox only**.
- Fixed: Folders / Scan Range buttons not visually showing their active state.
- Fixed: a stale folder count badge after switching accounts, and a false "select at least one folder" prompt that could appear despite a valid default selection.
- Fixed: version badge and changelog header were showing `v1.1.0`, out of sync with the actual `1.0.4` release — corrected.
- New optional "Support InboxPie" popover (Star on GitHub / Sponsor / Write a Review), shown once ~30 seconds after your first scan, dismissible for the session.

## 🖼️ Assets

- Added screenshots for the new Contacts and Browse pages, and refreshed By Sender / By Size / PieView screenshots to match the current UI.
- Refreshed toolbar and extension icons; added a proper favicon for the dashboard page.

---

All permissions remain unchanged — InboxPie continues to request only mailbox **metadata**
access (sender, subject, date, folder, read status, size). No message bodies are read, no
data leaves your device.
