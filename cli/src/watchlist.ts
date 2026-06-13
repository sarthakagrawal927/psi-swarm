import type { HistoryDB, RunRow, WatchlistEntry } from './db.js';

export type WatchStatus = 'regressed' | 'improved' | 'stable' | 'stale' | 'missing';

export interface WatchlistQueueItem {
  url: string;
  label?: string;
  preset: string;
  status: WatchStatus;
  baselineTag?: string;
  latestRunAt?: number;
  baselineRunAt?: number;
  metrics: {
    metric: 'lcp' | 'performance_score';
    baseline?: number;
    latest?: number;
    delta?: number;
    deltaPct?: number;
  }[];
  message: string;
}

const DEFAULT_LCP_REGRESSION_MS = 200;
const DEFAULT_LCP_REGRESSION_PCT = 10;
const DEFAULT_SCORE_REGRESSION = 5;

function percentile(values: number[], pct: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function p75(rows: RunRow[]): { lcp?: number; score?: number } {
  const lcps = rows.map((r) => r.lcp).filter((v): v is number => typeof v === 'number');
  const scores = rows.map((r) => r.performance_score).filter((v): v is number => typeof v === 'number');
  return {
    lcp: percentile(lcps, 75),
    score: percentile(scores, 75),
  };
}

function latestRuns(db: HistoryDB, url: string, preset: string): RunRow[] {
  const rows = db.recentRuns(url, preset, 50);
  if (rows.length === 0) return [];
  const latestTag = rows[0].tag ?? undefined;
  const latestStarted = rows[0].started_at;
  return rows.filter((r) => (r.tag ?? undefined) === latestTag && r.started_at === latestStarted);
}

function baselineRuns(db: HistoryDB, url: string, preset: string, baselineTag?: string): RunRow[] {
  if (baselineTag) return db.runsByTag(url, baselineTag).filter((r) => r.preset === preset && !r.error);
  const rows = db.recentRuns(url, preset, 200).filter((r) => !r.error);
  if (rows.length < 2) return [];
  const latest = rows[0];
  const older = rows.find((r) => (r.tag ?? '') !== (latest.tag ?? '') || r.started_at !== latest.started_at);
  if (!older) return [];
  const tag = older.tag ?? undefined;
  const started = older.started_at;
  return rows.filter((r) => (r.tag ?? undefined) === tag && r.started_at === started && r.preset === preset);
}

function classifyDelta(
  metric: 'lcp' | 'performance_score',
  baseline?: number,
  latest?: number,
  thresholds?: { lcpMs?: number; lcpPct?: number; score?: number },
): { delta?: number; deltaPct?: number; direction: 'regressed' | 'improved' | 'stable' } {
  if (baseline === undefined || latest === undefined || !Number.isFinite(baseline) || !Number.isFinite(latest)) {
    return { direction: 'stable' };
  }
  const delta = latest - baseline;
  const deltaPct = baseline === 0 ? 0 : (delta / baseline) * 100;
  if (metric === 'lcp') {
    const ms = thresholds?.lcpMs ?? DEFAULT_LCP_REGRESSION_MS;
    const pct = thresholds?.lcpPct ?? DEFAULT_LCP_REGRESSION_PCT;
    if (delta >= ms || deltaPct >= pct) return { delta, deltaPct, direction: 'regressed' };
    if (delta <= -ms || deltaPct <= -pct) return { delta, deltaPct, direction: 'improved' };
    return { delta, deltaPct, direction: 'stable' };
  }
  const score = thresholds?.score ?? DEFAULT_SCORE_REGRESSION;
  if (delta <= -score) return { delta, deltaPct, direction: 'regressed' };
  if (delta >= score) return { delta, deltaPct, direction: 'improved' };
  return { delta, deltaPct, direction: 'stable' };
}

export function evaluateWatchlist(db: HistoryDB, refreshedAt = Date.now()): WatchlistQueueItem[] {
  const entries = db.listWatchlist();
  const queue: WatchlistQueueItem[] = [];

  for (const entry of entries) {
    const preset = entry.preset || 'mobile-mid';
    const latest = latestRuns(db, entry.url, preset);
    const staleDays = entry.stale_days ?? 7;
    const staleMs = staleDays * 24 * 60 * 60 * 1000;

    if (latest.length === 0) {
      queue.push({
        url: entry.url,
        label: entry.label ?? undefined,
        preset,
        status: 'missing',
        baselineTag: entry.baseline_tag ?? undefined,
        metrics: [],
        message: 'No runs yet for this preset',
      });
      continue;
    }

    const latestAt = latest[0]?.started_at;
    if (latestAt && refreshedAt - latestAt > staleMs) {
      queue.push({
        url: entry.url,
        label: entry.label ?? undefined,
        preset,
        status: 'stale',
        baselineTag: entry.baseline_tag ?? undefined,
        latestRunAt: latestAt,
        metrics: [],
        message: `Last run is older than ${staleDays} days`,
      });
      continue;
    }

    const baseline = baselineRuns(db, entry.url, preset, entry.baseline_tag ?? undefined);
    const latestStats = p75(latest);
    const baselineStats = p75(baseline);

    const lcp = classifyDelta('lcp', baselineStats.lcp, latestStats.lcp, {
      lcpMs: entry.lcp_threshold_ms ?? undefined,
    });
    const score = classifyDelta('performance_score', baselineStats.score, latestStats.score, {
      score: entry.score_threshold ?? undefined,
    });

    let status: WatchStatus = 'stable';
    if (lcp.direction === 'regressed' || score.direction === 'regressed') {
      status = 'regressed';
    } else if (lcp.direction === 'improved' || score.direction === 'improved') {
      status = 'improved';
    }

    const parts: string[] = [];
    if (lcp.delta !== undefined) {
      const sign = lcp.delta > 0 ? '+' : '';
      parts.push(`LCP ${sign}${Math.round(lcp.delta)}ms`);
    }
    if (score.delta !== undefined) {
      const sign = score.delta > 0 ? '+' : '';
      parts.push(`score ${sign}${score.delta.toFixed(0)}`);
    }

    queue.push({
      url: entry.url,
      label: entry.label ?? undefined,
      preset,
      status,
      baselineTag: entry.baseline_tag ?? undefined,
      latestRunAt: latestAt,
      baselineRunAt: baseline[0]?.started_at,
      metrics: [
        {
          metric: 'lcp',
          baseline: baselineStats.lcp,
          latest: latestStats.lcp,
          delta: lcp.delta,
          deltaPct: lcp.deltaPct,
        },
        {
          metric: 'performance_score',
          baseline: baselineStats.score,
          latest: latestStats.score,
          delta: score.delta,
          deltaPct: score.deltaPct,
        },
      ],
      message: parts.length > 0 ? parts.join(' · ') : 'Within default thresholds',
    });
  }

  const rank: Record<WatchStatus, number> = {
    missing: 0,
    stale: 1,
    regressed: 2,
    improved: 3,
    stable: 4,
  };
  queue.sort((a, b) => {
    const byStatus = rank[a.status] - rank[b.status];
    if (byStatus !== 0) return byStatus;
    const aMag = Math.abs(a.metrics[0]?.delta ?? 0);
    const bMag = Math.abs(b.metrics[0]?.delta ?? 0);
    return bMag - aMag;
  });
  return queue;
}

export function summarizeWatchlist(queue: WatchlistQueueItem[]): {
  regressed: number;
  improved: number;
  stale: number;
  missing: number;
  stable: number;
} {
  return {
    regressed: queue.filter((q) => q.status === 'regressed').length,
    improved: queue.filter((q) => q.status === 'improved').length,
    stale: queue.filter((q) => q.status === 'stale').length,
    missing: queue.filter((q) => q.status === 'missing').length,
    stable: queue.filter((q) => q.status === 'stable').length,
  };
}

export type { WatchlistEntry };
