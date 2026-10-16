# 🍿 Watch Party

A real-time watch-party app: create a room, share the link or code, and everyone watches the same video in sync, with live chat, emoji reactions, a shared voting playlist, group polls, host transfer and movie discovery.

**Stack:** Node.js · Express · Socket.IO (WebSockets) · plain HTML/CSS/JS (no build step).

---

## Quick start

```bash
npm install
npm start
# open http://localhost:3000
```

1. Enter your name → **Create room**.
2. Click **Copy invite link** (or share the 6-letter code). Friends open the link or enter the code → **Join**.
3. Pick a title in **Discover** → **Play now**. The *Sync Test Pattern (offline)* title works with no internet.

To test with friends on the same Wi-Fi, they open `http://<your-laptop-IP>:3000` (find your IP with `ipconfig`).

---

## Features

### Core
| Requirement | How it works |
|---|---|
| Create / join rooms | 6-character codes (no confusable 0/O/1/I) and invite links `/r/CODE`. |
| Sync play, pause, seek | Server holds the **authoritative playback state**. Every action is broadcast to the room with a sequence number. Playback speed is synced too. |
| Movie recommendations, categories, filters, fuzzy search | Catalog with category, genre, length and sort filters. Fuzzy search handles typos ("sintl" → *Sintel*), prefixes and subsequences. Recommendations are scored on genre/mood overlap with what the room has watched and queued ("Because you watched…"). |
| Emoji reactions | Float over the video for everyone. |
| Live chat | Messages carry the video timestamp. Click a timestamp to jump there. |
| Shared playlist | Anyone can add and upvote. It is sorted by votes and auto-plays the top item when a video ends. |
| Group polls | Custom polls, or one click for **"Poll from playlist"** to vote on what to watch next. One changeable vote per person. |
| Host transfer | Manual (**Make host**), plus **automatic failover** if the host disconnects for longer than 15 s. The host can also let everyone control playback. |
| Drift detection & correction | Every client checks drift every 500 ms against the room clock and corrects it (see below). |
| Late joins, reconnections, concurrent actions | Late joiners get a full snapshot. Reconnecting users keep their seat and host role. Concurrent actions are serialised server-side (see below). |

### Creative extras
- **Reaction heatmap on the timeline.** Reactions are stored with the video timestamp, so the seek bar shows a heatmap of the moments the room reacted to most. Hover a bar for its top emoji and time.
- **Live "sync health" panel.** People tab shows every viewer's real-time drift and round-trip time, colour-coded (green ≤ 250 ms, amber ≤ 500 ms).
- **Sync badge** in the top bar shows *your own* drift live.
- **Timestamped chat**, so "look at this!" links to the exact moment.
- **Playlist → poll in one click** and **vote-sorted queue**.
- Keyboard: `Space` play/pause, `←/→` seek ±10 s.

---

## How sync works

```
 Controller ──control{type, position}──▶ Server (authoritative state, seq++)
                                           │  broadcast playback{position, playing, rate, updatedAt, seq}
                                           ▼
                               every viewer: expected = position + (serverNow − updatedAt) × rate
```

1. **Clock sync (NTP-style).** Each client pings the server 5 times on join and every 15 s, keeps the lowest-RTT sample and computes `offset = serverTime − (t0 + rtt/2)`. All maths uses server time, so clients with wrong system clocks still sync.
2. **Authoritative state, not event replay.** The server stores *where the video was at a moment in time*. Anyone (late joiner, reconnector, a slow device) computes where it should be *now*. This makes late joins and reconnections trivial and stops errors from piling up.
3. **Drift correction loop** (`public/sync.js`, every 500 ms):
   - drift ≤ 120 ms → do nothing
   - 120–600 ms → **nudge `playbackRate`** up to ±12% so the player catches up or slows down smoothly, with no visible jump
   - > 600 ms → **hard seek** to the expected position
   - Buffering clients are detected (`readyState`) and skipped, then corrected when playback resumes.
4. **Server heartbeat** every 2 s re-broadcasts state, so clients converge even if a message is dropped.

### Concurrency & reliability
- All control actions are handled one at a time on the server (single Node event loop). Each accepted action increments `seq`. Clients **ignore any state older than the newest they have seen**, so out-of-order delivery can't move playback backwards.
- Redundant actions (play while already playing, pause while paused) are dropped as no-ops. This removes double-click races when several people press play at once.
- **Permissions:** in host mode only the host can control. Others get a clear message.
- **Reconnects:** identity is a per-tab `userId`, not the socket. If your connection drops, Socket.IO reconnects and the client re-joins with the same id. The server restores your seat and host role (15 s grace), and the snapshot puts you back at the right position.
- **Host failover:** after the grace period the longest-present connected member becomes host automatically.
- **Autoplay blocking:** if a browser blocks autoplay, the viewer sees "Click to join playback" and is resynced on click.
- Input is sanitised and length-limited, output is HTML-escaped, reactions are rate-limited, and rooms cap at 50 members. Empty rooms are garbage-collected after 30 minutes.

---

## Latency measurements & test conditions

Run them yourself:

```bash
npm test             # 12 users, 300 control actions + reliability checks
npm run test:load50  # 50 users, 100 actions
npm run test:drift   # drift-correction simulation
```

To test across a real LAN, start the server on one machine and run from another:
`node scripts/loadtest.js 12 300 http://<server-ip>:3000`

### Results

**Test conditions:** server and simulated clients on the same machine (loopback), Node.js 22, Socket.IO 4 over WebSocket. Latency = time from the host emitting a control to *each* viewer receiving it. Every delivery to every viewer is counted.

| Scenario | Deliveries | p50 | **p95** | p99 | max | lost |
|---|---|---|---|---|---|---|
| 12 users, 300 actions | 3,300 | 1 ms | **1 ms** | 3 ms | 5 ms | 0 |
| 50 users, 100 actions | 4,900 | 1 ms | **2 ms** | 4 ms | 10 ms | 0 |

Target: **≤ 250 ms at p95 → met.** Loopback leaves out real network delay. On typical home Wi-Fi expect roughly RTT/2 extra (usually 2–20 ms), which is still far below the target. The live RTT of each viewer is shown in the People tab.

**Real-browser check (headless Chromium, two users):** after the host pressed play, the two players were **12 ms** apart, and the in-app badges showed −11 ms and −2 ms drift.

**Reliability checks** (`npm test`, all 16 pass): 12 concurrent users, host-only permissions, zero lost messages, all clients converge on the same state, concurrent actions from all 12 users giving one consistent final state, late joiner position accurate to < 0.3 s (got 101.50 s vs expected 101.5 s), host reconnect keeps role, automatic host failover after grace period, manual host transfer, polls, playlist, invalid room code rejected.

### Drift after correction (`npm run test:drift`)

Simulates bad players for 10 minutes each with the same correction logic the browser uses. Drift is measured continuously, *including* during stalls.

| Simulated problem | p50 | **p95** | max |
|---|---|---|---|
| Perfect player | 0 ms | 0 ms | 0 ms |
| Device clock 2% fast | 113 ms | 129 ms | 130 ms |
| Device clock 3% slow | 119 ms | 134 ms | 135 ms |
| 400 ms buffering stall every 30 s | 113 ms | 380 ms | 561 ms |
| 2.5 s stall every 60 s (bad Wi-Fi) | 88 ms | 121 ms | 550 ms |
| 1% slow + 40 ms clock-sync error + stalls | 148 ms | 164 ms | 204 ms |

Target: **≤ 500 ms after correction → met** (worst-case p95 is 380 ms). Short spikes above 500 ms happen only *during* a buffering stall, before the player has frames to show, and are corrected within about 1 s after playback resumes.

---

## Failure handling

| Failure | Behaviour |
|---|---|
| Viewer's network drops | Red dot and toast. Auto-reconnect (0.5–3 s backoff), re-join with the same identity, resync to the current position. |
| Host disconnects | Keeps host for 15 s (for page refreshes). After that, auto-handover to the next member, announced in chat. |
| Message lost or out of order | `seq` check ignores stale state; heartbeat every 2 s repairs missed updates. |
| Video buffering | Shown as "buffering…". Correction pauses, then rate-nudge or seek on resume. |
| Autoplay blocked by browser | "Click to join playback" overlay, then resync. |
| Invalid / unplayable URL | Server rejects non-http(s) URLs. The player shows the empty state. |
| Several people click play/seek at once | Serialised on the server, no-ops dropped, everyone converges to the last accepted action. |
| Room full / wrong code | Clear error on the join screen. |
| Server restart | Rooms are in memory and are lost (see limitations). |

## Limitations / next steps
- State is in memory. Redis (with the Socket.IO Redis adapter) would allow persistence and horizontal scaling.
- Plays direct video files (MP4/WebM, served via HTTP). YouTube support would need the YouTube IFrame API adapter.
- The catalog is a curated set of openly licensed sample films. A TMDB API connection could provide a full movie database.

## Project structure
```
server.js            rooms, authoritative playback, chat, polls, playlist, host logic
catalog.json         movie catalog (categories, genres, tags, ratings)
public/index.html    UI
public/app.js        client: sync loop, chat, reactions, heatmap, discovery, polls
public/sync.js       clock-offset, expected-position and drift-correction maths (shared with tests)
public/fuzzy.js      typo-tolerant fuzzy search
public/style.css     styles
scripts/loadtest.js  latency + reliability tests
scripts/drift-sim.js drift-correction simulation
videos/sample.webm   offline sync test video
```
