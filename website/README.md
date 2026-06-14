# InboxPie — Website

A single-page marketing site for InboxPie. Fully self-contained: no build step, no external
fonts/CDNs/trackers (on-brand with InboxPie's privacy-first stance).

## Files
- `index.html` — the one-pager (hero, features, privacy, apps, how-it-works)
- `styles.css` — all styling (dark theme, glassmorphism, gradient accents, responsive)

## View it
Just open the file:
```bash
open website/index.html        # macOS
```
Or serve it:
```bash
cd website && python3 -m http.server 8080   # → http://localhost:8080
```

## Notes
- Visual product mock (PieView donut + chat card) is drawn purely in CSS — no images.
- Update the GitHub / download links (currently `#` / `https://github.com/`) before publishing.
