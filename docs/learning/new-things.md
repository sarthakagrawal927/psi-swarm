# New things to learn — psi-swarm

Techniques that are genuinely novel in this project, ordered from most unfamiliar to most mainstream.

---

## Lighthouse 12 programmatic API (vs PSI HTTP API)
- What: Call Lighthouse directly as a Node module (`import lighthouse from 'lighthouse'`) instead of hitting the PageSpeed Insights REST endpoint.
- Why here: TBD
- Gotcha (from code): Node 24 breaks Lighthouse 12 via an internal `TraceEngineResult` performance mark — `engines` field in both `package.json` and `cli/package.json` hard-gates to `>=20 <24`. The runner passes `{ port: chrome.port, logLevel: 'silent', output: 'json' }` with an inline config object rather than a file (`runner.ts:58-74`).
- Source: https://github.com/GoogleChrome/lighthouse/blob/main/docs/configuration.md

---

## chrome-launcher for headless Chrome control
- What: `chrome-launcher` finds, launches, and tears down a local Chrome instance, returning a port the Lighthouse call connects to.
- Why here: TBD
- Gotcha (from code): Flags `--headless=new --no-sandbox --disable-dev-shm-usage` are required for CI/Docker; omitting them causes silent hangs. Defined at `runner.ts:37-42`; Chrome is always killed in the `finally` block (`runner.ts:127`).
- Source: https://github.com/GoogleChrome/chrome-launcher

---

## Distributional performance sampling (p50/p75/p90/p99 stabilization)
- What: Run the same audit N times, sort results, interpolate percentiles via linear index weighting — `p99` on small N is highly unstable.
- Why here: TBD
- Gotcha (from code): The interpolation is `idx = (p/100) * (sorted.length - 1)` with fractional weighting (`stats.ts:16-21`). No minimum sample size is enforced anywhere in the codebase — p99 from fewer than ~15 runs is mostly noise. A single run can deviate 30%+ on LCP (noted in `README.md:4`).
- Source: https://web.dev/articles/vitals-measurement-getting-started

---

## Ink — React for terminal UIs
- What: Write terminal UIs with React components (`Box`, `Text`, `render`) — Ink re-renders a virtual terminal the same way React re-renders the DOM.
- Why here: TBD
- Gotcha (from code): Ink uses Yoga (Flexbox engine) for layout; `ui.tsx:2` imports `{ Box, Text, render }` from `ink` and wraps a stateful React component that subscribes to the `SwarmRunner` event emitter for live progress updates.
- Source: https://github.com/vadimdemedes/ink

---

## Multi-LLM router pattern (Claude / Codex / Gemini via local-ai)
- What: A single `reason.ts` module routes to either a local proxy (`local-ai` on `:3456` that shells out to whichever CLI is authenticated) or any OpenAI-compatible REST endpoint, selected at call time.
- Why here: TBD
- Gotcha (from code): The local-ai path POSTs `{ provider, model, systemPrompt, messages }` to `/api/chat` and reads SSE `data:` lines, extracting either `parsed.text` or `parsed.delta` (`reason.ts:273-278`). The openai path uses the standard `choices[0].delta.content` field. Switching backends is a single `--reason-backend` flag.
- Source: https://github.com/sarthakagrawal927/local-ai

---

## Emulated network + CPU throttling (not real device variance)
- What: Lighthouse simulates slow networks and CPU slowdown multipliers via DevTools CDP — it is lab data, not field data.
- Why here: TBD
- Gotcha (from code): Lighthouse defaults to a **4× CPU multiplier** on desktop (not 6×; see upstream `throttling.md`). INP cannot be measured in navigation mode because it requires real user input — the row is suppressed via a silent `if (!s) continue` guard on `computeStats` returning null (`report.ts:101-102`). The notes footer at `report.ts:268` documents this explicitly.
- Source: https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md

---

## CrUX API integration — lab vs field gap
- What: `crux.ts` calls the Chrome UX Report API (`chromeuxreport.googleapis.com/v1/records:queryRecord`) to fetch 28-day real-user p75 for LCP, CLS, INP, FCP, and TTFB, then renders a side-by-side lab vs field table.
- Why here: TBD
- Gotcha (from code): The API is called with `preferUrl: true` — it tries URL-specific data first, then falls back to origin-aggregate if the URL has insufficient traffic (`crux.ts:26-28`). INP appears in the CrUX table (real users can trigger it) even though it is hidden from the lab table.
- Source: https://developer.chrome.com/docs/crux/api/

---

## Astro for the reporting/docs surface
- What: Astro builds the web UI as a hybrid static/SSR site; in dev mode it hot-reloads React island components while the shell stays static.
- Why here: TBD
- Source: https://docs.astro.build/en/getting-started/

---

## npm workspaces monorepo (cli + web)
- What: Root `package.json` declares `workspaces: ["cli", "web"]`; `npm --workspace cli run build` targets a single package without hoisting conflicts.
- Why here: TBD
- Gotcha (from code): The project uses **npm workspaces**, not pnpm — there is no `pnpm-workspace.yaml`. Root `package.json:7-10` lists the two workspaces.
- Source: https://docs.npmjs.com/cli/v10/using-npm/workspaces
