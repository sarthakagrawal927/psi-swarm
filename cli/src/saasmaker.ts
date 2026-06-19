/**
 * SaaS Maker auth for the psi-swarm CLI.
 *
 * "Working auth at the very least": hold an sm_ token (device flow or env/config)
 * and prove it works against the LIVE api.sassmaker.com. psi-swarm runs fine with
 * no token — this only lights up when the user runs `psi-swarm connect`. Mirrors
 * the device-flow contract CodeVetter uses (POST /v1/cli/code → approve → poll).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const CONFIG_DIR = join(homedir(), '.psi-swarm');
const CONFIG_PATH = join(CONFIG_DIR, 'saasmaker.json');
const DEFAULT_BASE = 'https://api.sassmaker.com';

export interface SaasMakerConfig {
  token?: string;
  base?: string;
}

export interface FleetProject {
  id: string;
  slug: string | null;
  name: string;
}

export function loadConfig(): SaasMakerConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as SaasMakerConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: SaasMakerConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/** Token from env first (SAASMAKER_TOKEN / SAASMAKER_SESSION_TOKEN), then ~/.psi-swarm/saasmaker.json. */
export function resolveToken(): string | null {
  return process.env.SAASMAKER_TOKEN || process.env.SAASMAKER_SESSION_TOKEN || loadConfig().token || null;
}

export function resolveBase(): string {
  return process.env.SAASMAKER_BASE_URL || loadConfig().base || DEFAULT_BASE;
}

/** Confirm a token actually works by listing the caller's projects. */
export async function verifyAuth(
  token: string | null = resolveToken(),
  base: string = resolveBase(),
): Promise<{ ok: boolean; status: number; projects: FleetProject[] }> {
  if (!token) return { ok: false, status: 0, projects: [] };
  const res = await fetch(`${base.replace(/\/+$/, '')}/v1/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { ok: false, status: res.status, projects: [] };
  const body = (await res.json().catch(() => ({}))) as { data?: unknown[] } | unknown[];
  const arr = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown[] }).data) ? (body as { data: unknown[] }).data : [];
  const projects = arr.map((p) => {
    const r = p as Record<string, unknown>;
    return { id: String(r.id ?? ''), slug: (r.slug as string) ?? null, name: String(r.name ?? '') };
  });
  return { ok: true, status: res.status, projects };
}

/**
 * Device-flow login: request a code, point the user at the approval URL, poll
 * until approved, then persist the sm_ token. Returns the token.
 */
export async function deviceLogin(
  base: string = resolveBase(),
  onPrompt?: (url: string) => void,
): Promise<string> {
  const root = base.replace(/\/+$/, '');
  const codeRes = await fetch(`${root}/v1/cli/code`, { method: 'POST' });
  if (!codeRes.ok) throw new Error(`POST /v1/cli/code failed (${codeRes.status})`);
  const { code, url, expires_in } = (await codeRes.json()) as { code: string; url: string; expires_in: number };
  onPrompt?.(url);

  const deadline = Date.now() + (expires_in ?? 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`${root}/v1/cli/poll?code=${encodeURIComponent(code)}`);
    const body = (await pollRes.json().catch(() => ({}))) as { status?: string; token?: string };
    if (body.status === 'approved' && body.token) {
      saveConfig({ ...loadConfig(), token: body.token, base });
      return body.token;
    }
    if (body.status === 'expired') break;
  }
  throw new Error('Device authorization timed out or was not approved.');
}
