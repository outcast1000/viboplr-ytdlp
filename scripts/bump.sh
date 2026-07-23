#!/usr/bin/env bash
# Bump the plugin version and stamp a new CHANGELOG section.
#
# Usage: scripts/bump.sh <patch|minor|major>
#        scripts/bump.sh <X.Y.Z>            # set an explicit version
#
# Effects:
#   - rewrites "version" in manifest.json
#   - prepends a "## vX.Y.Z" section to CHANGELOG.md (with a TODO placeholder)
#
# It does NOT commit, tag, or push — review the changes, fill in the changelog,
# then commit and release (see RELEASING.md).
set -euo pipefail
cd "$(dirname "$0")/.."

ARG="${1:-}"
if [ -z "$ARG" ]; then
  echo "Usage: scripts/bump.sh <patch|minor|major|X.Y.Z>" >&2
  exit 1
fi

CURRENT=$(node -e 'console.log(require("./manifest.json").version)')

NEW=$(CURRENT="$CURRENT" ARG="$ARG" node -e '
  var cur = process.env.CURRENT;
  var arg = process.env.ARG;
  if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(arg)) { console.log(arg); process.exit(0); }
  var m = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(cur);
  if (!m) { console.error("Current version is not X.Y.Z: " + cur); process.exit(1); }
  var major = +m[1], minor = +m[2], patch = +m[3];
  if (arg === "major") { major++; minor = 0; patch = 0; }
  else if (arg === "minor") { minor++; patch = 0; }
  else if (arg === "patch") { patch++; }
  else { console.error("Unknown bump kind: " + arg + " (use patch|minor|major|X.Y.Z)"); process.exit(1); }
  console.log(major + "." + minor + "." + patch);
')

if [ "$NEW" = "$CURRENT" ]; then
  echo "Version already $NEW — nothing to do." >&2
  exit 1
fi

if grep -qE "^## v${NEW//./\\.}$" CHANGELOG.md 2>/dev/null; then
  echo "CHANGELOG.md already has a section for v$NEW — aborting." >&2
  exit 1
fi

CURRENT="$CURRENT" NEW="$NEW" node -e '
  var fs = require("fs");
  var p = "manifest.json";
  var m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.version = process.env.NEW;
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'

NEW="$NEW" node -e '
  var fs = require("fs");
  var p = "CHANGELOG.md";
  var ver = process.env.NEW;
  var section = "## v" + ver + "\n- TODO: describe changes\n\n";
  var text = "";
  try { text = fs.readFileSync(p, "utf8"); } catch (e) { text = "# Changelog\n\n"; }
  var lines = text.split("\n");
  var idx = -1;
  for (var i = 0; i < lines.length; i++) {
    if (/^#\s+Changelog\s*$/.test(lines[i])) { idx = i; break; }
  }
  var out;
  if (idx === -1) {
    out = "# Changelog\n\n" + section + text;
  } else {
    var head = lines.slice(0, idx + 1).join("\n");
    var rest = lines.slice(idx + 1).join("\n").replace(/^\n+/, "");
    out = head + "\n\n" + section + rest;
  }
  fs.writeFileSync(p, out);
'

echo "Bumped $CURRENT -> $NEW"
echo " - manifest.json version updated"
echo " - CHANGELOG.md: added '## v$NEW' (fill in the TODO)"
echo
echo "Next: edit the changelog, then commit and release:"
echo "  git add manifest.json CHANGELOG.md index.js"
echo "  git commit -m \"Release v$NEW\""
echo "  git tag v$NEW && git push origin main v$NEW"
