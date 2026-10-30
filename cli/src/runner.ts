import { EventEmitter } from 'node:events';
import { launch, type LaunchedChrome } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import type { Preset } from './presets.js';
import { captureAuditsFromLhr, type CapturedAudit } from './audits.js';
import { captureLighthouseProvenance, type LighthouseProvenance } from './provenance.js';

export interface MetricSet {
  lcp?: number;
  cls?: number;
  inp?: number;
  tbt?: number;
  fcp?: number;
  ttfb?: number;
  si?: number;
  performance_score?: number;
}

/**
 * A Lighthouse run is only a valid product performance observation if it has at
 * least one numeric metric. Auth walls (Cloudflare Access 401), error pages,
 * and blank redirects can complete without throwing but yield no performance
 * data — without this guard the report counts them as "ok".
 */
export function hasValidMetrics(metrics: MetricSet | undefined): boolean {
  if (!metrics) return false;
  return Object.values(metrics).some((v) => typeof v === 'number' && Number.isFinite(v));
}

export interface RunResult {
  preset: Preset;
  startedAt: number;
  finishedAt: number;
  metrics?: MetricSet;
  error?: string;
}

export interface ScriptArtifact {
  url: string;
  content: string;
}

export interface RunResultWithArtifact extends RunResult {
  scripts?: ScriptArtifact[];
  audits?: CapturedAudit[];
  finalUrl?: string;
  provenance?: LighthouseProvenance;
}

const CHROME_FLAGS = ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'];

interface RunOnceOptions {
  captureScripts?: boolean;
  captureAudits?: boolean;
}

export type RunnerEvent =
  | { type: 'start'; total: number; presets: Preset[]; parallel: number }
  | { type: 'run-start'; preset: Preset; presetIndex: number; runIndex: number }
  | {
      type: 'run-complete';
      result: RunResultWithArtifact;
      preset: Preset;
      presetIndex: number;
      runIndex: number;
      done: number;
      total: number;
    }
  | { type: 'preset-complete'; preset: Preset; results: RunResultWithArtifact[] }
  | { type: 'all-complete'; elapsedMs: number; results: RunResultWithArtifact[] }
  | { type: 'cancelled'; results: RunResultWithArtifact[] };

export interface SwarmOptions {
  url: string;
  presets: Preset[];
  runs: number;
  parallel?: number;
  captureScripts?: boolean;
  captureAudits?: boolean;
}

function extractMetrics(
  audits: Parameters<typeof captureAuditsFromLhr>[0],
  lhr: { categories: { performance?: { score?: number } } }
): MetricSet {
  const numeric = (id: string): number | undefined => {
    const a = audits[id];
    return typeof a?.numericValue === 'number' ? a.numericValue : undefined;
  };
  return {
    lcp: numeric('largest-contentful-paint'),
    cls: numeric('cumulative-layout-shift'),
    inp: numeric('interaction-to-next-paint') ?? numeric('experimental-interaction-to-next-paint'),
    tbt: numeric('total-blocking-time'),
    fcp: numeric('first-contentful-paint'),
    ttfb: numeric('server-response-time'),
    si: numeric('speed-index'),
    performance_score:
      typeof lhr.categories.performance?.score === 'number'
        ? lhr.categories.performance.score * 100
        : undefined,
  };
}

function extractScripts(result: unknown): ScriptArtifact[] | undefined {
  const artifacts = (result as { artifacts?: { Scripts?: { url?: string; content?: string }[] } })
    .artifacts;
  if (!Array.isArray(artifacts?.Scripts)) return undefined;
  return artifacts.Scripts.filter(
    (s) => typeof s.content === 'string' && typeof s.url === 'string'
  ).map((s) => ({ url: s.url!, content: s.content! }));
}

export class SwarmRunner extends EventEmitter {
  private cancelled = false;
  private activeChromes = new Set<LaunchedChrome>();

  /**
   * Cancel an in-progress swarm. Sets the cancellation flag so the run loop
   * stops scheduling new audits, then kills every currently-active Chrome
   * child process so in-flight Lighthouse runs terminate promptly.
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const chrome of this.activeChromes) {
      try {
        void chrome.kill();
      } catch {
        /* best-effort */
      }
    }
    this.activeChromes.clear();
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  private async runOnce(
    url: string,
    preset: Preset,
    opts: RunOnceOptions = {}
  ): Promise<RunResultWithArtifact> {
    const startedAt = Date.now();
    let chrome: LaunchedChrome | undefined;
    let provenance: LighthouseProvenance | undefined;
    try {
      chrome = await launch({ chromeFlags: CHROME_FLAGS });
      this.activeChromes.add(chrome);
      // If cancel() fired while Chrome was launching, kill it immediately.
      if (this.cancelled) {
        throw new Error('Swarm cancelled');
      }
      const result = await lighthouse(
        url,
        {
          port: chrome.port,
          logLevel: 'silent',
          output: 'json',
        },
        {
          extends: 'lighthouse:default',
          settings: {
            onlyCategories: ['performance'],
            formFactor: preset.formFactor,
            throttling: preset.throttling,
            screenEmulation: preset.screenEmulation,
          },
        }
      );
      if (!result) throw new Error('Lighthouse returned no result');
      const lhr = result.lhr;
      provenance = {
        ...captureLighthouseProvenance(lhr),
        nodeVersion: process.version,
        chromeFlags: [...CHROME_FLAGS],
      };
      if (lhr.runtimeError) {
        throw new Error(
          `Lighthouse runtime error: ${lhr.runtimeError.code} — ${lhr.runtimeError.message}`
        );
      }
      const audits = lhr.audits;
      const metrics = extractMetrics(audits as Parameters<typeof captureAuditsFromLhr>[0], lhr);
      // Reject non-page and empty measurements: a Lighthouse run that completes
      // without error but yields no performance metrics (e.g. a Cloudflare Access
      // 401 page, a redirect to an auth wall, or a blank/error document) is not a
      // valid product performance observation. Without this guard, the report
      // counts these as "ok" and the Console retains a misleading score.
      if (!hasValidMetrics(metrics)) {
        throw new Error(
          `No performance metrics in Lighthouse result — likely a non-page response (auth wall, error page, or redirect). Final URL: ${lhr.finalDisplayedUrl ?? lhr.finalUrl ?? url}`
        );
      }
      const out: RunResultWithArtifact = {
        preset,
        startedAt,
        finishedAt: Date.now(),
        metrics,
        provenance,
        finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl,
      };
      if (opts.captureScripts) {
        // Lighthouse Scripts artifact contains the bundled JS source for every script
        // on the page. Perfect for framework route detection — works even on auth-gated SPAs.
        out.scripts = extractScripts(result);
      }
      if (opts.captureAudits) {
        out.audits = captureAuditsFromLhr(audits as Parameters<typeof captureAuditsFromLhr>[0]);
      }
      return out;
    } catch (err) {
      return {
        preset,
        startedAt,
        finishedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
        provenance,
      };
    } finally {
      if (chrome) {
        this.activeChromes.delete(chrome);
        await chrome.kill();
      }
    }
  }

  async run(opts: SwarmOptions): Promise<RunResultWithArtifact[]> {
    const parallel = Math.max(1, Math.min(opts.parallel ?? 1, opts.presets.length));
    const total = opts.presets.length * opts.runs;
    const startedAt = Date.now();
    this.emit('event', {
      type: 'start',
      total,
      presets: opts.presets,
      parallel,
    } satisfies RunnerEvent);

    const allResults: RunResultWithArtifact[] = [];
    let done = 0;

    const runPreset = async (
      preset: Preset,
      presetIndex: number
    ): Promise<RunResultWithArtifact[]> => {
      const presetResults: RunResultWithArtifact[] = [];
      // Only capture scripts on the first successful run per preset — saves memory (bundles can be MB).
      let scriptsCaptured = false;
      for (let i = 0; i < opts.runs; i++) {
        if (this.cancelled) break;
        this.emit('event', {
          type: 'run-start',
          preset,
          presetIndex,
          runIndex: i,
        } satisfies RunnerEvent);
        const r = await this.runOnce(opts.url, preset, {
          captureScripts: opts.captureScripts && !scriptsCaptured,
          captureAudits: opts.captureAudits,
        });
        if (r.scripts) scriptsCaptured = true;
        presetResults.push(r);
        allResults.push(r);
        done++;
        this.emit('event', {
          type: 'run-complete',
          result: r,
          preset,
          presetIndex,
          runIndex: i,
          done,
          total,
        } satisfies RunnerEvent);
      }
      this.emit('event', {
        type: 'preset-complete',
        preset,
        results: presetResults,
      } satisfies RunnerEvent);
      return presetResults;
    };

    // Worker pool across presets.
    const queue = opts.presets.map((p, i) => ({ preset: p, presetIndex: i }));
    const workers: Promise<void>[] = [];
    let cursor = 0;
    const next = async (): Promise<void> => {
      while (cursor < queue.length) {
        if (this.cancelled) break;
        const job = queue[cursor++];
        await runPreset(job.preset, job.presetIndex);
      }
    };
    for (let w = 0; w < parallel; w++) {
      workers.push(next());
    }
    await Promise.all(workers);

    // If the swarm was cancelled, emit a cancelled event instead of all-complete
    // and return the partial results collected so far.
    if (this.cancelled) {
      this.emit('event', {
        type: 'cancelled',
        results: allResults,
      } satisfies RunnerEvent);
      return allResults;
    }

    const elapsedMs = Date.now() - startedAt;
    this.emit('event', {
      type: 'all-complete',
      elapsedMs,
      results: allResults,
    } satisfies RunnerEvent);
    return allResults;
  }
}
