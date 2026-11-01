import { useCallback, useEffect, useState } from 'react';
import {
  AgentClient,
  connectToAgent,
  type CompareResponse,
  type HealthResponse,
  type Stats,
} from '../lib/agent.js';

type Status = 'probing' | 'disconnected' | 'ready';

interface TagInfo {
  tag: string;
  count: number;
  last: number;
}

interface UrlInfo {
  url: string;
  count: number;
  last: number;
}

const METRIC_LABELS: Record<
  string,
  {
    label: string;
    unit: 'ms' | 'index' | 'score';
    higherIsBetter?: boolean;
    good?: number;
    poor?: number;
  }
> = {
  performance_score: {
    label: 'Perf Score',
    unit: 'score',
    higherIsBetter: true,
    good: 90,
    poor: 50,
  },
  lcp: { label: 'LCP', unit: 'ms', good: 2500, poor: 4000 },
  inp: { label: 'INP', unit: 'ms', good: 200, poor: 500 },
  cls: { label: 'CLS', unit: 'index', good: 0.1, poor: 0.25 },
  tbt: { label: 'TBT', unit: 'ms', good: 200, poor: 600 },
  fcp: { label: 'FCP', unit: 'ms', good: 1800, poor: 3000 },
  ttfb: { label: 'TTFB', unit: 'ms', good: 800, poor: 1800 },
  si: { label: 'SI', unit: 'ms', good: 3400, poor: 5800 },
};

const PCT_OPTIONS: Array<'p50' | 'p75' | 'p90' | 'p99'> = ['p50', 'p75', 'p90', 'p99'];

function fmt(v: number | undefined, unit: 'ms' | 'index' | 'score'): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  if (unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
  if (unit === 'index') return v.toFixed(3);
  return v.toFixed(0);
}

function fmtDelta(
  base: number,
  cand: number,
  higherIsBetter: boolean,
  unit: 'ms' | 'index' | 'score'
): { text: string; cls: string } {
  if (!Number.isFinite(base) || !Number.isFinite(cand))
    return { text: '—', cls: 'text-[var(--color-dim)]' };
  const d = cand - base;
  const pctDelta = base === 0 ? 0 : (d / base) * 100;
  const regressed = higherIsBetter ? d < 0 : d > 0;
  const improved = higherIsBetter ? d > 0 : d < 0;
  const sign = d > 0 ? '+' : '';
  const cls = regressed
    ? 'text-[var(--color-poor)]'
    : improved
      ? 'text-[var(--color-good)]'
      : 'text-[var(--color-dim)]';
  const deltaStr =
    unit === 'index' ? `${sign}${d.toFixed(3)}` : `${sign}${d.toFixed(d % 1 === 0 ? 0 : 2)}`;
  return { text: `${deltaStr}  (${sign}${pctDelta.toFixed(1)}%)`, cls };
}

function colorClass(
  v: number | undefined,
  spec: { good?: number; poor?: number; higherIsBetter?: boolean }
): string {
  if (v === undefined || !Number.isFinite(v)) return 'text-[var(--color-dim)]';
  const good = spec.good ?? 0;
  const poor = spec.poor ?? (spec.higherIsBetter ? 0 : Infinity);
  const mid = (poor + good) / 2;
  const isGood = spec.higherIsBetter ? v >= good : v <= good;
  const isWarn = spec.higherIsBetter ? v >= mid : v <= poor;
  if (isGood) return 'text-[var(--color-good)]';
  if (isWarn) return 'text-[var(--color-warn)]';
  return 'text-[var(--color-poor)]';
}

function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function CompareView() {
  const [status, setStatus] = useState<Status>('probing');
  const [client, setClient] = useState<AgentClient | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  const [urls, setUrls] = useState<UrlInfo[]>([]);
  const [selectedUrl, setSelectedUrl] = useState('');
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [baselineTag, setBaselineTag] = useState('');
  const [candidateTag, setCandidateTag] = useState('');
  const [pct, setPct] = useState<'p50' | 'p75' | 'p90' | 'p99'>('p75');

  const [result, setResult] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async (mode: 'auto' | 'explicit') => {
    setStatus('probing');
    const conn = await connectToAgent(mode);
    if (!conn) {
      setStatus('disconnected');
      return;
    }
    setClient(conn.client);
    setHealth(conn.health);
    setStatus('ready');
  }, []);

  useEffect(() => {
    void connect('auto');
  }, [connect]);

  // Load known URLs when connected
  useEffect(() => {
    if (status !== 'ready' || !client) return;
    void (async () => {
      try {
        const res = await fetch(client.requestUrl('/api/urls'));
        const data = (await res.json()) as { urls: UrlInfo[] };
        setUrls(data.urls ?? []);
        if (data.urls.length > 0 && !selectedUrl) {
          setSelectedUrl(data.urls[0].url);
        }
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [status, client]);

  // Load tags when URL changes
  useEffect(() => {
    if (status !== 'ready' || !client || !selectedUrl) return;
    setTags([]);
    setBaselineTag('');
    setCandidateTag('');
    setResult(null);
    void (async () => {
      try {
        const data = await client.tags(selectedUrl);
        setTags(data.tags ?? []);
        if (data.tags.length >= 1) setBaselineTag(data.tags[0].tag);
        if (data.tags.length >= 2) setCandidateTag(data.tags[1].tag);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [status, client, selectedUrl]);

  const runCompare = async () => {
    if (!client || !selectedUrl || !baselineTag || !candidateTag) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await client.compare(selectedUrl, baselineTag, candidateTag, pct);
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (status === 'probing') {
    return (
      <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-8 text-center">
        <p className="text-[var(--color-dim)]">Looking for a local psi-swarm agent…</p>
      </div>
    );
  }

  if (status === 'disconnected') {
    return (
      <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-8 space-y-4">
        <h2 className="text-xl font-semibold">No local agent running</h2>
        <p className="text-[var(--color-dim)] text-sm">Start the agent in a terminal:</p>
        <pre className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-3 text-sm overflow-x-auto">
          <code className="text-[var(--color-cyan)]">pnpm run serve</code>
        </pre>
        <button
          onClick={() => void connect('explicit')}
          className="px-4 py-2 bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition"
        >
          Connect to local agent
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {health && (
        <div className="flex items-center justify-between text-sm bg-[var(--color-panel)] border border-[var(--color-border)] rounded px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-[var(--color-good)] animate-pulse" />
            <span className="text-[var(--color-dim)]">connected</span>
            <span className="font-mono text-[var(--color-dim)]">
              {health.machine.cores} cores · {health.machine.totalMemGB.toFixed(1)} GB
            </span>
          </div>
          <span className="text-[var(--color-dim)] font-mono text-xs">
            {urls.length} URL{urls.length === 1 ? '' : 's'} in history
          </span>
        </div>
      )}

      {/* Selector form */}
      <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-6 space-y-5">
        <div>
          <label className="block text-sm text-[var(--color-dim)] mb-1.5">URL to compare</label>
          {urls.length > 0 ? (
            <select
              value={selectedUrl}
              onChange={(e) => setSelectedUrl(e.target.value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-cyan)]"
            >
              {urls.map((u) => (
                <option key={u.url} value={u.url}>
                  {u.url} ({u.count} runs)
                </option>
              ))}
            </select>
          ) : (
            <input
              type="url"
              value={selectedUrl}
              onChange={(e) => setSelectedUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-cyan)]"
            />
          )}
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm text-[var(--color-dim)] mb-1.5">Baseline tag</label>
            <select
              value={baselineTag}
              onChange={(e) => setBaselineTag(e.target.value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-cyan)]"
            >
              <option value="">— select —</option>
              {tags.map((t) => (
                <option key={t.tag} value={t.tag}>
                  {t.tag} (n={t.count}, {fmtRelative(t.last)})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-[var(--color-dim)] mb-1.5">Candidate tag</label>
            <select
              value={candidateTag}
              onChange={(e) => setCandidateTag(e.target.value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-cyan)]"
            >
              <option value="">— select —</option>
              {tags.map((t) => (
                <option key={t.tag} value={t.tag}>
                  {t.tag} (n={t.count}, {fmtRelative(t.last)})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-[var(--color-dim)] mb-1.5">Percentile</label>
            <select
              value={pct}
              onChange={(e) => setPct(e.target.value as 'p50' | 'p75' | 'p90' | 'p99')}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-cyan)]"
            >
              {PCT_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={() => void runCompare()}
          disabled={
            !selectedUrl || !baselineTag || !candidateTag || baselineTag === candidateTag || loading
          }
          className="w-full px-4 py-3 bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? 'Comparing…' : 'Compare swarms'}
        </button>

        {tags.length === 0 && selectedUrl && (
          <p className="text-xs text-[var(--color-dim)]">
            No tagged runs found for this URL. Tag your swarms with{' '}
            <code className="text-[var(--color-cyan)]">--tag before-deploy</code> in the CLI or the
            tag field in the run dashboard to enable comparisons.
          </p>
        )}
      </div>

      {error && (
        <div className="border border-[var(--color-poor)] bg-red-950/30 text-[var(--color-poor)] rounded p-3 text-sm font-mono">
          {error}
        </div>
      )}

      {result && <CompareResult result={result} pct={pct} />}
    </div>
  );
}

export function CompareResult({
  result,
  pct,
}: {
  result: CompareResponse;
  pct: 'p50' | 'p75' | 'p90' | 'p99';
}) {
  const pctKey = pct as keyof Stats;
  if (result.comparability?.comparable === false) {
    const versions = (values: Array<string | null>) =>
      values.map((value) => value ?? 'unknown').join(', ');
    return (
      <div
        role="status"
        className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-5 space-y-3 break-words"
      >
        <h3 className="font-semibold">Measurements are not comparable</h3>
        <p className="text-sm text-[var(--color-dim)]">{result.comparability.message}</p>
        <p className="text-xs font-mono text-[var(--color-dim)]">
          Baseline Lighthouse: {versions(result.comparability.baselineVersions)}
          <br />
          Candidate Lighthouse: {versions(result.comparability.candidateVersions)}
        </p>
        <p className="text-xs text-[var(--color-dim)]">
          All original readings remain available in history.
        </p>
      </div>
    );
  }
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b border-[var(--color-border)]">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-semibold">Comparison</span>
          <span className="text-[var(--color-dim)] text-xs font-mono">
            {result.baselineTag} (n={result.baselineCount}) vs {result.candidateTag} (n=
            {result.candidateCount}) · {pct}
          </span>
        </div>
        <div className="text-xs text-[var(--color-dim)] mt-1 font-mono truncate">{result.url}</div>
        {result.comparability?.comparable && (
          <div className="text-xs text-[var(--color-dim)] mt-1 font-mono">
            Lighthouse {result.comparability.candidateVersions.join(', ')}
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[var(--color-dim)] text-xs uppercase tracking-wide">
              <th className="text-left py-2 px-4">Metric</th>
              <th className="text-right py-2 px-3">Baseline {pct}</th>
              <th className="text-right py-2 px-3">Candidate {pct}</th>
              <th className="text-right py-2 px-3">Δ</th>
              <th className="text-right py-2 px-3">Baseline range</th>
              <th className="text-right py-2 px-3">Candidate range</th>
            </tr>
          </thead>
          <tbody>
            {result.metrics.map((m) => {
              const spec = METRIC_LABELS[m.key];
              if (!spec) return null;
              const baseVal = m.baseline?.[pctKey];
              const candVal = m.candidate?.[pctKey];
              const delta = fmtDelta(
                baseVal ?? NaN,
                candVal ?? NaN,
                !!spec.higherIsBetter,
                spec.unit
              );
              return (
                <tr key={m.key} className="border-t border-[var(--color-border)]">
                  <td className="py-1.5 px-4 font-medium">{spec.label}</td>
                  <td className={`text-right py-1.5 px-3 font-mono ${colorClass(baseVal, spec)}`}>
                    {fmt(baseVal, spec.unit)}
                  </td>
                  <td className={`text-right py-1.5 px-3 font-mono ${colorClass(candVal, spec)}`}>
                    {fmt(candVal, spec.unit)}
                  </td>
                  <td className={`text-right py-1.5 px-3 font-mono text-xs ${delta.cls}`}>
                    {delta.text}
                  </td>
                  <td className="text-right py-1.5 px-3 font-mono text-xs text-[var(--color-dim)]">
                    {m.baseline
                      ? `${fmt(m.baseline.min, spec.unit)}–${fmt(m.baseline.max, spec.unit)}`
                      : '—'}
                  </td>
                  <td className="text-right py-1.5 px-3 font-mono text-xs text-[var(--color-dim)]">
                    {m.candidate
                      ? `${fmt(m.candidate.min, spec.unit)}–${fmt(m.candidate.max, spec.unit)}`
                      : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-5 py-3 border-t border-[var(--color-border)] text-xs text-[var(--color-dim)]">
        Green = improved · Red = regressed · Range = min–max across all runs in each tagged swarm.
      </div>
    </div>
  );
}
