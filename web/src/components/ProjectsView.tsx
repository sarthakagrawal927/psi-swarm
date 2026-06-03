import { useEffect, useMemo, useState } from 'react';
import { AgentClient, probeAgent, type HealthResponse } from '../lib/agent.js';

interface ProjectRow {
  url: string;
  totalRuns: number;
  lastRunAt: number;
  mobileLcpP75?: number;
  desktopLcpP75?: number;
  mobilePerfScoreP50?: number;
  desktopPerfScoreP50?: number;
  cls?: number;
}

interface HistoryRow {
  started_at: number;
  preset: string;
  lcp: number | null;
  cls: number | null;
  tbt: number | null;
  fcp: number | null;
  ttfb: number | null;
  performance_score: number | null;
  tag: string | null;
}

type Status = 'probing' | 'disconnected' | 'ready';

function fmtMs(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
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

function lcpTier(ms: number | undefined): 'good' | 'warn' | 'poor' | 'dim' {
  if (typeof ms !== 'number') return 'dim';
  if (ms <= 2500) return 'good';
  if (ms <= 4000) return 'warn';
  return 'poor';
}

const tierColor: Record<string, string> = {
  good: 'var(--color-good)',
  warn: 'var(--color-warn)',
  poor: 'var(--color-poor)',
  dim: 'var(--color-dim)',
};

function Sparkline({ values, height = 28, width = 120 }: { values: number[]; height?: number; width?: number }) {
  if (values.length === 0) return <span className="text-[var(--color-dim)] text-xs">no data</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const dx = width / Math.max(1, values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * dx;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = values[values.length - 1];
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline fill="none" stroke="var(--color-cyan)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" points={points} opacity={0.85} />
      <circle cx={(values.length - 1) * dx} cy={height - ((last - min) / range) * (height - 2) - 1} r={2.5} fill={tierColor[lcpTier(last)]} />
    </svg>
  );
}

export default function ProjectsView() {
  const [status, setStatus] = useState<Status>('probing');
  const [client, setClient] = useState<AgentClient | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [historyByUrl, setHistoryByUrl] = useState<Map<string, HistoryRow[]>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [runningUrl, setRunningUrl] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const probe = await probeAgent();
      if (!probe) {
        setStatus('disconnected');
        return;
      }
      setClient(new AgentClient(probe.url));
      setHealth(probe.health);
      setStatus('ready');
    })();
  }, []);

  const loadProjects = async () => {
    if (!client) return;
    try {
      const res = await fetch(`${client.baseUrl}/api/projects`);
      const data = (await res.json()) as { projects: ProjectRow[] };
      setProjects(data.projects ?? []);
      // Prefetch history for sparklines (small, cheap).
      const map = new Map<string, HistoryRow[]>();
      for (const p of data.projects ?? []) {
        const r = await fetch(`${client.baseUrl}/api/projects/history?url=${encodeURIComponent(p.url)}&limit=40`);
        const h = (await r.json()) as { rows: HistoryRow[] };
        map.set(p.url, h.rows ?? []);
      }
      setHistoryByUrl(map);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (status === 'ready') void loadProjects();
  }, [status, client]);

  const runNew = async (url: string) => {
    if (!client) return;
    setRunningUrl(url);
    setError(null);
    try {
      await client.startRun({ url, runs: 3, presets: 'psi', parallel: 1 });
      // Quick polling — re-pull projects in ~120s when the run should be done.
      setTimeout(() => {
        void loadProjects();
        setRunningUrl(null);
      }, 90_000);
    } catch (err) {
      setError((err as Error).message);
      setRunningUrl(null);
    }
  };

  const addProject = async () => {
    const url = newUrl.trim();
    if (!url) return;
    setNewUrl('');
    await runNew(url);
  };

  if (status === 'probing') {
    return <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-8 text-center text-[var(--color-dim)]">Looking for local psi-swarm agent…</div>;
  }
  if (status === 'disconnected') {
    return (
      <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-8 space-y-3">
        <h2 className="text-xl font-semibold">No local agent running</h2>
        <p className="text-[var(--color-dim)] text-sm">Start it in a terminal:</p>
        <pre className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-3 text-sm overflow-x-auto"><code className="text-[var(--color-cyan)]">npm run serve</code></pre>
        <button onClick={() => location.reload()} className="px-4 py-2 bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition">Retry</button>
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
            <span className="font-mono text-[var(--color-dim)]">{health.machine.cores} cores · {health.machine.totalMemGB.toFixed(1)} GB</span>
          </div>
          <span className="text-[var(--color-dim)] font-mono text-xs">v{health.version}</span>
        </div>
      )}

      <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-5 flex gap-3">
        <input
          type="url"
          placeholder="Add a URL to track — https://example.com"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addProject()}
          className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-cyan)]"
        />
        <button
          onClick={addProject}
          disabled={!newUrl.trim()}
          className="px-5 py-2 bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition disabled:opacity-40"
        >
          Track + run
        </button>
      </div>

      {error && (
        <div className="border border-[var(--color-poor)] bg-red-950/30 text-[var(--color-poor)] rounded p-3 text-sm font-mono">{error}</div>
      )}

      {projects.length === 0 ? (
        <div className="text-center text-[var(--color-dim)] text-sm py-12">
          No projects tracked yet. Add a URL above to start.
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((p) => {
            const history = historyByUrl.get(p.url) ?? [];
            const desktopRuns = history.filter((r) => r.preset === 'desktop' && typeof r.lcp === 'number');
            const mobileRuns = history.filter((r) => r.preset === 'mobile-mid' && typeof r.lcp === 'number');
            const desktopLcps = desktopRuns.map((r) => r.lcp as number).reverse();
            const mobileLcps = mobileRuns.map((r) => r.lcp as number).reverse();
            const desktopTs = desktopRuns.map((r) => r.started_at);
            const mobileTs = mobileRuns.map((r) => r.started_at);
            const isExpanded = expanded === p.url;
            const isRunning = runningUrl === p.url;
            return (
              <div key={p.url} className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg overflow-hidden">
                <div className="px-5 py-4 grid grid-cols-[1fr_140px_140px_140px_auto] gap-4 items-center">
                  <div>
                    <button onClick={() => setExpanded(isExpanded ? null : p.url)} className="font-semibold text-left hover:text-[var(--color-cyan)] transition">{p.url}</button>
                    <div className="text-xs text-[var(--color-dim)] mt-0.5">{p.totalRuns} runs · last {fmtRelative(p.lastRunAt)}</div>
                  </div>
                  <MetricCell label="desktop LCP p75" value={fmtMs(p.desktopLcpP75)} tier={lcpTier(p.desktopLcpP75)} values={desktopLcps} timestamps={desktopTs} />
                  <MetricCell label="mobile LCP p75" value={fmtMs(p.mobileLcpP75)} tier={lcpTier(p.mobileLcpP75)} values={mobileLcps} timestamps={mobileTs} />
                  <div className="text-right">
                    <div className="text-xs text-[var(--color-dim)] uppercase tracking-wide">CLS</div>
                    <div className="font-mono text-sm" style={{ color: tierColor[(typeof p.cls === 'number' && p.cls <= 0.1) ? 'good' : (typeof p.cls === 'number' && p.cls <= 0.25) ? 'warn' : (typeof p.cls === 'number' ? 'poor' : 'dim')] }}>
                      {typeof p.cls === 'number' ? p.cls.toFixed(3) : '—'}
                    </div>
                  </div>
                  <button
                    onClick={() => runNew(p.url)}
                    disabled={isRunning}
                    className="px-3 py-1.5 text-xs bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition disabled:opacity-40"
                  >
                    {isRunning ? '…running' : 'Run new'}
                  </button>
                </div>
                {isExpanded && <HistoryDetail rows={history} />}
              </div>
            );
          })}
        </div>
      )}

      <div className="text-xs text-[var(--color-dim)] pt-4 text-center">
        Each "Run new" starts a 3-run psi-group swarm in the background (~3 min). Refresh after to see the new numbers.
      </div>
    </div>
  );
}

const MIN_SPARKLINE_SPAN_MS = 12 * 60 * 60 * 1000; // 12h — below this, the line is just measurement noise within a session

function fmtSpan(ms: number): string {
  if (ms <= 0) return '0m';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function MetricCell({ label, value, tier, values, timestamps }: { label: string; value: string; tier: 'good' | 'warn' | 'poor' | 'dim'; values: number[]; timestamps: number[] }) {
  const span = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  const showSparkline = span >= MIN_SPARKLINE_SPAN_MS && values.length > 2;
  const min = values.length > 0 ? Math.min(...values) : undefined;
  const max = values.length > 0 ? Math.max(...values) : undefined;
  return (
    <div>
      <div className="text-xs text-[var(--color-dim)] uppercase tracking-wide">{label}</div>
      <div className="font-mono text-sm" style={{ color: tierColor[tier] }}>{value}</div>
      <div className="mt-1 text-xs text-[var(--color-dim)]">
        {showSparkline ? (
          <Sparkline values={values} />
        ) : values.length === 0 ? (
          <span>no runs</span>
        ) : values.length === 1 ? (
          <span>n=1</span>
        ) : (
          <span>
            n={values.length}
            {span > 0 ? ` over ${fmtSpan(span)}` : ''}
            {min !== max && (
              <>
                {' · range '}
                <span className="font-mono">{fmtMs(min)}</span>
                {'–'}
                <span className="font-mono">{fmtMs(max)}</span>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function HistoryDetail({ rows }: { rows: HistoryRow[] }) {
  const sorted = useMemo(() => rows.slice().sort((a, b) => b.started_at - a.started_at), [rows]);
  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[var(--color-dim)] text-xs uppercase tracking-wide">
            <th className="text-left py-1.5">When</th>
            <th className="text-left py-1.5">Preset</th>
            <th className="text-right py-1.5">LCP</th>
            <th className="text-right py-1.5">CLS</th>
            <th className="text-right py-1.5">TBT</th>
            <th className="text-right py-1.5">FCP</th>
            <th className="text-right py-1.5">TTFB</th>
            <th className="text-right py-1.5">Perf</th>
            <th className="text-left py-1.5">Tag</th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs">
          {sorted.slice(0, 30).map((r, i) => (
            <tr key={i} className="border-t border-[var(--color-border)]">
              <td className="py-1.5 text-[var(--color-dim)]">{fmtRelative(r.started_at)}</td>
              <td className="py-1.5">{r.preset}</td>
              <td className="text-right py-1.5" style={{ color: tierColor[lcpTier(r.lcp ?? undefined)] }}>{fmtMs(r.lcp ?? undefined)}</td>
              <td className="text-right py-1.5 text-[var(--color-dim)]">{typeof r.cls === 'number' ? r.cls.toFixed(3) : '—'}</td>
              <td className="text-right py-1.5 text-[var(--color-dim)]">{fmtMs(r.tbt ?? undefined)}</td>
              <td className="text-right py-1.5 text-[var(--color-dim)]">{fmtMs(r.fcp ?? undefined)}</td>
              <td className="text-right py-1.5 text-[var(--color-dim)]">{fmtMs(r.ttfb ?? undefined)}</td>
              <td className="text-right py-1.5 text-[var(--color-dim)]">{typeof r.performance_score === 'number' ? Math.round(r.performance_score) : '—'}</td>
              <td className="py-1.5 text-[var(--color-dim)]">{r.tag ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > 30 && <div className="text-xs text-[var(--color-dim)] mt-2">Showing 30 of {sorted.length} runs.</div>}
    </div>
  );
}
