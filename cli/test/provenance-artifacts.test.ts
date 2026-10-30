import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportSwarmArtifacts } from '../src/artifacts.js';
import { PRESETS } from '../src/presets.js';
import { captureLighthouseProvenance } from '../src/provenance.js';
import type { RunResultWithArtifact } from '../src/runner.js';

const sentinel = 'private-value-must-not-be-exported';

function lhr() {
  return {
    lighthouseVersion: '13.4.1',
    userAgent: 'fallback browser',
    environment: { hostUserAgent: 'Chrome/156', benchmarkIndex: 0, secret: sentinel },
    configSettings: {
      formFactor: 'mobile',
      throttlingMethod: 'simulate',
      extraHeaders: { Authorization: sentinel, Cookie: sentinel },
      screenEmulation: {
        mobile: true,
        width: 412,
        height: 823,
        deviceScaleFactor: 1.75,
        disabled: false,
        secret: sentinel,
      },
      throttling: {
        rttMs: 150,
        throughputKbps: 1638.4,
        requestLatencyMs: 562.5,
        downloadThroughputKbps: 1474.56,
        uploadThroughputKbps: 675,
        cpuSlowdownMultiplier: 4,
        secret: sentinel,
      },
    },
    runWarnings: ['Results may be incomplete.'],
    runtimeError: { code: 'NO_FCP', message: sentinel },
    audits: {
      metrics: {
        details: {
          items: [
            {
              observedFirstContentfulPaint: 0,
              observedLargestContentfulPaint: 1535,
              observedSpeedIndex: 1556,
              observedTrace: sentinel,
            },
          ],
        },
      },
    },
    cookies: sentinel,
    trace: sentinel,
  };
}

test('provenance explicitly allowlists typed settings and observed ms, retaining zero/false', () => {
  const source = lhr();
  const captured = captureLighthouseProvenance(source);
  assert.deepEqual(captured, {
    schemaVersion: 1,
    lighthouseVersion: '13.4.1',
    browserUserAgent: 'Chrome/156',
    benchmarkIndex: 0,
    formFactor: 'mobile',
    throttlingMethod: 'simulate',
    screenEmulation: {
      width: 412,
      height: 823,
      deviceScaleFactor: 1.75,
      mobile: true,
      disabled: false,
    },
    throttling: {
      rttMs: 150,
      throughputKbps: 1638.4,
      requestLatencyMs: 562.5,
      downloadThroughputKbps: 1474.56,
      uploadThroughputKbps: 675,
      cpuSlowdownMultiplier: 4,
    },
    runWarnings: ['Results may be incomplete.'],
    runtimeErrorCode: 'NO_FCP',
    observed: { fcpMs: 0, lcpMs: 1535, siMs: 1556 },
  });
  assert.equal(JSON.stringify(captured).includes(sentinel), false);
  source.runWarnings.push('Later mutation');
  source.configSettings.throttling.rttMs = 999;
  assert.deepEqual(captured.runWarnings, ['Results may be incomplete.']);
  assert.equal(captured.throttling.rttMs, 150);
});

test('absent warnings stay unknown, captured empty warnings mean zero; malformed values are omitted', () => {
  const missing = captureLighthouseProvenance({});
  assert.equal(missing.runWarnings, undefined);
  assert.equal(captureLighthouseProvenance({ runWarnings: [123] }).runWarnings, undefined);
  const captured = captureLighthouseProvenance({
    runWarnings: [],
    configSettings: {
      throttlingMethod: 'invalid',
      formFactor: 'invalid',
      screenEmulation: { width: '412', mobile: 'false' },
      throttling: { rttMs: NaN, throughputKbps: Infinity },
    },
    environment: { benchmarkIndex: '123' },
    audits: {
      metrics: {
        details: {
          items: [{ observedFirstContentfulPaint: NaN, observedLargestContentfulPaint: '1535' }],
        },
      },
    },
  });
  assert.deepEqual(captured.runWarnings, []);
  assert.equal(captured.runtimeErrorCode, null);
  assert.equal(captured.throttlingMethod, undefined);
  assert.equal(captured.formFactor, undefined);
  assert.equal(captured.benchmarkIndex, undefined);
  assert.deepEqual(captured.throttling, {});
  assert.deepEqual(captured.screenEmulation, {});
  assert.equal(captured.observed.fcpMs, undefined);
  assert.equal(captured.observed.lcpMs, undefined);
});

function result(startedAt: number, error?: string): RunResultWithArtifact {
  return {
    preset: PRESETS['mobile-mid'],
    startedAt,
    finishedAt: startedAt + 10,
    ...(error
      ? { error }
      : {
          metrics: { lcp: 3200, fcp: 2538, performance_score: 89 },
          finalUrl: 'https://example.com/',
        }),
  };
}

test('additive bundle keeps modeled metrics/audits compatible and exact attempt identity without audit capture', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-provenance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = result(100);
  const failed = { ...result(200, sentinel), provenance: captureLighthouseProvenance(lhr()) };
  const success = {
    ...result(300),
    provenance: captureLighthouseProvenance({ ...lhr(), runWarnings: [], runtimeError: null }),
  };
  const paths = exportSwarmArtifacts('https://example.com/', [legacy, failed, success], {
    artifactsDir: dir,
    swarmId: 'isolated',
    tag: 'exact-tag',
  });
  const path = paths.get('mobile-mid')!;
  const bundle = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(bundle.url, 'https://example.com/');
  assert.equal(bundle.tag, 'exact-tag');
  assert.equal(bundle.preset, 'mobile-mid');
  assert.equal(bundle.runs, 2);
  assert.deepEqual(bundle.metrics, [legacy.metrics, success.metrics]);
  assert.deepEqual(bundle.audits, []);
  assert.equal(bundle.finalUrl, legacy.finalUrl);
  assert.deepEqual(
    bundle.runMetadata.map(({ startedAt, finishedAt, metricsIndex }: Record<string, unknown>) => ({
      startedAt,
      finishedAt,
      metricsIndex,
    })),
    [
      { startedAt: 100, finishedAt: 110, metricsIndex: 0 },
      { startedAt: 200, finishedAt: 210, metricsIndex: null },
      { startedAt: 300, finishedAt: 310, metricsIndex: 1 },
    ]
  );
  assert.equal(bundle.runMetadata[0].provenance, undefined);
  assert.equal(bundle.runMetadata[1].provenance.runtimeErrorCode, 'NO_FCP');
  assert.deepEqual(bundle.runMetadata[2].provenance.runWarnings, []);
  assert.equal(JSON.stringify(bundle).includes(sentinel), false);
  assert.deepEqual(readdirSync(join(dir, 'isolated')), ['mobile-mid.json']);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('all failed attempts retain provenance without creating successful metrics', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-provenance-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const failed = { ...result(400, 'No FCP'), provenance: captureLighthouseProvenance(lhr()) };
  const path = exportSwarmArtifacts('https://example.com/', [failed], {
    artifactsDir: dir,
    swarmId: 'isolated',
  }).get('mobile-mid')!;
  const bundle = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(bundle.runs, 0);
  assert.deepEqual(bundle.metrics, []);
  assert.equal(bundle.runMetadata[0].metricsIndex, null);
  assert.equal(bundle.runMetadata[0].provenance.runtimeErrorCode, 'NO_FCP');
});

test('failed atomic publication leaves prior destination intact and removes its temporary file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'psi-provenance-atomic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const destination = join(dir, 'isolated', 'mobile-mid.json');
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'prior'), 'preserved');
  assert.throws(() =>
    exportSwarmArtifacts('https://example.com/', [result(100)], {
      artifactsDir: dir,
      swarmId: 'isolated',
    })
  );
  assert.equal(readFileSync(join(destination, 'prior'), 'utf8'), 'preserved');
  assert.deepEqual(readdirSync(join(dir, 'isolated')), ['mobile-mid.json']);
});
