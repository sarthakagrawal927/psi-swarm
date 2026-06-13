import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SwarmRunner, type RunResultWithArtifact, type RunnerEvent } from './runner.js';
import { HistoryDB } from './db.js';
import { PRESETS, PRESET_GROUPS, resolvePresets } from './presets.js';
import { profileMachine, resolveParallelism } from './machine.js';
import { discover, rank, type DiscoveredLink } from './discover.js';
import { detectFrameworkRoutes } from './routes.js';
import { computeStats } from './stats.js';
import { diagnosePreset, rankOpportunities, formatAggregatedAudit, type Diagnosis } from './diagnose.js';
import { streamReasoning, probeLocalAi, type ReasonBackend } from './reason.js';
import { domainRatingsForOrigins } from './ahrefs.js';
import { isCloudflarePlatformHost, hostnameFromUrl } from './domain.js';
import { createDomainRatingScheduler } from './domain-rating-scheduler.js';

interface RunRecord {
  id: string;
  url: string;
  presetNames: string[];
  runs: number;
  parallel: number;
  tag?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  events: RunnerEvent[];
  results: RunResultWithArtifact[];
  startedAt: number;
  finishedAt?: number;
  subscribers: Set<ServerResponse>;
  errorMessage?: string;
}

const runs = new Map<string, RunRecord>();
const VERSION = '0.2.0';

// Report registry: URL → file paths (newest first), built from any directory
// where psi-swarm has written --output html files.
const REPORT_DIRS = [
  '/tmp/psi-coverage',
  '/tmp/psi-more',
  '/tmp/psi-deploy',
  '/tmp/psi-insights',
  '/tmp/psi-fast',
  '/tmp/psi-populate',
  '/tmp/psi-populate2',
  join(homedir(), '.psi-swarm', 'reports'),
];
const META_URL_RE = /<meta\s+name=["']psi-url["']\s+content=["']([^"']+)["']/i;
const META_GENERATED_RE = /<meta\s+name=["']psi-generated["']\s+content=["']([^"']+)["']/i;
const TITLE_URL_RE = /<title>psi-swarm report\s*·\s*([^<]+)<\/title>/i;

interface ReportEntry { path: string; mtime: number; url: string; generatedAt?: string; }
let reportRegistry: Map<string, ReportEntry[]> | null = null;
let reportRegistryBuiltAt = 0;
const REPORT_REGISTRY_TTL_MS = 30_000;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function buildReportRegistry(): Map<string, ReportEntry[]> {
  const registry = new Map<string, ReportEntry[]>();
  for (const dir of REPORT_DIRS) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.html')) continue;
      const path = join(dir, f);
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size < 500) continue;
        // Read only the head — URL is in title/meta near the top.
        const content = readFileSync(path, 'utf-8');
        const head = content.slice(0, 4000);
        // Prefer explicit meta, fall back to the title's "psi-swarm report · <url>" pattern.
        const metaMatch = head.match(META_URL_RE);
        const titleMatch = !metaMatch ? head.match(TITLE_URL_RE) : null;
        const url = metaMatch ? decodeHtmlEntities(metaMatch[1]) : titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : null;
        if (!url) continue;
        const genMatch = head.match(META_GENERATED_RE);
        const generatedAt = genMatch ? genMatch[1] : undefined;
        const arr = registry.get(url) ?? [];
        arr.push({ path, mtime: stat.mtimeMs, url, generatedAt });
        registry.set(url, arr);
      } catch { /* skip */ }
    }
  }
  for (const entries of registry.values()) entries.sort((a, b) => b.mtime - a.mtime);
  return registry;
}

function getReportRegistry(): Map<string, ReportEntry[]> {
  if (!reportRegistry || Date.now() - reportRegistryBuiltAt > REPORT_REGISTRY_TTL_MS) {
    reportRegistry = buildReportRegistry();
    reportRegistryBuiltAt = Date.now();
  }
  return reportRegistry;
}

function send(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  res.end(JSON.stringify(body));
}

function readJson<T>(req: IncomingMessage, maxBytes = 64 * 1024): Promise<T> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({} as T);
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(new Error(`Invalid JSON: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function newRunId(): string {
  return randomBytes(6).toString('hex');
}

function startRun(record: RunRecord): void {
  const presets = resolvePresets(record.presetNames.join(','));
  const runner = new SwarmRunner();
  record.status = 'running';
  runner.on('event', (e: RunnerEvent) => {
    record.events.push(e);
    if (e.type === 'run-complete') record.results.push(e.result);
    broadcast(record, e);
  });
  runner
    .run({
      url: record.url,
      presets,
      runs: record.runs,
      parallel: record.parallel,
      captureScripts: true,
      captureAudits: true,
    })
    .then((results) => {
      record.results = results;
      record.status = 'complete';
      record.finishedAt = Date.now();
      // Persist to SQLite history.
      try {
        const db = new HistoryDB();
        for (const r of results) {
          db.insert({
            url: record.url,
            preset: r.preset.name,
            started_at: r.startedAt,
            finished_at: r.finishedAt,
            metrics: r.metrics,
            error: r.error,
            tag: record.tag,
          });
        }
        db.close();
      } catch {
        /* don't fail the run on persistence error */
      }
      // Don't re-broadcast all-complete — the runner already emitted it through the
      // event listener above. Just tidy up open SSE connections.
      closeSubscribers(record);
    })
    .catch((err: Error) => {
      record.status = 'error';
      record.errorMessage = err.message;
      record.finishedAt = Date.now();
      // Runner won't have emitted all-complete on error path, so send one synthetic
      // signal so connected clients can move out of "running" state.
      broadcast(record, { type: 'all-complete', elapsedMs: 0, results: record.results } as RunnerEvent);
      closeSubscribers(record);
    });
}

function broadcast(record: RunRecord, event: RunnerEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const sub of record.subscribers) {
    try {
      sub.write(payload);
    } catch {
      record.subscribers.delete(sub);
    }
  }
}

function closeSubscribers(record: RunRecord): void {
  for (const sub of record.subscribers) {
    try {
      sub.end();
    } catch {
      /* ignore */
    }
  }
  record.subscribers.clear();
}

async function suggestionsFor(url: string, scripts: { url: string; content: string }[] | undefined): Promise<{
  links: DiscoveredLink[];
  sources: string[];
}> {
  const allLinks = new Map<string, DiscoveredLink>();
  const sources: string[] = [];
  try {
    const { links, source } = await discover(url, { maxLinks: 50 });
    if (links.length > 0) {
      sources.push(source);
      for (const l of links) if (!allLinks.has(l.url)) allLinks.set(l.url, l);
    }
  } catch {
    /* skip */
  }
  if (scripts && scripts.length > 0) {
    try {
      const r = await detectFrameworkRoutes(url, scripts);
      if (r.routes.length > 0) {
        sources.push(`framework:${r.framework}`);
        for (const l of r.routes) if (!allLinks.has(l.url)) allLinks.set(l.url, l);
      }
    } catch {
      /* skip */
    }
  }
  return { links: rank(Array.from(allLinks.values())).slice(0, 25), sources };
}

export interface ServeOptions {
  port: number;
  host: string;
  origin: string;
  token?: string;
}

export function createAgentServer(opts: ServeOptions): { listen: () => Promise<void>; close: () => Promise<void> } {
  const checkAuth = (req: IncomingMessage, url: NodeURL): boolean => {
    if (!opts.token) return true;
    const q = url.searchParams.get('token');
    const auth = req.headers.authorization;
    if (q === opts.token) return true;
    if (auth && auth === `Bearer ${opts.token}`) return true;
    return false;
  };

  const isIdle = (): boolean => {
    for (const record of runs.values()) {
      if (record.status === 'running' || record.status === 'pending') return false;
    }
    return true;
  };

  const domainRatingScheduler = createDomainRatingScheduler({
    isIdle,
    onRefresh: ({ domains, refreshedAt }) => {
      console.log(`[psi-swarm] Ahrefs DR refreshed for ${domains} custom domain(s) · ${new Date(refreshedAt).toISOString()}`);
    },
    onError: (err) => {
      console.warn(`[psi-swarm] Ahrefs DR refresh failed: ${err.message}`);
    },
  });

  const server = createServer(async (req, res) => {
    const url = new NodeURL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', opts.origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      res.end();
      return;
    }

    if (!checkAuth(req, url)) {
      return send(res, 401, { error: 'Unauthorized' }, opts.origin);
    }

    try {
      // GET /api/health
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return send(
          res,
          200,
          { status: 'ok', version: VERSION, machine: profileMachine() },
          opts.origin,
        );
      }

      // GET /api/presets
      if (req.method === 'GET' && url.pathname === '/api/presets') {
        return send(
          res,
          200,
          { presets: PRESETS, groups: PRESET_GROUPS },
          opts.origin,
        );
      }

      // POST /api/run
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const body = await readJson<{
          url: string;
          runs?: number;
          presets?: string;
          parallel?: number | string;
          tag?: string;
        }>(req);
        if (!body.url || typeof body.url !== 'string') {
          return send(res, 400, { error: 'url is required' }, opts.origin);
        }
        const presetSpec = body.presets ?? 'psi';
        const presets = resolvePresets(presetSpec);
        const runsCount = Number.isInteger(body.runs) ? Number(body.runs) : 5;
        if (runsCount < 1) return send(res, 400, { error: 'runs must be >= 1' }, opts.origin);
        const parallel = resolveParallelism(body.parallel, presets.length);
        const id = newRunId();
        const record: RunRecord = {
          id,
          url: body.url,
          presetNames: presets.map((p) => p.name),
          runs: runsCount,
          parallel,
          tag: body.tag,
          status: 'pending',
          events: [],
          results: [],
          startedAt: Date.now(),
          subscribers: new Set(),
        };
        runs.set(id, record);
        startRun(record);
        return send(res, 202, { runId: id }, opts.origin);
      }

      // GET /api/runs/:id
      const runMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9]+)$/);
      if (req.method === 'GET' && runMatch) {
        const record = runs.get(runMatch[1]);
        if (!record) return send(res, 404, { error: 'run not found' }, opts.origin);
        return send(
          res,
          200,
          {
            id: record.id,
            url: record.url,
            presetNames: record.presetNames,
            runs: record.runs,
            parallel: record.parallel,
            status: record.status,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            error: record.errorMessage,
            results: record.results.map((r) => ({ ...r, scripts: undefined })),
          },
          opts.origin,
        );
      }

      // GET /api/runs/:id/events  (SSE)
      const eventsMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9]+)\/events$/);
      if (req.method === 'GET' && eventsMatch) {
        const record = runs.get(eventsMatch[1]);
        if (!record) return send(res, 404, { error: 'run not found' }, opts.origin);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', opts.origin);
        res.flushHeaders?.();
        // Send buffered events first.
        for (const e of record.events) {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        }
        if (record.status === 'complete' || record.status === 'error') {
          res.end();
          return;
        }
        record.subscribers.add(res);
        req.on('close', () => {
          record.subscribers.delete(res);
        });
        return;
      }

      // GET /api/runs/:id/suggestions
      const suggestionsMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9]+)\/suggestions$/);
      if (req.method === 'GET' && suggestionsMatch) {
        const record = runs.get(suggestionsMatch[1]);
        if (!record) return send(res, 404, { error: 'run not found' }, opts.origin);
        const scripts = record.results.find((r) => r.scripts && r.scripts.length > 0)?.scripts;
        const result = await suggestionsFor(record.url, scripts);
        return send(res, 200, result, opts.origin);
      }

      // GET /api/urls
      if (req.method === 'GET' && url.pathname === '/api/urls') {
        const db = new HistoryDB();
        const out = db.urls();
        db.close();
        return send(res, 200, { urls: out }, opts.origin);
      }

      // GET /api/projects — fleet dashboard view, grouped by origin
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        const windowDays = parseInt(url.searchParams.get('windowDays') ?? '30', 10);
        const db = new HistoryDB();
        try {
          const rows = db.projects(windowDays);
          // Group URL-level rows by URL origin so multiple pages of the same site
          // collapse under one "project" card. The path is derived for display.
          type Page = (typeof rows)[number] & { path: string };
          const byOrigin = new Map<string, Page[]>();
          for (const r of rows) {
            let origin: string;
            let path: string;
            try {
              const u = new URL(r.url);
              origin = u.origin;
              path = (u.pathname || '/') + (u.search || '');
            } catch {
              origin = r.url;
              path = '/';
            }
            const arr = byOrigin.get(origin) ?? [];
            arr.push({ ...r, path });
            byOrigin.set(origin, arr);
          }
          const registry = getReportRegistry();
          const origins = Array.from(byOrigin.keys());
          const dbRatings = domainRatingsForOrigins(origins, db);
          const projects = Array.from(byOrigin.entries()).map(([origin, pages]) => {
            // Attach per-page report info from the registry.
            const enrichedPages = pages.map((p) => {
              const entries = registry.get(p.url) ?? [];
              return {
                ...p,
                reportCount: entries.length,
                latestReportAt: entries[0]?.mtime,
              };
            }).sort((a, b) => a.path.localeCompare(b.path));
            const totalRuns = enrichedPages.reduce((s, p) => s + p.totalRuns, 0);
            const lastRunAt = enrichedPages.reduce((s, p) => Math.max(s, p.lastRunAt), 0);
            const allMobile = enrichedPages.map((p) => p.mobileLcpP75).filter((v): v is number => typeof v === 'number');
            const allDesktop = enrichedPages.map((p) => p.desktopLcpP75).filter((v): v is number => typeof v === 'number');
            const allCls = enrichedPages.map((p) => p.cls).filter((v): v is number => typeof v === 'number');
            const host = hostnameFromUrl(origin);
            const cfPlatform = host ? isCloudflarePlatformHost(host) : false;
            const dr = host ? dbRatings.get(host) : undefined;
            return {
              origin,
              totalRuns,
              lastRunAt,
              pageCount: enrichedPages.length,
              worstMobileLcp: allMobile.length > 0 ? Math.max(...allMobile) : undefined,
              worstDesktopLcp: allDesktop.length > 0 ? Math.max(...allDesktop) : undefined,
              worstCls: allCls.length > 0 ? Math.max(...allCls) : undefined,
              isCloudflarePlatform: cfPlatform,
              // dr.rating === null is the "checked, Ahrefs has no rating" sentinel —
              // expose no rating, but keep fetchedAt so the UI can show '—' vs pending.
              domainRating: dr?.rating ?? undefined,
              domainRatingDomain: dr?.domain,
              domainRatingFetchedAt: dr?.fetchedAt,
              pages: enrichedPages,
            };
          }).sort((a, b) => b.lastRunAt - a.lastRunAt);
          return send(res, 200, { projects }, opts.origin);
        } finally {
          db.close();
        }
      }

      // GET /api/report?url=<url>&which=latest — serve the latest HTML report
      if (req.method === 'GET' && url.pathname === '/api/report') {
        const target = url.searchParams.get('url');
        if (!target) return send(res, 400, { error: 'url required' }, opts.origin);
        const registry = getReportRegistry();
        const entries = registry.get(target);
        if (!entries || entries.length === 0) {
          return send(res, 404, { error: 'no report found for this url' }, opts.origin);
        }
        const which = url.searchParams.get('which') ?? 'latest';
        const idx = which === 'latest' ? 0 : Math.min(parseInt(which, 10) || 0, entries.length - 1);
        const entry = entries[idx];
        try {
          const html = readFileSync(entry.path, 'utf-8');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(html);
        } catch (err) {
          return send(res, 500, { error: (err as Error).message }, opts.origin);
        }
        return;
      }

      // GET /api/reports?url=<url> — list all known reports for a URL
      if (req.method === 'GET' && url.pathname === '/api/reports') {
        const target = url.searchParams.get('url');
        if (!target) return send(res, 400, { error: 'url required' }, opts.origin);
        const registry = getReportRegistry();
        const entries = registry.get(target) ?? [];
        return send(
          res,
          200,
          {
            url: target,
            count: entries.length,
            entries: entries.map((e) => ({ mtime: e.mtime, generatedAt: e.generatedAt })),
          },
          opts.origin,
        );
      }

      // GET /api/projects/history — per-URL timeseries for sparklines
      if (req.method === 'GET' && url.pathname === '/api/projects/history') {
        const u = url.searchParams.get('url');
        if (!u) return send(res, 400, { error: 'url query param required' }, opts.origin);
        const limit = parseInt(url.searchParams.get('limit') ?? '60', 10);
        const db = new HistoryDB();
        const rows = db.history(u, limit);
        db.close();
        return send(res, 200, { url: u, rows }, opts.origin);
      }

      // GET /api/history
      if (req.method === 'GET' && url.pathname === '/api/history') {
        const u = url.searchParams.get('url');
        if (!u) return send(res, 400, { error: 'url query param required' }, opts.origin);
        const preset = url.searchParams.get('preset') ?? undefined;
        const limit = parseInt(url.searchParams.get('limit') ?? '500', 10);
        const db = new HistoryDB();
        const rows = db.recentRuns(u, preset, limit);
        db.close();
        return send(res, 200, { rows }, opts.origin);
      }

      // POST /api/discover
      if (req.method === 'POST' && url.pathname === '/api/discover') {
        const body = await readJson<{ url: string }>(req);
        if (!body.url) return send(res, 400, { error: 'url required' }, opts.origin);
        const { links, source } = await discover(body.url, { maxLinks: 30 });
        return send(res, 200, { links, source }, opts.origin);
      }

      // GET /api/runs/:id/diagnosis — return Layer 1 (deterministic) diagnosis per preset
      const diagMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9]+)\/diagnosis$/);
      if (req.method === 'GET' && diagMatch) {
        const record = runs.get(diagMatch[1]);
        if (!record) return send(res, 404, { error: 'run not found' }, opts.origin);
        const byPreset = new Map<string, RunResultWithArtifact[]>();
        for (const r of record.results) {
          if (r.error) continue;
          const arr = byPreset.get(r.preset.name) ?? [];
          arr.push(r);
          byPreset.set(r.preset.name, arr);
        }
        const out: Record<string, { diagnosis: Diagnosis; topOpportunities: ReturnType<typeof formatAggregatedAudit>[] }> = {};
        for (const [name, rs] of byPreset) {
          const d = diagnosePreset(record.url, name, rs, rs[0].preset.label, rs[0].preset.formFactor);
          const ranked = rankOpportunities(d, 8);
          out[name] = { diagnosis: d, topOpportunities: ranked.map(formatAggregatedAudit) };
        }
        return send(res, 200, { byPreset: out }, opts.origin);
      }

      // GET /api/runs/:id/reason — stream LLM narrative via SSE (Layer 2)
      const reasonMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9]+)\/reason$/);
      if (req.method === 'GET' && reasonMatch) {
        const record = runs.get(reasonMatch[1]);
        if (!record) return send(res, 404, { error: 'run not found' }, opts.origin);
        if (record.status !== 'complete') {
          return send(res, 409, { error: 'run not yet complete' }, opts.origin);
        }
        const backendParam = url.searchParams.get('backend') ?? 'auto';
        let backend: ReasonBackend;
        if (backendParam === 'openai' || backendParam === 'local-ai') {
          backend = backendParam;
        } else {
          backend = (await probeLocalAi()) ? 'local-ai' : 'openai';
        }
        if (backend === 'openai') {
          const apiKey = process.env.OPENAI_API_KEY;
          if (!apiKey) {
            return send(
              res,
              503,
              {
                error:
                  'OPENAI_API_KEY not set on the agent and local-ai not reachable. Either start local-ai (github.com/sarthakagrawal927/local-ai) on :3456, or restart `psi-swarm serve` with OPENAI_API_KEY=... (and optional OPENAI_BASE_URL).',
              },
              opts.origin,
            );
          }
        }
        const model = url.searchParams.get('model') ?? 'auto';
        const byPreset = new Map<string, RunResultWithArtifact[]>();
        for (const r of record.results) {
          if (r.error) continue;
          const arr = byPreset.get(r.preset.name) ?? [];
          arr.push(r);
          byPreset.set(r.preset.name, arr);
        }
        const diagnoses: Diagnosis[] = [];
        for (const [name, rs] of byPreset) {
          diagnoses.push(diagnosePreset(record.url, name, rs, rs[0].preset.label, rs[0].preset.formFactor));
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', opts.origin);
        res.flushHeaders?.();
        // Tell the client which backend was resolved.
        res.write(`data: ${JSON.stringify({ type: 'backend', backend })}\n\n`);
        try {
          const result = await streamReasoning(record.url, record.results, diagnoses, {
            backend,
            model,
            onChunk: (chunk) => {
              res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
            },
          });
          res.write(`data: ${JSON.stringify({ type: 'done', modelUsed: result.modelUsed, durationMs: result.durationMs })}\n\n`);
        } catch (err) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: (err as Error).message })}\n\n`);
        }
        res.end();
        return;
      }

      // GET /api/aggregate?runId=... — compute percentiles server-side
      if (req.method === 'GET' && url.pathname === '/api/aggregate') {
        const id = url.searchParams.get('runId');
        if (!id) return send(res, 400, { error: 'runId required' }, opts.origin);
        const record = runs.get(id);
        if (!record) return send(res, 404, { error: 'run not found' }, opts.origin);
        const byPreset: Record<string, Record<string, ReturnType<typeof computeStats>>> = {};
        const metricKeys = ['lcp', 'cls', 'inp', 'tbt', 'fcp', 'ttfb', 'si', 'performance_score'] as const;
        for (const name of record.presetNames) {
          byPreset[name] = {};
          const rs = record.results.filter((r) => r.preset.name === name && !r.error);
          for (const m of metricKeys) {
            const vals = rs.map((r) => r.metrics?.[m]).filter((v): v is number => typeof v === 'number');
            byPreset[name][m] = computeStats(vals);
          }
        }
        return send(res, 200, { byPreset }, opts.origin);
      }

      return send(res, 404, { error: 'not found', path: url.pathname }, opts.origin);
    } catch (err) {
      return send(res, 500, { error: (err as Error).message }, opts.origin);
    }
  });

  return {
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
          domainRatingScheduler.start();
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        domainRatingScheduler.stop();
        server.close(() => resolve());
      }),
  };
}
