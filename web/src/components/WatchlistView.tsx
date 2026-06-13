import { useEffect, useState } from 'react';
import { AgentClient, probeAgent, type HealthResponse } from '../lib/agent.js';

type WatchStatus = 'regressed' | 'improved' | 'stable' | 'stale' | 'missing';

interface QueueItem {
  url: string;
  label?: string;
  preset: string;
  status: WatchStatus;
  baselineTag?: string;
  latestRunAt?: number;
  message: string;
}

interface WatchlistResponse {
  queue: QueueItem[];
  summary: {
    regressed: number;
    improved: number;
    stale: number;
    missing: number;
    stable: number;
  };
  refreshedAt: number | null;
}

const statusColor: Record<WatchStatus, string> = {
  regressed: 'var(--color-poor)',
  improved: 'var(--color-good)',
  stale: 'var(--color-warn)',
  missing: 'var(--color-warn)',
  stable: 'var(--color-dim)',
};

export default function WatchlistView() {
  const [status, setStatus] = useState<'probing' | 'disconnected' | 'ready'>('probing');
  const [client, setClient] = useState<AgentClient | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [data, setData] = useState<WatchlistResponse | null>(null);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [preset, setPreset] = useState('mobile-mid');
  const [baselineTag, setBaselineTag] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async (c: AgentClient) => {
    const res = await fetch(`${c.baseUrl}/api/watchlist`);
    if (!res.ok) throw new Error(`watchlist: HTTP ${res.status}`);
    setData((await res.json()) as WatchlistResponse);
  };

  useEffect(() => {
    void (async () => {
      const probe = await probeAgent();
      if (!probe) {
        setStatus('disconnected');
        return;
      }
      const c = new AgentClient(probe.url);
      setClient(c);
      setHealth(probe.health);
      setStatus('ready');
      try {
        await load(c);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  const refresh = async () => {
    if (!client) return;
    setError(null);
    try {
      const res = await fetch(`${client.baseUrl}/api/watchlist/refresh`, { method: 'POST' });
      if (!res.ok) throw new Error(`refresh: HTTP ${res.status}`);
      setData((await res.json()) as WatchlistResponse);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const addUrl = async () => {
    if (!client || !url.trim()) return;
    setError(null);
    try {
      const res = await fetch(`${client.baseUrl}/api/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          label: label.trim() || undefined,
          preset,
          baselineTag: baselineTag.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(`add: HTTP ${res.status}`);
      setData((await res.json()) as WatchlistResponse);
      setUrl('');
      setLabel('');
      setBaselineTag('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeUrl = async (target: string) => {
    if (!client) return;
    setError(null);
    try {
      const res = await fetch(`${client.baseUrl}/api/watchlist?url=${encodeURIComponent(target)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`remove: HTTP ${res.status}`);
      setData((await res.json()) as WatchlistResponse);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (status === 'probing') {
    return <p className="text-sm text-[var(--color-dim)]">Connecting to local agent…</p>;
  }

  if (status === 'disconnected') {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-6 text-sm">
        <p className="text-[var(--color-warn)]">Local agent not reachable.</p>
        <p className="text-[var(--color-dim)] mt-2">
          Start <code className="mono">psi-swarm serve</code>, then reload this page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--color-dim)]">
        <span>
          Agent {health?.version} · {data?.queue.length ?? 0} watched URL(s)
          {data?.refreshedAt ? ` · refreshed ${new Date(data.refreshedAt).toLocaleString()}` : ''}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="px-3 py-1.5 rounded border border-[var(--color-border)] hover:border-[var(--color-cyan)] transition"
        >
          Refresh queue
        </button>
      </div>

      {error && <p className="text-sm text-[var(--color-poor)]">{error}</p>}

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5">
        <h2 className="text-sm font-semibold mb-3">Add to watchlist</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Optional label"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          />
          <input
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            placeholder="Preset (mobile-mid)"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          />
          <input
            value={baselineTag}
            onChange={(e) => setBaselineTag(e.target.value)}
            placeholder="Baseline tag (optional)"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => void addUrl()}
          className="mt-4 px-4 py-2 rounded bg-[var(--color-cyan)]/15 text-[var(--color-cyan)] border border-[var(--color-cyan)]/30 hover:bg-[var(--color-cyan)]/25 transition text-sm font-medium"
        >
          Watch URL
        </button>
      </section>

      {data && (
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--color-border)] text-sm text-[var(--color-dim)]">
            {data.summary.regressed} regressed · {data.summary.improved} improved · {data.summary.stale} stale ·{' '}
            {data.summary.missing} missing · {data.summary.stable} stable
          </div>
          {data.queue.length === 0 ? (
            <p className="p-5 text-sm text-[var(--color-dim)]">No watched URLs yet.</p>
          ) : (
            <ul>
              {data.queue.map((item) => (
                <li
                  key={item.url}
                  className="px-5 py-4 border-b border-[var(--color-border)]/50 last:border-0 flex flex-wrap items-start justify-between gap-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs uppercase tracking-wide font-semibold"
                        style={{ color: statusColor[item.status] }}
                      >
                        {item.status}
                      </span>
                      <span className="text-xs text-[var(--color-dim)]">{item.preset}</span>
                    </div>
                    <div className="font-medium mt-1">{item.label ?? item.url}</div>
                    {item.label && <div className="text-xs text-[var(--color-dim)] break-all">{item.url}</div>}
                    <div className="text-sm text-[var(--color-dim)] mt-1">{item.message}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void removeUrl(item.url)}
                    className="text-xs text-[var(--color-dim)] hover:text-[var(--color-poor)]"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
