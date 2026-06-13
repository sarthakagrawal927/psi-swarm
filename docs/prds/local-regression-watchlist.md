# Local Regression Watchlist

**Status:** Shipped · **Release:** v0.4.0 · **Updated:** 2026-06-13

## What it is

A local-first watchlist layer on top of tagged SQLite history. Users mark critical URLs, compare the latest swarm against a baseline tag (or prior swarm), and get a compact queue of regressions, improvements, stale pages, and missing data.

## Entry points

| Surface | Path |
|---------|------|
| CLI | `psi-swarm watch list \| add \| remove \| check` |
| Agent API | `GET/POST/DELETE /api/watchlist`, `POST /api/watchlist/refresh` |
| Web UI | `/watchlist` (requires `psi-swarm serve`) |
| Storage | `watchlist` table in `~/.psi-swarm/history.db` |

## Behavior

- Explicit add/remove only — no auto-discovery from history.
- Default preset: `mobile-mid`. Optional `--baseline-tag`, label, and per-metric thresholds.
- Regression defaults: LCP +200 ms or +10%; perf score −5 points.
- Stale after 7 days without a fresh run (configurable via `--stale-days`).
- Queue sort: missing → stale → regressed → improved → stable, then by LCP delta magnitude.

## Implementation

- `cli/src/db.ts` — `watchlist` table
- `cli/src/watchlist.ts` — queue evaluation
- `web/src/pages/watchlist.astro` — dashboard
