/**
 * `GET /api/issues` and `POST /api/issues/refresh` — the surface Phase 16 builds against.
 *
 * `issues.test.ts` proves the STORE: the inventory, the cache's three states,
 * the ticket. Nothing proved the ROUTES, and the two claims the route block
 * makes are exactly the ones a later refactor takes away by accident:
 *
 *   1. **The GET lives above the "no source directory is open" wall and never
 *      fetches.** A board that 409s on a console with nothing open, or that
 *      blocks a page render on a `gh` call, is the failure the split between a
 *      read and a refresh verb exists to prevent — and moving the block ten
 *      lines down in `routes.ts` is all it takes.
 *   2. **The refresh is header-guarded and names its repository by INVENTORY
 *      KEY.** A missing console header is a 403, an unknown key is a 404, and a
 *      key with no GitHub remote is a 200 whose row says `no-remote` — never a
 *      silent refresh of everything.
 *
 * Plus the honest-degradation half of the phase's second exit criterion: a `gh`
 * that is not there answers 200 with a reason on the row, never an error page.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IssuesStore } from '../server/issues/index.ts';
import type { GhRunner } from '../server/issues/fetch.ts';

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
}

/** The same two-submodule estate `issues.test.ts` uses: root + alpha + a remote-less beta. */
function estate(): string {
  const root = temp('p15r-estate-');
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.git', 'config'),
    '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/hub.git\n');
  writeFileSync(join(root, '.gitmodules'),
    '[submodule "beta"]\n\tpath = beta\n\turl = ../beta.git\n');
  mkdirSync(join(root, 'beta'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: join(root, 'beta'), stdio: 'ignore' });
  return root;
}

const ROWS = JSON.stringify([{
  number: 7, title: 'Cart total is wrong on refunds', state: 'OPEN',
  labels: [{ name: 'bug' }], assignees: [{ login: 'dev' }],
  updatedAt: '2026-09-01T10:00:00Z', url: 'https://github.com/acme/hub/issues/7',
}]);

type Captured = { status: number; body: unknown };

/**
 * One request through the real `handleApi`.
 *
 * `res.req` is set for the same reason `debug-routes.test.ts` sets it:
 * `sendBody` negotiates an encoding off it, and a fake without one takes a
 * different path from the server's.
 */
async function call(
  service: unknown, method: string, path: string,
  opts: { body?: unknown; header?: boolean } = {},
): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: null };
  const payload = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const req = {
    method,
    headers: (opts.header === false ? {} : { 'x-phase-console': '1' }) as Record<string, string>,
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { if (payload) yield Buffer.from(payload, 'utf8'); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text); } catch { out.body = text; }
    },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

/** The narrowest Service the issues block touches, around a real store. */
function fakeService(issues: IssuesStore) {
  return {
    issues,
    root: null,
    // Deliberately falsy: everything below asserts the issues block answers
    // ABOVE the "No source directory is open." wall that `service.store` gates.
    store: null,
    flags: {
      allowWrites: false, allowRun: false, allowTerminal: false,
      allowAgent: false, allowAccounts: false, allowMcp: false, allowWebhooks: false,
    },
  };
}

type Payload = {
  at: number;
  refreshing: boolean;
  repos: { key: string; state: string; reason?: string; issues: unknown[]; ageMs?: number }[];
};

/* ------------------------------------------------------------------ *
 * The GET: above the wall, and never a fetch
 * ------------------------------------------------------------------ */

test('GET /api/issues answers 200 with NO source directory open', async () => {
  // A console that failed to open a directory still renders its board. The
  // store answers an empty estate rather than throwing on an absent root.
  const store = new IssuesStore({
    root: () => undefined,
    stateDir: temp('p15r-state-'),
    run: async () => { throw new Error('the GET must never reach gh'); },
  });
  const out = await call(fakeService(store), 'GET', '/api/issues');
  assert.equal(out.status, 200);
  const body = out.body as Payload;
  assert.deepEqual(body.repos, []);
  assert.equal(body.refreshing, false);
  assert.ok(Number.isFinite(body.at));
});

test('GET /api/issues never fetches — a runner that is asked anything fails the test', async () => {
  // The claim the whole read/refresh split rests on: a board renders at
  // whatever age its data has and never waits on the network. A `gh` that
  // throws when called turns "it blocked" into a red test rather than a slow one.
  let asked = 0;
  const store = new IssuesStore({
    root: () => estate(),
    stateDir: temp('p15r-state-'),
    run: async () => { asked += 1; return { ok: true, stdout: ROWS, stderr: '' }; },
  });
  const out = await call(fakeService(store), 'GET', '/api/issues');
  assert.equal(out.status, 200);
  assert.equal(asked, 0, 'the GET reached gh');
  const body = out.body as Payload;
  assert.deepEqual(body.repos.map((r) => r.key), ['root', 'beta']);
  assert.equal(body.repos[1].reason, 'no-remote',
    'a repository with no GitHub remote is a ROW carrying its reason, never an absence');
});

test('a gh that is not installed degrades to a row with a reason, never an error page', async () => {
  const root = estate();
  const store = new IssuesStore({
    root: () => root,
    stateDir: temp('p15r-state-'),
    run: async () => ({ ok: false, stdout: '', stderr: 'spawn gh ENOENT' }),
  });
  const service = fakeService(store);
  const refreshed = await call(service, 'POST', '/api/issues/refresh');
  assert.equal(refreshed.status, 200, 'a missing gh is not a 500');
  const after = await call(service, 'GET', '/api/issues');
  assert.equal(after.status, 200);
  const row = (after.body as Payload).repos[0];
  assert.equal(row.state, 'unknown');
  assert.equal(row.reason, 'no-gh', 'the one failure an operator can actually fix is the one named');
});

/* ------------------------------------------------------------------ *
 * The POST: guarded, keyed, and single-flighted downstream
 * ------------------------------------------------------------------ */

test('POST /api/issues/refresh without the console header is a 403 that fetches nothing', async () => {
  let asked = 0;
  const root = estate();
  const store = new IssuesStore({
    root: () => root,
    stateDir: temp('p15r-state-'),
    run: async () => { asked += 1; return { ok: true, stdout: ROWS, stderr: '' }; },
  });
  const out = await call(fakeService(store), 'POST', '/api/issues/refresh', { header: false });
  assert.equal(out.status, 403);
  assert.match(String((out.body as { error: string }).error), /console header/i);
  assert.equal(asked, 0, 'a refused write must not have already spent a gh call');
});

test('POST /api/issues/refresh fetches, and the GET afterwards is fresh with an age', async () => {
  const root = estate();
  const run: GhRunner = async (args) => ({
    ok: true, stdout: args[1] === 'list' ? ROWS : '{}', stderr: '',
  });
  const store = new IssuesStore({ root: () => root, stateDir: temp('p15r-state-'), run });
  const service = fakeService(store);

  const posted = await call(service, 'POST', '/api/issues/refresh');
  assert.equal(posted.status, 200);
  const row = (posted.body as Payload).repos[0];
  assert.equal(row.state, 'fresh');
  assert.deepEqual((row.issues as { number: number }[]).map((i) => i.number), [7]);
  assert.ok(Number.isFinite(row.ageMs), 'a fetched row carries the age of its data');

  const got = await call(service, 'GET', '/api/issues');
  assert.equal((got.body as Payload).repos[0].state, 'fresh',
    'the POST answers the same payload the GET does');
});

test('an unknown repository KEY is a 404, and a remote-less key is a 200 that says why', async () => {
  const root = estate();
  const store = new IssuesStore({
    root: () => root,
    stateDir: temp('p15r-state-'),
    run: async () => ({ ok: true, stdout: ROWS, stderr: '' }),
  });
  const service = fakeService(store);

  for (const repo of ['../../etc', 'acme/hub', 'nope']) {
    const out = await call(service, 'POST', '/api/issues/refresh', { body: { repo } });
    assert.equal(out.status, 404, repo);
    assert.match(String((out.body as { error: string }).error), /unknown repository/);
  }

  // `beta` is a legitimate key and an impossible fetch. A 404 would say the
  // repository is unknown, which is the wrong sentence.
  const beta = await call(service, 'POST', '/api/issues/refresh', { body: { repo: 'beta' } });
  assert.equal(beta.status, 200);
  assert.equal((beta.body as Payload).repos[1].reason, 'no-remote');
});

test('any other method on /api/issues is a 405 that names the two verbs', async () => {
  const store = new IssuesStore({
    root: () => undefined, stateDir: temp('p15r-state-'), run: async () => ({ ok: true, stdout: '[]', stderr: '' }),
  });
  for (const method of ['DELETE', 'PUT']) {
    const out = await call(fakeService(store), method, '/api/issues');
    assert.equal(out.status, 405, method);
    assert.match(String((out.body as { error: string }).error), /GET \/api\/issues or POST \/api\/issues\/refresh/);
  }
  // A POST to the head itself is not a refresh either — the verb is a path.
  const bare = await call(fakeService(store), 'POST', '/api/issues');
  assert.equal(bare.status, 405);
});

/* ------------------------------------------------------------------ *
 * The sweep clock's one promise
 * ------------------------------------------------------------------ */

test('the idle sweep keeps warm and never DISCOVERS', async () => {
  // The reason this clock is safe to run with no flag: a console that is merely
  // OPEN spends no GitHub quota. Only a repository somebody has already fetched
  // is swept, so the first fetch of anything is always an operator pressing
  // Refresh. A sweep that discovered would reach GitHub once per repository per
  // quarter hour for repositories nobody has ever looked at.
  const root = estate();
  let clock = 1_700_000_000_000;
  let asked = 0;
  const store = new IssuesStore({
    root: () => root,
    stateDir: temp('p15r-state-'),
    run: async () => { asked += 1; return { ok: true, stdout: ROWS, stderr: '' }; },
    now: () => clock,
  });

  await store.sweep();
  assert.equal(asked, 0, 'nothing cached, nothing asked — the sweep does not discover');

  await store.refresh('root');
  assert.equal(asked, 1);

  await store.sweep();
  assert.equal(asked, 1, 'fresh data is not re-asked for on the very next tick');

  clock += 15 * 60_000 + 1_000;
  await store.sweep();
  assert.equal(asked, 2, 'once the idle cadence has elapsed, a repository already fetched is kept warm');
});
