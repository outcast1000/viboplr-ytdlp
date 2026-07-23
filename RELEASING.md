# Releasing & publishing

This plugin ships as a GitHub release containing `ytdlp.zip` (with `manifest.json`
at the **zip root**) and `update.json`. The app installs/updates from the
`updateUrl` in `manifest.json`.

## Cut a release

1. Bump the version and stamp a changelog section:
   ```bash
   scripts/bump.sh patch      # or minor | major | X.Y.Z
   ```
   Edit `CHANGELOG.md` to replace the TODO with real notes.

2. Commit and tag:
   ```bash
   git add manifest.json CHANGELOG.md index.js
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

3. The **Release** workflow (`.github/workflows/release.yml`) runs on the tag:
   it runs the tests, verifies `manifest.json` version == tag, builds
   `ytdlp.zip` + `update.json` via `scripts/package.sh`, verifies the zip has
   `manifest.json` at its root, and publishes the release.

   You can also build locally: `scripts/package.sh`, then
   `gh release create vX.Y.Z ytdlp.zip update.json --repo outcast1000/viboplr-ytdlp --notes-file CHANGELOG.md`.

The permanent manifest endpoint is:
`https://github.com/outcast1000/viboplr-ytdlp/releases/latest/download/update.json`

## First-time GitHub setup

This repo is created locally. To publish it:

```bash
gh repo create outcast1000/viboplr-ytdlp --public --source . --remote origin --push
```

(or create the repo in the GitHub UI and `git remote add origin …` + `git push -u origin main`).

## Registering in the plugin gallery

The gallery (`outcast1000/viboplr-plugins`) is index-only. After the first
release exists, add an entry to its `index.json` under `plugins[]`:

```json
{
  "id": "ytdlp",
  "name": "yt-dlp",
  "author": "Viboplr",
  "description": "Play & download audio and video from YouTube, SoundCloud, Bandcamp and 1000+ sites via yt-dlp",
  "updateUrl": "https://github.com/outcast1000/viboplr-ytdlp/releases/latest/download/update.json"
}
```

- `id` **must** equal this plugin's `manifest.json` id (`ytdlp`).
- `version` / `minAppVersion` are auto-synced by the gallery's reconcile bot — omit them.
- Optionally set `recommended` / `profiles` for onboarding pre-selection.

## Superseding the `youtube` gallery entry

To make this the recommended web-source plugin, in `outcast1000/viboplr-plugins`
`index.json`: remove (or mark experimental/deprecated in its description) the
`youtube` entry once `ytdlp` is published. Installed `youtube` copies keep working
until users switch; there is no forced migration.

## Optional host change (nice-to-have)

New download providers default to priority `999` (tried last). To rank yt-dlp
where the old YouTube provider sat, add to `DEFAULT_DOWNLOAD_PROVIDER_PRIORITY`
in the app's `src/hooks/usePlugins.ts`:

```ts
"ytdlp:ytdlp-download": 300,
```

Not required — the plugin works without it (stream-resolver order is user-configurable
in Settings → Providers and needs no code change).
