import assert from 'node:assert/strict';
import test from 'node:test';
import { Graph, Metrics } from 'lighthouse/core/lib/lantern/lantern.js';

const moduleUrl = 'https://example.com/deferred-module.js';
const documentUrl = 'https://example.com/';
const task = { name: 'RunTask', ts: 200, dur: 10, tid: 1, pid: 1, args: {} };

function moduleTask() {
  // Older Chrome traces identify the module by scriptId; ModuleEvaluated's URL
  // is the document URL. The engine must use its compileModule URL mapping.
  return new Graph.CPUNode(
    task,
    [
      { name: 'v8.evaluateModule', ts: 200, dur: 9, args: { worldId: 0 } },
      {
        name: 'ModuleEvaluated',
        ts: 209,
        dur: 1,
        args: { data: { scriptId: 14, url: documentUrl } },
      },
    ],
    undefined,
    new Map([[14, moduleUrl]])
  );
}

test('official engine attributes deferred modules from older Chrome script IDs', () => {
  assert.deepEqual([...moduleTask().getEvaluateScriptURLs()], [moduleUrl]);
});

test('a module evaluated after paint is excluded from its render-blocking script set', () => {
  const script = new Graph.NetworkNode({
    requestId: 'module',
    rendererStartTime: 0,
    networkEndTime: 0.1,
    resourceType: 'Script',
    priority: 'High',
    url: moduleUrl,
  });
  moduleTask().addDependency(script);
  const result = Metrics.FirstContentfulPaint.getRenderBlockingNodeData(script, {
    cutoffTimestamp: 150,
    treatNodeAsRenderBlocking: () => true,
  });
  assert.deepEqual([...result.definitelyNotRenderBlockingScriptUrls], [moduleUrl]);
});

test('official engine still attributes classic scripts and URL-bearing module events', () => {
  for (const name of ['EvaluateScript', 'v8.evaluateModule']) {
    const cpu = new Graph.CPUNode(task, [
      { name, ts: 200, dur: 10, args: { data: { url: moduleUrl } } },
    ]);
    assert.deepEqual([...cpu.getEvaluateScriptURLs()], [moduleUrl]);
  }
});
