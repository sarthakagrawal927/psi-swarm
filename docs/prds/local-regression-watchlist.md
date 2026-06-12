# PRD: Local Regression Watchlist

Last updated: 2026-06-12

## Summary

psi-swarm can already compare two tagged runs. This PRD extends that into a
local regression watchlist that tracks important pages, highlights meaningful
changes, and makes repeat checks faster to interpret.

## Problem

Users currently have to remember which URLs matter and manually inspect recent
history to see whether a regression is real. That works for ad hoc debugging but
not for ongoing performance hygiene.

## Goal

Give the local history a watchlist layer that surfaces the highest-value pages
and flags meaningful deltas in a concise queue.

## Non-Goals

- Do not add cloud scheduling.
- Do not create team accounts or notifications.
- Do not replace the existing tagged history model.
- Do not broaden scope into full observability.

## Users

- Teams keeping a handful of critical pages under watch.
- Engineers doing weekly regression checks after deploys.
- Maintainers who want a compact "what changed" queue.

## Proposed Behavior

1. Users can mark URLs as watched with optional labels and thresholds.
2. psi-swarm scans local history for watched URLs and compares the latest runs
   against the last known baseline.
3. The UI shows:
   - pages with the largest regressions
   - pages with improved scores
   - pages missing fresh data
4. The watchlist can be refreshed manually from the CLI or web controller.

## Success Criteria

- The most important URLs are visible without digging through full history.
- Users can tell at a glance whether a change is statistically meaningful.
- The feature remains local-first and simple to run on one machine.

## Risks

- Threshold tuning may be too noisy if it is not configurable.
- A watchlist can become stale if users never refresh it.
- If the UI hides the raw comparison data, it could reduce trust.

## Implementation Slice

1. Add a watchlist table to local storage.
2. Compare watched URLs against the latest tagged history entries.
3. Surface the queue in the web dashboard and CLI output.
4. Add a clear "needs attention" state for missing or stale swarms.

