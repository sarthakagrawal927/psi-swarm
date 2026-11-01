import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HistoryDB } from '../src/db.js';
import type { RunResultWithArtifact } from '../src/runner.js';
import { deriveTraceInsights, resolveTraceInsightAdapter } from '../src/trace-insight.js';
import { METRICS } from '../src/metrics.js';

const preset = {
  name: 'mobile-mid',
  label: 'Mobile (Mid)',
  formFactor: 'mobile' as const,
  throttling: {} as never,
  screenEmulation: {} as never,
};

function result(lcp: number, audits: object[] = []): RunResultWithArtifact {
  return {
    preset,
    startedAt: Date.now(),
    finishedAt: Date.now() + 1,
    metrics: {
      lcp,
      ttfb: 200,
      cls: 0.05,
      inp: 100,
      tbt: 50,
      fcp: 800,
      si: 3000,
      performance_score: 85,
    },
    audits,
    provenance: {
      schemaVersion: 1,
      lighthouseVersion: '13.6.0',
      screenEmulation: {},
      throttling: {},
      observed: {},
    },
  };
}

function insertRun(db: HistoryDB, url: string, lcp: number, tag?: string, offsetMs = 0) {
  db.insert({
    lighthouseVersion: '13.6.0',
    url,
    preset: preset.name,
    started_at: Date.now() + offsetMs,
    finished_at: Date.now() + offsetMs + 1,
    metrics: { lcp },
    tag,
  });
}

test('builtin trace-insight adapter', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-builtin-shared-'));
  const db = new HistoryDB(join(dir, 'history.db'));

  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const adapter = await resolveTraceInsightAdapter();
  assert.equal(adapter.name, 'builtin');

  await t.test('produces a summary and detects bottleneck phase', async () => {
    const url = 'https://example.com';
    insertRun(db, url, 2500);

    const r = result(2500, [
      {
        id: 'largest-contentful-paint-element',
        score: 0,
        lcpPhases: [
          { phase: 'TTFB', timingMs: 800, percent: '32%' },
          { phase: 'Render Delay', timingMs: 1700, percent: '68%' },
        ],
      },
    ]);

    const insights = await deriveTraceInsights(db, url, [r], { adapter });

    assert.equal(insights.length, 1);
    assert.equal(insights[0].adapter, 'builtin');
    assert.equal(insights[0].bottleneckPhase, 'Render Delay');
    assert.ok(insights[0].summary.includes('LCP p75'));
    assert.ok(insights[0].summary.includes('dominant phase: Render Delay'));
  });

  await t.test('reports no failing audits when audits are empty', async () => {
    const url = 'https://no-audits.example.com';
    insertRun(db, url, 1800);

    const r = result(1800, []);
    const insights = await deriveTraceInsights(db, url, [r], { adapter });

    assert.equal(insights.length, 1);
    assert.ok(insights[0].summary.includes('no failing audits captured'));
    assert.equal(insights[0].bottleneckPhase, undefined);
  });

  await t.test('marks comparison as improved when LCP gets better', async () => {
    const url = 'https://improved.example.com';
    for (const lcp of [4000, 4100, 3900]) {
      insertRun(db, url, lcp, 'v1.0', -100_000);
    }
    insertRun(db, url, 2000);

    const r = result(2000, []);
    const insights = await deriveTraceInsights(db, url, [r], {
      adapter,
      baselineTag: 'v1.0',
    });

    assert.equal(insights.length, 1);
    assert.ok(insights[0].comparisonNotes!.includes('improved'));
  });

  await t.test('marks comparison as regressed when LCP worsens', async () => {
    const url = 'https://regressed.example.com';
    for (const lcp of [1500, 1600, 1400]) {
      insertRun(db, url, lcp, 'v1.0', -100_000);
    }
    insertRun(db, url, 3500);

    const r = result(3500, []);
    const insights = await deriveTraceInsights(db, url, [r], {
      adapter,
      baselineTag: 'v1.0',
    });

    assert.equal(insights.length, 1);
    assert.ok(insights[0].comparisonNotes!.includes('regressed'));
  });

  await t.test('marks comparison as stable when LCP is unchanged', async () => {
    const url = 'https://stable.example.com';
    for (const lcp of [2000, 2050, 1950]) {
      insertRun(db, url, lcp, 'v1.0', -100_000);
    }
    insertRun(db, url, 2010);

    const r = result(2010, []);
    const insights = await deriveTraceInsights(db, url, [r], {
      adapter,
      baselineTag: 'v1.0',
    });

    assert.equal(insights.length, 1);
    assert.ok(insights[0].comparisonNotes!.includes('stable'));
  });

  await t.test('omits comparison notes when no baseline is provided', async () => {
    const url = 'https://no-baseline.example.com';
    insertRun(db, url, 2200);

    const r = result(2200, []);
    const insights = await deriveTraceInsights(db, url, [r], { adapter });

    assert.equal(insights.length, 1);
    assert.equal(insights[0].comparisonNotes, undefined);
  });

  await t.test('omits comparison notes when baseline has no LCP data', async () => {
    const url = 'https://no-lcp.example.com';
    db.insert({
      lighthouseVersion: '13.6.0',
      url,
      preset: preset.name,
      started_at: Date.now() - 100_000,
      finished_at: Date.now() - 100_000 + 1,
      metrics: { ttfb: 200 },
      tag: 'v1.0',
    });
    insertRun(db, url, 2000);

    const r = result(2000, []);
    const insights = await deriveTraceInsights(db, url, [r], {
      adapter,
      baselineTag: 'v1.0',
    });

    assert.equal(insights.length, 1);
    assert.equal(insights[0].comparisonNotes, undefined);
  });

  await t.test('skips error results', async () => {
    const url = 'https://error-skip.example.com';
    insertRun(db, url, 2000);

    const errorResult: RunResultWithArtifact = {
      preset,
      startedAt: Date.now(),
      finishedAt: Date.now() + 1,
      metrics: undefined,
      error: 'Navigation timeout',
    };

    const insights = await deriveTraceInsights(db, url, [errorResult, result(2000, [])], {
      adapter,
    });

    assert.equal(insights.length, 1);
    assert.equal(insights[0].adapter, 'builtin');
  });
});

test('METRICS constant includes all core Web Vitals', () => {
  const keys = METRICS.map((m) => m.key);
  assert.ok(keys.includes('lcp'));
  assert.ok(keys.includes('inp'));
  assert.ok(keys.includes('cls'));
  assert.ok(keys.includes('performance_score'));
  assert.ok(keys.length >= 8);
});

test('METRICS performance_score is marked higherIsBetter', () => {
  const score = METRICS.find((m) => m.key === 'performance_score');
  assert.equal(score?.higherIsBetter, true);
});
