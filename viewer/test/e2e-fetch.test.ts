/**
 * The tour's one pass-through rule (`e2e/lib/fetch.ts`, #294 #312 #344): a
 * dropped connection under load is asked again, an answer never is, and no
 * spec reaches past the helper to a bare `route.fetch()`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Route } from '@playwright/test';

import { TRIES, passThrough, transient } from '../e2e/lib/fetch.ts';

const E2E = fileURLToPath(new URL('../e2e', import.meta.url));

function fakeRoute(method: string, answers: (Error | string)[]): { route: Route; calls: () => number } {
  let calls = 0;
  const route = {
    request: () => ({ method: () => method }),
    fetch: async () => {
      const next = answers[Math.min(calls, answers.length - 1)]!;
      calls++;
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as Route;
  return { route, calls: () => calls };
}

test('a GET whose socket is reset is asked again, and answers', async () => {
  const { route, calls } = fakeRoute('GET', [new Error('route.fetch: read ECONNRESET'), 'answer']);
  assert.equal(await passThrough(route), 'answer');
  assert.equal(calls(), 2);
});

test('a GET reset every time gives up after TRIES, with the reset', async () => {
  const { route, calls } = fakeRoute('GET', [new Error('route.fetch: read ECONNRESET')]);
  await assert.rejects(passThrough(route), /ECONNRESET/);
  assert.equal(calls(), TRIES);
});

test('a press is fetched once: a POST is never asked twice', async () => {
  const { route, calls } = fakeRoute('POST', [new Error('route.fetch: read ECONNRESET'), 'answer']);
  await assert.rejects(passThrough(route), /ECONNRESET/);
  assert.equal(calls(), 1);
});

test('anything but a dropped connection is thrown at once', async () => {
  const { route, calls } = fakeRoute('GET', [new Error('route.fetch: Test ended'), 'answer']);
  await assert.rejects(passThrough(route), /Test ended/);
  assert.equal(calls(), 1);
  assert.equal(transient(new Error('socket hang up')), true);
  assert.equal(transient(new Error('Target page, context or browser has been closed')), false);
});

test('no spec calls route.fetch() past the helper', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue; // .results, .shots
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && path !== join(E2E, 'lib', 'fetch.ts')) {
        readFileSync(path, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const code = line.trim();
            if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
            if (/\broute\.fetch\(/.test(code)) offenders.push(`${relative(E2E, path)}:${i + 1}`);
          });
      }
    }
  };
  walk(E2E);
  assert.deepEqual(offenders, [], `use passThrough(route) from e2e/lib/fetch.ts:\n  ${offenders.join('\n  ')}`);
});
