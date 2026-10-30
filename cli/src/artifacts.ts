import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RunResultWithArtifact } from './runner.js';

const ARTIFACTS_DIR = join(homedir(), '.psi-swarm', 'artifacts');

interface ArtifactOptions {
  tag?: string;
  swarmId?: string;
  artifactsDir?: string;
}

interface SwarmArtifactBundle {
  url: string;
  tag?: string;
  exportedAt: number;
  preset: string;
  runs: number;
  metrics: Array<Record<string, number | undefined>>;
  audits?: unknown[];
  finalUrl?: string;
  runMetadata: Array<{
    startedAt: number;
    finishedAt: number;
    metricsIndex: number | null;
    provenance?: RunResultWithArtifact['provenance'];
  }>;
}

function slugify(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 48);
}

/** Stable local path for one preset's Lighthouse capture bundle. */
function exportPresetArtifacts(
  url: string,
  presetName: string,
  results: RunResultWithArtifact[],
  opts: ArtifactOptions = {}
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const swarmKey = opts.swarmId ?? `${stamp}-${slugify(url)}`;
  const dir = join(opts.artifactsDir ?? ARTIFACTS_DIR, swarmKey);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const attempts = results.filter((r) => r.preset.name === presetName);
  const presetRuns = results.filter((r) => r.preset.name === presetName && !r.error);
  let metricsIndex = 0;
  const bundle: SwarmArtifactBundle = {
    url,
    tag: opts.tag,
    exportedAt: Date.now(),
    preset: presetName,
    runs: presetRuns.length,
    metrics: presetRuns.map((r) => ({ ...(r.metrics ?? {}) })),
    audits: presetRuns.flatMap((r) => r.audits ?? []),
    finalUrl: presetRuns[0]?.finalUrl,
    runMetadata: attempts.map((r) => ({
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      metricsIndex: r.error ? null : metricsIndex++,
      provenance: r.provenance,
    })),
  };
  const path = join(dir, `${presetName}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(bundle, null, 2), 'utf-8');
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return path;
}

/** Export one bundle per preset in a swarm. Returns preset → artifact path. */
export function exportSwarmArtifacts(
  url: string,
  results: RunResultWithArtifact[],
  opts: ArtifactOptions = {}
): Map<string, string> {
  const byPreset = new Map<string, RunResultWithArtifact[]>();
  for (const r of results) {
    const arr = byPreset.get(r.preset.name) ?? [];
    arr.push(r);
    byPreset.set(r.preset.name, arr);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const swarmId = opts.swarmId ?? `${stamp}-${slugify(url)}`;
  const out = new Map<string, string>();
  for (const [name, rs] of byPreset) {
    out.set(name, exportPresetArtifacts(url, name, rs, { ...opts, swarmId }));
  }
  return out;
}
