#!/usr/bin/env bash
# Regenerate homebrew/Formula/inboxpie.rb for a new PyPI release.
#
# Usage:
#   ./homebrew/scripts/update-formula.sh [VERSION]
#
# If VERSION is omitted, reads version from CLI/pyproject.toml.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FORMULA="$ROOT/homebrew/Formula/inboxpie.rb"
PYPROJECT="$ROOT/CLI/pyproject.toml"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(python3 - <<'PY' "$PYPROJECT"
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
if not match:
    raise SystemExit("Could not read version from pyproject.toml")
print(match.group(1))
PY
)"
fi

echo "Updating formula for inboxpie ${VERSION}..."

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

python3 -m pip download "inboxpie==${VERSION}" --dest "$TMPDIR" --no-binary :all: --quiet

python3 - <<'PY' "$VERSION" "$FORMULA" "$TMPDIR"
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

version, formula_path, deps_dir = sys.argv[1:4]
deps_dir = Path(deps_dir)

def pypi_sdist(package: str, filename: str):
    meta = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{package}/json"))
    for url in meta["urls"]:
        if url["packagetype"] == "sdist" and url["filename"] == filename:
            return url["url"], url["digests"]["sha256"]
    raise SystemExit(f"Could not find sdist for {package} {filename}")

main_tar = deps_dir / f"inboxpie-{version}.tar.gz"
if not main_tar.exists():
    raise SystemExit(f"Missing {main_tar.name}; is inboxpie {version} on PyPI?")

main_url, main_sha = pypi_sdist("inboxpie", main_tar.name)

resources = []
for tar in sorted(deps_dir.glob("*.tar.gz")):
    if tar.name == main_tar.name:
        continue
    stem = tar.name.removesuffix(".tar.gz")
    pkg_version = stem.rsplit("-", 1)[1]
    pkg_stem = stem.rsplit("-", 1)[0]
    pkg_name = pkg_stem.replace("_", "-")
    url, sha = pypi_sdist(pkg_name, tar.name)
    resource_name = pkg_name.lower()
    resources.append((resource_name, url, sha))

resources.sort(key=lambda item: item[0])

lines = [
    'class Inboxpie < Formula',
    '  include Language::Python::Virtualenv',
    '',
    '  desc "Visualize and clean your inbox. Private, local, open source"',
    '  homepage "https://github.com/AKSarav/InboxPie"',
    f'  url "{main_url}"',
    f'  sha256 "{main_sha}"',
    '  license "MIT"',
    '',
    '  depends_on :macos',
    '  depends_on "python@3.13"',
    '',
]

for name, url, sha in resources:
    lines.extend([
        f'  resource "{name}" do',
        f'    url "{url}"',
        f'    sha256 "{sha}"',
        '  end',
        '',
    ])

lines.extend([
    '  def install',
    '    virtualenv_install_with_resources',
    '  end',
    '',
    '  test do',
    '    assert_match "inboxpie-cli", shell_output("#{bin}/inboxpie version")',
    '    assert_match "InboxPie CLI", shell_output("#{bin}/inboxpie --help")',
    '  end',
    'end',
    '',
])

Path(formula_path).write_text("\n".join(lines))
print(f"Wrote {formula_path}")
PY

echo "Done. Review changes, then copy to homebrew-crafts:"
echo "  cp homebrew/Formula/inboxpie.rb ../homebrew-crafts/Formula/inboxpie.rb"
