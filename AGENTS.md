# live5 instructions

## Product rules (do not weaken without the owner's say-so)

- The only way to create video is a live camera broadcast. No file upload, import, or paste path — in the UI or the API.
- Going live is immediate. No preview/review/publish step between pressing *Go live* and viewers seeing it.
- Broadcasts are short and hard-capped server-side (time and bytes), not just in the client. Current cap: 30 seconds per stream (owner decision, 2026-11-13; previously 5 s).
- No logins. Each device gets a user with a public UUID and a private key (only the key's hash is stored server-side). Broadcasts are tied to the UUID, never to the display name. Names are free text: cleaned, at most 30 characters, changeable, not unique, and prove nothing about identity (owner decision, 2026-11-13).
- Profiles (`/u/<uuid>`) list a user's broadcasts, live and past.
- The home page and profiles are a full-screen vertical feed, one broadcast per screen (`public/feed.js`).
- The only non-video file the server accepts is the preview JPEG. It's grabbed from the live camera by `/go`, and the server accepts it only with the broadcast token, only while live, only once, up to 300 KB. It's a cover image, not an upload feature: there is no image picker.
- No editing: no trimming, replacing, deleting or reordering chunks; chunks are accepted only in sequence, only while live, only with the broadcast token.

## Engineering

- Zero runtime dependencies so far; keep it that way unless there is a clear need.
- `npm test` must pass for server changes.
- Phones need HTTPS for the camera (`npm run cert`). Real-device checks on iOS Safari and Android Chrome are still outstanding; the desktop browser pane cannot use a camera.
- Viewer playback relies on Media Source; keep the broadcaster preferring MP4 so iOS viewers can decode Android broadcasts.
- Do not deploy, publish, commit or push without the owner's authorization.

## Open questions

- Should ended broadcasts remain as replays, or vanish when they end?
- Moderation, reporting and impersonation handling (anyone can type any name) before any public use.
- Scaling: storage is local files in `data/`, served by a single process. Nothing is ever deleted (no retention limit).
- Recovering a profile on a new device or after clearing browser data.
- Rate limits on creating users and broadcasts.
- `test/server.test.mjs` predates users and disk storage. It still sends `name` when going live and doesn't set a temporary `dataDir`, so it needs updating before it is run again.
