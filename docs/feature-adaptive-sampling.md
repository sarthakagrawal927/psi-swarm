# Feature: Adaptive sampling — run until confident, not a fixed N

**Status:** proposed · the headline "fast *and* rigorous" feature.

The pitch is "distribution, not one noisy point." Adaptive sampling makes that
**fast**: spend runs proportional to how noisy the site actually is.

---

## Problem with fixed N
- **Stable site** → a fixed N (e.g. 20) wastes runs; you'd get the same p75 from ~6.
- **Noisy site** → a fixed N is *insufficient*; 10 runs won't pin p90.

## Approach
1. Run a **minimum batch** (e.g. 5) to seed.
2. After each additional run, recompute the **target percentile** (e.g. p75 LCP)
   **and its uncertainty.**
3. **Stop** when uncertainty < target precision, or a **max cap** is hit.

### Measuring convergence — bootstrap the percentile CI
Resample the collected runs with replacement ~1000×, compute the percentile each
time → distribution of the *estimate* → its confidence interval. Stop when the
**CI width** < target (e.g. p75 LCP within ±50ms or ±5%). Bootstrap is correct
here (percentiles aren't normal) and costs microseconds vs a multi-second run.
Cheaper proxy: stop when the percentile hasn't moved >X% over the last k runs.

### Honesty floor (this is a feature, not a limitation)
- High percentiles need samples — you **cannot** estimate a real p99 from 5 runs.
  Keep a higher floor for p90/p99, and **report the achieved CI next to each
  percentile**. "p75 LCP 1.8s ±40ms" is exactly the distribution-honesty thesis.

## Companion win: warm-Chrome reuse
`cli/src/runner.ts` `runOnce` currently `launch()` → kill **per run** — every run
eats a cold Chrome start (~0.3–0.8s ×N×presets). Reuse one Chrome with a fresh
context/tab per run (keeps isolation) → saves the launch cost ×N.

## Flags
```
--adaptive --target lcp --percentile 75 --precision 5% --min-runs 5 --max-runs 25
```

## Why it dominates fixed-N
- Stable → converges ~5–8 runs → **2–3× faster.**
- Noisy → runs more where it matters → **more accurate.**
- Time spent ∝ noise, not a flat budget.

## Caveats
- **Warmup:** discard/flag the first run (cache cold) before the stop math.
- **Drift:** thermal throttling makes late runs slower than early — violates the
  i.i.d. assumption bootstrap relies on. Detect + warn (or cap).
- Don't let `--adaptive` stop at the floor and *claim* a p99 — report uncertainty.

## Acceptance criteria
- [ ] `--adaptive` stops early once the target percentile's CI converges.
- [ ] min/max caps respected; higher floor enforced for p90/p99.
- [ ] output shows a confidence interval per reported percentile.
- [ ] warm-Chrome reuse with per-run context isolation.
- [ ] validated vs fixed-N on one stable + one noisy site (same percentiles, fewer runs).
