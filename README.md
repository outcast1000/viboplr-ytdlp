# viboplr-ytdlp

A [Viboplr](https://viboplr.com) plugin that plays and downloads **audio and video**
from YouTube, SoundCloud, Bandcamp, Vimeo and 1000+ other sites via
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp). It is the successor to the
`youtube` plugin and supersedes it.

## Features

- **Any yt-dlp source.** Search YouTube and SoundCloud from the sidebar, or paste
  a URL from any of the 1000+ sites yt-dlp supports (Bandcamp, Vimeo, Mixcloud, …).
- **Audio and video, per action.** In the search view: **Play** / **Queue** listen
  (audio), **Watch** opens the video in the theater, and **Download** opens a format
  picker that includes Video (MP4). No global mode to set — YouTube results are
  videos you choose to consume either way, and audio-only sources just have no
  "Watch". Rows also carry a `ytdlp://` ref, so right-click (Play / Enqueue / Play
  Next) and drag-to-queue work like any other track.
- **Hybrid playback.** Tracks stream directly whenever possible (`yt-dlp -g`, with
  the direct URL validated by a tiny range request), falling back to
  download-then-play when a direct stream isn't usable. Switch to **Download then
  play** in the plugin settings for maximum reliability.
- **Downloads.** A download provider offering Original audio (no re-encode), AAC,
  MP3, Opus, FLAC and Video (MP4, merged). Works from the sidebar, the now-playing
  download button, and the download modal's interactive search.
- **Drop-in for the YouTube plugin.** Registers the `ytdlp://` scheme for its own
  tracks and also keeps legacy `youtube://` tracks (from the old plugin) playable
  and downloadable.

## Requirements

- **yt-dlp** (required) — search, resolve and download.
- **ffmpeg** (optional) — needed to transcode audio to a chosen format and to
  merge video+audio into an MP4. Without it, only "Original audio" downloads are
  offered and video merging is unavailable.

Both are managed by the host app: install/update them from **Settings →
Dependencies**. This plugin never probes or downloads them itself — it only reads
the host's cached status (`api.system.getDependency`).

## How it works

- `manifest.json` contributes a sidebar view (`ytdlp-search`), a stream resolver
  (`ytdlp-fallback`), a download provider (`ytdlp-download`) and a settings panel.
- A track's identity is its source webpage URL, encoded into a `ytdlp://<url>`
  path (dots percent-escaped; a `.mp4` suffix marks video). The scheme resolver
  re-resolves it to a fresh stream at play time.
- Playback: `onStreamResolve` (metadata → search → resolve) and
  `onResolveStreamByUri("ytdlp" | "youtube")`.
- Downloads: `onResolveByUri` / `onResolveByMetadata` / `onInteractiveSearch` /
  `onInteractiveResolve` / `onGetQualities`.
- Everything shells out via the host's allow-listed `api.system.exec("yt-dlp" | "ffmpeg", …)`.

The plugin itself is just `index.js` + `manifest.json`. The `test/` tree is a
Node-based harness (not shipped).

## Develop

```bash
node --check index.js   # syntax
node --test             # run the harness
```

For live testing, symlink or copy the repo into the app's dev-plugins folder (see
the app's plugin-dev docs) and reload plugins.

## Release

See [RELEASING.md](RELEASING.md). In short: `scripts/bump.sh patch`, edit the
changelog, commit, then push a `vX.Y.Z` tag — CI builds `ytdlp.zip` + `update.json`
and publishes the GitHub release.

## Migrating from the `youtube` plugin

This plugin is a superset of `youtube`. To switch: install `ytdlp` from the
gallery, then disable/uninstall `youtube`. Existing `youtube://` queue/playlist
entries keep working. See RELEASING.md for the gallery `index.json` change that
makes this the recommended web-source plugin.
