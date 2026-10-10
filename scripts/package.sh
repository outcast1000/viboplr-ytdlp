#!/usr/bin/env bash
# Build ytdlp.zip (manifest.json at ROOT — required by install_plugin_from_zip)
# and update.json from the repo root. Run from the repo root: scripts/package.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -e 'console.log(require("./manifest.json").version)')
MIN_APP=$(node -e 'console.log(require("./manifest.json").minAppVersion || "")')
FILE_URL="https://github.com/outcast1000/viboplr-ytdlp/releases/latest/download/ytdlp.zip"

# Changelog: lines under the top-most "## " heading in CHANGELOG.md, if present.
CHANGELOG=""
if [ -f CHANGELOG.md ]; then
  CHANGELOG=$(awk '/^## /{if(seen)exit; seen=1; next} seen{print}' CHANGELOG.md | sed '/^$/d' | head -50)
fi

# Signature. Signed with the Viboplr PLUGIN-signing key (never the app updater
# key) whenever it is in the environment, and REQUIRED in CI (REQUIRE_SIGNATURE=1).
# A plugin signed by that key is pre-approved by the app: no permission prompt on
# install or update. Verified before zipping, because a signature that doesn't
# match is refused outright. A local build without the key ships unsigned.
rm -f signature.sig
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  node scripts/plugin-signing.mjs sign .
  node scripts/plugin-signing.mjs verify .
elif [ "${REQUIRE_SIGNATURE:-}" = "1" ]; then
  echo "error: REQUIRE_SIGNATURE=1 but no TAURI_SIGNING_PRIVATE_KEY is set." >&2
  exit 1
else
  echo "note: no plugin-signing key in the environment — building UNSIGNED (local use only)."
fi

rm -f ytdlp.zip
if [ -f signature.sig ]; then
  zip -q ytdlp.zip manifest.json index.js signature.sig
else
  zip -q ytdlp.zip manifest.json index.js
fi
echo "--- zip contents (manifest.json must have no dir prefix) ---"
unzip -l ytdlp.zip

VERSION="$VERSION" MIN_APP="$MIN_APP" FILE_URL="$FILE_URL" CHANGELOG="$CHANGELOG" node -e '
const fs=require("fs");
const info={version:process.env.VERSION, file:process.env.FILE_URL};
if(process.env.MIN_APP) info.minAppVersion=process.env.MIN_APP;
if(process.env.CHANGELOG) info.changelog=process.env.CHANGELOG;
fs.writeFileSync("update.json", JSON.stringify(info,null,2)+"\n");
console.log("wrote update.json:", JSON.stringify(info));
'

echo
echo "To publish: push the tag and let CI do it —"
echo "  git tag v${VERSION} && git push origin v${VERSION}"
echo
echo "Do NOT run 'gh release create' by hand. The Release workflow publishes on"
echo "the tag, so publishing locally creates the release first and CI's own"
echo "'gh release create' then dies with 'a release with the same tag name"
echo "already exists' — a red X on a release that is actually fine, which is"
echo "indistinguishable from a real failure. Let CI be the only publisher."
echo "(The zip + update.json built above are for local inspection; the workflow"
echo "rebuilds both from source.)"
