import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { RunResultWithArtifact } from './runner.js';
import { diagnosePreset, rankOpportunities, formatAggregatedAudit } from './diagnose.js';
import { computeStats } from './stats.js';
import type { HistoryDB } from './db.js';

export interface TraceInsightRecord {
  runId: number;
  url: string;
  preset: string;
  bottleneckPhase?: string;
  summary: string;
  opportunities: string[];
  comparisonNotes?: string;
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

function buildComparisonNotes(
  results: RunResultWithArtifact[],
  baselineResults?: RunResultWithArtifact[],
): string | undefined {
  if (!baselineResults || baselineResults.length === 0) return undefined;
  const curLcp = computeStats(results.map((r) => r.metrics?.lcp).filter((v): v is number => typeof v === 'number'));
  const baseLcp = computeStats(
    baselineResults.map((r) => r.metrics?.lcp).filter((v): v is number => typeof v === 'number'),
  );
  if (!curLcp || !baseLcp) return undefined;
  const delta = curLcp.p75 - baseLcp.p75;
  const pct = baseLcp.p75 === 0 ? 0 : (delta / baseLcp.p75) * 100;
  const sign = delta > 0 ? '+' : '';
  const direction = delta > 200 || pct > 10 ? 'regressed' : delta < -200 || pct < -10 ? 'improved' : 'stable';
  return `LCP p75 ${direction}: ${sign}${Math.round(delta)}ms (${sign}${pct.toFixed(1)}%) vs baseline tag`;
}

/** Deterministic local adapter — no network, uses captured Lighthouse audits. */
export const builtinTraceInsightAdapter: TraceInsightAdapter = {
  name: 'builtin',
  async diagnose({ url, preset, results, artifactPath, baselineResults }) {
    const ok = results.filter((r) => !r.error);
    const diag = diagnosePreset(url, preset, ok, ok[0]?.preset.label, ok[0]?.preset.formFactor);
    const ops = rankOpportunities(diag, 5).map((o) => {
      const f = formatAggregatedAudit(o);
      return f.savings ? `${f.label} (${f.savings})` : f.label;
    });
    const bottleneckPhase = dominantPhase(ok);
    const lcpStats = computeStats(ok.map((r) => r.metrics?.lcp).filter((v): v is number => typeof v === 'number'));
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
  },
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

export async function deriveTraceInsights(
  db: HistoryDB,
  url: string,
  results: RunResultWithArtifact[],
  opts: {
    tag?: string;
    artifactPaths?: Map<string, string>;
    baselineTag?: string;
    adapter?: TraceInsightAdapter;
  } = {},
): Promise<TraceInsightRecord[]> {
  const adapter = opts.adapter ?? (await resolveTraceInsightAdapter());
  const byPreset = new Map<string, RunResultWithArtifact[]>();
  for (const r of results) {
    if (r.error) continue;
    const arr = byPreset.get(r.preset.name) ?? [];
    arr.push(r);
    byPreset.set(r.preset.name, arr);
  }

  let baselineByPreset = new Map<string, RunResultWithArtifact[]>();
  if (opts.baselineTag) {
    const baseRows = db.runsByTag(url, opts.baselineTag);
    for (const row of baseRows) {
      const fake: RunResultWithArtifact = {
        preset: {
          name: row.preset,
          label: row.preset,
          formFactor: row.preset.includes('desktop') ? 'desktop' : 'mobile',
          throttling: {} as never,
          screenEmulation: {} as never,
        },
        startedAt: row.started_at,
        finishedAt: row.finished_at ?? row.started_at,
        metrics: {
          lcp: row.lcp ?? undefined,
          cls: row.cls ?? undefined,
          inp: row.inp ?? undefined,
          tbt: row.tbt ?? undefined,
          fcp: row.fcp ?? undefined,
          ttfb: row.ttfb ?? undefined,
          si: row.si ?? undefined,
          performance_score: row.performance_score ?? undefined,
        },
      };
      const arr = baselineByPreset.get(row.preset) ?? [];
      arr.push(fake);
      baselineByPreset.set(row.preset, arr);
    }
  }

  const out: TraceInsightRecord[] = [];
  for (const [preset, rs] of byPreset) {
    const runIds = db.recentRunIds(url, preset, 1);
    const runId = runIds[0];
    if (!runId) continue;
    const insight = await adapter.diagnose({
      url,
      preset,
      results: rs,
      artifactPath: opts.artifactPaths?.get(preset),
      baselineResults: baselineByPreset.get(preset),
    });
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
      adapter: insight.adapter,
      artifactPath: insight.artifactPath,
      createdAt: Date.now(),
    });
  }
  return out;
}

export function formatTraceInsightBlock(insights: TraceInsightRecord[]): string {
  if (insights.length === 0) return '';
  const lines: string[] = [];
  lines.push('Trace insight');
  for (const i of insights) {
    lines.push(`  ${i.preset}: ${i.summary}`);
    if (i.comparisonNotes) lines.push(`    ${i.comparisonNotes}`);
  }
  return lines.join('\n');
}
