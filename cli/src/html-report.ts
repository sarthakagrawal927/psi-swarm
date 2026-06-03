import type { RunResultWithArtifact } from './runner.js';
import { computeStats } from './stats.js';
import { diagnosePreset, rankOpportunities, formatAggregatedAudit } from './diagnose.js';
import type { CruxRecord } from './crux.js';

/**
 * Self-contained HTML report. One file, no external assets, opens anywhere.
 * Render is intentionally simple hand-written HTML — for a richer interactive
 * view, use the local web UI (`npm run web` + `npm run serve`).
 */

export interface HtmlReportOptions {
  url: string;
  results: RunResultWithArtifact[];
  elapsedMs: number;
  cruxByFormFactor?: { mobile?: CruxRecord | null; desktop?: CruxRecord | null };
  trafficProfile?: { name: string; weights: Record<string, number> };
  reasoning?: { text: string; backend?: string; model?: string; durationMs?: number };
  generatedAt?: Date;
}

type MetricKey = 'lcp' | 'inp' | 'cls' | 'tbt' | 'fcp' | 'ttfb' | 'si' | 'performance_score';
interface MetricSpec {
  key: MetricKey;
  label: string;
  unit: 'ms' | 'score' | 'index';
  good?: number;
  poor?: number;
  higherIsBetter?: boolean;
}

const METRICS: MetricSpec[] = [
  { key: 'performance_score', label: 'Perf Score', unit: 'score', good: 90, poor: 50, higherIsBetter: true },
  { key: 'lcp', label: 'LCP', unit: 'ms', good: 2500, poor: 4000 },
  { key: 'inp', label: 'INP', unit: 'ms', good: 200, poor: 500 },
  { key: 'cls', label: 'CLS', unit: 'index', good: 0.1, poor: 0.25 },
  { key: 'tbt', label: 'TBT', unit: 'ms', good: 200, poor: 600 },
  { key: 'fcp', label: 'FCP', unit: 'ms', good: 1800, poor: 3000 },
  { key: 'ttfb', label: 'TTFB', unit: 'ms', good: 800, poor: 1800 },
  { key: 'si', label: 'SI', unit: 'ms', good: 3400, poor: 5800 },
];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function fmt(v: number | undefined, unit: 'ms' | 'index' | 'score'): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  if (unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
  if (unit === 'index') return v.toFixed(3);
  return v.toFixed(0);
}
function tierClass(v: number | undefined, spec: { good?: number; poor?: number; higherIsBetter?: boolean }): string {
  if (v === undefined || !Number.isFinite(v)) return 'dim';
  if (spec.higherIsBetter) {
    if (v >= (spec.good ?? 0)) return 'good';
    if (v >= ((spec.poor ?? 0) + (spec.good ?? 0)) / 2) return 'warn';
    return 'poor';
  }
  if (v <= (spec.good ?? 0)) return 'good';
  if (v <= (spec.poor ?? Infinity)) return 'warn';
  return 'poor';
}

const CSS = `
  :root { --bg:#0b0f17; --panel:#131826; --border:#1f2738; --text:#e6e9f2; --dim:#8089a4;
          --cyan:#38bdf8; --good:#22c55e; --warn:#facc15; --poor:#ef4444; }
  *,*::before,*::after { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:var(--bg); color:var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-feature-settings: "tnum" on; }
  main { max-width: 1100px; margin: 0 auto; padding: 32px 24px 80px; }
  h1 { font-size: 28px; margin: 0; letter-spacing: -0.02em; }
  h1 .cyan { color: var(--cyan); }
  h2 { font-size: 18px; margin: 0 0 12px; letter-spacing: -0.01em; }
  .sub { color: var(--dim); font-size: 14px; margin-top: 4px; word-break: break-all; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 20px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
  th, td { padding: 8px 12px; text-align: right; border-bottom: 1px solid var(--border); }
  th:first-child, td:first-child { text-align: left; font-weight: 500; }
  th { color: var(--dim); font-weight: 500; text-transform: uppercase;
    font-size: 11px; letter-spacing: 0.05em; }
  tr:last-child td { border-bottom: none; }
  .good { color: var(--good); } .warn { color: var(--warn); }
  .poor { color: var(--poor); } .dim { color: var(--dim); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 4px;
    background: rgba(56,189,248,0.1); color: var(--cyan); font-size: 12px;
    font-weight: 500; margin-right: 8px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600; }
  .badge.good { background: rgba(34,197,94,0.15); color: var(--good); }
  .badge.warn { background: rgba(250,204,21,0.15); color: var(--warn); }
  .badge.poor { background: rgba(239,68,68,0.15); color: var(--poor); }
  .preset-head { display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 12px; }
  .preset-head .label { color: var(--dim); font-size: 13px; }
  .reasoning { background: var(--bg); border-left: 3px solid var(--cyan);
    padding: 16px 20px; border-radius: 0 6px 6px 0; line-height: 1.6;
    font-size: 15px; white-space: pre-wrap; }
  .footer { color: var(--dim); font-size: 12px; margin-top: 32px; text-align: center; }
  .gap-line { font-size: 14px; margin: 4px 0; }
  .lcp-element { background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; }
  .lcp-element .label { color: var(--warn); font-weight: 500; margin-bottom: 4px; }
  .lcp-element .snippet { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; color: var(--dim); word-break: break-all; }
  .phases { display: flex; flex-wrap: wrap; gap: 14px; margin: 8px 0; font-size: 13px; }
  .header-meta { margin-top:14px; display:flex; gap:24px; font-size:13px;
    color:var(--dim); flex-wrap:wrap; }
`;

export function renderHtmlReport(opts: HtmlReportOptions): string {
  const { url, results, elapsedMs, cruxByFormFactor, trafficProfile, reasoning } = opts;
  const okResults = results.filter((r) => !r.error);
  const errors = results.length - okResults.length;
  const byPreset = new Map<string, RunResultWithArtifact[]>();
  for (const r of okResults) {
    const arr = byPreset.get(r.preset.name) ?? [];
    arr.push(r);
    byPreset.set(r.preset.name, arr);
  }
  const generated = (opts.generatedAt ?? new Date()).toISOString();
  const presetNames = Array.from(byPreset.keys()).map(escapeHtml).join(', ');

  // Header
  const headerHtml = `
    <section>
      <h1><span class="cyan">psi</span>-swarm report</h1>
      <div class="sub">${escapeHtml(url)}</div>
      <div class="header-meta">
        <div><span class="dim">Runs:</span> ${results.length} (${okResults.length} ok${errors ? `, ${errors} failed` : ''})</div>
        <div><span class="dim">Presets:</span> ${presetNames}</div>
        <div><span class="dim">Elapsed:</span> ${(elapsedMs / 1000).toFixed(1)}s</div>
        <div><span class="dim">Generated:</span> <span class="mono">${escapeHtml(generated)}</span></div>
      </div>
    </section>
  `;

  // Per-preset percentile tables
  let presetsHtml = '';
  for (const [name, rs] of byPreset) {
    const label = rs[0].preset.label;
    const statsRows = METRICS.map((m) => {
      const vals = rs.map((r) => r.metrics?.[m.key]).filter((v): v is number => typeof v === 'number');
      const s = computeStats(vals);
      if (!s) return '';
      const cls = (v: number) => tierClass(v, m);
      return `<tr>
        <td>${m.label}</td>
        <td class="${cls(s.p50)} mono">${fmt(s.p50, m.unit)}</td>
        <td class="${cls(s.p75)} mono">${fmt(s.p75, m.unit)}</td>
        <td class="${cls(s.p90)} mono">${fmt(s.p90, m.unit)}</td>
        <td class="${cls(s.p99)} mono">${fmt(s.p99, m.unit)}</td>
        <td class="dim mono">${fmt(s.min, m.unit)}</td>
        <td class="dim mono">${fmt(s.max, m.unit)}</td>
        <td class="dim mono">${fmt(s.stddev, m.unit)}</td>
      </tr>`;
    }).join('');
    presetsHtml += `
      <section>
        <div class="preset-head">
          <div>
            <span class="pill">${escapeHtml(name)}</span>
            <span class="label">${escapeHtml(label)}</span>
          </div>
          <span class="dim mono" style="font-size:12px;">n = ${rs.length}</span>
        </div>
        <table>
          <thead><tr><th>Metric</th><th>p50</th><th>p75</th><th>p90</th><th>p99</th><th>min</th><th>max</th><th>σ</th></tr></thead>
          <tbody>${statsRows}</tbody>
        </table>
      </section>
    `;
  }

  // Weighted verdict
  let weightedHtml = '';
  if (trafficProfile) {
    const usedWeights: { preset: string; weight: number }[] = [];
    let totalWeight = 0;
    for (const [name] of byPreset) {
      const w = trafficProfile.weights[name];
      if (typeof w === 'number' && w > 0) {
        usedWeights.push({ preset: name, weight: w });
        totalWeight += w;
      }
    }
    if (usedWeights.length > 0) {
      const wmetrics = [
        { key: 'lcp' as const, label: 'LCP', good: 2500, poor: 4000, unit: 'ms' as const },
        { key: 'cls' as const, label: 'CLS', good: 0.1, poor: 0.25, unit: 'index' as const },
        { key: 'tbt' as const, label: 'TBT', good: 200, poor: 600, unit: 'ms' as const },
      ];
      const parts: string[] = [];
      for (const m of wmetrics) {
        let weightedSum = 0;
        let weightAccum = 0;
        for (const { preset, weight } of usedWeights) {
          const rs = byPreset.get(preset);
          if (!rs) continue;
          const vals = rs.map((r) => r.metrics?.[m.key]).filter((v): v is number => typeof v === 'number');
          const s = computeStats(vals);
          if (!s) continue;
          weightedSum += s.p75 * weight;
          weightAccum += weight;
        }
        if (weightAccum === 0) continue;
        const wp75 = weightedSum / weightAccum;
        const cls = tierClass(wp75, m);
        parts.push(`<span class="dim">${m.label}</span> <span class="${cls} mono">${fmt(wp75, m.unit)}</span>`);
      }
      const breakdown = usedWeights.map(({ preset, weight }) => `${Math.round((weight / totalWeight) * 100)}% ${preset}`).join(' + ');
      weightedHtml = `<section>
        <h2 style="color:var(--cyan)">Weighted verdict (${escapeHtml(trafficProfile.name)})</h2>
        <div style="display:flex;flex-wrap:wrap;gap:18px;font-size:14px;">${parts.join('')}</div>
        <div class="dim" style="font-size:12px;margin-top:8px;">profile: ${escapeHtml(breakdown)}</div>
      </section>`;
    }
  }

  // CrUX section
  let cruxHtml = '';
  if (cruxByFormFactor && (cruxByFormFactor.mobile || cruxByFormFactor.desktop)) {
    const cruxRow = (label: string, rec?: CruxRecord | null) => {
      if (!rec) return `<tr><td class="dim">${label}</td><td colspan="5" class="dim">no data</td></tr>`;
      const cell = (v: number | undefined, spec: { good: number; poor: number; unit: 'ms' | 'index' }) => {
        const klass = tierClass(v, spec);
        return `<td class="${klass} mono">${fmt(v, spec.unit)}</td>`;
      };
      return `<tr>
        <td>${label}</td>
        ${cell(rec.metrics.lcp?.p75, { good: 2500, poor: 4000, unit: 'ms' })}
        ${cell(rec.metrics.cls?.p75, { good: 0.1, poor: 0.25, unit: 'index' })}
        ${cell(rec.metrics.inp?.p75, { good: 200, poor: 500, unit: 'ms' })}
        ${cell(rec.metrics.fcp?.p75, { good: 1800, poor: 3000, unit: 'ms' })}
        ${cell(rec.metrics.ttfb?.p75, { good: 800, poor: 1800, unit: 'ms' })}
      </tr>`;
    };
    const period = cruxByFormFactor.mobile?.collectionPeriod ?? cruxByFormFactor.desktop?.collectionPeriod;
    cruxHtml = `<section>
      <h2>Real users (CrUX p75)</h2>
      <div class="sub">28-day field data from Chrome${period ? ` · ${escapeHtml(period)}` : ''}</div>
      <table style="margin-top:12px;">
        <thead><tr><th>Form factor</th><th>LCP</th><th>CLS</th><th>INP</th><th>FCP</th><th>TTFB</th></tr></thead>
        <tbody>
          ${cruxRow('mobile (PHONE)', cruxByFormFactor.mobile)}
          ${cruxRow('desktop', cruxByFormFactor.desktop)}
        </tbody>
      </table>
    </section>`;

    // Lab-vs-field gap
    const gapLines: string[] = [];
    for (const [factor, rec] of [['mobile', cruxByFormFactor.mobile], ['desktop', cruxByFormFactor.desktop]] as const) {
      if (!rec || !rec.metrics.lcp) continue;
      const labLcps: number[] = [];
      for (const [, runs] of byPreset) {
        const p = runs[0]?.preset;
        if (!p || p.formFactor !== factor) continue;
        for (const r of runs) if (typeof r.metrics?.lcp === 'number') labLcps.push(r.metrics.lcp);
      }
      const labStats = computeStats(labLcps);
      if (!labStats) continue;
      const fieldLcp = rec.metrics.lcp.p75;
      const ratio = labStats.p75 / fieldLcp;
      let verdictHtml: string;
      if (ratio >= 1.5) verdictHtml = `<span class="warn">lab is ${ratio.toFixed(1)}× more pessimistic</span>`;
      else if (ratio <= 0.67) verdictHtml = `<span class="poor">lab is ${(1 / ratio).toFixed(1)}× more optimistic than reality</span>`;
      else verdictHtml = `<span class="good">lab matches reality (within ±50%)</span>`;
      gapLines.push(`<div class="gap-line"><span class="dim">${factor}</span>  lab <strong class="mono">${fmt(labStats.p75, 'ms')}</strong> <span class="dim">vs field</span> <strong class="mono">${fmt(fieldLcp, 'ms')}</strong>  →  ${verdictHtml}</div>`);
    }
    if (gapLines.length > 0) {
      cruxHtml += `<section><h2>Lab vs field gap</h2>${gapLines.join('')}</section>`;
    }
  }

  // Why? per preset
  let opportunitiesHtml = '';
  for (const [name, rs] of byPreset) {
    const anyAudits = rs.some((r) => r.audits && r.audits.length > 0);
    if (!anyAudits) continue;
    const diag = diagnosePreset(url, name, rs, rs[0].preset.label, rs[0].preset.formFactor);
    const ops = rankOpportunities(diag, 6);
    if (ops.length === 0 && !diag.lcpElement) continue;
    const opsRows = ops.map((o) => {
      const f = formatAggregatedAudit(o);
      const top = f.topItems[0];
      return `<tr>
        <td>${escapeHtml(f.label)}</td>
        <td class="warn mono">${escapeHtml(f.savings || f.display || '—')}</td>
        <td class="dim mono" style="word-break:break-all;">${top ? `${escapeHtml(top.label)}${top.detail ? ` <span class="dim">(${escapeHtml(top.detail)})</span>` : ''}` : '—'}</td>
      </tr>`;
    }).join('');
    let elementHtml = '';
    if (diag.lcpElement) {
      const head = diag.lcpElement.nodeLabel ?? diag.lcpElement.selector ?? '(unknown)';
      const snippet = (diag.lcpElement.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
      elementHtml = `<div class="lcp-element">
        <div class="label">LCP element: ${escapeHtml(head)}</div>
        ${snippet ? `<div class="snippet">${escapeHtml(snippet)}</div>` : ''}
      </div>`;
    }
    let phasesHtml = '';
    if (diag.lcpPhases && diag.lcpPhases.length > 0) {
      const items = diag.lcpPhases.map((p) => {
        const pct = parseInt(p.percent, 10);
        const klass = pct >= 40 ? 'poor' : pct >= 25 ? 'warn' : 'dim';
        const ms = p.medianMs >= 1000 ? `${(p.medianMs / 1000).toFixed(1)}s` : `${Math.round(p.medianMs)}ms`;
        return `<span class="${klass} mono">${escapeHtml(p.phase)} ${escapeHtml(p.percent)} (${ms})</span>`;
      }).join('');
      phasesHtml = `<div class="phases"><span class="dim">LCP phases:</span>${items}</div>`;
    }
    opportunitiesHtml += `<section>
      <h2>Why ${escapeHtml(name)}?</h2>
      ${elementHtml}
      ${phasesHtml}
      ${opsRows ? `<table>
        <thead><tr><th>Opportunity</th><th>Impact</th><th>Top item</th></tr></thead>
        <tbody>${opsRows}</tbody>
      </table>` : ''}
    </section>`;
  }

  // Reasoning section
  let reasoningHtml = '';
  if (reasoning && reasoning.text) {
    const meta = [reasoning.backend, reasoning.model, reasoning.durationMs ? `${(reasoning.durationMs / 1000).toFixed(1)}s` : ''].filter(Boolean).join(' · ');
    reasoningHtml = `<section>
      <h2 style="color:var(--cyan)">Reasoning ${meta ? `<span class="dim" style="font-weight:400;font-size:12px;">· ${escapeHtml(meta)}</span>` : ''}</h2>
      <div class="reasoning">${escapeHtml(reasoning.text)}</div>
    </section>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>psi-swarm report · ${escapeHtml(url)}</title>
<meta name="psi-url" content="${escapeHtml(url)}">
<meta name="psi-generated" content="${escapeHtml(generated)}">
<style>${CSS}</style>
</head>
<body>
<main>
  ${headerHtml}
  ${presetsHtml}
  ${weightedHtml}
  ${cruxHtml}
  ${opportunitiesHtml}
  ${reasoningHtml}
  <div class="footer">Generated by <a href="https://github.com/sarthakagrawal927/psi-swarm" style="color:var(--cyan);">psi-swarm</a> · lab data is emulated network + CPU · for honest p99 use a RUM tool</div>
</main>
</body>
</html>`;
}
