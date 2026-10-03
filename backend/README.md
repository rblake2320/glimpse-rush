# Glimpse Rush — database schema

`schema.sql` is the Postgres system of record for Spec v1.1 (§15, §20, §21): accounts and profiles, groups, persistent teams, photo packs and answers, rooms, rounds, attempts, scores, a SHA-256 hash-chained score ledger, and the leaderboard views that Redis mirrors live.

## Run the tests (Windows PowerShell)

```powershell
cd <repo>\backend
npm init -y | Out-Null
npm install @electric-sql/pglite@0.2
node --test schema.test.mjs
```

Linux/macOS: same commands. The tests use PGlite (real PostgreSQL 16 compiled to WebAssembly), so no database server is needed.

## Apply to a real database

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f schema.sql
```

The file is idempotent: running it again on an existing database changes nothing and fails on nothing. Requires PostgreSQL 13+ (uses core `gen_random_uuid()` and `sha256()`, no extensions).

## What the 21 tests prove

| Suite | Tests | Proves |
|---|---|---|
| A Schema | 2 | Applies twice cleanly; `max_score()` equals Spec §5.6 × §4a for every grid and scramble level |
| B Score integrity | 6 | Over-bound, negative, duplicate, and mode-mismatched scores rejected; scores append-only; ranked rounds can't carry scramble, hint, or grids under 25; a third freeze is rejected |
| C Ledger | 4 | Every score is chained; ledger rows can't be edited; a tampered score or forged hash is reported at the exact sequence number, and the chain verifies again once restored |
| D Calendar keys | 1 (6 cases) | `day_key`/`week_key` follow America/Chicago, reset Monday 00:00, survive the DST change, and use the ISO week-year (2027-01-01 → 2026-W53) |
| E Leaderboards | 2 | Weekly board sums only the best 20 rounds; team round score is the half-up average including players with no score; room totals add up |
| F Groups, teams, rooms, packs, media, handles | 6 | One active team per player per group with history kept; teams can't cross groups; non-members can't join teams; room codes unique only while active and exclude I/L/O; packs need upload attestation, answers are unique case-insensitively, packs with people can't go public; unscanned media can't be marked clean; size/type limits; handle format and case-insensitive uniqueness |

## Troubleshooting

- **`Cannot find module '@electric-sql/pglite'`**: run the `npm install` line in the same folder as the test file.
- **`function sha256(bytea) does not exist`**: the server is older than PostgreSQL 11. Upgrade; the schema targets 15+.
- **`ledger_verify()` returns a number in production**: that sequence number or its score row was changed outside the API. Restore from the last snapshot where the chain verified and replay from the WAL, then investigate the access logs.
- **Score insert fails with `exceeds max`**: the game server scored above the bound for that round's grid and scramble. That's a server scoring bug or a forged request, never a reason to loosen the check.
