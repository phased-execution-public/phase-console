/**
 * The brief (measured-console phase 4, A2).
 *
 * A session the console supervises is told what it starts from at
 * SessionStart, by the presence hook, instead of in its prompt: the engine's
 * `phase-graph.sh --brief N` — the mode file to read, the phase's section, the
 * decisions still open, the notes, the scope and lock lines, the previous
 * handoff's summary, the errands, the memory index — with the presence line and
 * the session id LAST, the whole context at most 10,000 characters. These tests
 * run the real script with no console answering and hold its context to the
 * engine's output, byte for byte, so the hook can never tell a session
 * something the engine did not say.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const BRIEF_MAX = 10_000;

/** A docs root holding the `linear` fixture as plan `demo`, phase 1 handed off. */
function scratch(): { dir: string; root: string; outcome: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-brief-'));
  const root = join(dir, 'project');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'demo'), { recursive: true });
  copyFileSync(join(SKILL_DIR, 'tests', 'fixtures', 'plans', 'linear.md'), join(root, 'docs', 'plans', 'demo.md'));
  writeFileSync(join(root, 'docs', 'handoffs', 'demo', 'phase-01-alpha.md'), [
    '---', 'plan: docs/plans/demo.md', 'phase: 1', 'title: alpha', 'status: complete', '---',
    '# Phase 1 → next handoff: alpha', '', '## Summary', 'Alpha built the package — beta starts from its dist.', '',
    '## What this phase did', 'Shipped what the phase set out to.', '',
  ].join('\n'));
  const runs = join(dir, 'state', 'runs', 'inst', 'demo');
  mkdirSync(runs, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state'),
    PHASE_CONSOLE_HOOK_INGEST: '0', PE_SCRIPTS: SCRIPTS, CLAUDE_PID: String(process.pid),
  };
  for (const key of ['DOCS_ROOT', 'PE_SESSION_ID', 'PE_OWNER', 'PE_SCOPE', 'PE_OUTCOME_FILE', 'PE_SLUG', 'PE_PHASE',
    'PE_BRIEF', 'PE_BRIEF_MAX', 'PE_LOCK_MIRROR', 'PHASE_CONSOLE_URL', 'PHASE_CONSOLE_HOOK_OFF', 'PHASE_CONSOLE_PROBE',
    'CLAUDE_CODE_SESSION_ID', 'PE_SESSION_KIND']) {
    delete env[key];
  }
  return {
    dir, root: realpathSync(root), outcome: join(runs, 'run-r1-p2-outcome.json'), env,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function hook(env: NodeJS.ProcessEnv, root: string, source = 'startup'): string {
  const out = spawnSync('/bin/bash', [join(SCRIPTS, 'session-hook.sh')], {
    input: JSON.stringify({ session_id: 's-brief', hook_event_name: 'SessionStart', cwd: root, source }),
    env, encoding: 'utf8', cwd: root, timeout: 30_000,
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim()).hookSpecificOutput.additionalContext as string;
}

function engineBrief(env: NodeJS.ProcessEnv, root: string, phase: number, max?: number): string {
  const out = spawnSync('/bin/bash', [join(SCRIPTS, 'phase-graph.sh'), 'demo', '--brief', String(phase)], {
    env: { ...env, DOCS_ROOT: root, ...(max ? { PE_BRIEF_MAX: String(max) } : {}) }, encoding: 'utf8', cwd: root,
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

test('the hook\'s brief is --brief N, byte for byte, with the presence line and the id last', () => {
  const { root, outcome, env, cleanup } = scratch();
  try {
    const context = hook({ ...env, DOCS_ROOT: root, PE_OUTCOME_FILE: outcome }, root);
    const lines = context.split('\n');
    assert.match(lines[0], /references\/mode-phase-start\.md/, 'the first line names the mode file');
    assert.match(lines.at(-1)!, /this Claude session's id is s-brief/, 'the last line carries the session id');
    assert.ok(Buffer.byteLength(context) <= BRIEF_MAX, `${Buffer.byteLength(context)} bytes`);
    const brief = lines.slice(0, -1).join('\n');
    assert.equal(brief, engineBrief(env, root, 2).replace(/\n$/, ''));
    assert.match(brief, /Alpha built the package — beta starts from its dist\./);
  } finally { cleanup(); }
});

test('the plan and phase come from PE_SLUG / PE_PHASE when the console states them', () => {
  const { root, dir, env, cleanup } = scratch();
  try {
    const context = hook({ ...env, DOCS_ROOT: root, PE_OUTCOME_FILE: join(dir, 'elsewhere.json'), PE_SLUG: 'demo', PE_PHASE: '3' }, root);
    assert.match(context, /^### Phase 3 — Gamma$/m);
    assert.equal(context.split('\n').slice(0, -1).join('\n'), engineBrief(env, root, 3).replace(/\n$/, ''));
  } finally { cleanup(); }
});

test('a brief past its budget is cut from the END: the head stays, the id is still last', () => {
  const { root, outcome, env, cleanup } = scratch();
  try {
    mkdirSync(join(root, 'docs', 'memory', 'demo'), { recursive: true });
    writeFileSync(join(root, 'docs', 'memory', 'demo', 'index.md'),
      Array.from({ length: 40 }, (_, i) => `- 2026-10-25 ${i} ${'m'.repeat(400)}`).join('\n') + '\n');
    const context = hook({ ...env, DOCS_ROOT: root, PE_OUTCOME_FILE: outcome }, root);
    assert.ok(Buffer.byteLength(context) <= BRIEF_MAX, `${Buffer.byteLength(context)} bytes`);
    assert.match(context.split('\n')[0], /mode-phase-start/);
    assert.match(context, /the brief stops here at \d+ bytes/);
    assert.match(context.split('\n').at(-1)!, /this Claude session's id is s-brief/);
  } finally { cleanup(); }
});

test('without PE_OUTCOME_FILE, and on a resume, the hook says presence alone', () => {
  const { root, outcome, env, cleanup } = scratch();
  try {
    const plain = hook({ ...env, DOCS_ROOT: root }, root);
    assert.doesNotMatch(plain, /mode-phase-start/);
    assert.equal(plain.split('\n').length, 1);
    assert.match(plain, /this Claude session's id is s-brief/);
    const resumed = hook({ ...env, DOCS_ROOT: root, PE_OUTCOME_FILE: outcome }, root, 'resume');
    assert.doesNotMatch(resumed, /mode-phase-start/, 'a resumed session already holds its brief');
  } finally { cleanup(); }
});
