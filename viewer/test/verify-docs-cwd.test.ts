/**
 * A `docs/…` line in a mirror runs where the docs are, and a line that never
 * reached its file is never inherited (one-pool phase 20, #357).
 *
 * Measured: robot-platform-tags run `c67783c2b173`. Phase 2's `grep -q "Refs
 * #334" docs/handoffs/robot-platform-tags/pr-body-aws.md` passed at the docs
 * root when the session ran it; the console re-ran it in the mirror — which has
 * no `docs/` — and it exited 2, "No such file or directory". The baseline had
 * read it red the same way, so the verdict passed it as INHERITED: in a mirror
 * such a line was never checked, and a missing PR body would have passed.
 *
 *  - VD-1 a docs-only line runs with cwd = the docs root when one is given: it
 *    passes when the file holds the text and fails when it does not;
 *  - VD-2 a red line that never reached a file it names is marked `unreached`,
 *    and its red is the phase's own whatever the baseline read — as is a red
 *    whose base-tree line never reached its file;
 *  - VD-3 which lines are docs-only.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { docsOnlyLine, missingFiles, namedFiles, verifyPhase } from '../server/runner/verify.ts';
import { splitReds } from '../server/runner/verify-ledger.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

/** A mirror (mounts, no docs/) beside the docs root it belongs to. */
function layout(body: string | null): { mirror: string; docsRoot: string; file: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pc-vdocs-')));
  TRASH.push(base);
  const mirror = join(base, 'integration');
  mkdirSync(join(mirror, 'aws'), { recursive: true });
  const docsRoot = join(base, 'hub');
  const dir = join(docsRoot, 'docs', 'handoffs', 'robot-platform-tags');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'pr-body-aws.md');
  if (body !== null) writeFileSync(file, body);
  return { mirror, docsRoot, file };
}

const LINE = 'grep -q "Refs #334" docs/handoffs/robot-platform-tags/pr-body-aws.md';
const text = `- \`${LINE}\``;

test('VD-1 (#357): a docs-only line runs at the docs root — green when the file holds the text, red when it does not', async () => {
  const held = layout('Fixes the tags.\n\nRefs #334\n');
  const green = await verifyPhase(text, { cwd: held.mirror, docsRoot: held.docsRoot });
  assert.equal(green.ok, true, green.reason);
  assert.equal(green.ran[0]!.ranIn, held.docsRoot, 'it ran where the docs are');

  const lacking = layout('Fixes the tags.\n');
  const red = await verifyPhase(text, { cwd: lacking.mirror, docsRoot: lacking.docsRoot });
  assert.equal(red.ok, false);
  assert.equal(red.ran.at(-1)!.code, 1, 'grep read the file and did not find the text');
  assert.equal(red.ran.at(-1)!.unreached, undefined, 'the file was reached');

  // 7.1's shape, for the record: in the mirror itself the line can never pass.
  const before = await verifyPhase(text, { cwd: held.mirror });
  assert.equal(before.ok, false);
  assert.equal(before.ran.at(-1)!.code, 2);
  assert.deepEqual(before.ran.at(-1)!.unreached, ['docs/handoffs/robot-platform-tags/pr-body-aws.md']);
});

test('VD-2 (#357): a red that never reached its file is the phase\'s own, whatever the baseline read', async () => {
  const missing = layout(null);
  const red = await verifyPhase(text, { cwd: missing.mirror, docsRoot: missing.docsRoot });
  assert.equal(red.ok, false);
  const row = red.ran.at(-1)!;
  assert.deepEqual(row.unreached, ['docs/handoffs/robot-platform-tags/pr-body-aws.md'], 'a missing PR body is named');
  // The baseline read the line red too — 7.1 read that as inherited.
  const baseline = [{ command: LINE, ok: false, code: 2 }];
  const split = splitReds([{ command: row.command, failures: row.failures, unreached: row.unreached }], baseline);
  assert.equal(split.inherited.length, 0, JSON.stringify(split));
  assert.equal(split.own.length, 1);
  // A red that DID read its file, over a base-tree line that read nothing
  // (the body was not written yet): still the phase's own.
  const reached = splitReds([{ command: LINE, failures: [] }], [{ ...baseline[0]!, unreached: [row.unreached![0]!] }]);
  assert.equal(reached.inherited.length, 0, JSON.stringify(reached));
  // And a red both sides really read is still inherited, as #103 decided.
  const both = splitReds([{ command: LINE, failures: [] }], baseline);
  assert.equal(both.inherited.length, 1);
});

test('VD-3: a docs-only line names only docs/ paths and does not cd; the readers\' operands are its files', () => {
  assert.equal(docsOnlyLine(LINE), true);
  assert.equal(docsOnlyLine('test -f docs/plans/one-pool.md'), true);
  assert.equal(docsOnlyLine('grep -c "x" ./docs/a.md docs/b.md'), true);
  assert.equal(docsOnlyLine('cd docs && grep -q x a.md'), false, 'a line that moves itself is not moved');
  assert.equal(docsOnlyLine('node scripts/check.mjs docs/plans/a.md'), false, 'a script beside it is the tree\'s');
  assert.equal(docsOnlyLine('bash docs/tools/check.sh'), false, 'nothing that runs a script moves to the shared checkout');
  assert.equal(docsOnlyLine('test -f docs/a.md && rm docs/a.md'), false, 'nor anything that writes');
  assert.equal(docsOnlyLine('grep -c x docs/a.md | wc -l'), true, 'readers piped into readers still read');
  // Nothing that can run a program or write rides the move to the shared checkout.
  assert.equal(docsOnlyLine('grep -q x docs/a.md > docs/b.md'), false, 'a redirection writes');
  assert.equal(docsOnlyLine('cat docs/a.md >> docs/b.md'), false);
  assert.equal(docsOnlyLine('grep -q "$(touch docs/x)" docs/a.md'), false, 'a substitution runs');
  assert.equal(docsOnlyLine('grep -q `id` docs/a.md'), false);
  assert.equal(docsOnlyLine('FOO=1 grep -q x docs/a.md'), false, 'an env prefix is not the reader');
  assert.equal(docsOnlyLine('env grep -q x docs/a.md'), false, 'nor is a wrapper');
  assert.equal(docsOnlyLine('rg --pre ./x.sh pat docs/a.md'), false, 'rg can run a program');
  assert.equal(docsOnlyLine("grep -q $'a\\' > docs/b.md #' docs/a.md"), false, 'ANSI-C quoting no reader here models');
  assert.equal(docsOnlyLine('grep -q "$HOME" docs/a.md'), false, 'no expansion of any kind');
  assert.equal(docsOnlyLine('grep -q "a > b" docs/a.md'), true, 'a quoted angle bracket is data');
  assert.equal(docsOnlyLine('! grep -q TODO docs/a.md'), true);
  assert.equal(docsOnlyLine('test "$(gh issue list -R org/repo --json number)" = "0"'), false);
  assert.equal(docsOnlyLine('npm test'), false);
  assert.equal(docsOnlyLine('grep -q "a/b" docs/x.md'), true, 'a grep pattern is not a path');
  assert.deepEqual(namedFiles('grep -rn -e foo -e bar src docs').map((f) => f.path), ['src', 'docs']);
  assert.deepEqual(namedFiles('test -f a.md && [ -d b ] && cat c.txt | wc -l').map((f) => f.path), ['a.md', 'b', 'c.txt']);
  assert.deepEqual(namedFiles('gh issue list -R org/repo'), [], 'a word another command takes is never a path');
  const { docsRoot } = layout('x\n');
  assert.deepEqual(missingFiles('cd docs && grep -q x nope.md', docsRoot), ['docs/nope.md'], 'its own cd honoured, named from where the line starts');
});
