import { useEffect, useMemo, useState } from 'react';
import { AgentClient, probeAgent, type HealthResponse } from '../lib/agent.js';

interface PageRow {
  url: string;
  path: string;
  totalRuns: number;
  lastRunAt: number;
  mobileLcpP75?: number;
  desktopLcpP75?: number;
  cls?: number;
  reportCount?: number;
  latestReportAt?: number;
}
interface ProjectGrouped {
  origin: string;
  totalRuns: number;
  lastRunAt: number;
  pageCount: number;
  worstMobileLcp?: number;
  worstDesktopLcp?: number;
  worstCls?: number;
  isCloudflarePlatform?: boolean;
  domainRating?: number;
  domainRatingDomain?: string;
  /** Set whenever the domain was checked — even when Ahrefs has no rating. */
  domainRatingFetchedAt?: number;
  pages: PageRow[];
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
function fmtSpan(ms: number): string {
  if (ms <= 0) return '0m';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
function lcpTier(ms: number | undefined): 'good' | 'warn' | 'poor' | 'dim' {
  if (typeof ms !== 'number') return 'dim';
  if (ms <= 2500) return 'good';
  if (ms <= 4000) return 'warn';
  return 'poor';
}
function clsTier(v: number | undefined): 'good' | 'warn' | 'poor' | 'dim' {
  if (typeof v !== 'number') return 'dim';
  if (v <= 0.1) return 'good';
  if (v <= 0.25) return 'warn';
  return 'poor';
}
function drTier(v: number | undefined): 'good' | 'warn' | 'dim' {
  if (typeof v !== 'number') return 'dim';
  if (v >= 40) return 'good';
  if (v >= 10) return 'warn';
  return 'dim';
}
const tierColor: Record<string, string> = {
  good: 'var(--color-good)',
  warn: 'var(--color-warn)',
  poor: 'var(--color-poor)',
  dim: 'var(--color-dim)',
};

const MIN_SPARKLINE_SPAN_MS = 12 * 60 * 60 * 1000;

function Sparkline({ values, height = 22, width = 90 }: { values: number[]; height?: number; width?: number }) {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const dx = width / Math.max(1, values.length - 1);
  const points = values.map((v, i) => `${(i * dx).toFixed(1)},${(height - ((v - min) / range) * (height - 2) - 1).toFixed(1)}`).join(' ');
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
  const [projects, setProjects] = useState<ProjectGrouped[]>([]);
  const [historyByUrl, setHistoryByUrl] = useState<Map<string, HistoryRow[]>>(new Map());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [expandedPages, setExpandedPages] = useState<Set<string>>(new Set());
  const [newUrl, setNewUrl] = useState('');
  const [pageInputByOrigin, setPageInputByOrigin] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [runningUrl, setRunningUrl] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const pageUrl = new URL(window.location.href);
      const preferredAgent = pageUrl.searchParams.get('agent') ?? undefined;
      const token = pageUrl.searchParams.get('token') ?? undefined;
      const probe = await probeAgent(undefined, { preferredUrl: preferredAgent, token });
      if (!probe) { setStatus('disconnected'); return; }
      setClient(new AgentClient(probe.url, token));
      setHealth(probe.health);
      setStatus('ready');
    })();
  }, []);

  const loadProjects = async () => {
    if (!client) return;
    try {
      const res = await fetch(client.requestUrl('/api/projects'));
      const data = (await res.json()) as { projects: ProjectGrouped[] };
      setProjects(data.projects ?? []);
      // Prefetch sparkline history only for expanded projects' pages — cheap if collapsed.
      const map = new Map<string, HistoryRow[]>();
      for (const proj of data.projects ?? []) {
        if (!expandedProjects.has(proj.origin)) continue;
        for (const pg of proj.pages) {
          const r = await fetch(client.requestUrl('/api/projects/history', { url: pg.url, limit: 40 }));
          const h = (await r.json()) as { rows: HistoryRow[] };
          map.set(pg.url, h.rows ?? []);
        }
      }
      setHistoryByUrl((prev) => {
        const next = new Map(prev);
        for (const [k, v] of map) next.set(k, v);
        return next;
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => { if (status === 'ready') void loadProjects(); }, [status, client]);

  const runNew = async (url: string) => {
    if (!client) return;
    setRunningUrl(url);
    setError(null);
    try {
      const { runId } = await client.startRun({ url, runs: 3, presets: 'psi', parallel: 1 });
      await client.waitForRunCompletion(runId);
      await loadProjects();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunningUrl(null);
    }
  };
  const runAllPages = async (proj: ProjectGrouped) => {
    if (!client) return;
    setError(null);
    try {
      for (const pg of proj.pages) {
        const { runId } = await client.startRun({ url: pg.url, runs: 3, presets: 'psi', parallel: 1 });
        await client.waitForRunCompletion(runId);
      }
      await loadProjects();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const addProject = async () => {
    const url = newUrl.trim();
    if (!url) return;
    setNewUrl('');
    await runNew(url);
  };
  const addPage = async (origin: string) => {
    const raw = (pageInputByOrigin.get(origin) ?? '').trim();
    if (!raw) return;
    // Allow either a full URL or a path
    const url = raw.startsWith('http') ? raw : `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
    setPageInputByOrigin((m) => { const n = new Map(m); n.delete(origin); return n; });
    await runNew(url);
  };
  const toggleProject = async (origin: string) => {
    const next = new Set(expandedProjects);
    if (next.has(origin)) next.delete(origin);
    else next.add(origin);
    setExpandedProjects(next);
    // Lazy-load history when expanding
    if (next.has(origin) && client) {
      const proj = projects.find((p) => p.origin === origin);
      if (!proj) return;
      const map = new Map(historyByUrl);
      for (const pg of proj.pages) {
        if (map.has(pg.url)) continue;
        const r = await fetch(client.requestUrl('/api/projects/history', { url: pg.url, limit: 40 }));
        const h = (await r.json()) as { rows: HistoryRow[] };
        map.set(pg.url, h.rows ?? []);
      }
      setHistoryByUrl(map);
    }
  };
  const togglePage = (url: string) => {
    const next = new Set(expandedPages);
    if (next.has(url)) next.delete(url); else next.add(url);
    setExpandedPages(next);
  };

  if (status === 'probing') return <Panel><span className="text-[var(--color-dim)]">Looking for local psi-swarm agent…</span></Panel>;
  if (status === 'disconnected') return (
    <Panel>
      <h2 className="text-xl font-semibold mb-3">No local agent running</h2>
      <p className="text-[var(--color-dim)] text-sm mb-3">Start it: <code className="text-[var(--color-cyan)]">npm run serve</code></p>
      <button onClick={() => location.reload()} className="px-4 py-2 bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition">Retry</button>
    </Panel>
  );

  return (
    <div className="space-y-6">
      {health && (
        <div className="flex items-center justify-between text-sm bg-[var(--color-panel)] border border-[var(--color-border)] rounded px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-[var(--color-good)] animate-pulse" />
            <span className="text-[var(--color-dim)]">connected</span>
            <span className="font-mono text-[var(--color-dim)]">{health.machine.cores} cores · {health.machine.totalMemGB.toFixed(1)} GB</span>
          </div>
          <span className="text-[var(--color-dim)] font-mono text-xs">{projects.length} projects · {projects.reduce((s, p) => s + p.pageCount, 0)} pages tracked</span>
        </div>
      )}

      <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-5 flex gap-3">
        <input type="url" placeholder="Add a new project — https://example.com" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addProject()} className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-cyan)]" />
        <button onClick={addProject} disabled={!newUrl.trim()} className="px-5 py-2 bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition disabled:opacity-40">Track + run</button>
      </div>

      {error && <div className="border border-[var(--color-poor)] bg-red-950/30 text-[var(--color-poor)] rounded p-3 text-sm font-mono">{error}</div>}

      {projects.length === 0 ? (
        <div className="text-center text-[var(--color-dim)] text-sm py-12">No projects tracked yet. Add a URL above to start.</div>
      ) : (
        <div className="space-y-3">
          {projects.map((proj) => (
            <ProjectCard
              key={proj.origin}
              proj={proj}
              client={client!}
              expanded={expandedProjects.has(proj.origin)}
              onToggle={() => toggleProject(proj.origin)}
              expandedPages={expandedPages}
              onTogglePage={togglePage}
              historyByUrl={historyByUrl}
              runningUrl={runningUrl}
              onRunPage={(url) => runNew(url)}
              onRunAll={() => runAllPages(proj)}
              pageInput={pageInputByOrigin.get(proj.origin) ?? ''}
              setPageInput={(v) => setPageInputByOrigin((m) => { const n = new Map(m); n.set(proj.origin, v); return n; })}
              onAddPage={() => addPage(proj.origin)}
            />
          ))}
        </div>
      )}

      <div className="text-xs text-[var(--color-dim)] pt-4 text-center">"Run new" + "Run all pages" start 3-run psi-group swarms in the background (~3 min each). Refresh after to see new numbers.</div>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-8">{children}</div>;
}

interface ProjectCardProps {
  proj: ProjectGrouped;
  client: AgentClient;
  expanded: boolean;
  onToggle: () => void;
  expandedPages: Set<string>;
  onTogglePage: (url: string) => void;
  historyByUrl: Map<string, HistoryRow[]>;
  runningUrl: string | null;
  onRunPage: (url: string) => void;
  onRunAll: () => void;
  pageInput: string;
  setPageInput: (v: string) => void;
  onAddPage: () => void;
}

function ProjectCard({ proj, client, expanded, onToggle, expandedPages, onTogglePage, historyByUrl, runningUrl, onRunPage, onRunAll, pageInput, setPageInput, onAddPage }: ProjectCardProps) {
  const host = useMemo(() => { try { return new URL(proj.origin).host; } catch { return proj.origin; } }, [proj.origin]);
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg overflow-hidden">
      <div className="px-5 py-4 grid grid-cols-[1fr_100px_140px_140px_140px_auto] gap-4 items-center">
        <div>
          <button onClick={onToggle} className="font-semibold text-left hover:text-[var(--color-cyan)] transition flex items-center gap-2">
            <span className="text-xs text-[var(--color-dim)]">{expanded ? '▼' : '▶'}</span>
            {host}
          </button>
          <div className="text-xs text-[var(--color-dim)] mt-0.5">
            {proj.pageCount} page{proj.pageCount === 1 ? '' : 's'} · {proj.totalRuns} runs · last {fmtRelative(proj.lastRunAt)}
            {proj.isCloudflarePlatform && <span> · CF platform</span>}
          </div>
        </div>
        <DrCell value={proj.domainRating} cfPlatform={proj.isCloudflarePlatform} checked={proj.domainRatingFetchedAt !== undefined} />
        <Worst label="worst desktop" value={proj.worstDesktopLcp} />
        <Worst label="worst mobile" value={proj.worstMobileLcp} />
        <ClsCell value={proj.worstCls} />
        <button onClick={onRunAll} className="px-3 py-1.5 text-xs bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition">Run all pages</button>
      </div>
      {expanded && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)]">
          {proj.pages.map((pg) => (
            <PageRowComp key={pg.url} pg={pg} expanded={expandedPages.has(pg.url)} onToggle={() => onTogglePage(pg.url)} history={historyByUrl.get(pg.url) ?? []} running={runningUrl === pg.url} onRun={() => onRunPage(pg.url)} />
          ))}
          <div className="px-5 py-3 flex gap-2 border-t border-[var(--color-border)]">
            <input type="text" placeholder="Add page — /about or full URL" value={pageInput} onChange={(e) => setPageInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onAddPage()} className="flex-1 bg-[var(--color-panel)] border border-[var(--color-border)] rounded px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-[var(--color-cyan)]" />
            <button onClick={onAddPage} disabled={!pageInput.trim()} className="px-3 py-1.5 text-xs bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition disabled:opacity-40">Add page</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Worst({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div>
      <div className="text-xs text-[var(--color-dim)] uppercase tracking-wide">{label}</div>
      <div className="font-mono text-sm" style={{ color: tierColor[lcpTier(value)] }}>{fmtMs(value)}</div>
    </div>
  );
}
function ClsCell({ value }: { value: number | undefined }) {
  return (
    <div className="text-right">
      <div className="text-xs text-[var(--color-dim)] uppercase tracking-wide">worst CLS</div>
      <div className="font-mono text-sm" style={{ color: tierColor[clsTier(value)] }}>{typeof value === 'number' ? value.toFixed(3) : '—'}</div>
    </div>
  );
}
function DrCell({ value, cfPlatform, checked }: { value: number | undefined; cfPlatform?: boolean; checked?: boolean }) {
  // '…' only while a first lookup is pending; once checked (or ineligible) show '—'.
  return (
    <div>
      <div className="text-xs text-[var(--color-dim)] uppercase tracking-wide">Ahrefs DR</div>
      <div className="font-mono text-sm" style={{ color: tierColor[drTier(value)] }}>
        {typeof value === 'number' ? value.toFixed(1) : cfPlatform || checked ? '—' : '…'}
      </div>
    </div>
  );
}

function PageRowComp({ pg, expanded, onToggle, history, running, onRun }: { pg: PageRow; expanded: boolean; onToggle: () => void; history: HistoryRow[]; running: boolean; onRun: () => void }) {
  const desktopRuns = history.filter((r) => r.preset === 'desktop' && typeof r.lcp === 'number');
  const mobileRuns = history.filter((r) => r.preset === 'mobile-mid' && typeof r.lcp === 'number');
  const desktopLcps = desktopRuns.map((r) => r.lcp as number).reverse();
  const mobileLcps = mobileRuns.map((r) => r.lcp as number).reverse();
  const desktopTs = desktopRuns.map((r) => r.started_at);
  const mobileTs = mobileRuns.map((r) => r.started_at);
  return (
    <>
      <div className="px-5 py-2.5 grid grid-cols-[1fr_100px_140px_140px_140px_auto] gap-4 items-center border-t border-[var(--color-border)] first:border-t-0">
        <div>
          <button onClick={onToggle} className="text-sm font-mono text-left hover:text-[var(--color-cyan)] transition flex items-center gap-2">
            <span className="text-xs text-[var(--color-dim)]">{expanded ? '▼' : '▶'}</span>
            {pg.path}
          </button>
          <div className="text-xs text-[var(--color-dim)] mt-0.5">n={pg.totalRuns} · last {fmtRelative(pg.lastRunAt)}</div>
        </div>
        {/* Empty cell — DR is per-project, keeps page rows aligned with the card header grid. */}
        <div />
        <PageMetric label="desktop LCP" value={pg.desktopLcpP75} lcps={desktopLcps} timestamps={desktopTs} />
        <PageMetric label="mobile LCP" value={pg.mobileLcpP75} lcps={mobileLcps} timestamps={mobileTs} />
        <div className="text-right">
          <div className="text-xs text-[var(--color-dim)] uppercase tracking-wide">CLS</div>
          <div className="font-mono text-sm" style={{ color: tierColor[clsTier(pg.cls)] }}>{typeof pg.cls === 'number' ? pg.cls.toFixed(3) : '—'}</div>
        </div>
        <div className="flex items-center justify-end gap-2">
          {(pg.reportCount ?? 0) > 0 && (
            <a
              href={client.reportUrl(pg.url)}
              target="_blank"
              rel="noreferrer"
              className="px-2 py-1 text-xs text-[var(--color-cyan)] hover:underline whitespace-nowrap"
              title={`${pg.reportCount} report(s) · latest ${pg.latestReportAt ? fmtRelative(pg.latestReportAt) : ''}`}
            >
              analysis →
            </a>
          )}
          <button onClick={onRun} disabled={running} className="px-3 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-cyan)] text-[var(--color-cyan)] rounded hover:bg-[var(--color-cyan)] hover:text-black transition disabled:opacity-40">{running ? '…running' : 'Run'}</button>
        </div>
      </div>
      {expanded && <HistoryDetail rows={history} />}
    </>
  );
}

function PageMetric({ label, value, lcps, timestamps }: { label: string; value: number | undefined; lcps: number[]; timestamps: number[] }) {
  const span = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  const showSparkline = span >= MIN_SPARKLINE_SPAN_MS && lcps.length > 2;
  return (
    <div>
      <div className="text-xs text-[var(--color-dim)] uppercase tracking-wide">{label}</div>
      <div className="font-mono text-sm" style={{ color: tierColor[lcpTier(value)] }}>{fmtMs(value)}</div>
      <div className="mt-0.5 text-[10px] text-[var(--color-dim)]">
        {showSparkline ? <Sparkline values={lcps} /> : lcps.length > 0 ? `n=${lcps.length}${span > 0 ? ` · ${fmtSpan(span)}` : ''}` : '—'}
      </div>
    </div>
  );
}

function HistoryDetail({ rows }: { rows: HistoryRow[] }) {
  const sorted = useMemo(() => rows.slice().sort((a, b) => b.started_at - a.started_at), [rows]);
  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-panel)] px-5 py-3">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[var(--color-dim)] uppercase tracking-wide">
            <th className="text-left py-1">When</th><th className="text-left py-1">Preset</th>
            <th className="text-right py-1">LCP</th><th className="text-right py-1">CLS</th><th className="text-right py-1">TBT</th>
            <th className="text-right py-1">FCP</th><th className="text-right py-1">TTFB</th><th className="text-right py-1">Perf</th>
            <th className="text-left py-1">Tag</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {sorted.slice(0, 30).map((r, i) => (
            <tr key={i} className="border-t border-[var(--color-border)]">
              <td className="py-1 text-[var(--color-dim)]">{fmtRelative(r.started_at)}</td>
              <td className="py-1">{r.preset}</td>
              <td className="text-right py-1" style={{ color: tierColor[lcpTier(r.lcp ?? undefined)] }}>{fmtMs(r.lcp ?? undefined)}</td>
              <td className="text-right py-1 text-[var(--color-dim)]">{typeof r.cls === 'number' ? r.cls.toFixed(3) : '—'}</td>
              <td className="text-right py-1 text-[var(--color-dim)]">{fmtMs(r.tbt ?? undefined)}</td>
              <td className="text-right py-1 text-[var(--color-dim)]">{fmtMs(r.fcp ?? undefined)}</td>
              <td className="text-right py-1 text-[var(--color-dim)]">{fmtMs(r.ttfb ?? undefined)}</td>
              <td className="text-right py-1 text-[var(--color-dim)]">{typeof r.performance_score === 'number' ? Math.round(r.performance_score) : '—'}</td>
              <td className="py-1 text-[var(--color-dim)]">{r.tag ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > 30 && <div className="text-xs text-[var(--color-dim)] mt-2">Showing 30 of {sorted.length} runs.</div>}
    </div>
  );
}
