/**
 * A stub-engine `Runner` over real git, shared by control-tower phase 82's
 * suites (`sweep-keeps-resumable`, `provisional-lock-branch`): the engine is a
 * script, the sessions are a function, and git is real — the shape of
 * `git-strategy.test.ts`, whose own copy stays with it.
 */
import './state-sandbox.ts';

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { Runner } from '../server/runner/runner.ts';
import { runDir } from '../server/runner/state.ts';
import type { SpawnFn, SpawnRequest } from '../server/runner/spawn.ts';

export function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env, LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'p82', GIT_AUTHOR_EMAIL: 'p82@example.invalid',
      GIT_COMMITTER_NAME: 'p82', GIT_COMMITTER_EMAIL: 'p82@example.invalid',
    },
  })).trim();
}

const trash: string[] = [];
process.on('exit', () => { for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } });

export function repoAt(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

/** A superproject with two initialized submodules, `web` and `api`. */
export function superRoot(): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'p82-sweep-'));
  trash.push(base);
  const web = repoAt(join(base, 'web-src'), { 'index.html': 'web\n' });
  const api = repoAt(join(base, 'api-src'), { 'api.txt': 'api\n' });
  const root = repoAt(join(base, 'repo'), { 'README.md': 'root\n', 'docs/plans/demo.md': '# demo\n' });
  git(root, 'submodule', 'add', '-q', web, 'web');
  git(root, 'submodule', 'add', '-q', api, 'api');
  git(root, 'commit', '-q', '-m', 'submodules');
  return { base, root };
}

export type Harness = {
  root: string; scripts: string; state: string;
  requests: SpawnRequest[];
  runner: InstanceType<typeof Runner>;
};

/**
 * A two-phase stub plan driven through a real `Runner`, the shape of
 * `git-strategy.test.ts`: the engine is a script, the sessions are a function,
 * and git is real. `repos` is each phase's Repos cell as the engine prints it.
 */
export function harness(
  root: string,
  repos: Record<number, string>,
  deps: Record<string, unknown>,
  onSpawn?: (request: SpawnRequest, runner: InstanceType<typeof Runner>) => void | Promise<void>,
  opts: { lockScript?: (state: string) => string } = {},
): Harness {
  const scripts = mkdtempSync(join(tmpdir(), 'p82-scripts-'));
  const state = join(scripts, '.stub');
  trash.push(scripts);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'done'), '');
  const sh = (name: string, body: string): void => {
    writeFileSync(join(scripts, name), body);
    chmodSync(join(scripts, name), 0o755);
  };
  sh('phase-graph.sh', `#!/usr/bin/env bash
set -u
S="${state}"
shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""
    for p in 1 2; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"; else r="$r$p,"; fi
    done
    echo "done: \${d%,}"
    echo "ready: \${r%,}"
    echo "waiting:"
    ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "clear" ;;
  --repos) case "$arg" in 1) echo "${repos[1] ?? 'web'}" ;; *) echo "${repos[2] ?? 'web'}" ;; esac ;;
  *) echo "" ;;
esac
`);
  sh('phase-lock.sh', opts.lockScript?.(state) ?? '#!/usr/bin/env bash\nexit 0\n');
  for (const name of ['next-phase-prompt.sh', 'new-handoff.sh']) sh(name, '#!/usr/bin/env bash\nexit 0\n');
  sh('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');

  const requests: SpawnRequest[] = [];
  let runner: InstanceType<typeof Runner>;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    requests.push(request);
    await onSpawn?.(request, runner);
    const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
    if (phase) writeFileSync(join(state, 'done'), `${phase}\n`, { flag: 'a' });
    return {
      signal: { subtype: 'success', code: 0, text: '' },
      sessionId: `sess-${phase ?? 'x'}`, costUsd: 0, turns: 1, resultText: 'done', durationMs: 5, argv: [],
    };
  };
  runner = new Runner({
    scriptsDir: scripts, spawn, verificationText: () => '`true`',
    // The phase's own scope — what admission, the claim and the refusal read.
    phaseScope: (_slug: string, phase: number) => [repos[phase] ?? 'web'],
    ...deps,
  } as never);
  return { root, scripts, state, requests, runner };
}

export const ISOLATED = { slug: 'demo', gitMode: 'new-branch', isolation: 'worktree', settle: 'keep' } as const;

export async function drive(h: Harness, options: Record<string, unknown>): Promise<Record<string, unknown>> {
  await h.runner.start({ ...ISOLATED, root: h.root, ...options } as never);
  await h.runner.wait();
  return h.runner.current() as unknown as Record<string, unknown>;
}

export function journal(root: string, event: string): Record<string, unknown>[] {
  const dir = runDir(root, 'demo');
  if (!existsSync(dir)) return [];
  const out: Record<string, unknown>[] = [];
  for (const file of readdirSync(dir).filter((f) => /^run-.*\.jsonl$/.test(f))) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.event === event) out.push(entry);
    }
  }
  return out;
}

export async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((done) => { setTimeout(done, 50); });
  }
  assert.fail(`timed out waiting for ${what}`);
}

/* ------------------------------------------------------------------ *
 * A board the SUITE writes (control-tower phase 86)
 * ------------------------------------------------------------------ */

export type BoardWord = 'done' | 'in-progress' | 'stuck' | 'ready' | 'waiting';

export type BoardHarness = {
  root: string; scripts: string; state: string;
  /** Each phase's board word; `render()` writes it where the engine reads it. */
  states: Record<number, BoardWord>;
  /** `waiting` phases' unmet dependencies — the engine's `blocked:` line. */
  blocked: Record<number, number[]>;
  render: () => void;
  /** The phases whose sessions spawned, in spawn order. */
  spawned: number[];
  requests: SpawnRequest[];
  runner: InstanceType<typeof Runner>;
  events: { event: string; data: Record<string, unknown> }[];
};

/**
 * A stub-engine `Runner` over a board the test writes: `--memory-block` prints
 * `<state>/board`, so a phase can sit `in-progress` beside a `ready` one, or a
 * dependant can go back to `waiting` while it is queued — the shapes the
 * queue's ordering is about. No git (a shared checkout); each phase's scope is
 * `repos[phase]` (default `app`). A spawn marks its phase done and promotes the
 * waiting phases whose dependencies are then all done, unless `onSpawn`
 * answers an outcome of its own.
 */
export function boardHarness(opts: {
  states: Record<number, BoardWord>;
  blocked?: Record<number, number[]>;
  repos?: Record<number, string>;
  deps?: Record<string, unknown>;
  onSpawn?: (phase: number, request: SpawnRequest, h: BoardHarness) => unknown;
}): BoardHarness {
  const root = mkdtempSync(join(tmpdir(), 'p86-board-'));
  trash.push(root);
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  const sh = (name: string, body: string): void => {
    writeFileSync(join(scripts, name), body);
    chmodSync(join(scripts, name), 0o755);
  };
  sh('phase-graph.sh', `#!/usr/bin/env bash
set -u
S="${state}"
shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block) cat "$S/board" ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "clear (no gate)" ;;
  --size) echo M ;;
  *) echo "" ;;
esac
`);
  sh('phase-lock.sh', '#!/usr/bin/env bash\nexit 0\n');
  for (const name of ['next-phase-prompt.sh', 'new-handoff.sh']) sh(name, '#!/usr/bin/env bash\nexit 0\n');
  sh('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');

  const h = {
    root, scripts, state, states: { ...opts.states }, blocked: { ...(opts.blocked ?? {}) },
    spawned: [] as number[], requests: [] as SpawnRequest[], events: [] as { event: string; data: Record<string, unknown> }[],
  } as BoardHarness;
  h.render = () => {
    const of = (word: BoardWord): string => Object.entries(h.states)
      .filter(([, w]) => w === word).map(([p]) => p).sort((a, b) => Number(a) - Number(b)).join(',');
    const blocked = Object.entries(h.blocked).filter(([p]) => h.states[Number(p)] === 'waiting')
      .map(([p, deps]) => `${p}<-${deps.map((d) => `${d}(not-done)`).join(',')}`).join(' ');
    writeFileSync(join(state, 'board'), [
      `done: ${of('done')}`, `in-progress: ${of('in-progress')}`, `stuck: ${of('stuck')}`,
      `ready: ${of('ready')}`, `waiting: ${of('waiting')}`, ...(blocked ? [`blocked: ${blocked}`] : []),
    ].join('\n') + '\n');
  };
  h.render();
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    h.requests.push(request);
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? /phase (\d+)/.exec(request.prompt)?.[1] ?? 0);
    h.spawned.push(phase);
    const own = await opts.onSpawn?.(phase, request, h);
    if (own && typeof own === 'object') {
      return { signal: { subtype: 'success', code: 0, text: '' }, sessionId: `sess-${phase}`, costUsd: 0.01, turns: 1, resultText: 'done', durationMs: 5, argv: [], ...own } as never;
    }
    h.states[phase] = 'done';
    for (const [p, deps] of Object.entries(h.blocked)) {
      if (h.states[Number(p)] === 'waiting' && deps.every((d) => h.states[d] === 'done')) {
        h.states[Number(p)] = 'ready';
        delete h.blocked[Number(p)];
      }
    }
    h.render();
    return {
      signal: { subtype: 'success', code: 0, text: '' },
      sessionId: `sess-${phase}`, costUsd: 0.01, turns: 1, resultText: 'done', durationMs: 5, argv: [],
    };
  };
  h.runner = new Runner({
    scriptsDir: scripts, spawn, verificationText: () => '`true`',
    onEvent: (event: string, data: Record<string, unknown>) => h.events.push({ event, data }),
    phaseScope: (_slug: string, phase: number) => [opts.repos?.[phase] ?? 'app'],
    ...opts.deps,
  } as never);
  return h;
}

/** The journal lines a `boardHarness` runner emitted under `name`, in order. */
export function journalled(h: Pick<BoardHarness, 'events'>, name: string): Record<string, unknown>[] {
  return h.events.filter((e) => e.event === 'run:journal' && (e.data as { event?: string }).event === name)
    .map((e) => ({ ...((e.data as { data?: Record<string, unknown> }).data ?? {}), phase: (e.data as { phase?: number }).phase }));
}
