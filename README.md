# psi-swarm

> Lighthouse, run many times across realistic device/network presets. See the **p50 / p75 / p90 / p99** of your Web Vitals, not one noisy point.

A single PageSpeed Insights run tells you almost nothing — two runs on the same URL can disagree by 30%+ on LCP because of network jitter, CPU contention, third-party scripts, and server-side variance. `psi-swarm` runs the same audit many times across a matrix of realistic conditions and reports the **shape** of the distribution, not just one point.

**Free, open source (MIT), fully local.** No account, no signup, no telemetry — nothing leaves your machine. Clone it, run it, own it.

## Two ways to use it

```
┌──────────────────────────────────────────────────────────────┐
│  Beautiful terminal UI  (Ink-based live progress)            │
│                                                              │
│      $ psi-swarm run https://example.com --parallel auto     │
│                                                              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Or:  Web UI in your browser, compute on your machine        │
│                                                              │
│  Terminal:    $ psi-swarm serve                              │
│  Browser:     http://localhost:4321                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

The CLI is the engine. The web app is a beautiful controller that drives the same engine through a tiny local HTTP server. **Compute always happens on your machine** — the browser is just the UI.

## Repo layout

```
psi-swarm/
├── cli/          ← Node CLI + headless Chrome runner + HTTP agent
│                   `psi-swarm run | discover | serve | history | compare`
└── web/          ← Astro + React + Tailwind dashboard
                    Talks to the CLI's `serve` agent via CORS
```

## Quick start (3 commands)

```bash
git clone https://github.com/sarthakagrawal927/psi-swarm.git
cd psi-swarm
npm run setup                                                # installs + builds CLI
npm run cli -- run https://example.com --runs 5 --parallel auto
```

That's it. Beautiful Ink-driven progress UI in the terminal, percentile tables, LCP element identification, and ranked Lighthouse opportunities.

> **Node version**: use Node 22 LTS. Lighthouse 12 has a known incompatibility with Node 24 (an internal `performance.measure` trace mark). The `engines` field gates this.

### Web UI flavour

Same CLI, but driven from a browser:

```bash
npm run serve                  # in one terminal: starts the local agent
npm run web                    # in another terminal: starts the Astro dev server
# → open http://localhost:4321
```

The browser auto-detects the local agent. **Compute always happens on your machine** — the page is just the controller.

### Reasoning about *why* your numbers are what they are

After every swarm, psi-swarm can stream an LLM-generated explanation grounded in the actual audit data — which `<img>` is the LCP, what % of LCP is render delay vs load time, the top 3 opportunities ranked by savings. Two backends, your choice:

```bash
# Local — uses your already-authenticated Claude / Codex / Gemini CLI via local-ai
npm run cli -- run https://example.com --reason --reason-backend local-ai

# Any OpenAI-compatible endpoint — OpenAI, OpenRouter, Groq, your own gateway, etc.
export OPENAI_API_KEY=<your key>
export OPENAI_BASE_URL=<base url including /v1>   # optional, defaults to https://api.openai.com/v1
npm run cli -- run https://example.com --reason --reason-backend openai

# Auto (default) — probes local-ai first, falls back to the OpenAI-compatible backend
npm run cli -- run https://example.com --reason
```

**For the zero-config local path**, also clone and run [local-ai](https://github.com/sarthakagrawal927/local-ai) on `:3456` — it wraps whichever LLM CLI you're already logged into (Claude, Codex, Gemini). No API key needed anywhere.

**For the cloud path**, `OPENAI_BASE_URL` lets you point at whatever provider you want: official OpenAI, OpenRouter, Groq, Together, a self-hosted vLLM/Ollama, or your own gateway. As long as it implements `POST /chat/completions` with the standard request/response shape, it works.

### Sharing a static HTML report

```bash
npm run cli -- run https://example.com --runs 5 --reason --output html --output-path report.html
open report.html   # macOS — or just open the file path
```

Self-contained ~17 KB HTML with all the same data the terminal shows: percentile tables, CrUX comparison, lab-vs-field gap, LCP element / phase breakdown, ranked opportunities, and the LLM narrative.

### Using psi-swarm from Claude Code / Codex

Install the skill once:

```bash
npm run install:skill
```

After that, **Claude Code recognises perf-related questions automatically** — "why is example.com slow on mobile?", "check the Lighthouse score of x.com", "compare these two URLs", etc. — and runs psi-swarm with the right flags.

For **Codex** (which uses `~/.codex/AGENTS.md` instead of skills), open `.claude/skills/psi-swarm/SKILL.md` after installing and copy the "For Codex users" section into your AGENTS.md.

See [`cli/README.md`](./cli/README.md) for every command and option.

### Demo gallery (no agent required)

Open [`/gallery`](http://localhost:4321/gallery) after `npm run web`. It renders three curated before/after fixtures so new users can see what comparison output looks like without running a swarm first.

### Local regression watchlist

Track critical URLs in SQLite and surface a compact queue of regressions, improvements, and stale pages:

```bash
npm run cli -- watch add https://example.com/ --label "Home" --baseline-tag before-deploy
npm run cli -- watch list
npm run cli -- watch check
```

The web UI exposes the same queue at [`/watchlist`](http://localhost:4321/watchlist) when `psi-swarm serve` is running.

### Trace insight adapter

Every saved swarm exports Lighthouse capture bundles to `~/.psi-swarm/artifacts/` and stores a derived diagnosis beside the history row (dominant LCP phase, top opportunities, optional baseline comparison notes). Disable with `--no-insight`, or plug in an external adapter at `~/.psi-swarm/adapters/trace-insight.mjs`.

```bash
npm run cli -- run https://example.com --tag after-deploy --insight-baseline before-deploy
```

## What's different from PageSpeed Insights / Lighthouse alone

- **Distribution, not a point.** Run N times, get p50/p75/p90/p99 + min/max/σ. PSI gives you one number per run.
- **Realistic device/network matrix.** Built-in presets for slow-3G low-end Android, slow-4G mid Android, fast-4G iPhone-class, desktop cable. Easy to mix.
- **Adaptive parallelism.** `--parallel auto` runs presets concurrently, capped at safe limits based on your machine.
- **SPA-aware link discovery.** Suggests "other pages you should test" using static HTML, sitemap.xml, Next.js `_buildManifest`, React Router patterns in the bundle, and a generic string-harvest fallback.
- **Local history.** SQLite at `~/.psi-swarm/history.db`. Tag swarms (`--tag before-deploy`) and `compare` p75/p99 across deploys.
- **Regression watchlist.** Mark high-value URLs and get a local queue of meaningful deltas without cloud scheduling.
- **Trace insight.** Optional derived diagnosis stored next to each swarm (builtin adapter by default; external adapter hook supported).
- **Demo gallery.** Static before/after fixtures in the web UI for consistent demos and docs.
- **Beautiful live UI** — terminal (Ink) or browser (Astro + React + Tailwind 4), same data model.

## Honest about what it is

- **Lab data.** All measurements use emulated network and CPU on a single machine. For real-user p99, use CrUX (PSI's field-data API) or a RUM tool — they capture device + network variance you genuinely can't reproduce locally.
- **INP can't be measured in lab navigation mode** — it requires real user input. The row is hidden when absent.

## Architecture diagram

```
            ┌────────────────┐
   CLI ────▶│ SwarmRunner    │ ───── spawns ─────▶ headless Chrome
            │ (event emitter)│                          │
            └───────┬────────┘                          ▼
                    │                              Lighthouse
                    ▼                                   │
            ┌────────────────┐                          ▼
            │ Ink terminal   │ ◀──── events ──── metrics + artifacts
            │ progress UI    │                       (LCP, CLS, INP,
            └────────────────┘                        TBT, FCP, TTFB,
                                                      Scripts bundle)
                    OR
                    ▼
            ┌────────────────┐    SSE     ┌─────────────────┐
            │ HTTP agent     │ ─────────▶ │ Browser web UI   │
            │ (localhost)    │            │ (Astro + React)  │
            └────────────────┘            └─────────────────┘
```

## License

MIT — see [LICENSE](./LICENSE).
