import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();
await import('./lighthouse-module-attribution.test.ts');
await import('./measurement-series.test.ts');
await import('./measurement-api.test.ts');
test('local comparison consumers preserve engine boundaries', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const env = { ...process.env, TSX_TSCONFIG_PATH: 'web/tsconfig.json' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      './cli/node_modules/tsx/dist/loader.mjs',
      '--test',
      'web/test/measurement-consumer.test.ts',
    ],
    { cwd: root, env, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /pass 2/);
});
