# Changelog

## v1.20.0
- **The log now explains why a track played the way it did.** Until now it
  recorded the commands it ran and little else, so a report of "this played at
  360p" or "this wouldn't play" had nothing behind it. Each resolve is now
  written as one readable story: what was searched, which stream was picked,
  what was retried and what fell back — each step with how long it took and, on
  failure, the reason. Resolves are tagged, so the two that overlap while the
  next track is being prepared can be told apart instead of interleaving into
  one another.

  It also records the video and audio formats a source actually publishes, and
  which one was taken — including any hidden by your resolution limit. That is
  the difference between "this source had nothing better" and "something chose
  badly", which was previously impossible to tell from the outside. All of it
  comes from information yt-dlp had already returned, so nothing extra is run
  and nothing is slower.

  Turn on logging in Settings → Debug, and "Report a problem" there picks up the
  tail of it.

- **A yt-dlp track now shows the page it came from.** Hovering the source icon
  next to a playing track showed a long encoded line beginning `ytdlp://` — the
  right address, but scrambled, and with no way to open it. It now shows the
  plain YouTube (or SoundCloud, Bandcamp, …) address, with a button to open it
  in your browser, and names the plugin properly instead of "Ytdlp". Tracks the
  plugin found by searching already did this; now the ones you played from its
  own view or from your queue do too.

  Needs the matching app change, which ships in the next Viboplr release. On
  earlier versions the panel reads as it did before and nothing else in this
  release is affected.


## v1.19.0
- **Video played through "prefer video" is no longer stuck at 360p.** Asked to
  find a video for a track you were playing as audio, the plugin handed the app
  a single stream that carried both picture and sound — and on YouTube the only
  stream of that kind is 360p, so that is what you got however good the source
  was. It now offers the app the full list of streams, the same list the yt-dlp
  browse view already provides, and the app pairs a high-resolution picture with
  a separate audio stream. Watching from the yt-dlp view was already unaffected.

- **A stream that gets refused is retried properly.** YouTube turns down a
  playable link outright a fair share of the time, for no reason to do with the
  link. The app now asks again, and this plugin no longer answers with the link
  it just handed over — a refused one stays refused, so repeating it turned a
  moment's bad luck into a track that appeared broken.

  Requires Viboplr 1.0.25 or newer for both of these; on earlier versions this
  release behaves exactly like 1.18.0.

## v1.18.0
- **Playing a track you've already played is now instant, and searches you
  repeat are too.** Resolving a track meant running yt-dlp twice — once to find
  it, once to get a playable link — about three seconds before any sound. Both
  answers are now remembered for a while, so a replay, a re-queue, or the same
  search again costs nothing.

  The bigger reason is not the wait. Every lookup is a request to YouTube, and
  it starts refusing a device that makes too many of them — that is the "sign
  in to confirm you're not a bot" block, and once it lands nothing plays until
  it lifts. Roughly halving the requests a listening session makes is the point;
  the speed is a side effect.

  A playable link is remembered for at most 30 minutes, and never past its own
  expiry with less than 15 minutes to spare — these links are short-lived and
  tied to your network, and one that dies mid-song is worse than a short wait
  before it starts. Searches are remembered for 10 minutes. A search that
  *fails* is never remembered, so retrying after a block really retries.

  Also makes the scoring Tuning tab usable: adjusting weights re-ranks the same
  results instantly instead of re-fetching them every time.

## v1.17.0
- **Fixed YouTube playback failing with 403 and skipping to the next track.**
  v1.16.4 fixed this for videos, but only for videos: that fix works by handing
  the app a list of streams to choose from, and a list was the only thing that
  could carry the request headers a signed link needs. Every other kind of
  playback returned a single URL and had nowhere to put them, so the app played
  a bare link with no `User-Agent`. YouTube's links are bound to the agent that
  requested them and refuse anything else. Audio now reports its headers too.

  This covers **audio played from a yt-dlp search result or a saved playlist**,
  and works on Viboplr 1.0.24.

  It also covers **tracks from your own library that yt-dlp resolves by title
  and artist**, which needed a matching change in the app — that half needs
  Viboplr 1.0.25 or newer. On 1.0.24 those tracks behave as they did before;
  nothing regresses.

- **Playback failures now say why.** When a track can't be played, the plugin
  re-runs the extraction in verbose mode and logs what it finds — YouTube's
  token and player-client details, which is what separates a temporary block
  from a genuinely unavailable video. This ran for downloads already; playback
  only ever logged "direct stream unavailable".

  It runs **once per session** and never delays playback: a block affects every
  track, so probing each one would add a pile of extra requests to a service
  that is already turning us away, and the app has already moved on to its next
  source by then. Failures that already explain themselves — a removed video, a
  sign-in wall, a region block — are not re-probed at all.

- **Fixed region-locked videos being reported as an unknown error.** The check
  looked for "not available in your country", but the wording is "has not made
  this video available in your country", so it never matched.

## v1.16.5
- Relaxed the minimum app version to 1.0.23.

## v1.16.4
- **Fixed native mpv YouTube playback.** yt-dlp now passes the request headers
  required by its signed YouTube stream URLs to Viboplr's native mpv engine.
  Without those headers YouTube returned 403 even for fresh, available streams.
  Requires Viboplr 1.0.24 or newer.

## v1.16.3
- **Removed direct-stream preflight requests.** Stream playback now hands the
  URL yt-dlp resolves directly to the selected playback engine. The old
  two-byte Rust range probe was not equivalent to mpv or WebKit playback and
  could add an unnecessary request to signed YouTube media URLs.

## v1.16.2
- **Retry transient direct-stream 403s once.** YouTube can reject a newly
  minted googlevideo URL even when the video is otherwise available. After a
  failed direct-stream validation, the plugin now performs one fresh yt-dlp
  extraction and validates the replacement URL before reporting playback
  unavailable. Extractor failures such as bot checks and unavailable videos do
  not retry.


## v1.16.1
- **Improved direct-stream diagnostics.** When `yt-dlp -g` cannot obtain a
  playable URL, the plugin now logs its exit code and stderr to both the
  frontend log and the DevTools console. A direct-stream validation failure now
  logs the HTTP status too (for example, YouTube's temporary 403/rate gate),
  instead of collapsing into the browser's generic "no supported source" error.


## v1.16.0
- **Fixed: the seek-bar filmstrip never appeared on a video.** Seek-preview
  storyboards were being discovered from scratch on every single play. The sheet
  images were cached, but not the description of what they are — the grid, tile
  size and interval — so each play re-ran `yt-dlp -j` to work it out again.
  That call takes around twelve seconds, and the app gives a plugin a bounded
  window to answer; the answer arrived after the window closed, every time, so
  the filmstrip silently fell back to a plain seek bar. The description is now
  remembered alongside the images, and a video you have played before resolves
  instantly.

  Only successful lookups are remembered. A failure can be temporary — a bot
  check, a dropped connection — and remembering those would mean a video that
  failed once never showed a filmstrip again. If the cached images are cleared,
  the plugin notices and fetches them again rather than pointing at files that
  are no longer there.

- **Download progress now comes from yt-dlp itself.** A download here *is* the
  whole job — fetch both streams, merge them through ffmpeg — so the app had
  nothing to show but a spinner, sometimes for minutes. yt-dlp is now asked for
  machine-readable progress and it is forwarded to the app's download modal, so
  you get a real bar with a size, a speed and an ETA.

  A high-resolution video is two downloads (picture, then sound), each running
  0→100%, so the stage is named as it goes: *Downloading video* → *Downloading
  audio* → *Merging audio and video* — otherwise the bar appears to restart
  halfway through for no reason. Before the first sample arrives, unknown
  figures read as unknown rather than as zero: a 0% bar is a lie you would act
  on. Cancelling a download is reported as a cancellation, not as a broken
  install.

## v1.15.0
- **Searchable from the app's global search (Cmd+K).** yt-dlp now registers as a
  search provider, so a query in the caption bar can be sent to it and its
  results play straight from the dropdown. Useful mainly when you have no local
  library: that search only ever covered music on your machine, so for a
  streaming-only setup it could never match anything.

  The host asks **only when you pick the "Search … on yt-dlp" row** — never while
  you type. A search shells out to the binary and takes seconds, so a
  keystroke-triggered search would spawn a process per character. Results carry a
  `ytdlp://` path, so playing one doesn't re-search through the fallback
  resolver.

  Registered at runtime and only when yt-dlp is actually installed — a provider
  that can't answer shouldn't be offered at all. `minAppVersion` is deliberately
  unchanged: the registration is feature-detected, so on an older host the plugin
  simply omits this one feature instead of being held back entirely.

## v1.14.1
- **Fixed: video downloads produced an .mp4 that plays with no picture.** The
  merged-video selector asked yt-dlp for `bestvideo*+bestaudio`, and yt-dlp's
  default codec ranking prefers AV1 over H.264 and Opus over AAC — so a
  "Video · MP4" download came back as AV1 + Opus forced into an MP4 container.
  AVFoundation (QuickTime, Finder, the app's own webview) can't decode either in
  that container, so the file opened as audio-only. Video downloads now ask for
  H.264 + AAC first and only fall back to the codec-agnostic best when a source
  offers no such pair. A higher-resolution AV1/VP9 stream is deliberately skipped
  — on YouTube H.264 covers up to 1080p, and a playable file beats an extra 4K
  that nothing opens.
- The merge container is now `mp4/mkv` rather than a forced `mp4`. When the
  fallback tiers do land on codecs MP4 can't legally carry, yt-dlp writes an
  .mkv instead of mislabelling the file, and the saved name follows the real
  container. Also applies to "download then play" playback.

## v1.14.0
- **Seek-preview thumbnails.** Hovering the seek bar on a YouTube video now shows a
  thumbnail of that moment. Uses YouTube's *own* published storyboard sprite sheets
  (the `sb0`-`sb3` formats) rather than extracting frames — nothing decodes video and
  the stream is never fetched twice, so it costs ~58-170 KB and one `yt-dlp -j` call.
  Sheet **bytes** are cached under plugin storage, not their urls: YouTube signs
  storyboard urls with a short-lived `sqp` parameter while the images themselves never
  change, so a cached url would be dead within hours.

  Level choice trades tile size against download size, because YouTube keeps the same
  ~2-10 s interval at every level and grows the *sheet count* instead — a 3-hour video
  is 45 sheets at 160x90 but one at 48x27. The picker takes the largest readable tile
  that stays within an 8-sheet budget, falling back to the cheapest level when nothing
  qualifies (so long videos get coarse previews rather than a 45-request download).

  Requires a host with `api.playback.onResolveStoryboard`. `minAppVersion` is
  deliberately unchanged — the registration is feature-detected, so on an older host
  the plugin simply omits this one feature instead of being held back entirely.

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
