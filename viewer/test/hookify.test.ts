/**
 * The hookify rule files the console writes per plan, and the hooks Settings ▸
 * Hooks reads (measured-console phase 28, D3).
 *
 * Pinned: a plan's rules come from its `permission.destructive` row and the
 * never list — publishing blocks under the shipped deny and only WARNS when the
 * row names an exception; the never families always block; each file is
 * hookify's shape (front matter `name` · `enabled` · `event` · `action` · a
 * `pattern` or `conditions`, then the words); a write touches only the
 * console's own `hookify.pe-<slug>-` files, rewrites nothing that is current,
 * removes a file the rules no longer name and keeps the repository clean
 * (`info/exclude`); the read-back says whether a file is current; the
 * patterns match what they name and nothing beside it; a hook row carries its
 * event, matcher, timeout and `onFailure` and never a bearer. The run's own
 * enforcement is `approvals.test.ts`'s, and unchanged.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HOOKIFY_IGNORE, HOOKIFY_PREFIX, hookifyRules, hookifyText, readHookify, writeHookify,
} from '../server/hookify.ts';
import { hookRowsOf } from '../server/hooks-install.ts';
import { buildSettings, HOOK_ON_FAILURE } from '../server/runner/approvals.ts';
import { parseFrontMatter } from '../server/parse/frontmatter.ts';

const EXCEPTED = 'deny; allow `git push` and `gh pr create` in the release phases';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hookify-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

test('the shipped deny blocks publishing; a named exception only warns, and names it', () => {
  const shipped = hookifyRules('demo', null);
  assert.deepEqual(shipped.map((rule) => rule.rule), ['publish', 'force-push', 'host', 'secret-files']);
  const publish = shipped.find((rule) => rule.rule === 'publish')!;
  assert.equal(publish.action, 'block');
  assert.equal(publish.source, 'permission.destructive');
  const excepted = hookifyRules('demo', EXCEPTED).find((rule) => rule.rule === 'publish')!;
  assert.equal(excepted.action, 'warn');
  assert.match(excepted.words, /Bash\(git push:\*\)/);
  assert.match(excepted.words, /Bash\(gh pr create:\*\)/);
  // The never list does not move with the row.
  for (const rule of hookifyRules('demo', EXCEPTED).filter((r) => r.source === 'never')) assert.equal(rule.action, 'block');
});

test("each file is hookify's shape, named for the console and the plan", () => {
  for (const rule of hookifyRules('measured-console', null)) {
    assert.ok(rule.file.startsWith(`${HOOKIFY_PREFIX}measured-console-`), rule.file);
    assert.ok(rule.file.endsWith('.local.md'));
    const text = hookifyText(rule);
    const { values, lines } = parseFrontMatter(text);
    assert.equal(values.name, `pe-measured-console-${rule.rule}`);
    assert.equal(values.enabled, 'true');
    assert.equal(values.event, rule.event);
    assert.equal(values.action, rule.action);
    assert.ok(values.pattern || rule.conditions?.length, `${rule.rule} has a pattern or conditions`);
    assert.ok(text.split('\n').slice(lines).join('\n').includes(rule.words));
  }
  const secrets = hookifyText(hookifyRules('x', null).find((rule) => rule.rule === 'secret-files')!);
  assert.match(secrets, /conditions:\n {2}- field: file_path\n {4}operator: regex_match\n {4}pattern: /);
});

test('the patterns match what they name, and nothing beside it', () => {
  const rule = (name: string) => new RegExp(hookifyRules('x', null).find((r) => r.rule === name)!.pattern!);
  const publish = rule('publish');
  for (const yes of ['git push origin pe/x', 'gh pr create --fill', 'gh pr merge 4', 'npm publish', 'gh release create v9']) assert.ok(publish.test(yes), yes);
  for (const no of ['git pushd', 'git status', 'gh pr view 3']) assert.ok(!publish.test(no), no);
  const force = rule('force-push');
  for (const yes of ['git push --force origin x', 'git push -f', 'git push origin --delete x', 'git push --force-with-lease']) assert.ok(force.test(yes), yes);
  for (const no of ['git push origin main', 'git push -u origin x']) assert.ok(!force.test(no), no);
  const host = rule('host');
  for (const yes of ['sudo rm -rf /', 'ls && reboot', 'dd if=/dev/zero of=x']) assert.ok(host.test(yes), yes);
  for (const no of ['pseudo-code', 'echo add']) assert.ok(!host.test(no), no);
  const secret = new RegExp(hookifyRules('x', null).find((r) => r.rule === 'secret-files')!.conditions![0]!.pattern);
  for (const yes of ['/r/.env', '/r/.env.local', '/r/.secrets/token', '/home/u/.ssh/id_ed25519', '/r/key.pem']) assert.ok(secret.test(yes), yes);
  for (const no of ['/r/env.ts', '/r/docs/.environment.md']) assert.ok(!secret.test(no), no);
});

test("a write touches only the plan's own files, rewrites nothing current, removes what the rules dropped", () => {
  const root = repo();
  try {
    const dir = join(root, '.claude');
    const first = writeHookify(root, 'demo', null);
    assert.equal(first.written.length, 4);
    // A person's own rule, and another plan's, stand beside them.
    writeFileSync(join(dir, 'hookify.my-rule.local.md'), 'mine');
    writeFileSync(join(dir, `${HOOKIFY_PREFIX}other-publish.local.md`), 'theirs');
    // A file of this plan the rules no longer name.
    writeFileSync(join(dir, `${HOOKIFY_PREFIX}demo-retired.local.md`), 'old');
    const second = writeHookify(root, 'demo', null);
    assert.deepEqual(second.written, []);
    assert.equal(second.unchanged.length, 4);
    assert.deepEqual(second.removed, [`${HOOKIFY_PREFIX}demo-retired.local.md`]);
    assert.equal(readFileSync(join(dir, 'hookify.my-rule.local.md'), 'utf8'), 'mine');
    assert.equal(readFileSync(join(dir, `${HOOKIFY_PREFIX}other-publish.local.md`), 'utf8'), 'theirs');
    // The row changed: only publish is rewritten.
    assert.deepEqual(writeHookify(root, 'demo', EXCEPTED).written, [`${HOOKIFY_PREFIX}demo-publish.local.md`]);
    // The repository stays clean: the files are excluded, never a tracked .gitignore.
    assert.ok(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').includes(HOOKIFY_IGNORE));
    const status = execFileSync('git', ['status', '--porcelain', '--', '.claude'], { cwd: root, encoding: 'utf8' });
    assert.ok(!status.includes(`${HOOKIFY_PREFIX}demo`), status);
    writeHookify(root, 'demo', EXCEPTED);
    assert.equal(
      readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((line) => line === HOOKIFY_IGNORE).length,
      1,
      'the ignore line is written once',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the read-back says what is on disk and whether it is current', () => {
  const root = repo();
  try {
    assert.deepEqual(readHookify(root, 'demo', null).onDisk, []);
    writeHookify(root, 'demo', null);
    const read = readHookify(root, 'demo', null);
    assert.equal(read.onDisk.length, 4);
    assert.ok(read.onDisk.every((file) => file.current && file.enabled));
    const publish = read.onDisk.find((file) => file.file.endsWith('publish.local.md'))!;
    assert.equal(publish.action, 'block');
    assert.equal(publish.event, 'bash');
    assert.match(publish.words, /denies publishing/);
    // The row moved on and nobody started a run: the file is out of date.
    assert.equal(readHookify(root, 'demo', EXCEPTED).onDisk.find((f) => f.file === publish.file)!.current, false);
    assert.deepEqual(readdirSync(join(root, '.claude')).filter((n) => !n.startsWith(HOOKIFY_PREFIX)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hook row carries event, matcher, timeout and onFailure — and a run's bearer never leaves", () => {
  const settings = buildSettings({ runId: 'r', token: 'secret-token', origin: 'http://127.0.0.1:1', guardHook: '/g.sh', relay: true });
  const rows = hookRowsOf(settings, 'run', 'run-r.json');
  const pre = rows.filter((row) => row.event === 'PreToolUse');
  assert.ok(pre.length >= 2, 'the http hook and the guard');
  for (const row of pre) assert.equal(row.onFailure, HOOK_ON_FAILURE);
  assert.ok(pre.every((row) => row.matcher), 'each names its matcher');
  assert.ok(rows.some((row) => row.event === 'PermissionRequest'));
  assert.ok(!JSON.stringify(rows).includes('secret-token'));
  const user = hookRowsOf(
    { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash x.sh', timeout: 3 }] }] } },
    'user',
    '~/.claude/settings.json',
  );
  assert.deepEqual(user, [{ source: 'user', file: '~/.claude/settings.json', event: 'Stop', type: 'command', runs: 'bash x.sh', timeout: 3 }]);
  assert.deepEqual(hookRowsOf({ nothing: true }, 'project', 'x'), []);
});
