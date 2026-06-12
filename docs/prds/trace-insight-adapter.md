# PRD: Trace Insight Adapter

Last updated: 2026-06-12

## Summary

psi-swarm already produces percentile tables and Lighthouse artifacts. This PRD
adds an optional trace-insight adapter that turns one run's trace and Lighthouse
payload into a compact, LLM-readable diagnosis without replacing the existing
measurement engine.

## Problem

Users can see that a page is slow, but they still need to read the trace and
match the slow phase to the relevant artifact. Today psi-swarm surfaces the raw
signals, but it does not yet package them into a single diagnosis that explains
why a run regressed and what changed between two runs.

## Goal

Make each swarm more actionable by attaching a derived diagnosis to the existing
SQLite history row and report output.

## Non-Goals

- Do not replace Lighthouse.
- Do not add a hosted dependency.
- Do not require network access for the baseline path.
- Do not change the percentile math or the core run loop.

## Users

- Performance engineers comparing before/after deploys.
- Product engineers trying to identify the dominant regression phase.
- Local-first power users who want a concise explanation after a swarm.

## Proposed Behavior

1. After a swarm, psi-swarm exports the trace and Lighthouse artifact bundle to
   a stable local path.
2. If an optional trace-insight adapter is available, psi-swarm runs it against
   the local bundle.
3. The adapter returns a short diagnosis with:
   - dominant bottleneck phase
   - strongest opportunity candidates
   - comparison notes for before/after runs when a baseline exists
4. The derived insight is stored next to the existing history row and rendered
   in the terminal and HTML report.

## Success Criteria

- A single run produces a human-readable diagnosis without manual trace digging.
- Before/after comparisons show the delta in the same place as the percentile
  table.
- The feature remains optional and does not affect runs when the adapter is not
  installed.

## Risks

- Trace normalization could drift across Lighthouse versions.
- A generic summary could become too vague unless the adapter output is tightly
  structured.
- Optional integrations can add support burden if the fallback behavior is not
  obvious.

## Implementation Slice

1. Add stable artifact export for trace and Lighthouse payloads.
2. Define the insight schema stored in SQLite.
3. Add a local-only adapter interface with a no-op fallback.
4. Render the insight in the existing report surfaces.

