# Project Status

Last updated: 2026-06-10

## Current Scope

psi-swarm is a local-first website performance tracker. It measures Web Vitals across repeated Lighthouse runs and realistic device/network presets so users can reason about p50, p75, p90, and p99 instead of trusting one noisy PageSpeed/Lighthouse result.

## Done

- Node CLI supports `run`, `discover`, `serve`, `history`, and `compare` workflows.
- Headless Chrome and Lighthouse runs produce percentile tables, LCP element identification, ranked opportunities, and static HTML reports.
- Local browser UI exists as an Astro + React + Tailwind controller for the CLI `serve` agent.
- Compute stays local; the browser UI talks to the local agent through CORS/SSE.
- Local SQLite history supports tagged runs and before/after comparisons.
- Optional reasoning can use local-ai or an OpenAI-compatible backend.
- Claude/Codex usage paths are documented through the installable skill and AGENTS guidance notes.
- OSS performance-tool integrations were evaluated in
  `docs/oss-integration-evaluation.md`; the current decision is to keep
  Lighthouse as the engine and prefer an optional Chrome DevTools trace-insight
  adapter before adopting a heavier sitespeed/WebPageTest-style stack.
- Ahrefs Domain Rating (free public endpoint) is fetched for custom-domain
  projects in the `/projects` dashboard and CLI/HTML reports. Cloudflare platform
  hostnames (`*.pages.dev`, `*.workers.dev`) are skipped because DR is not
  meaningful on shared CF subdomains. Ratings persist in SQLite; `serve` refreshes
  them weekly when idle (no active swarms), probed hourly.

## Planned Next

1. Keep Node 22 LTS as the supported path until the Lighthouse 12 / Node 24 trace-mark issue is resolved.
2. Improve the local web controller so users can run, compare, and inspect swarms without dropping to the CLI.
3. Add an optional trace-insight adapter that stores LLM-readable diagnosis beside existing percentile history. See [docs/prds/trace-insight-adapter.md](docs/prds/trace-insight-adapter.md).
4. Add clearer public/demo examples that compare real product pages before and after performance work. See [docs/prds/shareable-demo-gallery.md](docs/prds/shareable-demo-gallery.md).
5. Add a local regression watchlist so the highest-value URLs can be monitored and compared from the local history store. See [docs/prds/local-regression-watchlist.md](docs/prds/local-regression-watchlist.md).

## Deferred / Parked

- Hosted RUM or real-user p99 collection is deferred; psi-swarm is lab data, not a RUM replacement.
- Cloud execution is parked because compute is intentionally local for now.
- Paid monitoring, team accounts, and alerting are deferred behind a stronger local workflow.

## Fleet Perf Push 2026-06 — Open Follow-ups

These items came out of the 2026-06-04/05 fleet desktop-LCP push (goal: <500 ms
p75 across all 23 sites). The push closed 5 sites under 500 ms via the Worker
+ Astro overlay pattern, self-hosted fonts, opacity-anim LCP fixes, CF Cache
Rules, and `caches.default` data wrapping. The remaining gap is being closed
at the app level — Argo (cost) and Vercel (external dep) are off the table.

1. **Knowledgebase landing site** — build Astro frontend for the FastAPI+Qdrant
   RAG at `fleet/knowledgebase/`. Not perf-critical; tracked here because it
   completes the fleet inventory.
2. **psi-swarm × saas-maker integration** — wire this CLI into the saas-maker
   fleet workflow so desktop LCP samples flow into Cockpit dashboards. Spec
   notes belong above in "Planned Next" once started.
3. **Beasties critical-CSS pass** — high-signal Beasties-only pass on
   saas-maker cockpit + sarthakagrawal.dev. Both have dynamic `/` so the
   Astro overlay does not apply; only the Beasties half is safe. Expected
   ~150–300 ms LCP win.

Also parked (intentional, do not re-open without a budget decision):

- **Custom-domain Worker TTFB floor** — CF Workers/Pages on custom domains
  floor at 400–1000 ms TTFB in Lighthouse cold-sim without Argo Smart Routing.
  User ruled out both Argo ($5/mo) and Vercel (external dep). Workers.dev
  URLs hit <500 ms; custom domains do not.
