import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompareResult } from '../src/components/CompareView.js';
import { MeasurementCoverage } from '../src/components/ProjectsView.js';
import type { CompareResponse } from '../src/lib/agent.js';

const comparableFixture: CompareResponse = {
  url: 'https://example.com/',
  baselineTag: 'baseline',
  candidateTag: 'candidate',
  pct: 'p75',
  baselineCount: 5,
  candidateCount: 5,
  comparability: {
    comparable: true,
    message: 'Same Lighthouse version',
    baselineVersions: ['13.6.0'],
    candidateVersions: ['13.6.0'],
  },
  metrics: [
    {
      key: 'lcp',
      baseline: {
        p50: 2600,
        p75: 2700,
        p90: 2800,
        p99: 2900,
        min: 2500,
        max: 3000,
        n: 5,
        stddev: 0,
        mean: 2700,
      },
      candidate: {
        p50: 1600,
        p75: 1700,
        p90: 1800,
        p99: 1900,
        min: 1500,
        max: 2000,
        n: 5,
        stddev: 0,
        mean: 1700,
      },
    },
  ],
};
const noncomparableFixture: CompareResponse = {
  ...comparableFixture,
  metrics: [],
  comparability: {
    comparable: false,
    message:
      'A run series mixes Lighthouse versions; collect both series under new tags before comparing',
    baselineVersions: [null, '13.4.1'],
    candidateVersions: ['13.6.0'],
  },
};

test('comparison consumer explains incompatible series and preserves same-engine metrics', () => {
  const render = (result: CompareResponse) =>
    renderToStaticMarkup(createElement(CompareResult, { result, pct: 'p75' }));
  const incompatible = render(noncomparableFixture);
  assert.match(incompatible, /Measurements are not comparable/);
  assert.match(incompatible, /collect both series under new tags/);
  assert.match(incompatible, /unknown, 13.4.1/);
  assert.match(incompatible, /13.6.0/);
  assert.match(incompatible, /readings remain available in history/);
  assert.doesNotMatch(incompatible, /<table|Green = improved/);
  const same = render(comparableFixture);
  assert.match(same, /<table/);
  assert.match(same, /2.70s/);
  assert.match(same, /1.70s/);
  assert.match(same, /Lighthouse 13.6.0/);
  assert.match(same, /Green = improved/);
  const legacy = render({ ...comparableFixture, comparability: undefined });
  assert.match(legacy, /2.70s/);
});

test('origin consumer makes engine and excluded headline coverage visible', () => {
  const known = {
    lighthouseVersion: '13.6.0',
    includedPages: 2,
    excludedPages: 1,
    missingPages: 1,
  };
  const unknown = { lighthouseVersion: null, includedPages: 0, excludedPages: 1, missingPages: 0 };
  const html = renderToStaticMarkup(
    createElement(MeasurementCoverage, {
      coverage: { mobile: known, desktop: unknown, cls: known },
    })
  );
  assert.match(html, /Mobile LCP: Lighthouse 13.6.0/);
  assert.match(html, /2 pages included · 1 excluded/);
  assert.match(html, /Desktop LCP: Lighthouse unknown · 0 pages included · 1 excluded/);
});
