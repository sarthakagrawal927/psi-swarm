import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RunResultWithArtifact } from './runner.js';

export const ARTIFACTS_DIR = join(homedir(), '.psi-swarm', 'artifacts');

export interface SwarmArtifactBundle {
  url: string;
  tag?: string;
  exportedAt: number;
  preset: string;
  runs: number;
  metrics: Array<Record<string, number | undefined>>;
  audits?: unknown[];
  finalUrl?: string;
}

function slugify(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 48);
}

/** Stable local path for one preset's Lighthouse capture bundle. */
export function exportPresetArtifacts(
  url: string,
  presetName: string,
  results: RunResultWithArtifact[],
  opts: { tag?: string; swarmId?: string } = {},
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const swarmKey = opts.swarmId ?? `${stamp}-${slugify(url)}`;
  const dir = join(ARTIFACTS_DIR, swarmKey);
  mkdirSync(dir, { recursive: true });

  const presetRuns = results.filter((r) => r.preset.name === presetName && !r.error);
  const bundle: SwarmArtifactBundle = {
    url,
    tag: opts.tag,
    exportedAt: Date.now(),
    preset: presetName,
    runs: presetRuns.length,
    metrics: presetRuns.map((r) => ({ ...(r.metrics ?? {}) })),
    audits: presetRuns.flatMap((r) => r.audits ?? []),
    finalUrl: presetRuns[0]?.finalUrl,
  };
  const path = join(dir, `${presetName}.json`);
  writeFileSync(path, JSON.stringify(bundle, null, 2), 'utf-8');
  return path;
}

/** Export one bundle per preset in a swarm. Returns preset → artifact path. */
export function exportSwarmArtifacts(
  url: string,
  results: RunResultWithArtifact[],
  opts: { tag?: string; swarmId?: string } = {},
): Map<string, string> {
  const byPreset = new Map<string, RunResultWithArtifact[]>();
  for (const r of results) {
    if (r.error) continue;
    const arr = byPreset.get(r.preset.name) ?? [];
    arr.push(r);
    byPreset.set(r.preset.name, arr);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const swarmId = opts.swarmId ?? `${stamp}-${slugify(url)}`;
  const out = new Map<string, string>();
  for (const [name, rs] of byPreset) {
    out.set(name, exportPresetArtifacts(url, name, rs, { tag: opts.tag, swarmId }));
  }
  return out;
}
