import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { RunResultWithArtifact } from './runner.js';
import { diagnosePreset, rankOpportunities, formatAggregatedAudit } from './diagnose.js';
import { computeStats } from './stats.js';
import type { HistoryDB, RunRow } from './db.js';
import { measurementCompatibility, type MeasurementCompatibility } from './measurement-series.js';

export interface TraceInsightRecord {
  runId: number;
  url: string;
  preset: string;
  bottleneckPhase?: string;
  summary: string;
  opportunities: string[];
  comparisonNotes?: string;
  comparability?: MeasurementCompatibility;
  adapter: string;
  artifactPath?: string;
  createdAt: number;
}

export interface TraceInsightAdapter {
  name: string;
  diagnose(input: {
    url: string;
    preset: string;
    results: RunResultWithArtifact[];
    artifactPath?: string;
    baselineResults?: RunResultWithArtifact[];
  }): Promise<Omit<TraceInsightRecord, 'runId' | 'url' | 'preset' | 'createdAt'>>;
}

function dominantPhase(results: RunResultWithArtifact[]): string | undefined {
  const byPreset = results.filter((r) => !r.error && r.audits?.length);
  if (byPreset.length === 0) return undefined;
  const diag = diagnosePreset('', byPreset[0].preset.name, byPreset, byPreset[0].preset.label);
  if (!diag.lcpPhases || diag.lcpPhases.length === 0) return undefined;
  const sorted = [...diag.lcpPhases].sort((a, b) => b.medianMs - a.medianMs);
  return sorted[0]?.phase;
}

function lcpP75(results: RunResultWithArtifact[]): number | undefined {
  const stats = computeStats(
    results.map((r) => r.metrics?.lcp).filter((v): v is number => typeof v === 'number')
  );
  return stats?.p75;
}

function classifyLcpDelta(delta: number, pct: number): string {
  if (delta > 200 || pct > 10) return 'regressed';
  if (delta < -200 || pct < -10) return 'improved';
  return 'stable';
}

function buildComparisonNotes(
  results: RunResultWithArtifact[],
  baselineResults?: RunResultWithArtifact[]
): string | undefined {
  if (!baselineResults || baselineResults.length === 0) return undefined;
  const comparability = measurementCompatibility(
    baselineResults.filter((run) => !run.error).map((run) => run.provenance?.lighthouseVersion),
    results.filter((run) => !run.error).map((run) => run.provenance?.lighthouseVersion)
  );
  if (!comparability.comparable) return `Not comparable: ${comparability.message}`;
  const curP75 = lcpP75(results);
  const baseP75 = lcpP75(baselineResults);
  if (curP75 === undefined || baseP75 === undefined) return undefined;
  const delta = curP75 - baseP75;
  const pct = baseP75 === 0 ? 0 : (delta / baseP75) * 100;
  const sign = delta > 0 ? '+' : '';
  const direction = classifyLcpDelta(delta, pct);
  return `LCP p75 ${direction}: ${sign}${Math.round(delta)}ms (${sign}${pct.toFixed(1)}%) vs baseline tag`;
}

/** Deterministic local adapter — no network, uses captured Lighthouse audits. */
async function diagnoseBuiltin({
  url,
  preset,
  results,
  artifactPath,
  baselineResults,
}: {
  url: string;
  preset: string;
  results: RunResultWithArtifact[];
  artifactPath?: string;
  baselineResults?: RunResultWithArtifact[];
}): Promise<Omit<TraceInsightRecord, 'runId' | 'url' | 'preset' | 'createdAt'>> {
  const ok = results.filter((r) => !r.error);
  const diag = diagnosePreset(url, preset, ok, ok[0]?.preset.label, ok[0]?.preset.formFactor);
  const ops = rankOpportunities(diag, 5).map((o) => {
    const f = formatAggregatedAudit(o);
    return f.savings ? `${f.label} (${f.savings})` : f.label;
  });
  const bottleneckPhase = dominantPhase(ok);
  const lcpStats = computeStats(
    ok.map((r) => r.metrics?.lcp).filter((v): v is number => typeof v === 'number')
  );
  const parts: string[] = [];
  if (lcpStats) {
    parts.push(`LCP p75 ${Math.round(lcpStats.p75)}ms across ${ok.length} runs`);
  }
  if (bottleneckPhase) {
    parts.push(`dominant phase: ${bottleneckPhase}`);
  }
  if (ops.length > 0) {
    parts.push(`top opportunity: ${ops[0]}`);
  } else {
    parts.push('no failing audits captured');
  }
  return {
    bottleneckPhase,
    summary: parts.join(' · '),
    opportunities: ops,
    comparisonNotes: buildComparisonNotes(ok, baselineResults),
    adapter: 'builtin',
    artifactPath,
  };
}

const builtinTraceInsightAdapter: TraceInsightAdapter = {
  name: 'builtin',
  diagnose: diagnoseBuiltin,
};

const EXTERNAL_ADAPTER_PATH = join(homedir(), '.psi-swarm', 'adapters', 'trace-insight.mjs');

async function loadExternalAdapter(): Promise<TraceInsightAdapter | null> {
  const fromEnv = process.env.PSI_TRACE_INSIGHT_ADAPTER;
  const path = fromEnv ?? EXTERNAL_ADAPTER_PATH;
  if (!existsSync(path)) return null;
  try {
    const mod = await import(pathToFileURL(path).href);
    const adapter = (mod.default ?? mod.adapter) as TraceInsightAdapter | undefined;
    if (!adapter?.name || typeof adapter.diagnose !== 'function') return null;
    return adapter;
  } catch {
    return null;
  }
}

export async function resolveTraceInsightAdapter(): Promise<TraceInsightAdapter> {
  const external = await loadExternalAdapter();
  return external ?? builtinTraceInsightAdapter;
}

function groupByPreset(results: RunResultWithArtifact[]): Map<string, RunResultWithArtifact[]> {
  const byPreset = new Map<string, RunResultWithArtifact[]>();
  for (const r of results) {
    if (r.error) continue;
    const arr = byPreset.get(r.preset.name) ?? [];
    arr.push(r);
    byPreset.set(r.preset.name, arr);
  }
  return byPreset;
}

const METRIC_KEYS = ['lcp', 'cls', 'inp', 'tbt', 'fcp', 'ttfb', 'si', 'performance_score'] as const;

function metricsFromRow(row: RunRow): import('./runner.js').MetricSet {
  const metrics: Record<string, number | undefined> = {};
  for (const key of METRIC_KEYS) {
    metrics[key] = row[key] ?? undefined;
  }
  return metrics as import('./runner.js').MetricSet;
}

function rowToRunResult(row: RunRow): RunResultWithArtifact {
  return {
    preset: {
      name: row.preset,
      label: row.preset,
      formFactor: row.preset.includes('desktop') ? 'desktop' : 'mobile',
      throttling: {} as never,
      screenEmulation: {} as never,
    },
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? row.started_at,
    metrics: metricsFromRow(row),
    provenance: {
      schemaVersion: 1,
      lighthouseVersion: row.lighthouse_version ?? undefined,
      screenEmulation: {},
      throttling: {},
      observed: {},
    },
  };
}

function loadBaselineByPreset(
  db: HistoryDB,
  url: string,
  baselineTag?: string
): Map<string, RunResultWithArtifact[]> {
  const baselineByPreset = new Map<string, RunResultWithArtifact[]>();
  if (!baselineTag) return baselineByPreset;
  for (const row of db.runsByTag(url, baselineTag)) {
    if (row.error) continue;
    const arr = baselineByPreset.get(row.preset) ?? [];
    arr.push(rowToRunResult(row));
    baselineByPreset.set(row.preset, arr);
  }
  return baselineByPreset;
}

export async function deriveTraceInsights(
  db: HistoryDB,
  url: string,
  results: RunResultWithArtifact[],
  opts: {
    tag?: string;
    artifactPaths?: Map<string, string>;
    baselineTag?: string;
    adapter?: TraceInsightAdapter;
  } = {}
): Promise<TraceInsightRecord[]> {
  const adapter = opts.adapter ?? (await resolveTraceInsightAdapter());
  const byPreset = groupByPreset(results);
  const baselineByPreset = loadBaselineByPreset(db, url, opts.baselineTag);

  const out: TraceInsightRecord[] = [];
  for (const [preset, rs] of byPreset) {
    const runIds = db.recentRunIds(url, preset, 1);
    const runId = runIds[0];
    if (!runId) continue;
    const baselineResults = baselineByPreset.get(preset);
    const comparability = opts.baselineTag
      ? measurementCompatibility(
          (baselineResults ?? []).map((run) => run.provenance?.lighthouseVersion),
          rs.map((run) => run.provenance?.lighthouseVersion)
        )
      : undefined;
    const insight = await adapter.diagnose({
      url,
      preset,
      results: rs,
      artifactPath: opts.artifactPaths?.get(preset),
      baselineResults: comparability?.comparable ? baselineResults : undefined,
    });
    if (comparability && !comparability.comparable) {
      insight.comparisonNotes = `Not comparable: ${comparability.message}`;
    }
    insight.comparability = comparability;
    db.upsertRunInsight({
      runId,
      bottleneckPhase: insight.bottleneckPhase,
      summary: insight.summary,
      opportunities: insight.opportunities,
      comparisonNotes: insight.comparisonNotes,
      adapter: insight.adapter,
      artifactPath: insight.artifactPath,
    });
    out.push({
      runId,
      url,
      preset,
      bottleneckPhase: insight.bottleneckPhase,
      summary: insight.summary,
      opportunities: insight.opportunities,
      comparisonNotes: insight.comparisonNotes,
      comparability,
      adapter: insight.adapter,
      artifactPath: insight.artifactPath,
      createdAt: Date.now(),
    });
  }
  return out;
}
