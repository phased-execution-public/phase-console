/**
 * `openInEditor`'s containment check.
 *
 * It hands a path to `$VISUAL`/`$EDITOR`/`open`, and its guard was
 * `target.startsWith(resolve(docsDir))` — a bare string prefix with no
 * separator in it. With a docs directory of `<root>/docs`, every sibling whose
 * name merely BEGINS with `docs` was inside: `docs-archive`, `docsbackup`,
 * `docs.old`, and — because there is no separator at all — `docsomething`.
 * A relative path was resolved against `process.cwd()`, which for a launchd
 * console is wherever the agent started it, so the guard was comparing against
 * a base that had nothing to do with the request.
 *
 * Every case here throws BEFORE the spawn. That is deliberate: a test that
 * reached `execFile` would open an editor on the developer's machine.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openInEditor, WriteError } from '../server/writes.ts';

function library(): { root: string; docs: string } {
  const root = mkdtempSync(join(tmpdir(), 'phase-writes-'));
  const docs = join(root, 'docs');
  mkdirSync(join(docs, 'plans'), { recursive: true });
  writeFileSync(join(docs, 'plans', 'demo.md'), '# demo\n');
  // The sibling the prefix check let through.
  mkdirSync(join(root, 'docs-archive'), { recursive: true });
  writeFileSync(join(root, 'docs-archive', 'secrets.md'), 'not yours\n');
  return { root, docs };
}

const refused = /outside the docs directory/;

test('a sibling whose name merely starts with the docs basename is refused', async () => {
  // THE regression: `/root/docs-archive/secrets.md`.startsWith('/root/docs').
  const { root, docs } = library();
  await assert.rejects(
    () => openInEditor(join(root, 'docs-archive', 'secrets.md'), docs),
    (error: unknown) => error instanceof WriteError && refused.test((error as Error).message),
  );
});

test('climbing out with .. is refused', async () => {
  const { docs } = library();
  for (const path of ['../../etc/passwd', join(docs, '..', '..', 'etc', 'passwd')]) {
    await assert.rejects(
      () => openInEditor(path, docs),
      (error: unknown) => error instanceof WriteError && refused.test((error as Error).message),
      path,
    );
  }
});

test('the docs directory itself is not a file to open', async () => {
  const { docs } = library();
  await assert.rejects(
    () => openInEditor(docs, docs),
    (error: unknown) => error instanceof WriteError && refused.test((error as Error).message),
  );
});

test('a relative path is answered against the docs directory, not the cwd', async () => {
  // Resolved against `docsDir`, so it is contained and gets past the guard —
  // and then fails on `existsSync`, which is how we know it was resolved there
  // rather than against `process.cwd()` (where no such file exists either, but
  // the containment check would have refused it first).
  const { docs } = library();
  await assert.rejects(
    () => openInEditor(join('plans', 'nope.md'), docs),
    (error: unknown) => error instanceof WriteError && /No such file/.test((error as Error).message),
  );
});

test('a file that is genuinely inside gets past containment', async () => {
  // It must not throw the CONTAINMENT error. It stops at the spawn boundary
  // instead: `EDITOR` is set to something that cannot run, so nothing opens.
  const { docs } = library();
  process.env.VISUAL = '';
  process.env.EDITOR = join(docs, 'no-such-editor-binary');
  await assert.doesNotReject(
    () => openInEditor(join(docs, 'plans', 'demo.md'), docs).catch((error: unknown) => {
      assert.ok(!refused.test(String((error as Error).message)), 'a real plan file is inside');
    }),
  );
});

test('insideDir is the same predicate, shared — and answers for the QA-report reader', async () => {
  const { insideDir } = await import('../server/writes.ts');
  const { root, docs } = library();
  assert.equal(insideDir(docs, join(docs, 'plans', 'demo.md')), true);
  assert.equal(insideDir(docs, join(docs, '..notes.md')), true, 'a file whose name starts with dots is inside');
  assert.equal(insideDir(docs, join(root, 'docs-archive', 'secrets.md')), false, 'the sibling prefix trap');
  assert.equal(insideDir(docs, join(docs, '..', '..', 'etc', 'passwd')), false);
  assert.equal(insideDir(docs, docs), false, 'the base itself is not a file inside it');
  assert.equal(insideDir(docs, join(docs, '..')), false);
});
