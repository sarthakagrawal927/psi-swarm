---
name: psi-swarm
description: Run distributional Lighthouse audits with grounded LLM reasoning on any URL. Use when the user asks about web performance, Core Web Vitals (LCP/CLS/INP/TBT/FCP/TTFB), PageSpeed Insights, Lighthouse scores, "is my site fast?", "why is X slow?", comparing perf before/after a change, or analysing render-blocking resources / hero image weight / unused JS. Returns p50/p75/p90/p99 across realistic device/network presets plus a natural-language explanation grounded in actual audit findings (LCP element, phase breakdown, ranked opportunities with byte/ms savings).
---

# psi-swarm — distributional Lighthouse with reasoning

You have access to **psi-swarm** ([github.com/sarthakagrawal927/psi-swarm](https://github.com/sarthakagrawal927/psi-swarm)) — a CLI tool that runs Lighthouse many times against a URL across realistic device/network presets, then explains the results.

## When to invoke

Use this skill when the user asks any of:
- "Check the perf of <url>"
- "What's wrong with <url>'s Lighthouse score?"
- "Why is <url> slow on mobile?"
- "Is <url> Core Web Vitals compliant?"
- "How does <url> compare to <other-url>?"
- "Compare perf before/after this deploy"
- Anything mentioning LCP, CLS, INP, TBT, FCP, TTFB, render-blocking, hero image, page weight, unused JS

Don't use this for: general web-dev advice without a URL, RUM/field-data-only questions where you'd want CrUX directly, or questions about Lighthouse internals (those don't need a swarm).

## Setup — check it's available

```bash
# Option 1: clone if missing
if [ ! -d ~/.psi-swarm-local ]; then
  git clone https://github.com/sarthakagrawal927/psi-swarm.git ~/.psi-swarm-local
  cd ~/.psi-swarm-local && npm install && npm --workspace cli run build
fi

# Option 2: if user has it elsewhere, prefer their copy
which psi-swarm || echo "use ~/.psi-swarm-local/cli/dist/cli.js"
```

The CLI binary is `node ~/.psi-swarm-local/cli/dist/cli.js` (or wherever the user installed it).

> **Node version**: psi-swarm requires Node 20-23. Lighthouse 12 crashes on Node 24. If the user is on Node 24, suggest `nvm use 22` or installing nvm.

## How to invoke

### Default — a single URL with reasoning

```bash
node <psi-swarm>/cli/dist/cli.js run <URL> --runs 5 --presets psi --reason
```

This gives:
- p50/p75/p90/p99 of LCP/CLS/TBT/FCP/TTFB/SI across 5 mobile + 5 desktop runs (~2-3 min)
- Per-preset "Why?" with LCP element, phase breakdown, ranked Lighthouse opportunities
- Streaming LLM narrative explaining the dominant cause and highest-impact fix

### Quick smoke test (~30 s)

```bash
node <psi-swarm>/cli/dist/cli.js run <URL> --runs 2 --presets desktop --reason
```

### Comparing two URLs

```bash
node <psi-swarm>/cli/dist/cli.js run <URL1> --runs 5 --tag a
node <psi-swarm>/cli/dist/cli.js run <URL2> --runs 5 --tag b
# Then call compare:
node <psi-swarm>/cli/dist/cli.js compare <URL1> --baseline a --candidate b
```

### Producing a shareable HTML report

```bash
node <psi-swarm>/cli/dist/cli.js run <URL> --runs 5 --reason --output html --output-path ./report.html
```

## Reasoning backend — auto-detected

The `--reason` flag streams an LLM explanation. Backend is auto-detected:

| Priority | Backend | Trigger |
| -------- | ------- | ------- |
| 1 | `local-ai` (no API key) | Reachable at `localhost:3456` — wraps already-authenticated Claude/Codex/Gemini CLI. Start it from [github.com/sarthakagrawal927/local-ai](https://github.com/sarthakagrawal927/local-ai). |
| 2 | `openai` (OpenAI-compatible) | `OPENAI_API_KEY` env var set. Any provider via `OPENAI_BASE_URL` (OpenAI, OpenRouter, Groq, Together, vLLM/Ollama). |

If neither is set, the swarm still runs and shows the deterministic "Why?" section (LCP element + phases + opportunities) — just no streaming narrative. Tell the user how to enable it.

## Useful flags

| Flag | Purpose |
| ---- | ------- |
| `--presets psi|realistic|mobile|desktop|fast` | Preset group. Default `psi` matches PageSpeed Insights (mobile-mid + desktop). |
| `--runs <N>` | Runs per preset. Default 5. Use 10-30 for stable percentiles. |
| `--parallel auto` | Concurrent preset execution. Faster but adds CPU-throttling noise. |
| `--profile mobile-heavy|desktop-heavy|balanced|mobile-only` | Weighted "fleet verdict" line matching your traffic mix. |
| `--no-crux` | Skip CrUX field-data lookup. (Auto-skipped if `CRUX_API_KEY` not set.) |
| `--tag <name>` | Tag this swarm for later `compare`. |

## Interpreting the output

A complete run produces these sections in order:
1. **Header box** — URL, run counts, elapsed time
2. **Per-preset percentile table** — LCP/CLS/TBT/FCP/TTFB/SI as p50/p75/p90/p99/min/max/σ
3. **`CWV LCP gate (p75 ≤ 2.5s)`** — naive overall verdict
4. **`Weighted verdict (<profile>)`** — only if `--profile` is set; matches traffic mix
5. **`Real users (CrUX p75)`** — only if `CRUX_API_KEY` is set and site is in CrUX
6. **`Lab vs field gap`** — only if both lab and CrUX data exist; tells you whether the lab is over- or under-stating real-user experience
7. **`Why <preset>?`** — LCP element + LCP phase breakdown (TTFB / Load Delay / Load Time / Render Delay) + ranked opportunities table
8. **`Reasoning`** — LLM narrative (only with `--reason`)

**Quick-read heuristic for the user:**
- If `mobile-mid` LCP is "POOR" but `mobile-fast` and `desktop` are "GOOD" → the test was strict for the bottom-quartile user, not a real product issue.
- If `Lab vs field gap` shows "lab is 3× more pessimistic" → the lab is calibrated harshly, real users are fine.
- If `Render Delay > 40%` of LCP → it's a CSS / blocking-JS issue, NOT an image issue. Don't recommend image optimisation.
- If `Load Delay + Load Time > 60%` of LCP → it IS an image/asset loading issue. Recommend resize + preload.

## Output styling

The terminal output uses Ink-style boxes and ANSI colours. When showing it back to the user, you can:
- Quote the LLM narrative verbatim (it's already grounded in the audit data — don't re-summarise unless asked)
- Pull out the top 2-3 opportunities by impact for a quick action list
- Highlight the verdict colour: GOOD / NEEDS WORK / POOR

When the user runs with `--output html`, point them at the generated file with `open <path>` (macOS) or just the file path.

## For Codex users

Codex (OpenAI's CLI) reads `AGENTS.md` files instead of Claude's skill system. To get the same behaviour, add a short section to `~/.codex/AGENTS.md`:

```markdown
## psi-swarm (web perf tool)

When the user asks about web performance of a URL (Lighthouse / Core Web Vitals / LCP / "is X slow"), run:
  node ~/.psi-swarm-local/cli/dist/cli.js run <URL> --runs 5 --reason

Full docs: https://github.com/sarthakagrawal927/psi-swarm
```

The CLI is otherwise identical — no Codex-specific changes needed.
