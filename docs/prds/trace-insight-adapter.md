# Trace Insight Adapter

**Status:** Shipped (builtin) · **Release:** v0.4.0 · **Updated:** 2026-06-13

## What it is

An optional post-swarm diagnosis layer that turns captured Lighthouse artifacts into a compact, structured summary stored beside each history row. Does not replace Lighthouse or change percentile math.

## Entry points

| Surface | Path |
|---------|------|
| CLI | On by default; `--no-insight` to skip; `--insight-baseline <tag>` for comparison notes |
| Agent API | `GET /api/insights?url=` |
| Artifacts | `~/.psi-swarm/artifacts/<swarm-id>/<preset>.json` |
| External hook | `~/.psi-swarm/adapters/trace-insight.mjs` or `PSI_TRACE_INSIGHT_ADAPTER` |
| Storage | `run_insights` table in `~/.psi-swarm/history.db` |

## Behavior

- Runs synchronously after a saved swarm completes.
- **Builtin adapter** (default): dominant LCP phase, top opportunities, optional baseline delta notes from metric p75s.
- Insight fields: `bottleneck_phase`, `summary`, `opportunities[]`, `comparison_notes`, `adapter`, `artifact_path`.
- Rendered in terminal report, HTML report (`--output html`), and persisted after web UI runs.

## Implementation

- `cli/src/artifacts.ts` — bundle export
- `cli/src/trace-insight.ts` — adapter interface + builtin implementation
- `cli/src/report.ts`, `cli/src/html-report.ts` — rendering

## Follow-up

Validate an external adapter (Chrome DevTools MCP) against a small set of known regressions.
