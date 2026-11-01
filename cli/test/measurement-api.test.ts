import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HistoryDB } from '../src/db.js';
import { createAgentServer } from '../src/server.js';

test('HTTP comparison guards engine changes while raw history remains readable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-engine-api-'));
  const historyPath = join(dir, 'history.db');
  const db = new HistoryDB(historyPath);
  const url = 'https://example.com/';
  const now = Date.now();
  for (const [tag, version, lcp] of [
    ['legacy', undefined, 4000],
    ['old', '13.4.1', 4000],
    ['new-baseline', '13.6.0', 4000],
    ['candidate', '13.6.0', 1500],
  ] as const) {
    db.insert({
      url,
      preset: 'mobile-mid',
      started_at: now,
      finished_at: now + 1,
      tag,
      lighthouseVersion: version,
      metrics: { lcp, performance_score: 99 },
    });
  }
  db.close();
  const agent = createAgentServer({
    port: 0,
    host: '127.0.0.1',
    origin: 'http://localhost',
    historyPath,
  });
  t.after(async () => {
    await agent.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await agent.listen();
  const address = agent.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const [baseline, reason] of [
    ['legacy', 'unknown-version'],
    ['old', 'different-versions'],
  ] as const) {
    const response = await fetch(
      `${origin}/api/compare?${new URLSearchParams({
        url,
        baseline,
        candidate: 'candidate',
      })}`
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.comparability.comparable, false);
    assert.equal(body.comparability.reason, reason);
    assert.deepEqual(body.metrics, []);
    assert.equal(body.baselineCount, 1);
    assert.equal(body.candidateCount, 1);
  }
  const comparable = await fetch(
    `${origin}/api/compare?${new URLSearchParams({
      url,
      baseline: 'new-baseline',
      candidate: 'candidate',
    })}`
  ).then((response) => response.json());
  assert.equal(comparable.comparability.comparable, true);
  const lcp = comparable.metrics.find((metric: { key: string }) => metric.key === 'lcp');
  assert.equal(lcp.baseline.p75, 4000);
  assert.equal(lcp.candidate.p75, 1500);
  const history = await fetch(`${origin}/api/history?${new URLSearchParams({ url })}`).then(
    (response) => response.json()
  );
  assert.equal(history.rows.length, 4);
  assert.equal(
    history.rows.find((row: { tag: string }) => row.tag === 'legacy').lighthouse_version,
    null
  );
});
