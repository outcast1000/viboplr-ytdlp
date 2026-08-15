# viboplr-ytdlp

A [Viboplr](https://viboplr.com) plugin that plays and downloads **audio and video**
from YouTube, SoundCloud, Bandcamp, Vimeo and 1000+ other sites via
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp). It is the successor to the
`youtube` plugin and supersedes it.

## Features

- **Any yt-dlp source.** Search YouTube and SoundCloud from the sidebar, or use the
  **Link** tab to paste a URL from any of the 1000+ sites yt-dlp supports (Bandcamp,
  Vimeo, Mixcloud, …). A single video becomes one track; a playlist, album or set
  fans out into all of its tracks (up to 100), ready to play, queue or download.
  Fetched playlists get a sticky header with the playlist's title and true track
  count plus one-click **Play all** (with a queue banner) / **Queue all**, and the
  rows are numbered in source order. Each tab keeps its own query and results, so
  a fetched link survives a detour through the search tabs.
- **Audio and video, per action.** In the search view: **Play** / **Queue** listen
  (audio), **Watch** opens the video in the theater, and **Download** opens a format
  picker that includes Video (MP4). No global mode to set — YouTube results are
  videos you choose to consume either way, and audio-only sources just have no
  "Watch". Rows also carry a `ytdlp://` ref, so right-click (Play / Enqueue / Play
  Next) and drag-to-queue work like any other track.
- **"Watch YouTube video" on any track.** A right-click action on every track
  (library, queue, playlists, search results, similar tracks) searches YouTube by
  the track's title + artist and plays the top match as a video in the theater.
- **Hybrid playback.** Tracks stream directly whenever possible (a single yt-dlp
  extraction yields the stream URL and the request headers it needs) or
  download-then-play. Switch to **Download then play** in the plugin settings for
  maximum reliability. Video on sites with no
  muxed video+audio stream (e.g. Reddit — DASH/HLS only) streams via the site's
  HLS master playlist, which carries the video renditions and the audio group in
  one URL.
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
