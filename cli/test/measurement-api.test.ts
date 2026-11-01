import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HistoryDB } from '../src/db.js';
import { createAgentServer } from '../src/server.js';

test('HTTP comparison, history and watchlist isolate engine versions and their database', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-engine-api-'));
  const historyPath = join(dir, 'history.db');
  const db = new HistoryDB(historyPath);
  const url = 'https://example.com/';
  const now = Date.now();
  let offset = 0;
  for (const [tag, version, lcp] of [
    ['legacy', undefined, 4000],
    ['old', '13.4.1', 4000],
    ['mixed', '13.4.1', 4000],
    ['mixed', '13.6.0', 1500],
    ['new-baseline', '13.6.0', 4000],
    ['candidate', '13.6.0', 1500],
  ] as const) {
    db.insert({
      url,
      preset: 'mobile-mid',
      started_at: now + offset,
      finished_at: now + offset + 1,
      tag,
      lighthouseVersion: version,
      metrics: { lcp, performance_score: 99 },
    });
    offset += 1;
  }
  db.insert({
    url: `${url}older`,
    preset: 'mobile-mid',
    started_at: now - 1,
    finished_at: now,
    tag: 'old-page',
    lighthouseVersion: '13.4.1',
    metrics: { lcp: 5000 },
  });
  db.insert({
    url: `${url}unknown`,
    preset: 'desktop',
    started_at: now,
    finished_at: now + 1,
    tag: 'unknown-page',
    metrics: { lcp: 3000 },
  });
  db.close();
  const agent = createAgentServer({
    port: 0,
    host: '127.0.0.1',
    origin: 'http://localhost',
    historyPath,
    token: 'fixture-token',
  });
  t.after(async () => {
    await agent.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await agent.listen();
  const address = agent.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (path: string, options: RequestInit = {}) =>
    fetch(`${origin}${path}`, {
      ...options,
      headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
  const comparisonPath = (baseline: string) =>
    `/api/compare?${new URLSearchParams({
      url,
      baseline,
      candidate: 'candidate',
    })}`;
  assert.equal((await fetch(`${origin}/api/history?${new URLSearchParams({ url })}`)).status, 401);
  assert.equal((await fetch(origin, { method: 'OPTIONS' })).status, 204);
  for (const [baseline, reason] of [
    ['legacy', 'unknown-version'],
    ['old', 'different-versions'],
    ['mixed', 'mixed-versions'],
    ['absent', 'missing-runs'],
  ] as const) {
    const response = await request(comparisonPath(baseline));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.comparability.comparable, false);
    assert.equal(body.comparability.reason, reason);
    assert.deepEqual(body.metrics, []);
    assert.equal(body.candidateCount, 1);
  }
  const comparable = await request(comparisonPath('new-baseline')).then((response) =>
    response.json()
  );
  assert.equal(comparable.comparability.comparable, true);
  const lcp = comparable.metrics.find((metric: { key: string }) => metric.key === 'lcp');
  assert.equal(lcp.baseline.p75, 4000);
  assert.equal(lcp.candidate.p75, 1500);
  for (const path of ['/api/history', '/api/projects/history']) {
    const history = await request(`${path}?${new URLSearchParams({ url })}`).then((response) =>
      response.json()
    );
    assert.equal(history.rows.length, 6);
    assert.equal(
      history.rows.find((row: { tag: string }) => row.tag === 'legacy').lighthouse_version,
      null
    );
  }
  const tags = await request(`/api/tags?${new URLSearchParams({ url })}`).then((response) =>
    response.json()
  );
  assert.equal(tags.tags.find((tag: { tag: string }) => tag.tag === 'mixed').count, 2);
  const urls = await request('/api/urls').then((response) => response.json());
  assert.equal(urls.urls.length, 3);
  const projects = await request('/api/projects').then((response) => response.json());
  assert.equal(projects.projects[0].totalRuns, 8);
  assert.equal(projects.projects[0].pages.length, 3);
  assert.equal(
    projects.projects[0].pages.find((page: { path: string }) => page.path === '/older')
      .mobileLcpP75,
    5000
  );
  assert.equal(projects.projects[0].worstMobileLcp, 1500);
  assert.equal(projects.projects[0].worstDesktopLcp, undefined);
  assert.deepEqual(projects.projects[0].measurementCoverage.mobile, {
    value: 1500,
    lighthouseVersion: '13.6.0',
    includedPages: 1,
    excludedPages: 1,
    missingPages: 1,
    reason: 'selected-latest-version',
  });
  assert.equal(projects.projects[0].measurementCoverage.desktop.reason, 'unknown-version');
  assert.equal(projects.projects[0].measurementCoverage.desktop.excludedPages, 1);
  assert.equal(projects.projects[0].pages[0].mobileLighthouseVersion, '13.6.0');
  const insights = await request(`/api/insights?${new URLSearchParams({ url })}`).then((response) =>
    response.json()
  );
  assert.deepEqual(insights.insights, []);
  const writeWatchlist = (baselineTag: string) =>
    request('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({ url, baselineTag }),
    }).then((response) => response.json());
  const crossEngine = await writeWatchlist('old');
  assert.equal(crossEngine.queue[0].status, 'missing');
  assert.equal(crossEngine.queue[0].comparability.reason, 'different-versions');
  const listed = await request('/api/watchlist').then((response) => response.json());
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.summary.improved, 0);
  const refreshed = await request('/api/watchlist/refresh', { method: 'POST' }).then((response) =>
    response.json()
  );
  assert.ok(refreshed.refreshedAt > 0);
  assert.equal(refreshed.queue[0].comparability.comparable, false);
  const sameEngine = await writeWatchlist('new-baseline');
  assert.equal(sameEngine.queue[0].status, 'improved');
  assert.equal(sameEngine.queue[0].comparability.comparable, true);
  const removed = await request(`/api/watchlist?${new URLSearchParams({ url })}`, {
    method: 'DELETE',
  }).then((response) => response.json());
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.queue, []);
  for (const path of [
    '/api/compare',
    '/api/history',
    '/api/projects/history',
    '/api/tags',
    '/api/insights',
  ]) {
    assert.equal((await request(path)).status, 400);
  }
  assert.equal((await request(comparisonPath('old') + '&pct=invalid')).status, 400);
  assert.equal((await request('/api/watchlist', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await request('/api/watchlist', { method: 'DELETE' })).status, 400);
  assert.equal((await request('/api/not-a-route')).status, 404);
});
