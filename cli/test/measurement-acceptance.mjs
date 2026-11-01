import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22 || major > 24) {
  test('acceptance executes on the declared supported backend Node runtime', () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      'mise',
      ['exec', 'node@24.20.0', '--', 'node', '--test', fileURLToPath(import.meta.url)],
      { env, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /fail 0/);
    console.log(
      'Acceptance child runtime: Node24.20.0 (backend pin); outer runtime:',
      process.version
    );
    console.log(result.stdout);
  });
} else {
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
}
