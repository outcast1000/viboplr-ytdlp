# Changelog

## v1.0.0
- Initial release. Successor to the YouTube plugin.
- Play and download **audio and video** from YouTube, SoundCloud, Bandcamp, Vimeo and 1000+ other yt-dlp-supported sites.
- **Hybrid playback:** stream directly (`yt-dlp -g`, validated) and fall back to download-then-play; switchable to download-only in settings.
- Sidebar search view with YouTube / SoundCloud source tabs, an Audio / Video toggle, and URL paste for any supported site.
- Download provider with Original / AAC / MP3 / Opus / FLAC / Video (MP4) qualities, plus interactive search in the download modal.
- **Tags + cover art embedded on download** via yt-dlp (`--embed-metadata --embed-thumbnail`), using yt-dlp's real music metadata (e.g. artist "Pixies", album "Doolittle", year 1989 — not the channel name). Host-supplied metadata (a real library track) takes precedence.
- **"Original" is a true lossless copy** (`-x --audio-format best`): keeps the source codec (YouTube Opus stays Opus) and only fixes the container to a taggable, non-webm one (opus→ogg, aac→m4a, flac→flac) — avoiding the host's webm→AAC re-encode and the earlier mislabeled-`.flac` bug. Honest quality labels; "Original" is the default.
- Registers the `ytdlp://` scheme and keeps legacy `youtube://` tracks playable/downloadable.
