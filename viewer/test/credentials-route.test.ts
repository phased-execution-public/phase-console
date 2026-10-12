/**
 * `GET /api/credentials` and `POST /api/credentials/probe {ids?}` (quiet-console
 * phase 25, §Architecture 5): every credential this machine is asked about —
 * the GitHub CLI and the machine `claude` login, as `doctor` asks, and every id
 * an open plan names on its `**Credentials:**` line or a phase's bullet — held
 * or not, why, whether the registry knows its kind, and which plans name it.
 * A word and a reason, never a value.
 *
 * Above the "no source directory" wall: the machine holds its credentials
 * whether or not a plan directory is open. The read answers from the probes'
 * minute-long cache; the press (the console header, like every write) asks
 * again now — the ids it names, or every one when it names none.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bareService, call, scratch, service, tempDir } from './thin-read-harness.ts';
import { CLI_PROBE_IDS, PROBE_CACHE_MS, forgetCredentialProbes, type ProbeDeps } from '../server/credentials-probe.ts';

const SECRET = 'p25-not-a-real-token-value';

/** A plan naming a credential on its own line and another on a phase's bullet. */
const CREDS_PLAN = `---
slug: creds
created: 2026-10-10
status: active
phases: 2
---

# creds

## Session budget

> **Credentials:** \`gh\`, \`env:P25_TOKEN\`, \`vault:p25\`

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | — | app | it works |
| 2 | two | 1 | — | app | it still works |

## Phases

### Phase 1 — one
- **Size:** S

### Phase 2 — two
- **Size:** S
- **Credentials:** \`file:~/.p25-absent\`
`;

/** A plan somebody finished by hand: `status: complete`, no `closed:` line — no longer open, so it names nothing. */
const FINISHED_PLAN = CREDS_PLAN.replace('slug: creds', 'slug: done').replace('status: active', 'status: complete')
  .replace('# creds', '# done').replace('`env:P25_TOKEN`, `vault:p25`', '`env:P25_FINISHED`');

/** Probes that never leave the process: a signed-in gh and claude, and an environment holding the token. */
function fakeProbes(env: NodeJS.ProcessEnv = { P25_TOKEN: SECRET }) {
  const asked: string[] = [];
  const deps: ProbeDeps = {
    exec: async (file) => {
      asked.push(file);
      return { code: 0, stderr: '' };
    },
    claudeLogin: async () => {
      asked.push('claude');
      return { loggedIn: true };
    },
    env,
    platform: 'darwin',
    home: tempDir('p25-home'),
  };
  return { deps, asked };
}

/** The service's own `credentialsView`, with the probes swapped — the route and the method stay real. */
function probing<T extends { credentialsView: (fresh?: readonly string[], deps?: ProbeDeps) => Promise<unknown> }>(
  svc: T, deps: ProbeDeps,
): T {
  const real = svc.credentialsView.bind(svc);
  svc.credentialsView = (fresh?: readonly string[]) => real(fresh, deps) as never;
  return svc;
}

type Row = { id: string; status: string; reason: string; known: boolean; named: { slug: string; phase?: number }[] };

test.beforeEach(() => forgetCredentialProbes());

test('GET /api/credentials answers with no source directory open: the CLI\'s own two, named by no plan', async () => {
  const { deps } = fakeProbes();
  const svc = probing(await bareService(), deps);
  try {
    const out = await call(svc, 'GET', '/api/credentials');
    assert.equal(out.status, 200);
    assert.equal(out.body.cacheMs, PROBE_CACHE_MS);
    assert.equal(typeof out.body.at, 'string');
    assert.deepEqual(out.body.credentials.map((row: Row) => row.id), [...CLI_PROBE_IDS]);
    for (const row of out.body.credentials as Row[]) {
      assert.equal(row.status, 'ok', row.id);
      assert.equal(row.known, true, row.id);
      assert.deepEqual(row.named, [], row.id);
    }
  } finally {
    svc.close();
  }
});

test('every id an open plan names, held or not, with the plans and phases that name it — and never its value', async () => {
  const root = scratch({ creds: CREDS_PLAN, done: FINISHED_PLAN });
  const { deps } = fakeProbes();
  const svc = probing(await service(root), deps);
  try {
    const out = await call(svc, 'GET', '/api/credentials');
    assert.equal(out.status, 200);
    const rows = new Map((out.body.credentials as Row[]).map((row) => [row.id, row]));
    assert.deepEqual([...rows.keys()], ['gh', 'claude', 'env:P25_TOKEN', 'vault:p25', 'file:~/.p25-absent']);
    assert.deepEqual(rows.get('gh')?.named, [{ slug: 'creds' }], 'the CLI\'s own id, named by the plan too');
    assert.deepEqual(rows.get('claude')?.named, []);
    assert.deepEqual(rows.get('env:P25_TOKEN'), {
      id: 'env:P25_TOKEN', status: 'ok', reason: '$P25_TOKEN is set', known: true, named: [{ slug: 'creds' }],
    });
    assert.deepEqual(rows.get('file:~/.p25-absent')?.named, [{ slug: 'creds', phase: 2 }], "a phase's own bullet names its phase");
    assert.equal(rows.get('file:~/.p25-absent')?.status, 'fail');
    assert.deepEqual(
      { status: rows.get('vault:p25')?.status, known: rows.get('vault:p25')?.known },
      { status: 'skip', known: false },
      'an id no probe knows is said to be unknown, never guessed at',
    );
    assert.ok(!JSON.stringify(out.body).includes(SECRET), 'a word and a reason — never the value');
    assert.ok(!rows.has('env:P25_FINISHED'), 'a finished plan is not open: its ids are neither listed nor probed');
    assert.ok(!rows.get('gh')?.named.some((where) => where.slug === 'done'));
  } finally {
    svc.close();
  }
});

test('the read answers from the cache; the probe asks again — the ids it names, or every one', async () => {
  const root = scratch({ creds: CREDS_PLAN });
  const env: NodeJS.ProcessEnv = { P25_TOKEN: SECRET };
  const { deps, asked } = fakeProbes(env);
  const svc = probing(await service(root), deps);
  try {
    const status = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Map<string, string>> => {
      const out = await call(svc, method, path, body);
      assert.equal(out.status, 200, `${method} ${path}`);
      return new Map((out.body.credentials as Row[]).map((row) => [row.id, row.status]));
    };
    assert.equal((await status('GET', '/api/credentials')).get('env:P25_TOKEN'), 'ok');
    delete env.P25_TOKEN;
    const home = deps.home!;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.p25-absent'), '');

    assert.equal((await status('GET', '/api/credentials')).get('env:P25_TOKEN'), 'ok', 'a read inside the minute is the cache');
    const askedBefore = asked.length;
    const named = await status('POST', '/api/credentials/probe', { ids: ['env:P25_TOKEN'] });
    assert.equal(named.get('env:P25_TOKEN'), 'fail', 'asked again now');
    assert.equal(named.get('file:~/.p25-absent'), 'fail', 'an id the press did not name is still the cached answer');
    assert.equal(asked.length, askedBefore, 'gh and claude were not asked again');

    const every = await status('POST', '/api/credentials/probe', {});
    assert.equal(every.get('file:~/.p25-absent'), 'ok', 'no ids: every id asked again');
    assert.deepEqual(asked.slice(askedBefore), ['gh', 'claude']);

    const junk = await call(svc, 'POST', '/api/credentials/probe', { ids: 'gh' });
    assert.equal(junk.status, 200, 'ids that are not a list are no ids — every one, as above');
  } finally {
    svc.close();
  }
});

test('the probe is a press: a request without the console header, or from another origin, is refused', async () => {
  const { handleApi } = await import('../server/api/routes.ts');
  const { deps, asked } = fakeProbes();
  const svc = probing(await bareService(), deps);
  try {
    for (const headers of [{}, { 'x-phase-console': '1', origin: 'https://elsewhere.example', host: '127.0.0.1:4130' }]) {
      let status = 0;
      const req = {
        method: 'POST', url: '/api/credentials/probe', headers, socket: { remoteAddress: '127.0.0.1' },
        on() { return this; },
        [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}', 'utf8'); },
      };
      const res = { req, writeHead(code: number) { status = code; return this; }, end() {}, setHeader() {}, on() { return this; } };
      await handleApi({ service: svc } as never, req as never, res as never, new URL('http://127.0.0.1/api/credentials/probe'));
      assert.equal(status, 403, JSON.stringify(headers));
    }
    assert.deepEqual(asked, [], 'nothing was probed');
  } finally {
    svc.close();
  }
});
