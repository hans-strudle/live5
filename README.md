# live5

A live-only video app. You can do exactly one thing: go live, briefly.

- **Live only.** Press *Go live* and you are broadcasting instantly. There is no preview-and-post step, no draft, no publish button.
- **Short.** Every broadcast stops automatically at the time limit (30 seconds for now; override with `LIVE5_MAX_SECONDS`).
- **No uploads.** Video comes only from the device camera. There is no file picker and the server rejects anything that is not part of an active, token-authorized broadcast.
- **No logins.** The first time you go live you enter a name. The server then gives that device a user: a permanent UUID plus a private key that the browser keeps. Broadcasts are tied to the UUID, so you can change your name (up to 30 characters) and keep the same profile. Names aren't unique or verified.
- **Feed.** The home page is a full-screen vertical timeline, one broadcast per screen: live ones first, then past lives, newest first. The one in view plays (muted until you tap); the next and previous ones load ahead of time. When a broadcast finishes, the feed scrolls to the next one by itself. If you scrolled back up to a broadcast, it loops instead, until you scroll down again. A "new lives ↑" pill appears when someone goes live after the page loaded. Arrow keys and `j`/`k` move between broadcasts on desktop.
- **Profiles.** `/u/<uuid>` starts with a heading (their picture, name, number of lives, and whether they're live now), followed straight away by the same timeline of just their broadcasts. The heading scrolls away with the feed. Names in the feed link to profiles.
- **Profile pictures.** Everyone's picture is the preview frame of their latest live, falling back to their initial before their first live. It appears in the feed next to their name, on their profile, and in link previews.
- **Link previews.** The server fills in Open Graph and Twitter card tags (title, description, preview image and its size) for the home page, broadcasts (`/watch/:id`) and profiles (`/u/:id`), and answers oEmbed at `/oembed?url=…`. Absolute links use the request's host, or `LIVE5_PUBLIC_URL` if set. Behind Caddy that's automatic.
- **Previews.** Just after going live, the broadcaster's page grabs one frame from the camera and sends it as the broadcast's cover image, which the feed shows before the video loads.
- **Daily limit.** Each user can start 5 lives in any rolling 24 hours (`LIVE5_MAX_PER_DAY`). The server refuses more with a 429. The Go live page shows how many are left and when the next one frees up. Lives that recorded no video don't count.
- **Welcome popup.** The first page a device opens explains the rules (30 seconds, no edits, it goes out to the world, the daily limit), once. The numbers come from `GET /api/config`.
- **No editing.** Chunks are appended in order while the broadcast is live; nothing can be changed, trimmed or re-sent afterwards.

## Run

Requires Node 20+. No dependencies.

```bash
npm start
```

Open http://localhost:5555. Camera access needs `localhost` or HTTPS.

```bash
npm test
```

### On phones

Phones reach the app by your computer's network address, and browsers only allow the camera on HTTPS there. Create a local certificate once:

```bash
npm run cert
```

Then `npm start` serves HTTPS and prints the address to open on the phone (for example `https://192.168.1.167:5555`). The certificate is self-signed, so each phone warns the first time:

- **Android Chrome:** *Advanced* → *Proceed to … (unsafe)*.
- **iOS Safari:** *Show Details* → *visit this website*.

The phone must be on the same Wi-Fi network, and Windows Firewall must allow Node on private networks. Re-run `npm run cert` if your computer's network address changes. `certs/` is git-ignored.

### Playback

Broadcasters record MP4 (H.264/AAC) when the browser supports it, otherwise WebM. Viewers play through Media Source (`ManagedMediaSource` on iOS 17.1+, `MediaSource` elsewhere), which handles an open-ended live stream on both iOS and Android. Browsers without Media Source fall back to a plain `<video>`. Finished broadcasts are served with Range support, which Safari requires.

## How it works

1. `/go` asks for a name on first use and calls `POST /api/users`, which returns `{ id, name, secret }`. The browser stores this under `live5:user` in localStorage. Later requests identify the user with the `x-user-id` and `x-user-secret` headers. `PATCH /api/users/me` changes the name.
2. *Go live* opens the camera and calls `POST /api/streams` with `{ "type" }` and the user headers. It returns a stream id and a private broadcast token. Each user can have only one live broadcast at a time.
3. The browser records with `MediaRecorder` in 500 ms slices and posts each slice, in order, to `POST /api/streams/:id/chunks?seq=n` with the token.
4. Viewers open `/watch/:id`. `GET /api/streams/:id/video` replays what has been received so far and keeps the HTTP response open, writing new slices as they arrive, until the broadcast ends.
5. The broadcast ends when the broadcaster stops, the time limit is reached, the size limit is hit, or no chunk arrives for 10 seconds. The page stops recording at the time limit; the server allows 3 more seconds for the recorder's final piece, then closes the broadcast regardless. The page asks for a key frame every second (`videoKeyFrameIntervalDuration`), because Chrome cuts MP4 pieces at key frames; without it, Android sends roughly 6-second pieces.
6. `GET /api/users/:id` returns a public profile (name, join date, broadcasts). It never includes the secret.
7. `GET /api/streams?user=&status=&offset=&limit=` returns one page of the feed as `{ items, next }`. Live broadcasts come first, then ended ones newest first. Ended broadcasts with no video are left out.
8. `POST /api/streams/:id/poster` takes one JPEG (up to 300 KB), only with the broadcast token, only while live, and only once. `GET` on the same path serves it.

### Storage

Everything is saved under `data/` (git-ignored; change it with `LIVE5_DATA_DIR`):

- `data/users.json`: users as `{ id, name, secretHash, createdAt }`. Only a SHA-256 hash of each private key is stored.
- `data/streams/<id>.json`: broadcast details, including `userId`, `type`, `status`, times, end reason and size.
- `data/streams/<id>.mp4` or `.webm`: the video, written piece by piece while live.
- `data/streams/<id>.jpg`: the preview frame, if one was captured.
- `data/streams/<id>.replay.mp4`: what replays serve for MP4 recordings. When a broadcast ends, the server rewrites the recorder's fragmented MP4 as a plain MP4 with the index up front ([mp4.mjs](mp4.mjs), no dependencies). The sample data is copied byte for byte, and the original recording is kept. Plain MP4 plays reliably everywhere; Chrome-on-Android recordings played straight from a URL didn't. On startup, older recordings without a replay file are converted in the background. Recordings with no video at all are marked `empty` and left out of feeds and profiles.

Broadcasts and profiles survive restarts. A broadcast that was live when the server stopped is marked ended (`server-restart`). If a browser loses its stored key (cleared site data, another browser or device), it gets a new profile; there is no recovery yet.

## Deploying

For a test server on a small EC2 instance running Amazon Linux 2023 or Ubuntu (systemd service plus Caddy for real HTTPS), see [deploy/EC2.md](deploy/EC2.md).

## Status

Prototype. See [AGENTS.md](AGENTS.md) for the product rules and open questions.
