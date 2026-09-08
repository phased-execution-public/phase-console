/**
 * The bypass inventory is closed (parallel-repaint P2, register N1).
 *
 * `Service.announce()` is the one choke point: record first, then every leg.
 * Its comment says "if it is not in the store, it was not announced", and that
 * is only true while nothing else calls `push.announce()` directly. Two things
 * do, on purpose — the halt and stall CORRECTIVES in `service-live.ts` — and
 * they are justified rather than routed through: a corrective annotates the
 * records that exist (`resolveWhere`) and must not add one, must ride the
 * alarm's own tag so the service worker replaces the card, and must not fire
 * the out-of-band notifier or a webhook for an all-clear.
 *
 * So the pin is on the SHAPE of the source: exactly those three call sites,
 * and both correctives carrying `replace: true`, without which the 5-second
 * same-tag dedupe swallows an all-clear that follows its alarm quickly. A new
 * direct call anywhere else fails here, by name, and has to justify itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SERVER = join(ROOT, 'server');
/** Every source tree a call could hide in — tests excluded, they stub the leg by design. */
const TREES = ['server', 'client/src', 'shared'].map((t) => join(ROOT, t));
const CALL = /\bpush\.announce\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

function sitesOf(file: string, needle: string | RegExp): number[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (typeof needle === 'string' ? line.includes(needle) : needle.test(line)) out.push(i + 1);
  });
  return out;
}

test('push.announce() is called from the choke point and the two correctives, nowhere else', () => {
  // A textual pin, by word boundary, over every source tree — an alias
  // (`const p = this.push; p.announce(`) is the one shape it cannot see, and
  // the stall-corrective suite exercises the real callers for that reason.
  const found = new Map<string, number[]>();
  for (const tree of TREES) {
    for (const file of walk(tree)) {
      const sites = sitesOf(file, CALL);
      if (sites.length) found.set(relative(ROOT, file), sites);
    }
  }
  assert.deepEqual([...found.keys()].sort(), ['server/service-base.ts', 'server/service-live.ts'],
    `direct push.announce() call sites: ${JSON.stringify([...found])}`);
  assert.equal(found.get('server/service-base.ts')?.length, 1, 'the choke point itself');
  assert.equal(found.get('server/service-live.ts')?.length, 2, 'retractHalt and retractStall — the correctives');
});

test('both correctives ride their alarm\'s tag with `replace: true` and arrive quiet', () => {
  const source = readFileSync(join(SERVER, 'service-live.ts'), 'utf8');
  const lines = source.split('\n');
  for (const line of sitesOf(join(SERVER, 'service-live.ts'), 'push.announce(')) {
    // The call's argument list is the next dozen lines; the opts object closes it.
    const window = lines.slice(line - 1, line + 14).join('\n');
    assert.match(window, /replace:\s*true/, `the corrective at service-live.ts:${line} must opt out of the dedupe`);
    assert.match(window, /urgent:\s*false/, `the corrective at service-live.ts:${line} is an all-clear, not an alarm`);
    assert.match(window, /tagFor\(/, `the corrective at service-live.ts:${line} rides a stable tag`);
  }
});

test('a corrective annotates through resolveWhere and never records anew', () => {
  const source = readFileSync(join(SERVER, 'service-live.ts'), 'utf8');
  for (const name of ['retractHalt', 'retractStall']) {
    const start = source.indexOf(`protected ${name}(`);
    assert.ok(start > 0, `${name} exists`);
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    assert.match(body, /notifications\.resolveWhere\(/, `${name} annotates the records that exist`);
    assert.doesNotMatch(body, /notifications\.record\(/, `${name} must not add an inbox record`);
    assert.doesNotMatch(body, /this\.announce\(/, `${name} must not re-announce — that would record, notify and webhook an all-clear`);
    assert.doesNotMatch(body, /webhooks\.announce\(/, `${name} sends no webhook`);
    assert.doesNotMatch(body, /notifyOutOfBand\(/, `${name} runs no out-of-band notifier`);
  }
});
