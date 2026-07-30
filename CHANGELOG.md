# Changelog

## v1.13.0
- **Separate audio & video scoring profiles for finding a track.** When the
  plugin has to *pick* a result from a search — the playback/download fallback
  (Spotify tracks, library misses) and the "Watch YouTube video" / prefer-video
  paths — it now ranks candidates with one of two tunable profiles instead of a
  single view-boost + duration heuristic. The **audio** profile favors clean
  official-audio / "- Topic" uploads whose length matches the track; the
  **video** profile favors the official music video / VEVO upload, popularity-led.
  Scoring is a weighted sum over relevance, views and duration match plus
  title/channel keyword signals (official / official audio / official video · MV /
  Topic / VEVO / lyrics / live / cover / remix / instrumental / sped-up·nightcore·8D).
- **Tuning tab** (Settings → yt-dlp → Debugging → "Show scoring in results" adds
  a "🔧 Tuning" tab to the yt-dlp sidebar). Rank a real search with either
  profile, see the full per-signal breakdown behind every result, and edit any
  weight live — the list re-ranks instantly with no re-fetch. The edited profile
  is the live one, so tuning immediately changes what automated resolves pick;
  Reset restores the defaults. Controls sit beside the ranked results.
- **"Last resolve" moved to its own "🧭 Last resolve" tab** (same Debugging
  toggle) and now shows the **profile used** plus the same per-signal
  calculations as Tuning, with the winning pick marked. Previously it was an
  inline panel in the search view with no score breakdown.
- Scoring debug annotations and the two new tabs are all opt-in behind the
  existing "Show scoring in results" toggle; nothing changes with it off.


## v1.12.0
- **"Last resolve" debug panel.** With debug scoring on (Settings → yt-dlp →
  Debugging), the yt-dlp sidebar now shows a panel — right when a track is
  resolved — listing every candidate the resolver considered, scored, with the
  one it actually picked marked by a ✓. Covers the invisible automated paths:
  the playback/download fallback (Spotify tracks, library misses) and the
  "Watch YouTube video" action. So when the wrong video plays, you can see the
  alternatives and exactly why the winner won (e.g. a duration match that beat a
  higher-scored result), and click any candidate to Play/Watch/Download and
  compare. Only active while debug scoring is on; a Clear button dismisses it.

## v1.11.0
- **Debug scoring (Settings → yt-dlp → Debugging).** A new "Show scoring in
  results" toggle annotates every search result with how it was ranked — its
  final position, whether the view boost moved it up or down, and the score that
  put it there (e.g. `#1 · was #2 · score 12.34 · boost +13.34`). Searches, the
  "Watch YouTube video" action and the playback/download fallback all rank the
  same way, so typing a track's "title artist" in the sidebar shows exactly why
  the automated pick chooses what it chooses. Off by default; nothing changes
  about how results are ranked — this only makes the existing ranking visible.

## v1.10.0
- **View counts in search results.** Each result now shows its video's view
  count in the row subtitle (e.g. `Radiohead · 1.5B views`), so it's easy to
  spot the real/official upload at a glance. Sources that don't report a view
  count just show the artist as before.
- **Searches lean toward popular results (usually the official music video).**
  yt-dlp's relevance ordering stays the primary signal, but results now get a
  gentle boost based on view count: a runaway view lead — an official video with
  100–1000× the views of a cover or lyric re-upload — climbs to the top, while a
  modest edge barely moves anything. Pasted links and playlists keep their
  original order, and sources without view data are unaffected.

## v1.9.0
- **Hi-res video streaming (up to 4K).** Watching a video no longer caps at the
  360–720p muxed stream. On the **native (mpv) playback engine**, the plugin now
  hands the host the full menu of a source's streams and the host picks a hi-res
  **video-only** stream paired with a separate **audio-only** stream, which mpv
  merges on the fly — so YouTube plays at 1080p/1440p/4K with no download wait.
  The browser engine can't merge two streams, so it still gets the self-contained
  muxed stream (and is used as the instant fallback if a native play fails).
  Requires app **v1.0.3+** (new stream-candidate contract).
- **Max video quality setting** (Settings → yt-dlp → Playback): cap streaming and
  the default video download at Best / 4K / 1080p / 720p / 480p. Defaults to
  1080p so 4K isn't pulled by surprise.
- **Resolution choices for video downloads.** The download quality picker now
  offers Video · MP4 at Best / 4K / 1080p / 720p / 480p, mirroring the streaming
  choices (previously a single "best" video option).

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
