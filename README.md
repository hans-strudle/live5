# live5

A live-only video app. You can do exactly one thing: go live, briefly.

- **Live only.** Press *Go live* and you are broadcasting instantly. There is no preview-and-post step, no draft, no publish button.
- **Short.** Every broadcast stops automatically at the time limit (30 seconds for now; override with `LIVE5_MAX_SECONDS`).
- **No uploads.** Video comes only from the device camera. There is no file picker and the server rejects anything that is not part of an active, token-authorized broadcast.
- **No logins.** The first time you press *Go live* (or send a comment), a popup over the screen asks for a name, then carries on. The server then gives that device a user: a permanent UUID plus a private key that the browser keeps. Broadcasts are tied to the UUID, so you can change your name (up to 30 characters) and keep the same profile. Names aren't unique or verified.
- **Feed.** The home page is a full-screen vertical timeline, one broadcast per screen: live ones first, then past lives, newest first. The one in view plays (muted until you tap); the next and previous ones load ahead of time. When a broadcast finishes, the feed scrolls to the next one by itself. If you scrolled back up to a broadcast, it loops instead, until you scroll down again. A "new lives ↑" pill appears when someone goes live after the page loaded. Arrow keys and `j`/`k` move between broadcasts on desktop.
- **Profiles.** `/u/<uuid>` starts with a heading (their picture, name, number of lives, and whether they're live now), followed straight away by the same timeline of just their broadcasts. The heading scrolls away with the feed. Names in the feed link to profiles.
- **Profile pictures.** Everyone's picture is the preview frame of their latest live, falling back to their initial before their first live. It appears in the feed next to their name, on their profile, and in link previews.
- **Link previews.** The server fills in Open Graph and Twitter card tags (title, description, preview image and its size) for the home page, broadcasts (`/watch/:id`) and profiles (`/u/:id`), and answers oEmbed at `/oembed?url=…`. Absolute links use the request's host, or `LIVE5_PUBLIC_URL` if set. Behind Caddy that's automatic.
- **Going live, noticed.** The feed checks every 5 seconds. When someone goes live, a banner says "Sam just went live" with a **Watch** button, which puts that live next in the feed and scrolls to it. It hides after a while or when the live ends. You aren't told about your own lives.
- **Live alerts (Web Push).** The 🔔 in the header turns on phone notifications for when anyone goes live. Tapping one opens that live in the feed. The server does Web Push itself on `node:crypto` (VAPID signing and aes128gcm encryption, in [push.mjs](push.mjs)), with no dependencies. Its key pair lives in `data/vapid.json` and subscriptions in `data/push.json`. It only sends to real browser push services (Google, Apple, Mozilla, Microsoft). On iPhone and iPad, Apple only allows this once live5 is added to the Home Screen; in a Safari tab, the bell explains how. A manifest (`public/manifest.webmanifest`) and icon make the Home Screen app work. Set `LIVE5_VAPID_SUBJECT` to a real `mailto:` or `https:` contact, because Apple rejects placeholders.
- **Sound.** Videos play with sound unless you turned it off (remembered per device). Browsers block sound until the first tap or click on a page, so on a fresh visit the video starts muted with a "Tap for sound" hint, and the first tap anywhere turns it on.
- **Likes.** A ♡ on every feed card fills red when tapped; tapping again un-likes. Double-tapping the video also likes it, with a big heart where you tapped; a double-tap never un-likes. Because of this, a single tap on the video (sound on, or pause) waits about 0.3 s to make sure it isn't a double-tap. Likes are private: no counts are shown to viewers or to the person who went live. No name is needed, because each device gets an anonymous viewer ID (`live5:viewer` in localStorage), and the device remembers what it liked (`live5:liked`). The server keeps one like per device per broadcast in `data/streams/<id>.likes.jsonl`, plus a hidden `likeCount` in the broadcast's details for later use. API: `POST /api/streams/:id/like` with `{ viewer, liked }`; nothing about likes is ever returned.
- **Sharing.** Every broadcast has a Share button: on feed cards (home and profiles) and on the Go live page while you're live. Phones open the system share sheet; elsewhere the `/watch/<id>` link is copied ("Link copied"). A shared link opens the main feed with that broadcast first, then carries on into the rest of the feed (auto-advancing); there is no separate watch page. Shared links show the preview card described under Link previews.
- **Comments.** Text-only comments (up to 200 characters) on any broadcast, live or replay. The 💬 button on feed cards opens a sheet. Comments are oldest first, and new ones appear every few seconds while the sheet is open. Commenting uses the same no-login identity; people without a profile are asked for their name in a popup after pressing Send. One comment every 3 seconds per person; comments can't be edited or deleted. API: `GET /api/streams/:id/comments?from=n` returns `{ items, next }`, and `POST` with `{ text }` and the user headers adds one. Comments are stored in `data/streams/<id>.comments.jsonl`.
- **Previews.** Just after going live, the broadcaster's page grabs one frame from the camera and sends it as the broadcast's cover image, which the feed shows before the video loads.
- **One live every 12 hours.** Each user can go live once per rolling 12 hours (`LIVE5_MAX_PER_DAY`, default 1, and `LIVE5_LIMIT_HOURS`, default 12); after a live, going live locks until 12 hours after it started. The server refuses early attempts with a 429 that says when the lock ends. On the Go live page, the button turns into a "🔒 Next live in 11h 22m" countdown and unlocks by itself. Lives that recorded no video don't count.
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

1. The camera opens right away. When someone without a profile presses *Go live*, a name popup (`askName` in `public/me.js`) appears over the camera; it calls `POST /api/users`, which returns `{ id, name, secret }`. The browser stores this under `live5:user` in localStorage. Later requests identify the user with the `x-user-id` and `x-user-secret` headers. `PATCH /api/users/me` changes the name.
2. *Go live* opens the camera and calls `POST /api/streams` with `{ "type" }` and the user headers. It returns a stream id and a private broadcast token. Each user can have only one live broadcast at a time.
3. The browser records with `MediaRecorder` in 500 ms slices and posts each slice, in order, to `POST /api/streams/:id/chunks?seq=n` with the token.
4. Viewers watch in the feed (a shared `/watch/:id` link opens the feed with that broadcast first). `GET /api/streams/:id/video` replays what has been received so far and keeps the HTTP response open, writing new slices as they arrive, until the broadcast ends.
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
