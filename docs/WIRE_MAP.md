# Glimpse Rush wire map

Run 2026-10-03T23:26:01.108Z against https://glimpse-rush.pages.dev. **All wired.** Regenerate: `node scripts/wire-map.mjs`.

🟢 works and its completion is recorded · 🟡 promised but not built yet (kept visible) · 🔴 broken, unregistered or dead (fails the build)

## Inventory

Discovered in code: 79 ui, 8 screen, 4 mode, 7 api, 12 event, 11 tag. Photos: 63 in the pool of 82 catalogued (not sourced yet: eiffel-tower, statue-of-liberty, taj-mahal, christ-the-redeemer, angkor-wat, burj-khalifa, mount-fuji, brooklyn-bridge, hollywood-sign, golden-retriever, lion, cow, chair, guitar, piano, typewriter, hot-air-balloon, lighthouse, strawberry).

- No unregistered, dead or mismatched elements.

## Wires

| | Wire | Promise | Result | Failing since |
|---|---|---|---|---|
| 🟢 | home | Home loads with every mode and no errors | 5 mode controls visible |  |
| 🟢 | consent_no | Declining consent sends nothing and stores no id | no data sent, no id stored |  |
| 🟢 | consent_yes | Accepting consent records session_start and screens | session_start, screen landed |  |
| 🟢 | practice_full | Practice: freeze, correct answer, results with credit; events land | photo loaded (900px), credit shown, 4 events landed |  |
| 🟢 | half_credit | Half answer banks and continues; wrong 2nd answer keeps half credit | banked, continued, kept |  |
| 🟢 | giveup | Give up reveals the photo and records the outcome; Back returns home | gave_up landed, home reached |  |
| 🟢 | unfreeze | Unfreeze spends a freeze and is recorded | freeze spent, freeze_fail landed |  |
| 🟢 | options | Practice grid, scramble and hint options reach the round | 9 tiles, scramble 1, hint on |  |
| 🟢 | blitz | Blitz: answer, skip, end run, run again; run total recorded | run total 1901 recorded |  |
| 🟢 | world | World Live: join, freeze, answer, results with leaderboard, next round | leaderboard shown, round_end landed |  |
| 🟢 | group_reconnect | Group Room survives reloads: guest returns to the live round with their score; host keeps the game; unknown codes explain themselves | guest + host reload mid-game, scores kept, game continued |  |
| 🟢 | world_live_board | World Live is live: players in the same round see each other's real scores within a second | both boards had both within 252 ms |  |
| 🟢 | world_same | World Live is the same round on every device at the same moment, even with a wrong device clock | plain sea-turtle 3 ms apart; scrambled owl 3 ms apart (one device clock 9 s fast) |  |
| 🟢 | world_scr | World Live: Scrambled: every round shuffled + turned, x1.5 score, own board, recorded as its own mode | scrambled round played, recorded as world_scr |  |
| 🟢 | abandon | Quitting a round before it ends is recorded | round_abandon landed |  |
| 🟢 | visit_data | Visit data lands: device details, page speed, answer time, play time, errors | windows/chrome, first byte 117 ms, 4 s active, error captured |  |
| 🟢 | owner_device | ?owner=1 marks a device so its plays are never counted | owner plays stored, excluded from stats |  |
| 🟢 | feedback_form | Feedback form: rating, tags, text, send; stored with context | feedback stored (1 rows for this session) |  |
| 🟢 | round_reaction | Round thumbs and 'should count' flag are stored per photo | thumbs + dispute stored |  |
| 🟢 | admin | Admin results are locked without the token, load with it, and exclude test traffic | locked, renders, 2 real testers counted |  |
| 🟢 | api_guard | APIs reject garbage, oversize and empty input | 400 / 413 / 400 |  |
| 🟢 | headers | Security and no-index headers are served | noindex on /admin, nosniff |  |
| 🟢 | photos | Every built-in photo loads at 900x900 with an allowed licence, answers and a credit | 63 photos OK |  |
| 🟢 | selftest | Scoring self-test in the page passes every spec vector | 38/38 pass |  |
| 🟢 | pack | Your own photos: add a photo from the device, name the pack, back out | 1 photo added |  |
| 🟡 | pack_persist | Your own photos survive a reload | after reload the pack has 0 photos (saving needs the claude.ai asset store; not available on this site) | 2026-10-03T23:25:12.430Z |
| 🟢 | profile | Player name is saved on the device | kept after reload |  |
| 🟢 | group | Group Room: host shares a link, a friend joins with just a name, both play the same round live | joined via invite in 208 ms, round start skew 2 ms, boards match |  |

## Open promises

- 🟡 **group-realtime** (undefined): Friends and family join one shared link and play in real time with no noticeable delay — wire `group`
- 🟡 **world-real-board** (undefined): World Live leaderboard shows the real people playing that same round, live — wire `world_live_board`
- 🟡 **ai-agents** (planned): People can connect their AI agents to play (agent API / MCP seat in a room) — no wire yet
- 🟡 **pack-persist** (gap): My own photos survive a page reload — wire `pack_persist`
- 🟡 **anti-capture** (planned): Discourage screenshots / phone capture of photos (native app: Android FLAG_SECURE, iOS capture detection; web can only deter) — no wire yet
- 🟡 **real-device-test** (planned): Checked on a real phone, not only an emulated one — no wire yet
- 🟡 **retention-purge** (planned): Old playtest data purged automatically (spec §21.5) — no wire yet

## Elements

| | Kind | Element | Purpose | Wire | Completion |
|---|---|---|---|---|---|
| 🟢 | ui | `app` | Root the whole game renders into | home | display |
| 🟢 | ui | `profName` | Player name, saved on this device | profile | none: stored locally only |
| 🟢 | ui | `goWorld` | Start World Live (60 s cycle, bots in this build) | world | round_start |
| 🟢 | ui | `goWorldScr` | Start World Live: Scrambled (advanced scramble every round, own board) | world_scr | round_start |
| 🟢 | ui | `goPractice` | Start Solo Practice with the chosen grid, photos, scramble and hint | practice_full | round_start |
| 🟢 | ui | `goBlitz` | Start a 2-minute Solo Blitz run | blitz | round_start |
| 🟢 | ui | `goGroup` | Open Group Room (host or join with a code) | group | screen |
| 🟢 | ui | `goPack` | Open Your own photos | pack | screen |
| 🟢 | ui | `grids` | Practice grid size picker (4-100 tiles) | options | round_start |
| 🟢 | ui | `pSrc` | Practice photo source: built-in or my photos | pack | round_start |
| 🟢 | ui | `pScr` | Practice scramble level (off, x1.25, x1.5) | options | round_start |
| 🟢 | ui | `hint` | Practice category hint (x0.5) | options | round_start |
| 🟢 | ui | `vec` | Scoring self-test output (spec §11 vectors) | selftest | display |
| 🟢 | ui | `phaseLbl` | Round phase label (join, live reveal, final window) | practice_full | display |
| 🟢 | ui | `clock` | Round / run clock | practice_full | display |
| 🟢 | ui | `prog` | Reveal progress bar | practice_full | display |
| 🟢 | ui | `tiles` | Tile grid covering the photo | practice_full | display |
| 🟢 | ui | `rev` | Tiles revealed counter | practice_full | display |
| 🟢 | ui | `worldAt` | Live tile count while frozen | practice_full | display |
| 🟢 | ui | `cd` | Join countdown ring before a synced round | world | display |
| 🟢 | ui | `wlLive` | World Live: how many are playing now and how many scored this round (live) | world_live_board | display |
| 🟢 | ui | `quit` | Leave a round during the join countdown | world | round_abandon |
| 🟢 | ui | `fz` | FREEZE: stop the board and answer | practice_full | freeze |
| 🟢 | ui | `af` | Answer form | practice_full | answer |
| 🟢 | ui | `ans` | Answer input | practice_full | answer |
| 🟢 | ui | `dict` | Autocomplete from a general word list (never this round's answers) | practice_full | display |
| 🟢 | ui | `ansBar` | 7-second answer timer bar | practice_full | display |
| 🟢 | ui | `ansClock` | 7-second answer countdown | practice_full | display |
| 🟢 | ui | `unfreeze` | Give up this freeze and keep watching | unfreeze | freeze_fail |
| 🟢 | ui | `giveup` | Practice: give up and reveal | giveup | round_end |
| 🟢 | ui | `photoClock` | Blitz: this photo's reveal clock | blitz | display |
| 🟢 | ui | `skip` | Blitz: skip photo, or move on keeping a banked half credit | blitz | round_end |
| 🟢 | ui | `endRun` | Blitz: end the run now | blitz | blitz_end |
| 🟢 | ui | `next` | Next World Live round / play practice again | world | round_start |
| 🟢 | ui | `nextIn` | Countdown to the next synced round | world | display |
| 🟢 | ui | `home` | Back to menu | giveup | screen |
| 🟢 | ui | `again` | Blitz: run again | blitz | round_start |
| 🟢 | ui | `files` | Add photos from the device | pack | none: photos never leave the device |
| 🟢 | ui | `packMsg` | Upload progress / result message | pack | display |
| 🟢 | ui | `packName` | Name of the photo pack | pack | none: stored locally only |
| 🟢 | ui | `tryIt` | Practice with my own photos | pack | round_start |
| 🟢 | ui | `srcNote` | Explains which photos a group game uses | group | display |
| 🟢 | ui | `nick` | Group: your name in the room | group | screen |
| 🟢 | ui | `host` | Group: create a room | group | screen |
| 🟢 | ui | `join` | Group: join a room | group | screen |
| 🟢 | ui | `joinCode` | Group: room code input | group | screen |
| 🟢 | ui | `gGrid` | Group setting: grid | group | screen |
| 🟢 | ui | `gRounds` | Group setting: rounds | group | screen |
| 🟢 | ui | `gHint` | Group setting: hint | group | screen |
| 🟢 | ui | `gScr` | Group setting: scramble | group | screen |
| 🟢 | ui | `gScrEach` | Group setting: scramble varies per round | group | screen |
| 🟢 | ui | `gSrc` | Group setting: built-in or pack photos | group | screen |
| 🟢 | ui | `gTeams` | Group setting: number of teams | group | screen |
| 🟢 | ui | `copy` | Group: copy the invite link | group | screen |
| 🟢 | ui | `share` | Group: share the invite through the phone share sheet (text, WhatsApp...) | group | screen |
| 🟢 | ui | `start` | Group: host starts the game | group | round_start |
| 🟢 | ui | `tpick` | Group: pick a team | group | screen |
| 🟢 | ui | `live` | Group: live board during a round | group | display |
| 🟢 | ui | `leave` | Group: leave the room | group | screen |
| 🟢 | ui | `takeover` | Group: take over as host if the host left | group | screen |
| 🟢 | ui | `back` | Back from a sub-screen | pack | screen |
| 🟢 | ui | `retry` | Group: retry when live rooms are unavailable | group | screen |
| 🟢 | ui | `pt-yes` | Consent: share anonymous play data | consent_yes | session_start |
| 🟢 | ui | `pt-no` | Consent: decline; nothing is sent or stored | consent_no | none: declining must leave no trace |
| 🟢 | ui | `pt-stars` | Feedback: 1-5 rating | feedback_form | feedback:general |
| 🟢 | ui | `pt-tags` | Feedback: what it was about | feedback_form | feedback:general |
| 🟢 | ui | `pt-liked` | Feedback: what they liked | feedback_form | feedback:general |
| 🟢 | ui | `pt-dis` | Feedback: what they didn't like | feedback_form | feedback:general |
| 🟢 | ui | `pt-bug` | Feedback: what broke | feedback_form | feedback:general |
| 🟢 | ui | `pt-contact` | Feedback: optional email for follow-up | feedback_form | feedback:general |
| 🟢 | ui | `pt-send` | Feedback: send | feedback_form | feedback:general |
| 🟢 | ui | `pt-cancel` | Feedback: close without sending | feedback_form | feedback_open |
| 🟢 | ui | `pt-msg` | Feedback: send status | feedback_form | display |
| 🟢 | ui | `pt-st` | Round reaction: send status | round_reaction | display |
| 🟢 | ui | `tok` | Admin token input | admin | none: secret, never logged |
| 🟢 | ui | `login` | Admin: load results | admin | display |
| 🟢 | ui | `status` | Admin: load status | admin | display |
| 🟢 | ui | `out` | Admin: results tables and comments | admin | display |
| 🟢 | ui | `dl` | Admin: download every number as JSON (for ads, buyers, investors) | admin | none: owner download |
| 🟢 | screen | `home` | Mode menu | home | screen |
| 🟢 | screen | `play` | A round in progress | practice_full | screen |
| 🟢 | screen | `results` | Round result, score breakdown, board, reaction | practice_full | round_end |
| 🟢 | screen | `blitzResults` | Blitz run summary | blitz | blitz_end |
| 🟢 | screen | `pack` | Your own photos | pack | screen |
| 🟢 | screen | `groupSetup` | Group Room host/join | group | screen |
| 🟢 | screen | `groupLobby` | Group Room lobby | group | screen |
| 🟢 | screen | `groupFinal` | Group Room final standings | group | screen |
| 🟢 | mode | `world` | World Live | world | round_end |
| 🟢 | mode | `practice` | Solo Practice | practice_full | round_end |
| 🟢 | mode | `blitz` | Solo Blitz | blitz | blitz_end |
| 🟢 | mode | `group` | Group Room in real time over a shared link | group | round_end |
| 🟢 | api | `api/e` | Ingest consented play events | consent_yes | display |
| 🟢 | api | `api/feedback` | Ingest tester feedback | feedback_form | display |
| 🟢 | api | `api/admin/summary` | Aggregated results for the owner | admin | display |
| 🟢 | api | `api/room/[name]` | WebSocket into a live room (Durable Object) | group | display |
| 🟢 | api | `api/world/[q]` | WebSocket into the live World Live board for a queue | world_live_board | display |
| 🟢 | api | `api/time` | Server clock that aligns World Live on every device | world_same | display |
| 🟢 | api | `api/admin/session` | One session's rows (wire map proof, deletion requests) | admin | display |
| 🟢 | event | `session_start` | A consenting tester arrived | consent_yes | display |
| 🟢 | event | `screen` | Navigation path | consent_yes | display |
| 🟢 | event | `round_start` | A round began (mode, grid, photo, options) | practice_full | display |
| 🟢 | event | `freeze` | A freeze (timing, tiles shown) | practice_full | display |
| 🟢 | event | `answer` | What was typed and how it matched | practice_full | display |
| 🟢 | event | `freeze_fail` | Wrong answer, timeout, unfreeze, or left the app | unfreeze | display |
| 🟢 | event | `round_end` | Outcome and score of a round | practice_full | display |
| 🟢 | event | `round_abandon` | Left mid-round (menu or closed) | abandon | display |
| 🟢 | event | `blitz_end` | Blitz run total | blitz | display |
| 🟢 | event | `feedback_open` | Opened the feedback form | feedback_form | display |
| 🟢 | event | `heartbeat` | Play time per visit (active minutes, rounds), server reply time, live-room delay | visit_data | display |
| 🟢 | event | `client_error` | Crashes and failed files on testers' devices | visit_data | display |
| 🟢 | tag | `fun` | Feedback tag: fun | feedback_form | feedback:general |
| 🟢 | tag | `too_hard` | Feedback tag: too_hard | feedback_form | feedback:general |
| 🟢 | tag | `too_easy` | Feedback tag: too_easy | feedback_form | feedback:general |
| 🟢 | tag | `unfair_scoring` | Feedback tag: unfair_scoring | feedback_form | feedback:general |
| 🟢 | tag | `confusing` | Feedback tag: confusing | feedback_form | feedback:general |
| 🟢 | tag | `too_slow` | Feedback tag: too_slow | feedback_form | feedback:general |
| 🟢 | tag | `photo_issue` | Feedback tag: photo_issue | feedback_form | feedback:general |
| 🟢 | tag | `answer_rejected` | Feedback tag: answer_rejected | feedback_form | feedback:general |
| 🟢 | tag | `layout` | Feedback tag: layout | feedback_form | feedback:general |
| 🟢 | tag | `performance` | Feedback tag: performance | feedback_form | feedback:general |
| 🟢 | tag | `other` | Feedback tag: other | feedback_form | feedback:general |
