# psi-swarm

> Run Lighthouse N times across realistic device/network presets. Get **p50 / p75 / p90 / p99** of your Web Vitals instead of one noisy number.

A single PageSpeed run tells you almost nothing. Two runs on the same page can differ by 30%+ on LCP because of network jitter, CPU contention, third-party scripts, and server-side variance. `psi-swarm` runs the same audit many times across a matrix of realistic conditions and reports the **shape** of the result, not just one point.

## Quick start

```bash
npm install
npm run build
./dist/cli.js run https://example.com
```

Or during development:

```bash
npm run dev -- run https://example.com --runs 20
```

## Usage

```bash
psi-swarm run <url> [options]

  -r, --runs <n>        Runs per preset           (default: 5)
  -p, --presets <spec>  Preset group or names     (default: psi)
  -t, --tag <tag>       Tag this swarm in history
  --parallel <spec>     Preset-level parallelism: 1|N|auto  (default: 1)
  --no-save             Skip saving to local db
  --no-suggest          Skip post-run link suggestions

psi-swarm presets             # list available presets and groups
psi-swarm history <url>       # show recent history (formatted as a report)
psi-swarm urls                # list all URLs seen
psi-swarm compare <url> --baseline <tag> --candidate <tag> [--pct p75]
psi-swarm discover <url>      # list same-origin links from a page (static only)
```

Default is the **`psi`** preset group (mobile + desktop, matching Google PSI) × 5 runs = 10 runs total (~2-3 min) serial. For deeper data, use `--parallel auto --runs 30`.

### Parallelism

By default runs are **serial** — Lighthouse's CPU throttling assumes a dedicated core, so parallel Chrome instances introduce noise on CPU-bound metrics (TBT, INP, Perf Score). Use `--parallel auto` to run across presets concurrently when speed matters more than perfect TBT integrity. Auto-detects safe parallelism from your CPU/RAM (capped at 4).

### Link discovery (the "what else should I test?" feature)

After a run, psi-swarm tries hard to find related pages on the same site, using four sources merged:

1. **Static HTML** — `<a href>` regex on the fetched landing page.
2. **`/sitemap.xml`** — for sites that publish one (most SEO-tuned sites).
3. **Next.js `_buildManifest.js`** — extracted from the JS bundles Lighthouse already captured. Works for any Next.js site without a sitemap.
4. **React Router patterns** in bundled JS — `<Route path="...">` and `{ path: "..." }` shapes from data routers. Falls back to a generic string-harvest for unknown frameworks.

For pure auth-gated SPAs where the bundle is the only source, you may see a small or partial list — that's expected. (Auth-aware crawling is a future feature.)

### Presets

| Preset        | Form factor | Network             | CPU |
| ------------- | ----------- | ------------------- | --- |
| `mobile-slow` | Mobile      | Slow 3G (300ms RTT) | 6×  |
| `mobile-mid`  | Mobile      | Slow 4G (150ms RTT) | 4×  |
| `mobile-fast` | Mobile      | Fast 4G (75ms RTT)  | 2×  |
| `desktop`     | Desktop     | Cable (40ms RTT)    | 1×  |

Groups: `realistic` (all four), `mobile`, `desktop`, `psi` (matches Google PSI's mobile + desktop).

### Reasoning about what's slow (`--reason`)

After the percentile tables, psi-swarm can stream an LLM-generated **explanation** of why your numbers are what they are. Two backends:

```bash
# Auto: tries local-ai first, falls back to free-ai gateway
node dist/cli.js run https://example.com --runs 3 --reason

# Explicit
node dist/cli.js run https://example.com --reason --reason-backend local-ai
node dist/cli.js run https://example.com --reason --reason-backend free-ai
```

| Backend | Where it runs | Auth | Setup |
| ------- | ------------- | ---- | ----- |
| **local-ai** ([github.com/sarthakagrawal927/local-ai](https://github.com/sarthakagrawal927/local-ai)) | Your machine — wraps your already-authenticated Claude / Codex / Gemini CLI | None | `git clone … && npm install && npm start` (port 3456) |
| **free-ai** ([github.com/sarthakagrawal927/free-ai](https://github.com/sarthakagrawal927/free-ai)) | Cloudflare Workers, OpenAI-compatible API | `FREE_AI_API_KEY` env var | `export FREE_AI_API_KEY=...` |

The LLM gets a compacted summary of the Lighthouse audit data (ranked opportunities + LCP element + LCP phase breakdown — TTFB / Load Delay / Load Time / Render Delay), so its output cites specific files, byte counts, and percentages. Not generic advice.

### Comparing before/after a deploy

```bash
psi-swarm run https://example.com --tag before-deploy --runs 30
# ... ship the change ...
psi-swarm run https://example.com --tag after-deploy --runs 30
psi-swarm compare https://example.com --baseline before-deploy --candidate after-deploy
```

## What you see

For each preset: a table of p50 / p75 / p90 / p99 / min / max / σ for LCP, INP, CLS, TBT, FCP, TTFB, Speed Index, and the Lighthouse Performance Score. Cells are colored by Core Web Vitals "good / needs improvement / poor" bands. Sparkline shows distribution shape. CWV pass/fail gate based on LCP p75 ≤ 2.5s.

## Design notes

- **Lab data only.** All measurements happen on your machine with emulated network + CPU. Real-user p99 is dominated by device/network variance you can't reproduce locally. For real user p75 → use CrUX. For real user p99 → use a RUM tool (Cloudflare Web Analytics, Vercel Speed Insights, SpeedCurve LUX).
- **Runs are serial.** Parallel Chrome instances pollute CPU throttling. Integrity > speed.
- **History is local.** SQLite at `~/.psi-swarm/history.db`. Nothing leaves your machine.
- **INP is experimental in lab mode.** Lighthouse can't measure real INP without user input; the value shown is a heuristic and may be missing on some pages.

## Roadmap

- `--config` file for custom presets
- JSON / NDJSON export
- HTML report
- Hosted runner tier (cloud-side runs, multi-region, scheduled, alerts) — separate from this OSS CLI

## License

MIT
