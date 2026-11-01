# AGENTS.md — psi-swarm

> Agent bootloader. Concise by design — depth lives in [`docs/`](./docs/).

## What this is

psi-swarm is a **local-first** website performance tracker. It runs
Lighthouse 13 many times across realistic device/network presets and
reports the **p50 / p75 / p90 / p99** of Web Vitals instead of one noisy
point. Compute stays on the user's machine; the browser UI is only a
controller. MIT, no telemetry, no account.

It is a standalone Sass Maker repository. The repository owns its runtime,
domain logic, and canonical `SKILL.md`; Fleet may expose a thin invocation
entrypoint, but must not duplicate this implementation.

## Essential commands

```bash
pnpm run setup                                      # install + build CLI
pnpm run cli -- run <url> --runs 5 --parallel auto  # a swarm
pnpm run serve                                      # local HTTP agent (for web UI)
pnpm run web                                        # Astro dev server → :4321
pnpm run build:cli && pnpm run build:web            # type-check by build
pnpm docs:check                                     # validate docs/ + internal links
```

**Node 22.19+** required (Lighthouse 13 requires Node >=22.19 and supports Node 24). pnpm 10.33.2
pinned via `packageManager`.

## Critical constraints

- **No root test/lint scripts.** The CLI owns a narrow external-adapter
  regression suite; the web package tests the local comparison consumers. See
  [docs/development/testing.md](./docs/development/testing.md).
- **Repository CI exists.** `.github/workflows/ci.yml` runs the CLI
  regression suite, CLI/web builds, and docs checks for helper changes.
  `.github/workflows/deploy.yml` remains manual. See
  [docs/operations/deploy.md](./docs/operations/deploy.md).
- **Deploy is manual.** `main` should stay releasable/green but is not an
  automatic production trigger. Use `pnpm run deploy` (guarded) — see
  [docs/operations/deploy.md](./docs/operations/deploy.md). Do not use
  `pnpm deploy`, which invokes pnpm's built-in workspace deploy command.
- **Local-first.** The deployed site is a static Astro build — no SSR, no
  Workers, no runtime secrets. Don't add server-side compute.
- Keep `SKILL.md` aligned with helper-owned commands and paths; do not copy its
  implementation into `.claude/` or another skill/plugin definition.
- **Don't** deploy, migrate, rotate credentials, or edit production config
  unless explicitly asked.

## Documentation navigation

The canonical knowledge system is [`docs/`](./docs/). Start at
[`docs/index.md`](./docs/index.md).

- [Product](./docs/product/) — overview, surfaces (CLI/web/API/skill), presets
- [Architecture](./docs/architecture/) — system design, data model, ADRs
- [Development](./docs/development/) — workflow, reasoning backends, testing
- [Operations](./docs/operations/) — deploy, background jobs, runbooks
- [Knowledge](./docs/knowledge/) — learnings, failed approaches
- [Current](./docs/current/) — proposed/in-progress specs
- [PRDs](./docs/prds/) — shipped v0.4.0 PRDs

Two status homes, by design — don't duplicate:

- [`STATUS.md`](./STATUS.md) — short living snapshot (today's objective,
  active work, blockers, unresolved questions, next steps).
- [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — fleet-mandated durable
  ledger (why/what, dependencies, full timeline, shipped features,
  long-form todo/deferred/blocked). **Canonical history.**

## Documentation maintenance rules

1. **Markdown in `docs/` is the source of truth.** Keep canonical content in
   the committed docs tree.
2. **One home per fact.** If a fact lives in `PROJECT_STATUS.md` or in
   code, link to it; don't restate.
3. **Code is authoritative** for implementation details and schedules.
4. **Mark unresolved questions** explicitly (`_Unresolved:_`).
5. **No empty folders or placeholder pages.**
6. **Run `pnpm docs:check` before merging docs changes.** CI
   (`.github/workflows/docs.yml`) runs the same check on PRs touching
   `docs/`.
7. When a `docs/current/` spec ships, move it to `docs/prds/` with a
   `Status: Shipped` header and update `PROJECT_STATUS.md`.
