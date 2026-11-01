import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { HistoryDB } from '../src/db.js';
import { measurementCompatibility, measurementHeadline } from '../src/measurement-series.js';
import { evaluateWatchlist } from '../src/watchlist.js';
import { deriveTraceInsights } from '../src/trace-insight.js';

test('measurement comparisons require one matching known engine version', () => {
  assert.equal(measurementCompatibility(['13.6.0', '13.6.0'], ['13.6.0']).comparable, true);
  for (const [baseline, candidate, reason] of [
    [['13.4.1'], ['13.6.0'], 'different-versions'],
    [[null], ['13.6.0'], 'unknown-version'],
    [['13.6.0'], [undefined], 'unknown-version'],
    [['13.4.1', '13.6.0'], ['13.6.0'], 'mixed-versions'],
    [[null, '13.6.0'], ['13.6.0'], 'mixed-versions'],
    [[], ['13.6.0'], 'missing-runs'],
  ] as const) {
    const result = measurementCompatibility(baseline, candidate);
    assert.equal(result.comparable, false);
    assert.equal(result.reason, reason);
  }
});

test('origin headlines retain one known engine with explicit excluded coverage', () => {
  const old = { value: 4500, lighthouseVersion: '13.4.1', measuredAt: 1 };
  const current = { value: 1500, lighthouseVersion: '13.6.0', measuredAt: 2 };
  const latest = { value: 1600, lighthouseVersion: '13.6.0', measuredAt: 3 };
  assert.deepEqual(measurementHeadline([old, current, latest]), {
    value: 1600,
    lighthouseVersion: '13.6.0',
    includedPages: 2,
    excludedPages: 1,
    missingPages: 0,
    reason: 'selected-latest-version',
  });
  assert.equal(measurementHeadline([current, latest]).reason, 'single-version');
  assert.equal(measurementHeadline([]).reason, 'missing-readings');
  assert.equal(measurementHeadline([current], 3).excludedPages, 2);
  assert.equal(measurementHeadline([current], 3).missingPages, 2);
  const unknown = measurementHeadline([old, { value: 1800, measuredAt: 4 }]);
  assert.equal(unknown.reason, 'unknown-version');
  assert.equal(unknown.value, undefined);
  assert.equal(unknown.includedPages, 0);
  assert.equal(unknown.excludedPages, 2);
  const tied = measurementHeadline([old, { ...current, measuredAt: 1 }]);
  assert.equal(tied.reason, 'ambiguous-latest-version');
  assert.equal(tied.value, undefined);
  assert.equal(tied.excludedPages, 2);
});

test('legacy history migration preserves every old value and leaves its engine unknown', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-engine-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'history.db');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, preset TEXT NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER, lcp REAL, cls REAL, inp REAL,
    tbt REAL, fcp REAL, ttfb REAL, si REAL, performance_score REAL, error TEXT, tag TEXT
  ); INSERT INTO runs VALUES (
    47, 'https://example.com/', 'mobile-mid', 100, 200, 2539.876, 0, NULL,
    0, 1234, 200, 1567, 94, NULL, 'retained-baseline'
  )`);
  const before = legacy.prepare('SELECT * FROM runs').get();
  legacy.close();
  const db = new HistoryDB(file);
  const migrated = db.recentRuns('https://example.com/')[0];
  const { lighthouse_version, ...oldValues } = migrated;
  assert.deepEqual(oldValues, before);
  assert.equal(lighthouse_version, null);
  assert.equal(db.history('https://example.com/')[0].lighthouse_version, null);
  db.insert({
    url: 'https://example.com/',
    preset: 'mobile-mid',
    started_at: 300,
    finished_at: 400,
    metrics: { lcp: 1500, performance_score: 99 },
    lighthouseVersion: '13.6.0',
    tag: 'new-series',
  });
  db.close();
  const reopened = new HistoryDB(file);
  assert.equal(reopened.recentRuns('https://example.com/').length, 2);
  assert.equal(
    reopened.runsByTag('https://example.com/', 'new-series')[0].lighthouse_version,
    '13.6.0'
  );
  assert.deepEqual(reopened.runsByTag('https://example.com/', 'retained-baseline')[0], {
    ...(before as object),
    lighthouse_version: null,
  });
  reopened.close();
});

test('watchlist retains readings but never calls cross-engine or unknown history improved', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-engine-watchlist-'));
  const db = new HistoryDB(join(dir, 'history.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.now();
  for (const [name, version] of [
    ['old', '13.4.1'],
    ['unknown', undefined],
    ['same', '13.6.0'],
  ] as const) {
    const url = `https://${name}.example.com/`;
    db.insert({
      url,
      preset: 'mobile-mid',
      started_at: now - 1000,
      finished_at: now - 999,
      metrics: { lcp: 4000, performance_score: 70 },
      tag: 'baseline',
      lighthouseVersion: version,
    });
    db.insert({
      url,
      preset: 'mobile-mid',
      started_at: now,
      finished_at: now + 1,
      metrics: { lcp: 1500, performance_score: 99 },
      tag: 'candidate',
      lighthouseVersion: '13.6.0',
    });
    db.addWatchlist({ url, baselineTag: 'baseline' });
  }
  const queue = evaluateWatchlist(db, now + 2);
  for (const name of ['old', 'unknown']) {
    const item = queue.find((row) => row.url === `https://${name}.example.com/`)!;
    assert.equal(item.status, 'missing');
    assert.equal(item.comparability?.comparable, false);
    assert.equal(
      item.metrics.some((metric) => metric.delta !== undefined),
      false
    );
    assert.equal(db.recentRuns(item.url)[0].lcp, 1500);
  }
  const same = queue.find((row) => row.url === 'https://same.example.com/')!;
  assert.equal(same.status, 'improved');
  assert.equal(same.comparability?.comparable, true);
});

test('project aggregation separates reused tags by engine version', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-engine-projects-'));
  const db = new HistoryDB(join(dir, 'history.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = 'https://example.com/';
  const now = Date.now();
  for (const [offset, lcp, version] of [
    [0, 4000, '13.4.1'],
    [1, 4500, '13.4.1'],
    [2, 1500, '13.6.0'],
    [3, 1600, '13.6.0'],
  ] as const) {
    db.insert({
      url,
      preset: 'mobile-mid',
      started_at: now + offset,
      finished_at: now + offset + 1,
      metrics: { lcp },
      tag: 'reused-tag',
      lighthouseVersion: version,
    });
  }
  const project = db.projects()[0];
  assert.equal(project.mobileLcpP75, 1575);
  assert.equal(project.mobileLighthouseVersion, '13.6.0');
  assert.equal(project.totalRuns, 4);
});

test('trace adapters cannot report improvement from a baseline measured by another engine', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-engine-insight-'));
  const db = new HistoryDB(join(dir, 'history.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = 'https://example.com/';
  const now = Date.now();
  db.insert({
    url,
    preset: 'mobile-mid',
    started_at: now - 1000,
    finished_at: now - 999,
    metrics: { lcp: 4000 },
    tag: 'baseline',
    lighthouseVersion: '13.4.1',
  });
  db.insert({
    url,
    preset: 'mobile-mid',
    started_at: now,
    finished_at: now + 1,
    metrics: { lcp: 1500 },
    tag: 'candidate',
    lighthouseVersion: '13.6.0',
  });
  const result = {
    preset: {
      name: 'mobile-mid',
      label: 'Mobile',
      formFactor: 'mobile' as const,
      throttling: {} as never,
      screenEmulation: {} as never,
    },
    startedAt: now,
    finishedAt: now + 1,
    metrics: { lcp: 1500 },
    provenance: {
      schemaVersion: 1 as const,
      lighthouseVersion: '13.6.0',
      screenEmulation: {},
      throttling: {},
      observed: {},
    },
  };
  const insights = await deriveTraceInsights(db, url, [result], {
    baselineTag: 'baseline',
    adapter: {
      name: 'fixture',
      async diagnose(input) {
        assert.equal(input.baselineResults, undefined);
        return {
          summary: 'Current reading',
          opportunities: [],
          adapter: 'fixture',
          comparisonNotes: 'improved',
        };
      },
    },
  });
  assert.equal(insights[0].comparability?.comparable, false);
  assert.equal(insights[0].comparability?.reason, 'different-versions');
  assert.match(insights[0].comparisonNotes!, /^Not comparable:/);
  assert.doesNotMatch(db.runInsightsForUrl(url)[0].comparison_notes!, /improved/);
});
