# AGENTS.md — psi-swarm

## Shared Fleet Standard

Also read and follow the shared fleet-level agent standard at `../AGENTS.md`. Treat this repository as owned product code: protect production stability, keep changes scoped, verify work, and record durable follow-up tasks when something remains incomplete or blocked.

## Project

- **Stack**: Node, Lighthouse 12, headless Chrome, Ink CLI, Astro web UI, pnpm monorepo.
- **Local dev**: `pnpm run setup` (installs + builds CLI) · `pnpm run cli -- run <url>` · `pnpm run serve` (web UI) · `pnpm run web` (Astro dev server)
- **Checks**: no root test/lint scripts — CLI and web packages have their own.
- **PRDs**: shipped v0.4.0 items archived under `docs/prds/archive/`.
