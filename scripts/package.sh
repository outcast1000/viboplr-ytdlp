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

rm -f ytdlp.zip
zip -q ytdlp.zip manifest.json index.js
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
echo "To publish:"
echo "  gh release create v${VERSION} ytdlp.zip update.json --repo outcast1000/viboplr-ytdlp --title \"v${VERSION}\" --notes-file CHANGELOG.md"
