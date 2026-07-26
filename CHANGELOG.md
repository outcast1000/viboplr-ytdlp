# Changelog

## v1.8.1
- **Fix: non-Latin titles (Greek, Cyrillic, etc.) came back as mojibake on
  Windows** — search results, Link-tab fetches, and downloaded-file metadata
  (title/artist/album tags) could all show garbled text for sites whose pages
  contain non-ASCII text, because yt-dlp writes some `--print` output using
  the OS locale's ANSI codepage rather than UTF-8 (the host's
  `PYTHONUTF8`/`PYTHONIOENCODING` env vars don't override this internal
  yt-dlp behavior). Every yt-dlp invocation that reads text back now passes
  `--encoding utf-8` explicitly.


## v1.8.0
- **Clearer download quality options.** Every option now reads "Type · Format —
  note": *Audio · Original — keeps the source codec*, *Audio · AAC (.m4a) —
  re-encode*, *Audio · MP3 — re-encode*, *Audio · FLAC — lossless wrap of a
  lossy source*, *Video · MP4 — best video + audio, merged*. On newer app
  versions each option also shows a full explanation under the picker (what
  the format really is, typical source bitrates, that tags are embedded);
  older apps just show the improved labels.
- **Removed the Opus re-encode option** — unused. If it was your remembered
  choice, the modal falls back to Original; programmatic `enqueue` calls with
  `format: "opus"` still work.

## v1.7.1
- **Downloads that fail with HTTP 403 now retry once with a fresh extraction.**
  YouTube's media URLs are minted per-extraction and sometimes get a transient
  403 gate (SABR/PO-token enforcement) — a new extraction mints fresh URLs and
  usually passes, so what used to need a manual retry now happens automatically.
  Applies to both the download modal and download-then-play playback.
- **Persistent download errors now note when yt-dlp itself is outdated**
  ("Installed yt-dlp X is outdated (latest Y) — update it in Settings →
  Dependencies") — a stale yt-dlp is the other common cause of YouTube 403s.

## v1.7.0
- **Fixed the first download after every app restart failing** ("Provider could
  not resolve this track for download"). The plugin's startup cleanup removes
  its whole temp folder, and resolving a missing folder returns nothing — so
  the download ran with a literal `-P null` output dir. Missing temp/cache
  folders are now recreated on demand.
- **Downloads make one yt-dlp request instead of two.** The metadata
  (artist/album/year) now rides the download run itself rather than a separate
  fetch — half the request volume, which matters because YouTube temporarily
  rate-gates devices that make too many ("sign in to confirm you're not a bot").
- **When YouTube's bot check kicks in, the plugin now tells you** — one
  notification per session — instead of playback silently falling back (e.g.
  to your library's audio copy of the song) and searches coming back empty
  with no explanation.
- **Download failures now report the real reason** (bot check / needs sign-in /
  format unavailable / video removed / HTTP 403). Shown in the download modal
  on hosts new enough to pass provider messages through; older hosts keep the
  generic message.
- **Link tab: new Paste button** next to Fetch — one click pastes the link from
  the clipboard and fetches it. Each source tab also keeps its own typed text.
  (Both light up on hosts new enough to support them; older hosts are
  unaffected.)

## v1.6.0
- **Link tab: fetched playlists get a header with whole-list actions.** Pasting a
  playlist / album / set now shows a sticky header with the playlist's title and
  its TRUE track count, plus one-click **Play all** (with a queue banner naming
  the playlist) and **Queue all** — no need to select rows first. Rows are
  numbered in source order, and the 100-track cap note now says how many tracks
  the link really has ("Showing the first 100 of 342 tracks").
- **Each source tab keeps its own search.** YouTube / SoundCloud / Link each
  remember their own query and results, so flipping tabs no longer shows one
  tab's results under another — and a fetched link survives a detour through
  the search tabs.
- **Fixed video playback on sites with no combined video+audio stream (e.g.
  Reddit).** Reddit only serves split DASH/HLS streams, so "Watch" failed with
  "Requested format is not available". When no muxed stream exists, the plugin
  now streams the site's HLS master playlist — one URL carrying the video
  renditions and the audio group.
- Titles from sites that HTML-escape them (e.g. Reddit) now display decoded —
  "Clips &amp; More" reads "Clips & More".

## v1.5.0
- **New "Watch YouTube video" right-click action on any track.** Appears in the
  context menu on every track surface — library, queue, playlists, search
  results, similar tracks. It searches YouTube by the track's title + artist and
  plays the top hit as a video in the in-app theater. (This replaces the host's
  old built-in "Find in YouTube", which opened the video in your browser.)

## v1.4.0
- **Fixed downloads failing with "Provider could not resolve this track".** The
  cover-art embed step (`--embed-thumbnail`) needs the Python `mutagen` module,
  which the managed yt-dlp zipapp's system Python often lacks — for opus/ogg/flac
  (i.e. the default "Original") that aborted the *entire* download. We no longer
  embed cover art; tags (artist/album/year) still embed via ffmpeg, and in-app
  artwork is unaffected (it comes from the track, not the file).
- **Downloading a video you're watching now defaults to Video (MP4)** instead of
  audio (on hosts new enough to honor the hint; older hosts are unaffected). You
  can still pick any audio format.

## v1.3.0
- **New "Link" tab.** Paste a URL and get the track(s): a single video becomes one
  track, and a **playlist / album / set** (YouTube, SoundCloud, Bandcamp, …) fans
  out into all of its tracks — ready to play, queue or download like any result.
- Pasted playlists are capped at 100 tracks so a huge list can't flood the view or
  queue (with a note when the cap is hit).
- Fixed a wrong assumption in the URL path: `--no-playlist` only disambiguates a
  "video + &list=" watch URL toward the single video; it never blocked a pure
  playlist URL from expanding.

## v1.2.0
- **Stream mode no longer falls back to downloading.** A direct-stream failure now
  fails cleanly instead of downloading the whole file first — that fallback was
  slow and couldn't fix a codec the player can't decode (that's the mpv engine's
  job). Use "Download then play" for a guaranteed local copy.
- Fixed a crash where the (now-removed) fallback / download mode could pass an
  invalid `-P null` output dir to yt-dlp when the cache path was unavailable.

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
