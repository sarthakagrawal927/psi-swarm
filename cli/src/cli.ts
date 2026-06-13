#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import Table from 'cli-table3';
import { PRESETS, PRESET_GROUPS, TRAFFIC_PROFILES, resolvePresets, type Preset } from './presets.js';
import { fetchCrux, type CruxRecord } from './crux.js';
import { fetchDomainRating, type DomainRatingResult } from './ahrefs.js';
import { SwarmRunner, type RunResult, type RunResultWithArtifact } from './runner.js';
import { HistoryDB } from './db.js';
import { renderSwarmReport } from './report.js';
import { discover, rank, type DiscoveredLink } from './discover.js';
import { profileMachine, resolveParallelism } from './machine.js';
import { renderProgress } from './ui.js';
import { detectFrameworkRoutes } from './routes.js';
import { createAgentServer } from './server.js';
import { diagnosePreset, type Diagnosis } from './diagnose.js';
import { streamReasoning, probeLocalAi, type ReasonBackend } from './reason.js';
import { renderHtmlReport } from './html-report.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { homedir } from 'node:os';

const program = new Command();

program
  .name('psi-swarm')
  .description(
    'Run Lighthouse N times across realistic presets. Get p50/p75/p90/p99 of your Web Vitals instead of a single noisy number.',
  )
  .version('0.1.0');

program
  .command('run')
  .description('Run a swarm of Lighthouse audits against a URL')
  .argument('<url>', 'URL to audit')
  .option('-r, --runs <n>', 'Runs per preset', '5')
  .option(
    '-p, --presets <spec>',
    'Preset group or comma list (realistic|mobile|desktop|psi|<names>)',
    'psi',
  )
  .option('-t, --tag <tag>', 'Tag this swarm in history (e.g. "before-deploy")')
  .option('--parallel <spec>', 'Preset-level parallelism (1|N|auto)', '1')
  .option('--no-save', 'Skip saving to local history db')
  .option('--no-suggest', 'Skip post-run link suggestions')
  .option('--no-diagnose', 'Skip the "Why?" Lighthouse-audit opportunities section')
  .option('--reason', 'Stream an LLM narrative explaining the numbers')
  .option('--reason-backend <name>', 'openai | local-ai | auto (OpenAI-compatible endpoint, or local-ai CLI wrapper)', 'auto')
  .option('--reason-model <id>', 'Override the model id', 'auto')
  .option('--profile <name>', 'Traffic profile for the weighted verdict (mobile-heavy|desktop-heavy|balanced|mobile-only)')
  .option('--no-crux', 'Skip the CrUX real-user p75 lookup')
  .option('--no-ahrefs', 'Skip Ahrefs Domain Rating lookup (custom domains only)')
  .option('--output <fmt>', 'Also write a report file: html', undefined)
  .option('--output-path <file>', 'Override the report output path')
  .action(async (url: string, opts) => {
    let presets: Preset[];
    try {
      presets = resolvePresets(opts.presets);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
    const runs = parseInt(opts.runs, 10);
    if (!Number.isInteger(runs) || runs < 1) {
      console.error(chalk.red('--runs must be a positive integer'));
      process.exit(1);
    }
    let parallel: number;
    try {
      parallel = resolveParallelism(opts.parallel, presets.length);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }

    if (parallel > 1) {
      const machine = profileMachine();
      console.log(
        chalk.dim(
          `Running ${parallel}× parallel across presets ` +
            `(${machine.cores} cores, ${machine.totalMemGB.toFixed(1)}GB RAM). ` +
            `CPU-bound metrics (TBT, INP, Perf Score) may show slight noise vs serial.`,
        ),
      );
    }

    const runner = new SwarmRunner();
    const swarmPromise = runner.run({
      url,
      presets,
      runs,
      parallel,
      captureScripts: opts.suggest !== false,
      captureAudits: opts.diagnose !== false || opts.reason === true,
    });
    const startedAt = Date.now();
    // Ink subscribes to runner events; it resolves when 'all-complete' fires.
    const results = await renderProgress(runner, url, presets, runs, parallel);
    await swarmPromise; // ensure runner promise is settled
    const elapsed = Date.now() - startedAt;
    const failed = results.filter((r) => r.error).length;
    if (failed === results.length) {
      console.error(chalk.red(`All ${results.length} runs failed`));
      console.error(chalk.red(results[0]?.error ?? 'Unknown error'));
      process.exit(1);
    }

    if (opts.save !== false) {
      const db = new HistoryDB();
      for (const r of results) {
        db.insert({
          url,
          preset: r.preset.name,
          started_at: r.startedAt,
          finished_at: r.finishedAt,
          metrics: r.metrics,
          error: r.error,
          tag: opts.tag,
        });
      }
      db.close();
    }

    // Pre-render side-channel: fetch CrUX (mobile + desktop) in parallel.
    let cruxByFormFactor: { mobile?: CruxRecord | null; desktop?: CruxRecord | null } | undefined;
    if (opts.crux !== false && process.env.CRUX_API_KEY) {
      try {
        const [mobile, desktop] = await Promise.all([
          fetchCrux(url, { formFactor: 'PHONE' }).catch(() => null),
          fetchCrux(url, { formFactor: 'DESKTOP' }).catch(() => null),
        ]);
        if (mobile || desktop) cruxByFormFactor = { mobile, desktop };
      } catch {
        /* skip — report still renders without CrUX */
      }
    }
    let domainRating: DomainRatingResult | null | undefined;
    if (opts.ahrefs !== false) {
      try {
        const db = new HistoryDB();
        domainRating = await fetchDomainRating(url, { db });
        db.close();
      } catch {
        /* skip — report still renders without DR */
      }
    }
    let trafficProfile: { name: string; weights: Record<string, number> } | undefined;
    if (opts.profile) {
      const weights = TRAFFIC_PROFILES[opts.profile];
      if (!weights) {
        console.error(chalk.red(`Unknown --profile: ${opts.profile}. Try: ${Object.keys(TRAFFIC_PROFILES).join(', ')}`));
      } else {
        trafficProfile = { name: opts.profile, weights };
      }
    }
    console.log('\n' + renderSwarmReport(url, results, elapsed, { cruxByFormFactor, trafficProfile, domainRating }));

    let reasoningCapture: { text: string; backend?: string; model?: string; durationMs?: number } | undefined;
    if (opts.reason === true) {
      reasoningCapture = await runReasoning(url, results, opts.reasonModel ?? 'auto', opts.reasonBackend ?? 'auto');
    }

    if (opts.output === 'html') {
      const slug = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 60);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const defaultDir = pathResolve(homedir(), '.psi-swarm', 'reports');
      const defaultPath = pathJoin(defaultDir, `psi-swarm-${slug}-${stamp}.html`);
      const outPath = pathResolve(process.cwd(), opts.outputPath ?? defaultPath);
      mkdirSync(pathResolve(outPath, '..'), { recursive: true });
      const html = renderHtmlReport({
        url,
        results,
        elapsedMs: elapsed,
        cruxByFormFactor,
        domainRating,
        reasoning: reasoningCapture,
      });
      writeFileSync(outPath, html, 'utf-8');
      console.log('\n' + chalk.dim('Wrote HTML report → ') + chalk.cyan(outPath));
    } else if (opts.output && opts.output !== 'html') {
      console.error(chalk.red(`Unknown --output format: ${opts.output}. Try: html`));
    }

    if (opts.suggest !== false) {
      await renderSuggestions(url, results);
    }
  });

async function resolveBackend(spec: string): Promise<ReasonBackend> {
  if (spec === 'openai' || spec === 'local-ai') return spec;
  // auto: prefer local-ai if reachable.
  const local = await probeLocalAi();
  return local ? 'local-ai' : 'openai';
}

async function runReasoning(
  url: string,
  results: RunResultWithArtifact[],
  model: string,
  backendSpec: string,
): Promise<{ text: string; backend: string; model?: string; durationMs?: number } | undefined> {
  const byPreset = new Map<string, RunResultWithArtifact[]>();
  for (const r of results) {
    if (r.error) continue;
    const arr = byPreset.get(r.preset.name) ?? [];
    arr.push(r);
    byPreset.set(r.preset.name, arr);
  }
  if (byPreset.size === 0) return undefined;
  const diagnoses: Diagnosis[] = [];
  for (const [name, rs] of byPreset) {
    diagnoses.push(diagnosePreset(url, name, rs, rs[0].preset.label, rs[0].preset.formFactor));
  }
  const backend = await resolveBackend(backendSpec);
  console.log('\n' + chalk.cyan.bold('Reasoning') + chalk.dim(`  · backend=${backend} · model=${model}`));
  process.stdout.write(chalk.dim('  '));
  let acc = '';
  try {
    const result = await streamReasoning(url, results, diagnoses, {
      backend,
      model,
      onChunk: (chunk) => {
        acc += chunk;
        process.stdout.write(chunk.replace(/\n/g, '\n  '));
      },
    });
    process.stdout.write('\n');
    const modelLabel = result.modelUsed && result.modelUsed !== model ? `routed to ${result.modelUsed} · ` : '';
    console.log(chalk.dim(`  · ${modelLabel}${(result.durationMs / 1000).toFixed(1)}s`));
    return { text: acc.trim(), backend, model: result.modelUsed, durationMs: result.durationMs };
  } catch (err) {
    console.error('\n' + chalk.red(`Reasoning failed: ${(err as Error).message}`));
    return acc ? { text: acc.trim(), backend, model } : undefined;
  }
}

async function renderSuggestions(url: string, results: RunResultWithArtifact[]): Promise<void> {
  try {
    const scripts = results.find((r) => r.scripts && r.scripts.length > 0)?.scripts;
    const allLinks = new Map<string, DiscoveredLink>();
    const sources: string[] = [];

    // Source 1: static HTML + sitemap.
    try {
      const { links, source } = await discover(url, { maxLinks: 50 });
      if (links.length > 0) {
        sources.push(source);
        for (const l of links) if (!allLinks.has(l.url)) allLinks.set(l.url, l);
      }
    } catch {
      /* skip */
    }

    // Source 2: framework route detection from the captured bundle JS.
    if (scripts && scripts.length > 0) {
      try {
        const routeResult = await detectFrameworkRoutes(url, scripts);
        if (routeResult.routes.length > 0) {
          sources.push(`framework:${routeResult.framework}`);
          for (const l of routeResult.routes) if (!allLinks.has(l.url)) allLinks.set(l.url, l);
        }
      } catch {
        /* skip */
      }
    }

    const merged = rank(Array.from(allLinks.values())).slice(0, 15);
    if (merged.length === 0) {
      console.log(
        '\n' +
          chalk.dim(
            'No additional pages found (static HTML, sitemap.xml, framework routes ' +
              'all empty). Likely an auth-gated SPA — pass specific URLs to test more pages.',
          ),
      );
      return;
    }

    console.log(
      '\n' +
        chalk.cyan.bold('Other pages on this site you may want to test:') +
        chalk.dim(`  (sources: ${sources.join(', ')})`),
    );
    const t = new Table({
      head: [chalk.bold('Path'), chalk.bold('Link text')],
      style: { head: [], border: ['gray'] },
      colWidths: [42, 48],
      wordWrap: true,
    });
    for (const l of merged) {
      t.push([l.path, chalk.dim(l.text || '—')]);
    }
    console.log(t.toString());
    console.log(
      chalk.dim(
        `  Re-run with any of these URLs:  psi-swarm run ${chalk.bold('<url>')}`,
      ),
    );
  } catch (err) {
    console.log(chalk.dim(`\n(Link discovery skipped: ${(err as Error).message})`));
  }
}

program
  .command('discover')
  .description('Extract same-origin links from a page (no Lighthouse runs)')
  .argument('<url>', 'URL to crawl one level')
  .option('-n, --max <n>', 'Max links to show', '25')
  .action(async (url: string, opts) => {
    const spinner = ora(`Fetching ${url}`).start();
    try {
      const { links, source } = await discover(url, {
        maxLinks: parseInt(opts.max, 10),
      });
      const tag =
        source === 'sitemap'
          ? ' via sitemap.xml'
          : source === 'html'
          ? ' from HTML'
          : '';
      spinner.succeed(`Found ${links.length} same-origin links${tag}`);
      if (links.length === 0) {
        console.log(
          chalk.dim(
            'No links found in static HTML or /sitemap.xml — likely a SPA.',
          ),
        );
        return;
      }
      const t = new Table({
        head: [chalk.bold('Path'), chalk.bold('Link text'), chalk.bold('URL')],
        style: { head: [], border: ['gray'] },
        wordWrap: true,
      });
      for (const l of links) {
        t.push([l.path, chalk.dim(l.text || '—'), chalk.dim(l.url)]);
      }
      console.log(t.toString());
    } catch (err) {
      spinner.fail((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('presets')
  .description('List available presets and groups')
  .action(() => {
    const t = new Table({
      head: [
        chalk.bold('Name'),
        chalk.bold('Form factor'),
        chalk.bold('Description'),
      ],
      style: { head: [], border: ['gray'] },
    });
    for (const p of Object.values(PRESETS)) {
      t.push([p.name, p.formFactor, p.label]);
    }
    console.log(chalk.cyan.bold('Presets'));
    console.log(t.toString());

    const g = new Table({
      head: [chalk.bold('Group'), chalk.bold('Members')],
      style: { head: [], border: ['gray'] },
    });
    for (const [name, members] of Object.entries(PRESET_GROUPS)) {
      g.push([name, members.join(', ')]);
    }
    console.log('\n' + chalk.cyan.bold('Groups'));
    console.log(g.toString());

    const p = new Table({
      head: [chalk.bold('Traffic profile'), chalk.bold('Weights (sums to 100%)')],
      style: { head: [], border: ['gray'] },
    });
    for (const [name, weights] of Object.entries(TRAFFIC_PROFILES)) {
      const total = Object.values(weights).reduce((s, w) => s + w, 0);
      const parts = Object.entries(weights)
        .map(([k, v]) => `${Math.round((v / total) * 100)}% ${k}`)
        .join(', ');
      p.push([name, parts]);
    }
    console.log('\n' + chalk.cyan.bold('Traffic profiles (--profile)'));
    console.log(p.toString());
  });

program
  .command('history')
  .description('Show recent history for a URL')
  .argument('<url>', 'URL')
  .option('-p, --preset <name>', 'Filter by preset')
  .option('-n, --limit <n>', 'Max rows', '500')
  .action((url: string, opts) => {
    const db = new HistoryDB();
    const rows = db.recentRuns(
      url,
      opts.preset,
      parseInt(opts.limit, 10),
    );
    if (rows.length === 0) {
      console.log(chalk.dim('No history for this URL yet.'));
      db.close();
      return;
    }
    const fakeResults: RunResult[] = rows.map((r) => ({
      preset: {
        name: r.preset,
        label: PRESETS[r.preset]?.label ?? r.preset,
        formFactor: PRESETS[r.preset]?.formFactor ?? 'mobile',
        throttling: PRESETS[r.preset]?.throttling ?? ({} as any),
        screenEmulation: PRESETS[r.preset]?.screenEmulation ?? ({} as any),
      },
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? r.started_at,
      metrics: {
        lcp: r.lcp ?? undefined,
        cls: r.cls ?? undefined,
        inp: r.inp ?? undefined,
        tbt: r.tbt ?? undefined,
        fcp: r.fcp ?? undefined,
        ttfb: r.ttfb ?? undefined,
        si: r.si ?? undefined,
        performance_score: r.performance_score ?? undefined,
      },
      error: r.error ?? undefined,
    }));
    console.log(renderSwarmReport(url, fakeResults, 0));
    db.close();
  });

program
  .command('compare')
  .description('Compare two tagged swarms across all metrics (p75 by default)')
  .argument('<url>', 'URL')
  .requiredOption('--baseline <tag>', 'Baseline tag')
  .requiredOption('--candidate <tag>', 'Candidate tag')
  .option('--pct <pct>', 'Percentile to compare (p50|p75|p90|p99)', 'p75')
  .action((url: string, opts) => {
    const db = new HistoryDB();
    const base = db.runsByTag(url, opts.baseline);
    const cand = db.runsByTag(url, opts.candidate);
    db.close();
    if (base.length === 0 || cand.length === 0) {
      console.log(
        chalk.red(
          `Missing runs. baseline=${opts.baseline} (n=${base.length})  candidate=${opts.candidate} (n=${cand.length})`,
        ),
      );
      process.exit(1);
    }
    const pctKey = String(opts.pct).toLowerCase();
    if (!['p50', 'p75', 'p90', 'p99'].includes(pctKey)) {
      console.error(chalk.red(`--pct must be one of p50|p75|p90|p99`));
      process.exit(1);
    }
    const pctNum = parseInt(pctKey.slice(1), 10);

    const metrics: { key: keyof typeof base[number]; label: string; unit: 'ms' | 'index' | 'score'; higherIsBetter?: boolean }[] = [
      { key: 'performance_score', label: 'Perf Score', unit: 'score', higherIsBetter: true },
      { key: 'lcp', label: 'LCP', unit: 'ms' },
      { key: 'cls', label: 'CLS', unit: 'index' },
      { key: 'tbt', label: 'TBT', unit: 'ms' },
      { key: 'fcp', label: 'FCP', unit: 'ms' },
      { key: 'ttfb', label: 'TTFB', unit: 'ms' },
      { key: 'si', label: 'SI', unit: 'ms' },
    ];

    const percentile = (vs: number[], pct: number): number => {
      if (vs.length === 0) return NaN;
      const sorted = vs.slice().sort((a, b) => a - b);
      const idx = (pct / 100) * (sorted.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return sorted[lo];
      const w = idx - lo;
      return sorted[lo] * (1 - w) + sorted[hi] * w;
    };

    const fmt = (v: number, unit: 'ms' | 'index' | 'score') => {
      if (!Number.isFinite(v)) return '—';
      if (unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
      if (unit === 'index') return v.toFixed(3);
      return v.toFixed(0);
    };

    const delta = (a: number, b: number, higherIsBetter: boolean) => {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return chalk.dim('—');
      const d = b - a;
      const pctDelta = a === 0 ? 0 : (d / a) * 100;
      const regressed = higherIsBetter ? d < 0 : d > 0;
      const improved = higherIsBetter ? d > 0 : d < 0;
      const sign = d > 0 ? '+' : '';
      const colorize = regressed ? chalk.red : improved ? chalk.green : chalk.dim;
      return colorize(`${sign}${d.toFixed(d % 1 === 0 ? 0 : 2)}  (${sign}${pctDelta.toFixed(1)}%)`);
    };

    const t = new Table({
      head: [
        chalk.bold('Metric'),
        chalk.bold(`Baseline ${pctKey}`),
        chalk.bold(`Candidate ${pctKey}`),
        chalk.bold('Δ'),
      ],
      style: { head: [], border: ['gray'] },
    });
    for (const m of metrics) {
      const baseVals = base.map((r) => r[m.key]).filter((v): v is number => typeof v === 'number');
      const candVals = cand.map((r) => r[m.key]).filter((v): v is number => typeof v === 'number');
      if (baseVals.length === 0 && candVals.length === 0) continue;
      const b = percentile(baseVals, pctNum);
      const c = percentile(candVals, pctNum);
      t.push([
        chalk.bold(m.label),
        fmt(b, m.unit),
        fmt(c, m.unit),
        delta(b, c, !!m.higherIsBetter),
      ]);
    }
    console.log(
      boxen(
        `Comparison for ${chalk.bold(url)}\n` +
          `baseline=${opts.baseline} (n=${base.length})  vs  candidate=${opts.candidate} (n=${cand.length})\n` +
          `percentile = ${pctKey}`,
        { padding: 1, borderColor: 'cyan', borderStyle: 'round' },
      ),
    );
    console.log(t.toString());
  });

program
  .command('serve')
  .description('Run a local HTTP agent that the psi-swarm web UI can drive')
  .option('-p, --port <n>', 'Port to listen on', '7777')
  .option('--host <addr>', 'Bind address (127.0.0.1 for loopback only)', '127.0.0.1')
  .option('--origin <url>', 'CORS allowed origin', 'http://localhost:4321')
  .option('--token <tok>', 'Optional shared secret required for requests')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(chalk.red('--port must be 1-65535'));
      process.exit(1);
    }
    const server = createAgentServer({
      port,
      host: opts.host,
      origin: opts.origin,
      token: opts.token,
    });
    try {
      await server.listen();
    } catch (err) {
      console.error(chalk.red(`Failed to listen on ${opts.host}:${port}: ${(err as Error).message}`));
      process.exit(1);
    }
    const url = `http://${opts.host}:${port}`;
    console.log(
      boxen(
        `${chalk.bold.cyan('psi-swarm agent running')}\n\n` +
          `${chalk.dim('URL:    ')}${url}\n` +
          `${chalk.dim('Origin: ')}${opts.origin}\n` +
          (opts.token ? `${chalk.dim('Token:  ')}${chalk.yellow(opts.token)}\n` : '') +
          `\n${chalk.dim('Open the web UI and it will auto-connect. Ctrl-C to stop.')}\n` +
          `${chalk.dim('Ahrefs DR refreshes weekly when idle (no active swarms).')}`,
        { padding: 1, borderColor: 'cyan', borderStyle: 'round' },
      ),
    );
    const shutdown = async () => {
      console.log(chalk.dim('\nShutting down...'));
      await server.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('urls')
  .description('List URLs in history')
  .action(() => {
    const db = new HistoryDB();
    const rows = db.urls();
    db.close();
    if (rows.length === 0) {
      console.log(chalk.dim('No history yet.'));
      return;
    }
    const t = new Table({
      head: [chalk.bold('URL'), chalk.bold('Runs'), chalk.bold('Last')],
      style: { head: [], border: ['gray'] },
    });
    for (const r of rows) {
      t.push([r.url, String(r.count), new Date(r.last).toLocaleString()]);
    }
    console.log(t.toString());
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
