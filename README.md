# Glimpse Rush

**Same photo. Same clock. See it first.**

A mobile photo-reveal guessing game. A photo sits under a grid of tiles that flip on a shared clock; players tap **Freeze** when they think they know it and have 7 seconds to type the answer. Fewer tiles showing and more time left means more points.

Owner: Ron Blake. Personal project; all IP belongs to the owner.

## Status

Live playtest: **https://glimpse-rush.pages.dev** (results dashboard at `/admin/`). Wire map: `docs/WIRE_MAP.md`.

| Piece | State |
|---|---|
| Build spec | `docs/Glimpse_Rush_Build_Spec_v1.1.md` (source of truth, now v1.1.1; changelog in §22) |
| Scoring library | `packages/scoring/`: integer, half-up, matches spec §4a/§5; 24 tests |
| Database schema | `backend/schema.sql`: PostgreSQL 15+, hash-chained score ledger; 21 tests |
| Playable game | `prototype/index.html`: World Live (bots), Solo Practice, Solo Blitz, **Group Room live over a shared invite link**, custom photos, scramble, teams; 9 browser flow tests |
| Photos | 63 real photos (famous places, animals, insects, objects, food, nature) from Wikimedia Commons, public domain / CC0 / CC BY only, each checked by eye; credits in `prototype/photos/CREDITS.md`; fetcher `tools/fetch_photos.py` |
| Live rooms | `rooms/`: Cloudflare Durable Object per room, WebSockets, server-clock sync; 6 tests (local workerd and deployed) |
| Playtest data | `functions/` + D1: consent-gated events, feedback, dashboard; 7 backend tests |
| Wire map | `scripts/wire-map.mjs`: inventory gate + 22 live wires against production, daily in GitHub Actions |
| Mobile app (Flutter), accounts, server-side scoring, media pipeline | Not started (spec §17 M1-M5) |

## Layout

```
glimpse-rush/
├─ docs/
│  ├─ Glimpse_Rush_Build_Spec_v1.1.md   current spec
│  ├─ Glimpse_Rush_Build_Spec_v1.0.md   original, kept for history
│  └─ mockup-v1.png                     brand/screen mockup
├─ packages/scoring/                    reference scoring (port to Dart + server as-is)
├─ backend/                             Postgres schema + tests + README
├─ prototype/index.html                 single-file playtest
└─ package.json                         test scripts
```

## Run the tests (Windows PowerShell)

```powershell
cd <path>\glimpse-rush
npm install
npm test
```

Expected: `scoring` 24/24 and `schema` 21/21 pass. No database server needed; the schema tests run on PGlite (PostgreSQL 16 in WebAssembly).

## Open the prototype

Open `prototype/index.html` in a browser for solo modes offline. Group Room needs the deployed site (`npm run deploy`, plus `npm run deploy:rooms` for the room service).

## Spec map

| Topic | Section |
|---|---|
| Modes | §2, §10 |
| World Live 60 s cycle | §3 |
| Tile reveal, scramble levels | §4, §4a |
| Scoring, test vectors, constants | §5, §11, §12 |
| Freeze/answer flow, matching | §6, §7 |
| Anti-cheat | §8 |
| Custom photo packs | §10a |
| Profiles, teams, live leaderboards | §20 |
| Backend services, storage, API, retention | §21 |

## Rules for contributors (and coding agents)

- The spec wins over mockups and over this README.
- Scoring uses the integer formulas in §5.1; never floats, never banker's rounding.
- Any change to scoring, matching, or the schema ships with tests that fail on the old behavior.
- Don't publish anything about this project (blog posts, store listings, demos) without the owner's go-ahead.
