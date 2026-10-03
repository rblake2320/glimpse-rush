# Playtest: collecting what testers do, like and dislike

Live at **https://glimpse-rush.pages.dev** (Cloudflare Pages + Functions + D1 `glimpse-rush-playtest`).
Results dashboard: **/admin/** (needs the admin token; see Operate below).

## What is collected

Nothing is sent until the tester taps **Share anonymously** on the first-visit notice. **No thanks** sends and stores nothing (verified live).

| Data | Where it comes from | Why |
|---|---|---|
| Random browser ID (not an account, not derived from anything personal) | generated in the browser, saved only after consent | group one tester's rounds together |
| Device class (mobile/desktop, touch/mouse), viewport, language, build, country | browser + Cloudflare country header | layout and difficulty by device |
| `round_start` (mode, grid size, photo, scramble, hint) / `round_end` (outcome, score, tiles shown at freeze, freeze time, duration) / `round_abandon` (where they quit) | game | is a mode/grid too hard, too easy, or being abandoned |
| `freeze` (which freeze, time, tiles shown) | game | do people freeze early or late |
| `answer` (what they typed, how it matched: correct / partial / wrong) | game | **wrong answers that repeat for one photo are probably missing from the accepted list** |
| `freeze_fail` (wrong answer, timeout, left the app) | game | |
| `screen` visits, `feedback_open` | game | where people go and where they stall |
| Feedback form: 1-5 rating, tags, liked, disliked, bug text, optional email | tester, explicit | the qualitative signal |
| Per-round 👍/👎 and "my answer should count" | tester, explicit | per-photo quality, answer-matching fixes |
| Feedback context: screen, mode, round, photo, viewport, last 20 lines of that round's action log | attached automatically to feedback | reproduce bugs |

**Not collected:** IP address (not stored), name, account, location beyond country, photos the tester uploads (custom pack images never leave the device), contact details unless the tester types an email.
Typed answers are free text, so the notice says answers are recorded.

## What the dashboard answers

Rounds started / finished / abandoned by mode · outcomes and average score · solve rate and average tiles-at-freeze by grid size · hardest photos · most common wrong answers per photo · "my answer should count" flags · 👍/👎 by photo · tag counts · devices and countries · every written comment, newest first.

## Hard limits (server-enforced, tested)

32 KB per request, 50 events per batch, 400 events/min per browser ID, 20 feedback posts/min, fixed tag vocabulary, event-type allow-list, rating ranges checked, text clipped. `ADMIN_TOKEN` unset means the dashboard is locked, not open.

## Operate

```powershell
npm test                      # 51 tests incl. 6 backend tests (real SQL on SQLite, D1's engine)
npm run deploy                # publish prototype/ + functions/ to Cloudflare Pages
```

- Admin token: stored as the Pages secret `ADMIN_TOKEN` and, on the owner's PC, in `C:\Users\techai\.glimpse-rush.env`. Rotate with `npx wrangler pages secret put ADMIN_TOKEN --project-name glimpse-rush`.
- Schema changes: add `playtest/migrations/000N_*.sql`, then `npx wrangler d1 execute glimpse-rush-playtest --remote --file <file>`.
- Live check against production (needs Playwright): `node playtest/e2e-live.cjs` plays a real round in a headless browser and asserts the events, wrong answer, dispute, thumbs and feedback land in D1. Run it only against a database you are happy to add a test row to.
- Delete a tester's data on request: `DELETE FROM events WHERE sid='…'; DELETE FROM feedback WHERE sid='…'; DELETE FROM sessions WHERE sid='…';` (they can read their ID in the browser console as `__playtest.sid`).

## Known gaps

- **No automatic retention purge yet.** Spec §21.5 keeps attempt text 13 months; for the playtest, purge by hand until a scheduled job exists.
- Rate limits are per browser ID, which a scripted client can rotate. Fine for a friends-and-family playtest; put Cloudflare rate limiting on a custom domain before wide public traffic.
- Group Room events are recorded through the same game hooks; "Suggest answers" for custom packs is not available on this site.
- Custom photo packs are not saved across a reload on this site (wire `pack_persist`, amber).
- The e2e script uses real Chromium against production but not a phone; real-device testing is still to do.
