# Changelog

## v1.1.0
- Honor the host's **"Prefer video"** hint (Settings → Playback): when set, the
  fallback resolver returns the music **video** stream and flags it so the host
  plays it in the theater — so a Spotify (or other metadata-only) playlist can be
  watched as clips. Falls back to audio when no video is available, and is a
  no-op on hosts without the hint (backward-compatible).

## v1.0.0
- Initial release. Successor to the YouTube plugin.
- Play and download **audio and video** from YouTube, SoundCloud, Bandcamp, Vimeo and 1000+ other yt-dlp-supported sites.
- **Hybrid playback:** stream directly (`yt-dlp -g`, validated) and fall back to download-then-play; switchable to download-only in settings.
- Sidebar search view with YouTube / SoundCloud source tabs and URL paste for any supported site. Per-selection actions: **Play** / **Queue** (audio), **Watch** / **Queue video** (video theater), **Download** (format picker incl. MP4) — no global audio/video mode. Rows carry a `ytdlp://` ref so the native right-click menu + drag-to-queue work.
- Per-**video** thumbnails in results (deterministic `i.ytimg.com/vi/<id>` — flat search returns none, which otherwise fell back to the artist image).
- SoundCloud search hides **Go+ 30-second previews** (paywalled tracks that only expose a snippet without auth); pasted URLs are never filtered.
- **Fallback resolver source** setting (Settings → yt-dlp), default **YouTube** — the site used to resolve a track with no direct source of its own (e.g. played from Spotify, or a library track missing on disk), for both playback and download. Switchable to SoundCloud.
- Download provider with Original / AAC / MP3 / Opus / FLAC / Video (MP4) qualities, plus interactive search in the download modal.
- **Tags + cover art embedded on download** via yt-dlp (`--embed-metadata --embed-thumbnail`), using yt-dlp's real music metadata (e.g. artist "Pixies", album "Doolittle", year 1989 — not the channel name). Host-supplied metadata (a real library track) takes precedence.
- **"Original" is a true lossless copy** (`-x --audio-format best`): keeps the source codec (YouTube Opus stays Opus) and only fixes the container to a taggable, non-webm one (opus→ogg, aac→m4a, flac→flac) — avoiding the host's webm→AAC re-encode and the earlier mislabeled-`.flac` bug. Honest quality labels; "Original" is the default.
- Registers the `ytdlp://` scheme and keeps legacy `youtube://` tracks playable/downloadable.
