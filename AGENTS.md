# live5 instructions

## Product rules (do not weaken without the owner's say-so)

- The only way to create video is a live camera broadcast. No file upload, import, or paste path — in the UI or the API.
- Going live is immediate. No preview/review/publish step between pressing *Go live* and viewers seeing it.
- Broadcasts are short and hard-capped server-side (time and bytes), not just in the client. Current cap: 30 seconds per stream (owner decision, 2026-11-13; previously 5 s).
- No logins. Each device gets a user with a public UUID and a private key (only the key's hash is stored server-side). Broadcasts are tied to the UUID, never to the display name. Names are free text: cleaned, at most 30 characters, changeable, not unique, and prove nothing about identity (owner decision, 2026-11-13).
- Profiles (`/u/<uuid>`) list a user's broadcasts, live and past, after a short heading in the page flow: picture, name, details. It's not floating and not full-screen; the first video follows directly (owner decision, 2026-11-14).
- Profile pictures are always the preview frame of the user's latest non-empty live; there's no picture picker.
- Shared links must preview well: pages carry server-rendered Open Graph/Twitter tags (placeholder `<!--META-->` in each page's head), and `/oembed` answers for `/watch/:id` and `/u/:id`. Escape everything user-provided that goes into them.
- The home page and profiles are a full-screen vertical feed, one broadcast per screen (`public/feed.js`).
- The only non-video file the server accepts is the preview JPEG. It's grabbed from the live camera by `/go`, and the server accepts it only with the broadcast token, only while live, only once, up to 300 KB. It's a cover image, not an upload feature: there is no image picker.
- Daily limit: each user can start at most 5 lives in any rolling 24 hours, enforced server-side (owner decision, 2026-11-14). Lives marked `empty` don't count. The limit is per user, so someone can get around it by starting a new profile (another browser, or after clearing site data).
- First visit shows a welcome popup explaining the rules (`public/welcome.js`, once per device).
- Comments are simple: plain text, one line, at most 200 characters, append-only (no editing or deleting), one every 3 seconds per user, tied to the user's UUID like broadcasts (owner request, 2026-11-14).
- No editing: no trimming, replacing, deleting or reordering chunks; chunks are accepted only in sequence, only while live, only with the broadcast token.

## Engineering

- Don't do manual testing: no browser pages, screenshots, page inspection, or temporary servers to try things out. The owner does all manual and device testing; build the change, then say what to check (owner decision, 2026-11-13).

- Zero runtime dependencies so far; keep it that way unless there is a clear need.
- `npm test` must pass for server changes.
- Phones need HTTPS for the camera (`npm run cert`). The desktop browser pane cannot use a camera. Replays converted by `mp4.mjs` were checked in Chromium only; iOS Safari and Firefox playback are still unverified.
- Viewer playback relies on Media Source; keep the broadcaster preferring MP4 so iOS viewers can decode Android broadcasts.
- Replays of MP4 recordings are served from `<id>.replay.mp4`, a plain (non-fragmented) copy made by `mp4.mjs` when the broadcast ends. Never modify the original recording.
- The `/go` page must send the recorder's final piece after `stop()`. Android Chrome only delivers MP4 at fragment boundaries, so dropping it lost several seconds, or the whole video for short lives.
- Do not deploy, publish, commit or push without the owner's authorization.

## Open questions

- Should ended broadcasts remain as replays, or vanish when they end?
- Moderation, reporting and impersonation handling (anyone can type any name) before any public use. Comments have no moderation, deletion or daily cap yet.
- Showing comments to the broadcaster while they're live (the Go live page doesn't show them yet).
- Scaling: storage is local files in `data/`, served by a single process. Nothing is ever deleted (no retention limit).
- Recovering a profile on a new device or after clearing browser data.
- Rate limits on creating users (and per IP/device), so the daily limit can't be bypassed with fresh profiles.
- `test/server.test.mjs` predates users and disk storage. It still sends `name` when going live and doesn't set a temporary `dataDir`, so it needs updating before it is run again.
