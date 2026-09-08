/**
 * `server/memory.ts` — the third artefact of the trio, and the one nothing
 * tested (coverage-13).
 *
 * Memory is the only artefact that does NOT live in the project repo: it sits
 * under the Claude home(s), its file name may not match the slug (a plan's
 * `memory:` key can point at a pre-existing entry), and it is spelled with
 * either an underscore or a hyphen because both exist in the wild. Three
 * degrees of freedom, and the failure mode of getting any of them wrong is
 * silent: `findMemory` returns `undefined`, the phase page renders "no memory
 * entry", and the durable record a session was told to read simply does not
 * appear. Nothing errors.
 *
 * `memoryDirs()` is exercised against a fabricated `$HOME` — `os.homedir()`
 * prefers `$HOME` on POSIX, so the directory shape (which `.claude*` homes
 * count, and that a project without a `memory/` directory is skipped) can be
 * asserted without touching the operator's own.
 *
 * Needs no plan library, no PHASE_CONSOLE_TEST_ROOT, no client build.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TRASH: string[] = [];
const REAL_HOME = process.env.HOME;

process.on('exit', () => {
  for (const dir of TRASH) {
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  }
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TRASH.push(dir);
  return dir;
}

/** A memory directory with the given `<name>: <contents>` files in it. */
function memoryDir(files: Record<string, string>): string {
  const dir = scratch('pc-memory-');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const { memoryDirs, findMemory, memoryIndexLines } = await import('../server/memory.ts');

test('findMemory: both spellings are searched, and the exact key wins', () => {
  assert.equal(
    findMemory('project_demo', [memoryDir({ 'project_demo.md': 'underscore\n' })])?.text,
    'underscore\n',
  );
  // The hyphen spelling is not a typo to be corrected — entries written by
  // older tooling really are named this way, and they are the same entry.
  assert.equal(
    findMemory('project_demo', [memoryDir({ 'project-demo.md': 'hyphen\n' })])?.text,
    'hyphen\n',
  );
  // A bare name with no prefix at all is the last candidate.
  assert.equal(
    findMemory('project_demo', [memoryDir({ 'demo.md': 'bare\n' })])?.text,
    'bare\n',
  );

  // Asked by the hyphen key, the underscore file still answers: the prefix is
  // stripped before the candidates are built, so neither spelling is primary.
  assert.equal(
    findMemory('project-demo', [memoryDir({ 'project_demo.md': 'underscore\n' })])?.text,
    'underscore\n',
  );

  // When several spellings coexist, the key AS GIVEN is tried first.
  const both = memoryDir({ 'project-demo.md': 'hyphen\n', 'project_demo.md': 'underscore\n' });
  assert.equal(findMemory('project-demo', [both])?.text, 'hyphen\n', 'the exact key is candidate one');
  assert.equal(findMemory('project_demo', [both])?.text, 'underscore\n');
});

test('findMemory: a plan\'s `memory:` override finds an entry whose name is not the slug', () => {
  // The whole reason the key is a parameter rather than the slug: a plan may
  // point at an entry that predates it.
  const dir = memoryDir({ 'project_the-real-entry.md': 'durable facts\n' });
  assert.equal(findMemory('project_the-real-entry', [dir])?.text, 'durable facts\n');
  assert.equal(findMemory('project_console-audit-hardening', [dir]), undefined,
    'and the slug-named entry genuinely is not there');
});

test('findMemory: the entry carries the key it was asked for, its path and its mtime', () => {
  const dir = memoryDir({ 'project_demo.md': 'body\n' });
  const entry = findMemory('project_demo', [dir]);
  assert.ok(entry);
  assert.equal(entry.key, 'project_demo', 'the key is echoed as ASKED, not as found');
  assert.equal(entry.path, join(dir, 'project_demo.md'));
  assert.equal(entry.text, 'body\n');
  assert.ok(Number.isFinite(entry.mtime) && entry.mtime > 0, 'mtime drives the "last updated" note');
});

test('findMemory: directories are searched in order, and a miss is undefined', () => {
  const first = memoryDir({ 'project_demo.md': 'from the first home\n' });
  const second = memoryDir({ 'project_demo.md': 'from the second home\n' });
  assert.equal(findMemory('project_demo', [first, second])?.text, 'from the first home\n');
  assert.equal(findMemory('project_demo', [second, first])?.text, 'from the second home\n');

  assert.equal(findMemory('project_demo', []), undefined, 'no directories, no entry');
  assert.equal(findMemory('project_nothing', [first]), undefined, 'a key nobody wrote');
  assert.equal(findMemory('project_demo', [join(tmpdir(), 'pc-memory-does-not-exist')]), undefined,
    'a directory that is not there is skipped, not fatal');
});

test('findMemory: an unreadable entry is absent rather than an exception', () => {
  // "Unreadable memory is simply absent" — the console must render a phase
  // page whatever the filesystem thinks of it.
  const dir = memoryDir({ 'project_locked.md': 'secret\n' });
  chmodSync(join(dir, 'project_locked.md'), 0o000);

  let result: unknown;
  assert.doesNotThrow(() => { result = findMemory('project_locked', [dir]); });
  // Running as root defeats the permission bit; then the read legitimately
  // succeeds and the contract under test is simply not exercised.
  if (process.getuid?.() !== 0) {
    assert.equal(result, undefined, 'a file we cannot read is reported as no file');
  }
  chmodSync(join(dir, 'project_locked.md'), 0o600);
});

test('memoryIndexLines: the MEMORY.md pointers for this key, trimmed, dashes only', () => {
  const dir = memoryDir({
    'MEMORY.md': [
      '# Memory index',
      '',
      '## Plans',
      '  - [Demo plan](project_demo.md) — the hook line',
      '- [Something else](project_other.md) — unrelated',
      'demo appears here too but this line is prose, not a pointer',
      '  * [Demo](project_demo.md) — a bullet that is not a dash',
      '- [Demo, hyphen-spelled](project-demo.md) — also this one',
    ].join('\n'),
  });

  const lines = memoryIndexLines('project_demo', [dir]);
  assert.deepEqual(lines, [
    '- [Demo plan](project_demo.md) — the hook line',
    '- [Demo, hyphen-spelled](project-demo.md) — also this one',
  ]);
  for (const line of lines) assert.ok(line.startsWith('- '), 'trimmed, and a dash bullet');
});

test('memoryIndexLines: matching is on the BARE key, so either spelling is found', () => {
  const dir = memoryDir({ 'MEMORY.md': '- [Demo](project-demo.md) — hook\n' });
  // Asked with the underscore key, the hyphen-spelled pointer must still match:
  // the prefix is stripped and only `demo` is looked for.
  assert.deepEqual(memoryIndexLines('project_demo', [dir]), ['- [Demo](project-demo.md) — hook']);
  assert.deepEqual(memoryIndexLines('project-demo', [dir]), ['- [Demo](project-demo.md) — hook']);
});

test('memoryIndexLines: no index, no directories, or an unreadable index is an empty list', () => {
  assert.deepEqual(memoryIndexLines('project_demo', []), []);
  assert.deepEqual(memoryIndexLines('project_demo', [memoryDir({})]), [], 'a memory dir with no MEMORY.md');
  assert.deepEqual(memoryIndexLines('project_demo', [join(tmpdir(), 'pc-memory-absent')]), []);

  const dir = memoryDir({ 'MEMORY.md': '- [Demo](project_demo.md) — hook\n' });
  chmodSync(join(dir, 'MEMORY.md'), 0o000);
  let lines: string[] = ['not-run'];
  assert.doesNotThrow(() => { lines = memoryIndexLines('project_demo', [dir]); });
  if (process.getuid?.() !== 0) assert.deepEqual(lines, [], 'an unreadable index contributes nothing');
  chmodSync(join(dir, 'MEMORY.md'), 0o600);
});

test('memoryIndexLines: every matching directory contributes, in order', () => {
  const a = memoryDir({ 'MEMORY.md': '- [A](project_demo.md) — from home A\n' });
  const b = memoryDir({ 'MEMORY.md': '- [B](project_demo.md) — from home B\n' });
  assert.deepEqual(memoryIndexLines('project_demo', [a, b]), [
    '- [A](project_demo.md) — from home A',
    '- [B](project_demo.md) — from home B',
  ]);
});

test('memoryDirs: every .claude* home, every project, but only real memory directories', () => {
  const home = scratch('pc-home-');

  // Two homes that count, by the /^\.claude(-[a-z0-9]+)?$/ shape.
  mkdirSync(join(home, '.claude', 'projects', 'hub', 'memory'), { recursive: true });
  mkdirSync(join(home, '.claude-work', 'projects', 'other', 'memory'), { recursive: true });
  // A second project under the first home.
  mkdirSync(join(home, '.claude', 'projects', 'second', 'memory'), { recursive: true });
  // A project with no memory/ directory at all — skipped, not returned.
  mkdirSync(join(home, '.claude', 'projects', 'no-memory-here'), { recursive: true });
  // Homes that do NOT match the shape. `.claude-UPPER` rather than a
  // differently-cased spelling of a home used above: macOS and Windows fold
  // case in the FILESYSTEM, so `.claude-Work` beside `.claude-work` is ONE
  // directory there and the fixture would be asserting against itself.
  mkdirSync(join(home, '.claudex', 'projects', 'nope', 'memory'), { recursive: true });
  mkdirSync(join(home, '.claude-UPPER', 'projects', 'nope', 'memory'), { recursive: true });
  mkdirSync(join(home, 'claude', 'projects', 'nope', 'memory'), { recursive: true });

  process.env.HOME = home;
  try {
    const dirs = memoryDirs();
    assert.deepEqual([...dirs].sort(), [
      join(home, '.claude', 'projects', 'hub', 'memory'),
      join(home, '.claude', 'projects', 'second', 'memory'),
      join(home, '.claude-work', 'projects', 'other', 'memory'),
    ].sort());

    assert.ok(!dirs.some((d) => d.includes('.claudex')), 'a home whose suffix is not -<lower> does not count');
    assert.ok(!dirs.some((d) => d.includes('.claude-UPPER')), 'the suffix is lower-case only');
    assert.ok(!dirs.some((d) => d.includes('no-memory-here')), 'a project without memory/ is skipped');
  } finally {
    if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  }
});

test('memoryDirs: a home with no .claude* directory at all yields nothing', () => {
  const home = scratch('pc-home-empty-');
  process.env.HOME = home;
  try {
    assert.deepEqual(memoryDirs(), [], 'no homes, no directories — and no throw');
  } finally {
    if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  }
});

test('findMemory defaults to the real memoryDirs(), so the seam is optional', () => {
  // The default parameter is what production uses; a caller passing dirs is the
  // test seam. Asking for a key nobody could have written proves the default is
  // wired without asserting anything about this machine's actual memory.
  assert.doesNotThrow(() => findMemory('project_a-key-that-cannot-exist-9f3c2b'));
  assert.equal(findMemory('project_a-key-that-cannot-exist-9f3c2b'), undefined);
  assert.deepEqual(memoryIndexLines('project_a-key-that-cannot-exist-9f3c2b'), []);
});
