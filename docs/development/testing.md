---
title: Testing
description: The current test and quality checks.
---

# Testing

## Current state

- The root `package.json` deliberately has no generic `test` or `lint` script;
  tests stay with the package that owns them. `pnpm quality` is the repository
  quality gate.
- The `cli` package has Node tests covering crawler IP matching, project
  aggregation, metric validation, engine provenance and migration, comparison
  compatibility, HTTP responses, and the external trace-insight adapter boundary. Run them with `pnpm --filter psi-swarm test` or run the gated
  coverage pass with `pnpm --filter psi-swarm test:coverage`.
- The `web` package tests comparison compatibility and coverage rendering with
  `pnpm --filter psi-swarm-web test`, reusing the existing CLI TypeScript loader.
  Both `pnpm quality` and CI run these checks. Its build is `astro build`.
- `.github/workflows/psi-swarm-ci.yml` runs the complete quality gate for
  helper pull requests and pushes to `main`. See
  [operations → deploy](../operations/deploy.md).

## What stands in for tests

- **Type-check by build.** `pnpm run build:cli` and `pnpm run build:web`
  catch type regressions.
- **Docs validation.** `pnpm docs:check` validates frontmatter and internal
  links (see [workflow](./workflow.md)).
- **Static health.** Knip rejects unused code and import cycles; Lizard and
  jscpd reject complexity and duplication regressions; `pnpm audit` rejects
  critical/high advisories; the suppression check rejects new inline ignores.
- **Smoke checks in deploy CI.** The deploy workflow curls `/` and
  `/projects/` against the production URL after a Pages deploy.
- **Trace regression fixtures.** The external adapter suite is correlated to
  controlled Chrome DevTools MCP traces; see
  [external trace-insight validation](./trace-insight-validation.md).
- **Manual runs.** Broader measurement correctness is still validated by
  running swarms against known URLs and reading the percentile tables.

## Remaining gap

Coverage currently measures only CLI modules exercised by the suite, not the
entire CLI or the web application. The checked floor is 75% lines, 79%
branches, and 66% functions. Core math (percentile interpolation in
`cli/src/stats.ts`, preset resolution in `cli/src/presets.ts`) and browser
behavior remain the highest-value additions.

## If you add tests

- Put a `test` script on the package that owns the code (`cli` or `web`),
  not the root.
- Prefer `node --test` (built-in, no dependency) for the CLI's pure
  functions (`stats.ts`, `presets.ts`, `watchlist.ts` queue sort).
- Raise the checked coverage floor in `cli/package.json` when a new test lifts
  the measured baseline.
