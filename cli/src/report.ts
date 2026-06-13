import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';
import type { RunResult } from './runner.js';
import { computeStats, type Stats } from './stats.js';
import { diagnosePreset, rankOpportunities, formatAggregatedAudit, type Diagnosis } from './diagnose.js';
import type { CruxRecord } from './crux.js';
import type { DomainRatingResult } from './ahrefs.js';
import type { TraceInsightRecord } from './trace-insight.js';

type MetricKey =
  | 'lcp'
  | 'inp'
  | 'cls'
  | 'tbt'
  | 'fcp'
  | 'ttfb'
  | 'si'
  | 'performance_score';

interface MetricSpec {
  key: MetricKey;
  label: string;
  unit: 'ms' | 'score' | 'index';
  good?: number;
  poor?: number;
  higherIsBetter?: boolean;
}

const METRICS: MetricSpec[] = [
  {
    key: 'performance_score',
    label: 'Perf Score',
    unit: 'score',
    good: 90,
    poor: 50,
    higherIsBetter: true,
  },
  { key: 'lcp', label: 'LCP', unit: 'ms', good: 2500, poor: 4000 },
  { key: 'inp', label: 'INP', unit: 'ms', good: 200, poor: 500 },
  { key: 'cls', label: 'CLS', unit: 'index', good: 0.1, poor: 0.25 },
  { key: 'tbt', label: 'TBT', unit: 'ms', good: 200, poor: 600 },
  { key: 'fcp', label: 'FCP', unit: 'ms', good: 1800, poor: 3000 },
  { key: 'ttfb', label: 'TTFB', unit: 'ms', good: 800, poor: 1800 },
  { key: 'si', label: 'SI', unit: 'ms', good: 3400, poor: 5800 },
];

function fmt(v: number, unit: MetricSpec['unit']): string {
  if (!Number.isFinite(v)) return '—';
  if (unit === 'ms') {
    if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
    return `${Math.round(v)}ms`;
  }
  if (unit === 'index') return v.toFixed(3);
  return v.toFixed(0);
}

function color(v: number, spec: MetricSpec): (s: string) => string {
  if (!Number.isFinite(v)) return chalk.dim;
  const good = spec.good ?? 0;
  const poor = spec.poor ?? Infinity;
  if (spec.higherIsBetter) {
    if (v >= good) return chalk.green;
    if (v >= (poor + good) / 2) return chalk.yellow;
    return chalk.red;
  }
  if (v <= good) return chalk.green;
  if (v <= poor) return chalk.yellow;
  return chalk.red;
}

type ColumnsByMetric = Record<string, Stats | null>;

function statsByMetric(results: RunResult[]): ColumnsByMetric {
  const out: ColumnsByMetric = {};
  for (const m of METRICS) {
    const vals = results
      .map((r) => r.metrics?.[m.key])
      .filter((v): v is number => typeof v === 'number');
    out[m.key] = computeStats(vals);
  }
  return out;
}

function presetTable(label: string, stats: ColumnsByMetric): string {
  const table = new Table({
    head: [
      chalk.bold('Metric'),
      chalk.bold('p50'),
      chalk.bold('p75'),
      chalk.bold('p90'),
      chalk.bold('p99'),
      chalk.bold('min'),
      chalk.bold('max'),
      chalk.bold('σ'),
    ],
    style: { head: [], border: ['gray'] },
  });
  for (const m of METRICS) {
    const s = stats[m.key];
    // Skip rows with no data — typical for INP in lab mode.
    if (!s) continue;
    const c = (v: number) => color(v, m)(fmt(v, m.unit));
    table.push([
      chalk.bold(m.label),
      c(s.p50),
      c(s.p75),
      c(s.p90),
      c(s.p99),
      chalk.dim(fmt(s.min, m.unit)),
      chalk.dim(fmt(s.max, m.unit)),
      chalk.dim(fmt(s.stddev, m.unit)),
    ]);
  }
  return chalk.cyan.bold(label) + '\n' + table.toString();
}

function sparkline(values: number[], width = 32): string {
  if (values.length === 0) return '';
  const chars = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const bucketSize = Math.max(1, Math.floor(values.length / width));
  const buckets: number[] = [];
  for (let i = 0; i < values.length; i += bucketSize) {
    const slice = values.slice(i, i + bucketSize);
    buckets.push(slice.reduce((s, v) => s + v, 0) / slice.length);
  }
  return buckets
    .map((v) => {
      const idx = Math.min(
        chars.length - 1,
        Math.floor(((v - min) / range) * (chars.length - 1)),
      );
      return chars[idx];
    })
    .join('');
}

function distributionStrip(results: RunResult[]): string {
  const lcps = results
    .map((r) => r.metrics?.lcp)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  if (lcps.length === 0) return '';
  return (
    chalk.dim('LCP shape: ') +
    chalk.cyan(sparkline(lcps, 32)) +
    chalk.dim(`  ${fmt(lcps[0], 'ms')} → ${fmt(lcps[lcps.length - 1], 'ms')}`)
  );
}

function overallVerdict(allResults: RunResult[]): string {
  const lcps = allResults
    .map((r) => r.metrics?.lcp)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  if (lcps.length === 0) return '';
  const p75 = lcps[Math.floor(0.75 * (lcps.length - 1))];
  const verdict =
    p75 <= 2500
      ? chalk.green('GOOD')
      : p75 <= 4000
      ? chalk.yellow('NEEDS WORK')
      : chalk.red('POOR');
  return (
    chalk.dim('CWV LCP gate (p75 ≤ 2.5s): ') +
    verdict +
    chalk.dim(`  observed p75 = ${fmt(p75, 'ms')}`)
  );
}

export interface RenderOptions {
  cruxByFormFactor?: {
    mobile?: CruxRecord | null;
    desktop?: CruxRecord | null;
  };
  trafficProfile?: { name: string; weights: Record<string, number> };
  domainRating?: DomainRatingResult | null;
  traceInsights?: TraceInsightRecord[];
}

export function renderSwarmReport(
  url: string,
  results: RunResult[],
  elapsedMs: number,
  renderOpts: RenderOptions = {},
): string {
  const okResults = results.filter((r) => !r.error);
  const errors = results.length - okResults.length;
  const byPreset = new Map<string, RunResult[]>();
  for (const r of okResults) {
    const arr = byPreset.get(r.preset.name) ?? [];
    arr.push(r);
    byPreset.set(r.preset.name, arr);
  }

  const headerLines: string[] = [
    chalk.bold('psi-swarm report'),
    '',
    chalk.dim('URL:      ') + url,
    chalk.dim('Runs:     ') +
      `${results.length} (${chalk.green(`${okResults.length} ok`)}${
        errors ? ', ' + chalk.red(`${errors} failed`) : ''
      })`,
    chalk.dim('Presets:  ') + Array.from(byPreset.keys()).join(', '),
    chalk.dim('Elapsed:  ') + `${(elapsedMs / 1000).toFixed(1)}s`,
  ];

  const sections: string[] = [
    boxen(headerLines.join('\n'), {
      padding: 1,
      borderStyle: 'round',
      borderColor: 'cyan',
    }),
  ];

  for (const [presetName, rs] of byPreset) {
    const label = rs[0].preset.label;
    const stats = statsByMetric(rs);
    sections.push(
      presetTable(`${presetName}  ·  ${label}  ·  n=${rs.length}`, stats),
    );
    const strip = distributionStrip(rs);
    if (strip) sections.push(strip);
  }

  const verdict = overallVerdict(okResults);
  if (verdict) sections.push(verdict);

  // Traffic-weighted fleet verdict across presets.
  if (renderOpts.trafficProfile) {
    const weighted = renderWeightedVerdict(byPreset, renderOpts.trafficProfile);
    if (weighted) sections.push(weighted);
  }

  // CrUX field data — real-user p75 alongside our lab numbers.
  const cruxSection = renderCrux(renderOpts.cruxByFormFactor);
  if (cruxSection) sections.push(cruxSection);

  const drSection = renderDomainRating(renderOpts.domainRating);
  if (drSection) sections.push(drSection);

  // Lab-vs-field gap analysis when both are available.
  const gapSection = renderLabFieldGap(byPreset, renderOpts.cruxByFormFactor);
  if (gapSection) sections.push(gapSection);

  // "Why?" — surface Lighthouse opportunities + LCP element if audits were captured.
  for (const [presetName, rs] of byPreset) {
    const anyAudits = rs.some((r) => (r as { audits?: unknown[] }).audits?.length);
    if (!anyAudits) continue;
    const diag = diagnosePreset(url, presetName, rs as never, rs[0].preset.label, rs[0].preset.formFactor);
    sections.push(renderOpportunities(diag));
  }

  if (renderOpts.traceInsights && renderOpts.traceInsights.length > 0) {
    sections.push(renderTraceInsights(renderOpts.traceInsights));
  }

  sections.push(
    chalk.dim(
      [
        '',
        'Notes:',
        '  • LAB data (emulated network + CPU). Real-user p99 is dominated by device/network',
        '    variance you cannot reproduce locally — use CrUX or a RUM tool for that.',
        '  • INP requires real user input and is not measured in navigation mode (row is hidden).',
        '  • Thresholds = Core Web Vitals "good"/"needs improvement"/"poor" bands.',
      ].join('\n'),
    ),
  );

  return sections.join('\n\n');
}

function renderWeightedVerdict(
  byPreset: Map<string, RunResult[]>,
  profile: { name: string; weights: Record<string, number> },
): string {
  // Compute per-preset p75 for the CWV metrics, weight them, render one summary line.
  const metricSpecs: { key: keyof NonNullable<RunResult['metrics']>; label: string; unit: 'ms' | 'index'; good: number; poor: number }[] = [
    { key: 'lcp', label: 'LCP', unit: 'ms', good: 2500, poor: 4000 },
    { key: 'cls', label: 'CLS', unit: 'index', good: 0.1, poor: 0.25 },
    { key: 'tbt', label: 'TBT', unit: 'ms', good: 200, poor: 600 },
  ];
  const usedWeights: { preset: string; weight: number }[] = [];
  let totalWeight = 0;
  for (const [name] of byPreset) {
    const w = profile.weights[name];
    if (typeof w === 'number' && w > 0) {
      usedWeights.push({ preset: name, weight: w });
      totalWeight += w;
    }
  }
  if (usedWeights.length === 0) return '';
  const parts: string[] = [];
  for (const m of metricSpecs) {
    let weightedSum = 0;
    let weightAccum = 0;
    for (const { preset, weight } of usedWeights) {
      const rs = byPreset.get(preset);
      if (!rs) continue;
      const vals = rs.map((r) => r.metrics?.[m.key]).filter((v): v is number => typeof v === 'number');
      const stats = computeStats(vals);
      if (!stats) continue;
      weightedSum += stats.p75 * weight;
      weightAccum += weight;
    }
    if (weightAccum === 0) continue;
    const wp75 = weightedSum / weightAccum;
    const color = wp75 <= m.good ? chalk.green : wp75 <= m.poor ? chalk.yellow : chalk.red;
    const display = m.unit === 'ms' ? (wp75 >= 1000 ? `${(wp75 / 1000).toFixed(2)}s` : `${Math.round(wp75)}ms`) : wp75.toFixed(3);
    parts.push(`${chalk.dim(m.label)} ${color(display)}`);
  }
  const breakdown = usedWeights
    .map(({ preset, weight }) => `${Math.round((weight / totalWeight) * 100)}% ${preset}`)
    .join(' + ');
  return (
    chalk.cyan.bold(`Weighted verdict (${profile.name})`) +
    chalk.dim('  · ') +
    parts.join(chalk.dim('  ·  ')) +
    '\n' +
    chalk.dim(`  profile: ${breakdown}`)
  );
}

function renderLabFieldGap(
  byPreset: Map<string, RunResult[]>,
  cruxByFormFactor?: { mobile?: CruxRecord | null; desktop?: CruxRecord | null },
): string {
  if (!cruxByFormFactor) return '';
  const factors: { factor: 'mobile' | 'desktop'; rec?: CruxRecord | null }[] = [
    { factor: 'mobile', rec: cruxByFormFactor.mobile },
    { factor: 'desktop', rec: cruxByFormFactor.desktop },
  ];
  const lines: string[] = [];
  for (const { factor, rec } of factors) {
    if (!rec) continue;
    // Aggregate lab LCP values across all presets matching this form factor.
    const labLcps: number[] = [];
    for (const [, runs] of byPreset) {
      const p = runs[0]?.preset;
      if (!p) continue;
      if (p.formFactor !== factor) continue;
      for (const r of runs) {
        if (typeof r.metrics?.lcp === 'number') labLcps.push(r.metrics.lcp);
      }
    }
    if (labLcps.length === 0) continue;
    const labStats = computeStats(labLcps);
    if (!labStats) continue;
    const fieldLcp = rec.metrics.lcp?.p75;
    if (typeof fieldLcp !== 'number') continue;
    const ratio = labStats.p75 / fieldLcp;
    let verdict: string;
    if (ratio >= 1.5) {
      verdict = chalk.yellow(`lab is ${ratio.toFixed(1)}× more pessimistic`);
    } else if (ratio <= 0.67) {
      verdict = chalk.red(`lab is ${(1 / ratio).toFixed(1)}× more optimistic than reality`);
    } else {
      verdict = chalk.green('lab matches reality (within ±50%)');
    }
    const lab = labStats.p75 >= 1000 ? `${(labStats.p75 / 1000).toFixed(2)}s` : `${Math.round(labStats.p75)}ms`;
    const field = fieldLcp >= 1000 ? `${(fieldLcp / 1000).toFixed(2)}s` : `${Math.round(fieldLcp)}ms`;
    lines.push(
      chalk.dim(`  ${factor.padEnd(7)} LCP — lab `) +
        chalk.bold(lab) +
        chalk.dim(' vs field ') +
        chalk.bold(field) +
        chalk.dim('  →  ') +
        verdict,
    );
  }
  if (lines.length === 0) return '';
  return chalk.cyan.bold('Lab vs field gap') + '\n' + lines.join('\n');
}

function renderCrux(
  byFormFactor?: { mobile?: CruxRecord | null; desktop?: CruxRecord | null },
): string {
  if (!byFormFactor) return '';
  const have = (byFormFactor.mobile ?? undefined) || (byFormFactor.desktop ?? undefined);
  if (!have) return '';
  const lines: string[] = [];
  lines.push(chalk.cyan.bold('Real users (CrUX p75)') + chalk.dim('  · 28-day field data from Chrome'));
  const t = new Table({
    head: [
      chalk.bold('Form factor'),
      chalk.bold('LCP'),
      chalk.bold('CLS'),
      chalk.bold('INP'),
      chalk.bold('FCP'),
      chalk.bold('TTFB'),
    ],
    style: { head: [], border: ['gray'] },
  });
  const formatMetric = (kind: 'ms' | 'index', spec: { good: number; poor: number }, v?: number): string => {
    if (v === undefined) return chalk.dim('—');
    const val = kind === 'ms' ? (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`) : v.toFixed(3);
    const color = v <= spec.good ? chalk.green : v <= spec.poor ? chalk.yellow : chalk.red;
    return color(val);
  };
  const row = (label: string, rec?: CruxRecord | null) => {
    if (!rec) {
      t.push([chalk.dim(label), '—', '—', '—', '—', '—']);
      return;
    }
    t.push([
      label,
      formatMetric('ms', { good: 2500, poor: 4000 }, rec.metrics.lcp?.p75),
      formatMetric('index', { good: 0.1, poor: 0.25 }, rec.metrics.cls?.p75),
      formatMetric('ms', { good: 200, poor: 500 }, rec.metrics.inp?.p75),
      formatMetric('ms', { good: 1800, poor: 3000 }, rec.metrics.fcp?.p75),
      formatMetric('ms', { good: 800, poor: 1800 }, rec.metrics.ttfb?.p75),
    ]);
  };
  row('mobile (PHONE)', byFormFactor.mobile);
  row('desktop', byFormFactor.desktop);
  lines.push(t.toString());
  // Pick whichever record has a collectionPeriod for the dim hint.
  const period = byFormFactor.mobile?.collectionPeriod ?? byFormFactor.desktop?.collectionPeriod;
  const source = (byFormFactor.mobile ?? byFormFactor.desktop)?.source === 'url' ? 'URL-specific' : 'origin-aggregate';
  if (period) {
    lines.push(chalk.dim(`  · ${source} · ${period}`));
  }
  return lines.join('\n');
}

function renderDomainRating(rec?: DomainRatingResult | null): string {
  if (!rec) return '';
  const color =
    rec.rating >= 40 ? chalk.green : rec.rating >= 10 ? chalk.yellow : chalk.dim;
  return (
    chalk.cyan.bold('Domain authority (Ahrefs DR)') +
    chalk.dim('  · free public endpoint\n') +
    chalk.dim('  domain: ') +
    rec.domain +
    chalk.dim('  ·  DR: ') +
    color.bold(rec.rating.toFixed(1))
  );
}

function renderTraceInsights(insights: TraceInsightRecord[]): string {
  const lines: string[] = [];
  lines.push(chalk.cyan.bold('Trace insight') + chalk.dim('  · derived diagnosis beside percentile history'));
  for (const i of insights) {
    lines.push(chalk.bold(`  ${i.preset}`) + chalk.dim(` (${i.adapter})`));
    lines.push(chalk.dim('    ') + i.summary);
    if (i.comparisonNotes) lines.push(chalk.yellow('    ' + i.comparisonNotes));
    if (i.opportunities.length > 0) {
      lines.push(chalk.dim('    opportunities: ') + i.opportunities.slice(0, 3).join(chalk.dim(' · ')));
    }
  }
  return lines.join('\n');
}

function renderOpportunities(d: Diagnosis): string {
  const lines: string[] = [];
  lines.push(chalk.cyan.bold(`Why ${d.preset}?`) + chalk.dim(`  (n=${d.okRuns})`));
  if (d.lcpElement) {
    const el = d.lcpElement;
    const head = el.nodeLabel ?? el.selector ?? '';
    const snippet = (el.snippet ?? '').replace(/\s+/g, ' ').trim();
    lines.push(chalk.dim('LCP element: ') + chalk.yellow(head || '(unknown)'));
    if (snippet) {
      const trimmed = snippet.length > 130 ? snippet.slice(0, 127) + '...' : snippet;
      lines.push(chalk.dim('             ') + chalk.gray(trimmed));
    }
  }
  if (d.lcpPhases && d.lcpPhases.length > 0) {
    const phaseStr = d.lcpPhases
      .map((p) => {
        const colorize = parseInt(p.percent, 10) >= 40 ? chalk.red : parseInt(p.percent, 10) >= 25 ? chalk.yellow : chalk.dim;
        const ms = p.medianMs >= 1000 ? `${(p.medianMs / 1000).toFixed(1)}s` : `${Math.round(p.medianMs)}ms`;
        return colorize(`${p.phase} ${p.percent} (${ms})`);
      })
      .join(chalk.dim('  ·  '));
    lines.push(chalk.dim('LCP phases : ') + phaseStr);
  }
  const ops = rankOpportunities(d, 8);
  if (ops.length === 0) {
    lines.push(chalk.dim('No actionable opportunities — Lighthouse marked all captured audits as passing.'));
    return lines.join('\n');
  }
  const t = new Table({
    head: [chalk.bold('Opportunity'), chalk.bold('Impact'), chalk.bold('Affects'), chalk.bold('Top item')],
    style: { head: [], border: ['gray'] },
    colWidths: [38, 18, 14, 50],
    wordWrap: true,
  });
  for (const o of ops) {
    const f = formatAggregatedAudit(o);
    const topItem = f.topItems[0];
    const itemCell = topItem
      ? chalk.dim(topItem.label) + (topItem.detail ? chalk.gray(`  (${topItem.detail})`) : '')
      : chalk.dim('—');
    t.push([f.label, f.savings || f.display || '—', f.affects, itemCell]);
  }
  lines.push(t.toString());
  if (d.consistencyNotes.length > 0) {
    for (const n of d.consistencyNotes) lines.push(chalk.dim(`  · ${n}`));
  }
  return lines.join('\n');
}
