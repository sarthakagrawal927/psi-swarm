import { useEffect, useMemo, useState } from 'react';
import {
  AgentClient,
  probeAgent,
  type HealthResponse,
  type PresetsResponse,
  type RunMetrics,
  type RunnerEvent,
  type DiagnosisResponse,
} from '../lib/agent.js';

type View = 'connecting' | 'disconnected' | 'form' | 'running' | 'done';

interface PresetState {
  name: string;
  label: string;
  done: number;
  total: number;
  failed: number;
  active: boolean;
  lcps: number[];
  lastLcp?: number;
}

interface RunSummary {
  byPreset: Record<string, Record<string, { p50: number; p75: number; p90: number; p99: number; min: number; max: number; stddev: number; n: number } | null>>;
}

interface Suggestion {
  url: string;
  path: string;
  text: string;
}

const METRIC_SPECS: { key: keyof RunMetrics; label: string; unit: 'ms' | 'index' | 'score'; good?: number; poor?: number; higherIsBetter?: boolean }[] = [
  { key: 'performance_score', label: 'Perf Score', unit: 'score', good: 90, poor: 50, higherIsBetter: true },
  { key: 'lcp', label: 'LCP', unit: 'ms', good: 2500, poor: 4000 },
  { key: 'inp', label: 'INP', unit: 'ms', good: 200, poor: 500 },
  { key: 'cls', label: 'CLS', unit: 'index', good: 0.1, poor: 0.25 },
  { key: 'tbt', label: 'TBT', unit: 'ms', good: 200, poor: 600 },
  { key: 'fcp', label: 'FCP', unit: 'ms', good: 1800, poor: 3000 },
  { key: 'ttfb', label: 'TTFB', unit: 'ms', good: 800, poor: 1800 },
  { key: 'si', label: 'SI', unit: 'ms', good: 3400, poor: 5800 },
];

function fmt(v: number | undefined, unit: 'ms' | 'index' | 'score'): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  if (unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
  if (unit === 'index') return v.toFixed(3);
  return v.toFixed(0);
}

function colorClass(v: number | undefined, spec: (typeof METRIC_SPECS)[number]): string {
  if (v === undefined || !Number.isFinite(v)) return 'text-[var(--color-dim)]';
  if (spec.higherIsBetter) {
    if (v >= (spec.good ?? 0)) return 'text-[var(--color-good)]';
    if (v >= ((spec.poor ?? 0) + (spec.good ?? 0)) / 2) return 'text-[var(--color-warn)]';
    return 'text-[var(--color-poor)]';
  }
  if (v <= (spec.good ?? 0)) return 'text-[var(--color-good)]';
  if (v <= (spec.poor ?? Infinity)) return 'text-[var(--color-warn)]';
  return 'text-[var(--color-poor)]';
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

export default function RunDashboard() {
  const [view, setView] = useState<View>('connecting');
  const [client, setClient] = useState<AgentClient | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [presetsData, setPresetsData] = useState<PresetsResponse | null>(null);

  const [url, setUrl] = useState('https://web.dev');
  const [runs, setRuns] = useState(5);
  const [presetGroup, setPresetGroup] = useState('psi');
  const [parallelMode, setParallelMode] = useState<'1' | 'auto'>('1');
  const [tag, setTag] = useState('');

  const [runId, setRunId] = useState<string | null>(null);
  const [presetStates, setPresetStates] = useState<Map<string, PresetState>>(new Map());
  const [totalDone, setTotalDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [startedAt, setStartedAt] = useState<number>(0);
  const [now, setNow] = useState<number>(Date.now());
  const [finished, setFinished] = useState(false);
  const [aggregate, setAggregate] = useState<RunSummary | null>(null);
  const [diagnosis, setDiagnosis] = useState<DiagnosisResponse | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggestionSources, setSuggestionSources] = useState<string[]>([]);
  const [reasonText, setReasonText] = useState<string>('');
  const [reasonStatus, setReasonStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const [reasonModel, setReasonModel] = useState<string | undefined>();
  const [reasonBackendUsed, setReasonBackendUsed] = useState<'openai' | 'local-ai' | undefined>();
  const [reasonBackendPref, setReasonBackendPref] = useState<'auto' | 'openai' | 'local-ai'>('auto');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Probe for the local agent on mount.
  useEffect(() => {
    void (async () => {
      const pageUrl = new URL(window.location.href);
      const preferredAgent = pageUrl.searchParams.get('agent') ?? undefined;
      const token = pageUrl.searchParams.get('token') ?? undefined;
      const probe = await probeAgent(undefined, { preferredUrl: preferredAgent, token });
      if (!probe) {
        setView('disconnected');
        return;
      }
      const c = new AgentClient(probe.url, token);
      setClient(c);
      setHealth(probe.health);
      try {
        const ps = await c.presets();
        setPresetsData(ps);
        setView('form');
      } catch (err) {
        setError((err as Error).message);
        setView('disconnected');
      }
    })();
  }, []);

  // Tick every 250ms while running so elapsed/ETA update.
  useEffect(() => {
    if (view !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [view]);

  const startRun = async () => {
    if (!client || !presetsData) return;
    setError(null);
    const presetNames = presetsData.groups[presetGroup] ?? [presetGroup];
    const initial = new Map<string, PresetState>();
    for (const name of presetNames) {
      const meta = presetsData.presets[name];
      initial.set(name, {
        name,
        label: meta?.label ?? name,
        done: 0,
        total: runs,
        failed: 0,
        active: false,
        lcps: [],
      });
    }
    setPresetStates(initial);
    setTotalDone(0);
    setTotal(presetNames.length * runs);
    setStartedAt(Date.now());
    setNow(Date.now());
    setFinished(false);
    setAggregate(null);
    setDiagnosis(null);
    setSuggestions(null);
    setSuggestionSources([]);
    setReasonText('');
    setReasonStatus('idle');
    setReasonError(null);
    setReasonModel(undefined);
    setView('running');

    try {
      const { runId: id } = await client.startRun({
        url,
        runs,
        presets: presetGroup,
        parallel: parallelMode,
        tag: tag || undefined,
      });
      setRunId(id);

      const unsubscribe = client.subscribe(id, (e: RunnerEvent) => handleEvent(e));
      // Cleanup on view change handled via ref-equivalent: store unsubscribe.
      (window as unknown as { __psiSwarmUnsub?: () => void }).__psiSwarmUnsub = unsubscribe;
      void client.waitForRunCompletion(id)
        .then(() => completeRun())
        .catch((err) => setError((err as Error).message));
    } catch (err) {
      setError((err as Error).message);
      setView('form');
    }
  };

  const handleEvent = (e: RunnerEvent) => {
    if (e.type === 'run-start') {
      setPresetStates((prev) => {
        const next = new Map(prev);
        const cur = next.get(e.preset.name);
        if (cur) next.set(e.preset.name, { ...cur, active: true });
        return next;
      });
    } else if (e.type === 'run-complete') {
      setPresetStates((prev) => {
        const next = new Map(prev);
        const cur = next.get(e.preset.name);
        if (cur) {
          const failed = cur.failed + (e.result.error ? 1 : 0);
          const lcp = e.result.metrics?.lcp;
          const lcps = typeof lcp === 'number' ? [...cur.lcps, lcp] : cur.lcps;
          next.set(e.preset.name, {
            ...cur,
            done: cur.done + 1,
            failed,
            active: cur.done + 1 < cur.total,
            lcps,
            lastLcp: lcp ?? cur.lastLcp,
          });
        }
        return next;
      });
      setTotalDone(e.done);
    } else if (e.type === 'all-complete') {
      setFinished(true);
    }
  };

  const completeRun = async () => {
    if (!client || !runId) return;
    try {
      const agg = await client.aggregate(runId);
      setAggregate(agg as RunSummary);
      const diag = await client.diagnosis(runId);
      setDiagnosis(diag);
      const sug = await client.suggestions(runId);
      setSuggestions(sug.links);
      setSuggestionSources(sug.sources);
    } catch (err) {
      setError((err as Error).message);
    }
    setView('done');
  };

  const startReasoning = () => {
    if (!client || !runId) return;
    setReasonText('');
    setReasonStatus('streaming');
    setReasonError(null);
    setReasonModel(undefined);
    setReasonBackendUsed(undefined);
    client.subscribeReason(
      runId,
      (e) => {
        if (e.type === 'backend') {
          setReasonBackendUsed(e.backend);
        } else if (e.type === 'chunk') {
          setReasonText((prev) => prev + e.text);
        } else if (e.type === 'done') {
          setReasonStatus('done');
          setReasonModel(e.modelUsed);
        } else if (e.type === 'error') {
          setReasonStatus('error');
          setReasonError(e.message);
        }
      },
      { backend: reasonBackendPref },
    );
  };

  const presetStateList = useMemo(() => Array.from(presetStates.values()), [presetStates]);
  const elapsedMs = startedAt ? now - startedAt : 0;
  const avgPerRun = totalDone > 0 ? elapsedMs / totalDone : 0;
  const remaining = total - totalDone;
  const etaMs = remaining * avgPerRun;

  if (view === 'connecting') {
    return <ConnectingPanel />;
  }
  if (view === 'disconnected') {
    return <DisconnectedPanel onRetry={() => location.reload()} error={error} />;
  }
  if (!presetsData || !health) {
    return <ConnectingPanel />;
  }
  return (
    <div className="space-y-8">
      <ConnectedBadge baseUrl={client?.baseUrl ?? ''} health={health} />

      {view === 'form' || view === 'done' ? (
        <RunForm
          url={url}
          setUrl={setUrl}
          runs={runs}
          setRuns={setRuns}
          presetGroup={presetGroup}
          setPresetGroup={setPresetGroup}
          parallelMode={parallelMode}
          setParallelMode={setParallelMode}
          tag={tag}
          setTag={setTag}
          presetsData={presetsData}
          onStart={startRun}
          showWarnIfParallel={parallelMode === 'auto'}
        />
      ) : null}

      {(view === 'running' || view === 'done') && (
        <LiveProgress
          presets={presetStateList}
          total={total}
          totalDone={totalDone}
          elapsedMs={elapsedMs}
          etaMs={etaMs}
          finished={finished}
        />
      )}

      {view === 'done' && aggregate && (
        <ResultsView aggregate={aggregate} presetStates={presetStateList} />
      )}

      {view === 'done' && diagnosis && (
        <WhyPanel
          diagnosis={diagnosis}
          reasonStatus={reasonStatus}
          reasonText={reasonText}
          reasonModel={reasonModel}
          reasonBackendUsed={reasonBackendUsed}
          reasonBackendPref={reasonBackendPref}
          setReasonBackendPref={setReasonBackendPref}
          reasonError={reasonError}
          onAskReason={startReasoning}
        />
      )}

      {view === 'done' && suggestions && (
        <SuggestionsView links={suggestions} sources={suggestionSources} onPick={(u) => setUrl(u)} />
      )}

      {error && <ErrorBanner error={error} />}
    </div>
  );
}

function ConnectingPanel() {
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-8 text-center">
      <p className="text-[var(--color-dim)]">Looking for a local psi-swarm agent…</p>
    </div>
  );
}

function DisconnectedPanel({ onRetry, error }: { onRetry: () => void; error: string | null }) {
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-8 space-y-4">
      <h2 className="text-xl font-semibold">No local agent running</h2>
      <p className="text-[var(--color-dim)] text-sm">
        psi-swarm runs Lighthouse on your machine. Start the local agent in a terminal:
      </p>
      <pre className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-3 text-sm overflow-x-auto">
        <code className="text-[var(--color-cyan)]">
          {`# install
npm install -g psi-swarm

# run the agent (in any terminal)
psi-swarm serve --origin http://localhost:4321`}
        </code>
      </pre>
      <p className="text-[var(--color-dim)] text-xs">
        Compute happens on your machine. The browser is just the UI. {error ? `Last error: ${error}` : ''}
      </p>
      <button
        onClick={onRetry}
        className="px-4 py-2 bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition"
      >
        Retry connection
      </button>
    </div>
  );
}

function ConnectedBadge({ baseUrl, health }: { baseUrl: string; health: HealthResponse }) {
  return (
    <div className="flex items-center justify-between text-sm bg-[var(--color-panel)] border border-[var(--color-border)] rounded px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-[var(--color-good)] animate-pulse" />
        <span className="text-[var(--color-dim)]">connected to</span>
        <span className="font-mono">{baseUrl}</span>
        <span className="text-[var(--color-dim)]">·</span>
        <span className="font-mono text-[var(--color-dim)]">
          {health.machine.cores} cores · {health.machine.totalMemGB.toFixed(1)} GB · max {health.machine.recommendedParallel}× parallel
        </span>
      </div>
      <span className="text-[var(--color-dim)] font-mono text-xs">v{health.version}</span>
    </div>
  );
}

interface RunFormProps {
  url: string; setUrl: (v: string) => void;
  runs: number; setRuns: (v: number) => void;
  presetGroup: string; setPresetGroup: (v: string) => void;
  parallelMode: '1' | 'auto'; setParallelMode: (v: '1' | 'auto') => void;
  tag: string; setTag: (v: string) => void;
  presetsData: PresetsResponse;
  onStart: () => void;
  showWarnIfParallel: boolean;
}

function RunForm(props: RunFormProps) {
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-6 space-y-5">
      <div>
        <label className="block text-sm text-[var(--color-dim)] mb-1.5">URL to audit</label>
        <input
          type="url"
          value={props.url}
          onChange={(e) => props.setUrl(e.target.value)}
          placeholder="https://example.com"
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-cyan)]"
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm text-[var(--color-dim)] mb-1.5">Runs per preset</label>
          <input
            type="number"
            min={1}
            max={200}
            value={props.runs}
            onChange={(e) => props.setRuns(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-cyan)]"
          />
        </div>

        <div>
          <label className="block text-sm text-[var(--color-dim)] mb-1.5">Preset group</label>
          <select
            value={props.presetGroup}
            onChange={(e) => props.setPresetGroup(e.target.value)}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-cyan)]"
          >
            {Object.entries(props.presetsData.groups).map(([name, members]) => (
              <option key={name} value={name}>
                {name} ({members.length})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm text-[var(--color-dim)] mb-1.5">Parallelism</label>
          <select
            value={props.parallelMode}
            onChange={(e) => props.setParallelMode(e.target.value as '1' | 'auto')}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-cyan)]"
          >
            <option value="1">Serial (most accurate)</option>
            <option value="auto">Auto (faster, mild TBT noise)</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm text-[var(--color-dim)] mb-1.5">Tag (optional, for comparing later)</label>
        <input
          value={props.tag}
          onChange={(e) => props.setTag(e.target.value)}
          placeholder="e.g. before-deploy"
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-cyan)]"
        />
      </div>

      <button
        onClick={props.onStart}
        disabled={!props.url}
        className="w-full px-4 py-3 bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Run swarm
      </button>
    </div>
  );
}

interface LiveProgressProps {
  presets: PresetState[];
  total: number;
  totalDone: number;
  elapsedMs: number;
  etaMs: number;
  finished: boolean;
}

function LiveProgress({ presets, total, totalDone, elapsedMs, etaMs, finished }: LiveProgressProps) {
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg p-6 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">{finished ? 'Done' : 'Running'}</h2>
        <div className="text-sm font-mono text-[var(--color-dim)]">
          {totalDone}/{total} · {(elapsedMs / 1000).toFixed(1)}s
          {!finished && totalDone > 0 && ` · ETA ${(etaMs / 1000).toFixed(0)}s`}
        </div>
      </div>
      <div className="space-y-2">
        {presets.map((p) => {
          const sorted = p.lcps.slice().sort((a, b) => a - b);
          const p50 = percentile(sorted, 50);
          const p90 = percentile(sorted, 90);
          const pct = (p.done / p.total) * 100;
          return (
            <div key={p.name} className="grid grid-cols-[140px_1fr_90px_140px] gap-3 items-center">
              <div className={`text-sm font-mono ${p.active ? 'text-[var(--color-cyan)]' : 'text-[var(--color-text)]'}`}>
                {p.active ? '●' : ' '} {p.name}
              </div>
              <div className="h-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded overflow-hidden">
                <div
                  className="h-full bg-[var(--color-cyan)] transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="text-xs font-mono text-[var(--color-dim)]">
                {p.done}/{p.total}
              </div>
              <div className="text-xs font-mono text-[var(--color-dim)] flex gap-3">
                <span>p50 {fmt(Number.isFinite(p50) ? p50 : undefined, 'ms')}</span>
                <span>p90 {fmt(Number.isFinite(p90) ? p90 : undefined, 'ms')}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResultsView({ aggregate, presetStates }: { aggregate: RunSummary; presetStates: PresetState[] }) {
  return (
    <div className="space-y-6">
      {presetStates.map((p) => {
        const stats = aggregate.byPreset[p.name];
        if (!stats) return null;
        return (
          <div key={p.name} className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg overflow-hidden">
            <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-baseline justify-between">
              <div>
                <span className="font-semibold">{p.name}</span>
                <span className="text-[var(--color-dim)] text-sm ml-3">{p.label}</span>
              </div>
              <span className="text-[var(--color-dim)] text-xs font-mono">n = {p.done - p.failed}</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--color-dim)] text-xs uppercase tracking-wide">
                  <th className="text-left py-2 px-4">Metric</th>
                  <th className="text-right py-2 px-3">p50</th>
                  <th className="text-right py-2 px-3">p75</th>
                  <th className="text-right py-2 px-3">p90</th>
                  <th className="text-right py-2 px-3">p99</th>
                  <th className="text-right py-2 px-3">min</th>
                  <th className="text-right py-2 px-3">max</th>
                  <th className="text-right py-2 px-3">σ</th>
                </tr>
              </thead>
              <tbody>
                {METRIC_SPECS.map((spec) => {
                  const s = stats[spec.key];
                  if (!s) return null;
                  const cls = (v: number) => `text-right py-1.5 px-3 font-mono ${colorClass(v, spec)}`;
                  return (
                    <tr key={spec.key} className="border-t border-[var(--color-border)]">
                      <td className="py-1.5 px-4 font-medium">{spec.label}</td>
                      <td className={cls(s.p50)}>{fmt(s.p50, spec.unit)}</td>
                      <td className={cls(s.p75)}>{fmt(s.p75, spec.unit)}</td>
                      <td className={cls(s.p90)}>{fmt(s.p90, spec.unit)}</td>
                      <td className={cls(s.p99)}>{fmt(s.p99, spec.unit)}</td>
                      <td className="text-right py-1.5 px-3 font-mono text-[var(--color-dim)]">{fmt(s.min, spec.unit)}</td>
                      <td className="text-right py-1.5 px-3 font-mono text-[var(--color-dim)]">{fmt(s.max, spec.unit)}</td>
                      <td className="text-right py-1.5 px-3 font-mono text-[var(--color-dim)]">{fmt(s.stddev, spec.unit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function SuggestionsView({ links, sources, onPick }: { links: Suggestion[]; sources: string[]; onPick: (u: string) => void }) {
  if (links.length === 0) {
    return (
      <div className="text-sm text-[var(--color-dim)] italic px-2">
        No related pages found via static HTML, sitemap, or framework routes. Likely an auth-gated SPA.
      </div>
    );
  }
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b border-[var(--color-border)]">
        <span className="font-semibold">Other pages you might want to test</span>
        <span className="text-[var(--color-dim)] text-xs ml-3 font-mono">sources: {sources.join(', ')}</span>
      </div>
      <ul className="divide-y divide-[var(--color-border)]">
        {links.map((l) => (
          <li key={l.url} className="px-5 py-2.5 flex items-center justify-between hover:bg-[var(--color-bg)] transition">
            <div className="flex flex-col">
              <span className="font-mono text-sm">{l.path}</span>
              {l.text && <span className="text-xs text-[var(--color-dim)]">{l.text}</span>}
            </div>
            <button
              onClick={() => onPick(l.url)}
              className="text-xs text-[var(--color-cyan)] hover:underline"
            >
              run this →
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ErrorBanner({ error }: { error: string }) {
  return (
    <div className="border border-[var(--color-poor)] bg-red-950/30 text-[var(--color-poor)] rounded p-3 text-sm font-mono">
      {error}
    </div>
  );
}

interface WhyPanelProps {
  diagnosis: DiagnosisResponse;
  reasonStatus: 'idle' | 'streaming' | 'done' | 'error';
  reasonText: string;
  reasonModel?: string;
  reasonBackendUsed?: 'openai' | 'local-ai';
  reasonBackendPref: 'auto' | 'openai' | 'local-ai';
  setReasonBackendPref: (b: 'auto' | 'openai' | 'local-ai') => void;
  reasonError: string | null;
  onAskReason: () => void;
}

function WhyPanel({ diagnosis, reasonStatus, reasonText, reasonModel, reasonBackendUsed, reasonBackendPref, setReasonBackendPref, reasonError, onAskReason }: WhyPanelProps) {
  const presets = Object.entries(diagnosis.byPreset);
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-panel)] rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-baseline justify-between">
        <span className="font-semibold">Why these numbers?</span>
        <div className="flex items-center gap-3">
          {reasonStatus === 'idle' && (
            <>
              <select
                value={reasonBackendPref}
                onChange={(e) => setReasonBackendPref(e.target.value as 'auto' | 'openai' | 'local-ai')}
                className="text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-dim)] focus:outline-none focus:border-[var(--color-cyan)]"
                title="LLM backend"
              >
                <option value="auto">backend: auto</option>
                <option value="local-ai">local-ai (Claude CLI)</option>
                <option value="openai">OpenAI-compatible</option>
              </select>
              <button
                onClick={onAskReason}
                className="text-xs px-3 py-1.5 bg-[var(--color-cyan)] text-black rounded font-medium hover:opacity-90 transition"
              >
                Ask LLM ✨
              </button>
            </>
          )}
          {reasonStatus === 'streaming' && (
            <span className="text-xs text-[var(--color-dim)] flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--color-cyan)] animate-pulse" />
              streaming via {reasonBackendUsed ?? '...'}
            </span>
          )}
          {reasonStatus === 'done' && (
            <span className="text-xs text-[var(--color-dim)] font-mono">
              {reasonBackendUsed && `${reasonBackendUsed} · `}
              {reasonModel}
            </span>
          )}
        </div>
      </div>

      {(reasonText || reasonStatus !== 'idle') && (
        <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
          {reasonStatus === 'error' && reasonError && (
            <div className="text-[var(--color-poor)] text-sm font-mono">Reasoning failed: {reasonError}</div>
          )}
          {reasonText && (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">
              {reasonText}
              {reasonStatus === 'streaming' && <span className="inline-block w-2 h-4 bg-[var(--color-cyan)] ml-0.5 align-middle animate-pulse" />}
            </p>
          )}
        </div>
      )}

      <div className="divide-y divide-[var(--color-border)]">
        {presets.map(([name, data]) => (
          <PresetWhy key={name} name={name} data={data} />
        ))}
      </div>
    </div>
  );
}

function PresetWhy({ name, data }: { name: string; data: DiagnosisResponse['byPreset'][string] }) {
  const { diagnosis, topOpportunities } = data;
  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <span className="font-semibold">{name}</span>
          <span className="text-[var(--color-dim)] text-xs ml-3 font-mono">n = {diagnosis.okRuns}</span>
        </div>
        {diagnosis.presetLabel && <span className="text-xs text-[var(--color-dim)]">{diagnosis.presetLabel}</span>}
      </div>

      {diagnosis.lcpElement && (
        <div className="text-sm">
          <span className="text-[var(--color-dim)]">LCP element: </span>
          <span className="font-mono text-[var(--color-warn)]">{diagnosis.lcpElement.nodeLabel ?? diagnosis.lcpElement.selector ?? '(unknown)'}</span>
          {diagnosis.lcpElement.snippet && (
            <div className="ml-4 text-xs text-[var(--color-dim)] font-mono mt-0.5 truncate">{diagnosis.lcpElement.snippet}</div>
          )}
        </div>
      )}

      {diagnosis.lcpPhases && diagnosis.lcpPhases.length > 0 && (
        <div className="text-sm flex flex-wrap gap-x-4 gap-y-1">
          <span className="text-[var(--color-dim)]">LCP phases:</span>
          {diagnosis.lcpPhases.map((p) => {
            const pct = parseInt(p.percent, 10);
            const color = pct >= 40 ? 'text-[var(--color-poor)]' : pct >= 25 ? 'text-[var(--color-warn)]' : 'text-[var(--color-dim)]';
            return (
              <span key={p.phase} className={`font-mono text-xs ${color}`}>
                {p.phase} {p.percent} ({p.medianMs >= 1000 ? `${(p.medianMs / 1000).toFixed(1)}s` : `${Math.round(p.medianMs)}ms`})
              </span>
            );
          })}
        </div>
      )}

      {topOpportunities.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[var(--color-dim)] text-xs uppercase tracking-wide">
              <th className="text-left py-1.5">Opportunity</th>
              <th className="text-left py-1.5">Impact</th>
              <th className="text-left py-1.5">Top item</th>
            </tr>
          </thead>
          <tbody>
            {topOpportunities.map((op, i) => (
              <tr key={i} className="border-t border-[var(--color-border)]">
                <td className="py-1.5 pr-3 font-medium">{op.label}</td>
                <td className="py-1.5 pr-3 font-mono text-xs text-[var(--color-warn)]">{op.savings || op.display || '—'}</td>
                <td className="py-1.5 font-mono text-xs text-[var(--color-dim)] truncate max-w-[420px]">
                  {op.topItems[0]?.label ?? '—'}
                  {op.topItems[0]?.detail && <span className="ml-1 text-[var(--color-dim)]">({op.topItems[0].detail})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
