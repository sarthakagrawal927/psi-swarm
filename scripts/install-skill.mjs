#!/usr/bin/env node
// Installs the psi-swarm skill into Claude Code's user-level skills directory.
// Codex users: read .claude/skills/psi-swarm/SKILL.md and copy the relevant
// section into ~/.codex/AGENTS.md (no auto-install — Codex's pattern differs).

import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '.claude', 'skills', 'psi-swarm', 'SKILL.md');
const dstDir = join(homedir(), '.claude', 'skills', 'psi-swarm');
const dst = join(dstDir, 'SKILL.md');

if (!existsSync(src)) {
  console.error(`✗ Source not found: ${src}`);
  process.exit(1);
}

mkdirSync(dstDir, { recursive: true });
copyFileSync(src, dst);
console.log(`✓ Installed psi-swarm skill → ${dst}`);
console.log('');
console.log('Claude Code will now use it automatically when you ask about web');
console.log('performance, Lighthouse, or Core Web Vitals of a URL.');
console.log('');
console.log('For Codex (~/.codex/AGENTS.md), see the "For Codex users" section');
console.log('in the skill file for what to copy in.');
