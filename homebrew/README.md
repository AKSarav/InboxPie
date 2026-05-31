# InboxPie Homebrew Tap Files

These files are meant to be copied into the [homebrew-crafts](https://github.com/AKSarav/homebrew-crafts) tap repository.

## Tap layout

After copying, your tap repo should look like:

```text
homebrew-crafts/
├── Formula/
│   └── inboxpie.rb
└── README.md
```

## Install (for users)

```bash
brew tap AKSarav/crafts
brew install inboxpie
```

Then verify:

```bash
inboxpie version
inboxpie --help
```

## Publish to your tap

From this repo:

```bash
# Copy the formula into your tap checkout
cp homebrew/Formula/inboxpie.rb ../homebrew-crafts/Formula/inboxpie.rb

cd ../homebrew-crafts
git add Formula/inboxpie.rb
git commit -m "Add inboxpie formula"
git push
```

Or clone the tap and copy directly:

```bash
git clone git@github.com:AKSarav/homebrew-crafts.git
cp homebrew/Formula/inboxpie.rb homebrew-crafts/Formula/inboxpie.rb
cd homebrew-crafts
git add Formula/inboxpie.rb
git commit -m "Add inboxpie formula"
git push
```

## Test locally before pushing

Homebrew requires formulae to live inside a tap. Test from a local tap checkout:

```bash
brew tap AKSarav/crafts ./path/to/homebrew-crafts
brew install inboxpie
brew test inboxpie
```

Or, after pushing to GitHub:

```bash
brew untap AKSarav/crafts 2>/dev/null || true
brew tap AKSarav/crafts
brew install inboxpie
```

## Updating for a new PyPI release

1. Publish a new version to PyPI (`inboxpie` on PyPI).
2. Bump the version in `CLI/pyproject.toml`.
3. Regenerate the formula:

```bash
./homebrew/scripts/update-formula.sh 1.0.4
```

4. Copy the updated `homebrew/Formula/inboxpie.rb` into `homebrew-crafts` and push.

Alternatively, after copying into your tap:

```bash
brew update-python-resources --version 1.0.4 Formula/inboxpie.rb
```

## Notes

- The formula installs the PyPI package `inboxpie` into an isolated Homebrew virtualenv.
- macOS only — InboxPie reads Apple Mail data under `~/Library/Mail/`.
- Users still need to grant **Full Disk Access** to their terminal app (see CLI README).
