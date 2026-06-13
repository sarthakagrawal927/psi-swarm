import { GALLERY_ENTRIES, deltaLabel, formatMs } from '../data/gallery.js';

function MetricCompare({
  label,
  before,
  after,
  unit,
  lowerIsBetter = true,
}: {
  label: string;
  before: number;
  after: number;
  unit: 'ms' | 'score' | 'index';
  lowerIsBetter?: boolean;
}) {
  const fmt = (v: number) => {
    if (unit === 'ms') return formatMs(v);
    if (unit === 'index') return v.toFixed(3);
    return v.toFixed(0);
  };
  const improved = lowerIsBetter ? after < before : after > before;
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-baseline text-sm py-1 border-b border-[var(--color-border)]/40 last:border-0">
      <span className="text-[var(--color-dim)]">{label}</span>
      <span className="mono text-right">{fmt(before)}</span>
      <span className="mono text-right">{fmt(after)}</span>
      <span className={`mono text-right text-xs ${improved ? 'text-[var(--color-good)]' : 'text-[var(--color-warn)]'}`}>
        {deltaLabel(before, after, lowerIsBetter)}
      </span>
    </div>
  );
}

export default function GalleryView() {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-4 text-sm text-[var(--color-dim)]">
        Static fixtures only — deterministic demo data for evaluating psi-swarm without running a swarm or exposing local history.
      </div>

      {GALLERY_ENTRIES.map((entry) => (
        <article
          key={entry.id}
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">{entry.title}</h2>
              <p className="text-sm text-[var(--color-dim)] mt-1 break-all">{entry.url}</p>
            </div>
            <span className="text-xs uppercase tracking-wide text-[var(--color-cyan)] border border-[var(--color-cyan)]/30 rounded px-2 py-1">
              fixture
            </span>
          </div>

          <p className="text-sm mb-4">{entry.summary}</p>
          <p className="text-sm text-[var(--color-dim)] mb-6">{entry.narrative}</p>

          <div className="rounded-lg border border-[var(--color-border)]/60 p-4">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 text-xs uppercase tracking-wide text-[var(--color-dim)] mb-2">
              <span>Metric ({entry.before.preset})</span>
              <span className="text-right">{entry.before.tag}</span>
              <span className="text-right">{entry.after.tag}</span>
              <span className="text-right">Δ</span>
            </div>
            <MetricCompare label="LCP p75" before={entry.before.lcpP75Ms} after={entry.after.lcpP75Ms} unit="ms" />
            <MetricCompare
              label="Perf score p75"
              before={entry.before.perfScoreP75}
              after={entry.after.perfScoreP75}
              unit="score"
              lowerIsBetter={false}
            />
            <MetricCompare label="CLS p75" before={entry.before.clsP75} after={entry.after.clsP75} unit="index" />
            <MetricCompare label="TBT p75" before={entry.before.tbtP75Ms} after={entry.after.tbtP75Ms} unit="ms" />
          </div>
        </article>
      ))}
    </div>
  );
}
