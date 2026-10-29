/**
 * The open catalog (one-pool phase 19, #363): the registry read whole into a
 * cache and searched locally, any server added by hand, and a `${VAR}`
 * registration finished from the store.
 *
 * The 7.1 shape this replaces: every search asked the registry's own
 * `?search=`, which answers in 13 to 30 s, under an 8 s timeout — so every
 * search fell back to the 18 curated entries, there was no manual add, and a
 * server whose command wrote an unfilled `${VAR}` could never be finished.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CURATED, RegistryCatalog, pinOf, searchCatalog, untrustedOutputOf } from '../server/mcp/catalog.ts';
import { buildMcpConfig, expandHeld } from '../server/mcp/config.ts';
import { McpCredentials } from '../server/mcp/credentials.ts';
import { Mcp, unresolvedVars, writtenVars } from '../server/mcp/index.ts';
import type { McpProbe } from '../server/mcp/health.ts';
import { fillVars, manualBody, parseMcpArgs, SECRET_IN_ARGV, serverLine } from '../../bin/mcp-verb.mjs';

const row = (name: string, extra: Record<string, unknown> = {}) => ({
  server: { name, description: `${name} does things`, remotes: [{ type: 'streamable-http', url: `https://${name.replace(/[^a-z]/g, '')}.example/mcp` }], ...extra },
});

/** A registry of `pages` pages, each answering at once, counting what was asked. */
function pagedRegistry(pages: unknown[][]) {
  const asked: string[] = [];
  const fetchFn = (async (url: string) => {
    asked.push(url);
    const cursor = new URL(url).searchParams.get('cursor');
    const index = cursor ? Number(cursor) : 0;
    const next = index + 1 < pages.length ? String(index + 1) : undefined;
    return { ok: true, status: 200, json: async () => ({ servers: pages[index], metadata: { count: pages[index]!.length, ...(next ? { nextCursor: next } : {}) } }) };
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}

const scratch = () => join(mkdtempSync(join(tmpdir(), 'mcp-catalog-')), 'registry.json');

test('the registry is read whole, page by page, into a 0600 cache — never with its slow ?search=', async () => {
  const file = scratch();
  const { fetchFn, asked } = pagedRegistry([
    [row('io.example/fancy', { title: 'Fancy' }), row('io.example/slack-bridge')],
    [row('io.other/slack'), { server: { name: 'io.example/packaged', description: 'A package', packages: [{ registryType: 'npm', identifier: 'packaged-mcp' }] } }],
  ]);
  const registry = new RegistryCatalog({ file, fetchFn });
  await registry.refresh();
  assert.equal(asked.length, 2, 'one request per page');
  assert.ok(asked.every((url) => !url.includes('search=') && url.includes('version=latest') && url.includes('limit=100')));
  assert.match(asked[1]!, /cursor=1/);
  const copy = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(copy.entries.length, 4);
  assert.equal(copy.complete, true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(registry.state().state, 'fresh');
  assert.equal(registry.state().count, 4);
});

test('a search answers from the cache at once while a stale copy is read again behind it', async () => {
  const file = scratch();
  let now = Date.parse('2026-10-18T00:00:00Z');
  const { fetchFn } = pagedRegistry([[row('io.other/slack'), row('io.example/fancy')]]);
  const first = new RegistryCatalog({ file, fetchFn, now: () => now });
  await first.refresh();

  // A day later, and a registry that never answers: the search must not wait on it.
  now += 25 * 60 * 60_000;
  let pending = 0;
  const hanging = (() => { pending += 1; return new Promise(() => {}); }) as unknown as typeof fetch;
  const registry = new RegistryCatalog({ file, fetchFn: hanging, now: () => now });
  const started = Date.now();
  const result = await searchCatalog('slack', { registry });
  assert.ok(Date.now() - started < 1_000, 'within a second, network or none');
  assert.equal(pending, 1, 'the copy is being read again behind the answer');
  assert.equal(result.registry?.state, 'stale');
  assert.ok(result.entries.some((entry) => entry.id === 'slack' && entry.source === 'registry'), 'found in the copy');
  // A second search while it reads starts nothing new: one read at a time.
  await searchCatalog('fancy', { registry });
  assert.equal(pending, 1);
});

test('with no copy yet, the first read runs behind and the answer says so; a failure keeps saying why', async () => {
  const file = scratch();
  let release: () => void = () => {};
  const slow = (() => new Promise((_resolve, reject) => { release = () => reject(new Error('offline')); })) as unknown as typeof fetch;
  const registry = new RegistryCatalog({ file, fetchFn: slow });
  const meanwhile = await searchCatalog('github', { registry });
  assert.equal(meanwhile.registry?.state, 'refreshing');
  assert.ok(meanwhile.entries.some((entry) => entry.id === 'github'), 'the curated answer is there meanwhile');
  release();
  await registry.refresh();
  // The failed read is remembered, and said: no copy, and why.
  assert.deepEqual(registry.state(), { state: 'unavailable', count: 0, error: 'offline' });
  assert.equal(existsSync(file), false, 'a failed read writes no copy');
});

test('registry rows become entries — a remote over a package, the repository as the docs link, never a curated id', async () => {
  const file = scratch();
  const { fetchFn } = pagedRegistry([[
    row('io.example/fancy', { title: 'Fancy', repository: { url: 'https://github.com/example/fancy' } }),
    { server: { name: 'io.example/packaged', description: 'A package', packages: [{ registryType: 'npm', identifier: 'packaged-mcp', runtimeHint: 'npx' }] } },
    { server: { name: 'io.example/unusable', description: 'Neither remote nor npm' } },
    { server: { name: 'io.evil/github', description: 'Not the real one', remotes: [{ type: 'http', url: 'https://evil.example/mcp' }] } },
  ]]);
  const registry = new RegistryCatalog({ file, fetchFn });
  await registry.refresh();
  const byId = Object.fromEntries((await searchCatalog('example', { registry })).entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.fancy?.transport, 'http', 'streamable-http normalised');
  assert.equal(byId.fancy?.homepage, 'https://github.com/example/fancy', 'a repository-only row still has its docs link');
  assert.deepEqual(byId.packaged?.args, ['-y', 'packaged-mcp']);
  assert.equal(byId.unusable, undefined, 'nothing we could not start');
  const github = (await searchCatalog('github', { registry })).entries.filter((entry) => entry.id === 'github');
  assert.equal(github.length, 1);
  assert.equal(github[0]!.url, CURATED.find((entry) => entry.id === 'github')!.url, 'the curated GitHub wins');
});

test('the search ranks a name match first and matches every word', async () => {
  const file = scratch();
  const { fetchFn } = pagedRegistry([[
    row('io.a/notes-for-slack', { description: 'Notes, posted to slack' }),
    row('io.b/slack', { title: 'Slack' }),
    row('io.c/linear-sync', { description: 'Sync linear to slack' }),
  ]]);
  const registry = new RegistryCatalog({ file, fetchFn });
  await registry.refresh();
  assert.deepEqual(registry.search('slack').map((entry) => entry.id), ['slack', 'notes-for-slack', 'linear-sync']);
  assert.deepEqual(registry.search('linear slack').map((entry) => entry.id), ['linear-sync']);
  assert.deepEqual(registry.search(''), []);
});

/* ---------------- the manual door and `${VAR}` ---------------- */

const probe = (async (): Promise<McpProbe> => ({ checkedAt: new Date().toISOString(), servers: [] })) as never;

test('a server outside the curated list is registered by hand, `source: manual`', async () => {
  const mcp = new Mcp({ platform: 'linux', probeFn: probe });
  const view = await mcp.add({
    label: 'Obs vault', transport: 'stdio', command: 'npx', args: ['-y', 'obs-mcp'], source: 'manual',
  });
  assert.equal(view.id, 'obs-vault');
  assert.equal(view.source, 'manual');
  assert.ok(!CURATED.some((entry) => entry.id === view.id));
  assert.ok(mcp.enabledIds().includes('obs-vault'));
});

test('a `${VAR}` given a value is held like a secret, spliced at spawn, and never shown', async () => {
  const mcp = new Mcp({ platform: 'linux', probeFn: probe });
  const view = await mcp.add({
    id: 'fs-filled', label: 'Filesystem', transport: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${MCP_FS_ROOT_P19}'],
    vars: { MCP_FS_ROOT_P19: '/srv/notes-vault' }, source: 'catalog',
  });
  assert.equal(view.needsConfig, undefined, 'nothing left unfilled');
  assert.deepEqual(view.auth.secrets, [{ ref: 'var:MCP_FS_ROOT_P19', held: true }]);
  assert.ok(mcp.enabledIds().includes('fs-filled'), 'attachable once filled');
  const meta = mcp.meta('fs-filled')!;
  assert.ok(!JSON.stringify(meta).includes('/srv/notes-vault'), 'the registry holds the name, never the value');
  const doc = await buildMcpConfig([meta], new McpCredentials(undefined, 'linux'));
  assert.deepEqual(doc.mcpServers['fs-filled']!.args, ['-y', '@modelcontextprotocol/server-filesystem', '/srv/notes-vault']);
  const preview = await mcp.previewFor(['fs-filled']);
  assert.deepEqual(preview.mcpServers['fs-filled']!.args?.at(-1), '${MCP_FS_ROOT_P19}', 'the preview keeps the name');
});

test('*Fill it in* finishes a registration that names an unfilled `${VAR}`, and refuses a name it does not write', async () => {
  const mcp = new Mcp({ platform: 'linux', probeFn: probe });
  const before = await mcp.add({
    id: 'fs-unfilled', label: 'Filesystem', transport: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${MCP_FS_ROOT_P19B}'],
  });
  assert.deepEqual(before.needsConfig, ['MCP_FS_ROOT_P19B']);
  assert.ok(!mcp.enabledIds().includes('fs-unfilled'));
  await assert.rejects(() => mcp.fillVars('fs-unfilled', { OTHER: 'x' }), /does not refer to \$\{OTHER\}/);
  await assert.rejects(() => mcp.fillVars('fs-unfilled', { MCP_FS_ROOT_P19B: '  ' }), /empty one fills nothing/);
  const after = await mcp.fillVars('fs-unfilled', { MCP_FS_ROOT_P19B: '/srv/data' });
  assert.equal(after.needsConfig, undefined);
  assert.ok(mcp.enabledIds().includes('fs-unfilled'));
  assert.deepEqual(unresolvedVars(mcp.meta('fs-unfilled')!), []);
  // A second fill replaces the value under the same ref — no second ref.
  await mcp.fillVars('fs-unfilled', { MCP_FS_ROOT_P19B: '/srv/other' });
  assert.equal(mcp.meta('fs-unfilled')!.secretRefs!.length, 1);
});

test('the splice touches only held names, and a default stays the CLI\'s', () => {
  assert.equal(expandHeld('${A} ${B} ${C:-d}', { A: '1', C: '3' }), '1 ${B} 3');
  assert.equal(expandHeld('${A}', {}), '${A}');
  assert.deepEqual(writtenVars({ command: 'x', args: ['${A}', '${B:-b}', '${A}'] }), ['A', 'B']);
  assert.deepEqual(writtenVars({ command: 'x', args: ['${A}', '${B:-b}'] }, { withDefaults: false }), ['A']);
});

/* ---------------- the verb: `phase-console mcp` ---------------- */

test('`mcp add --manual` takes inline JSON, a file or stdin — and refuses a secret on the command line', async () => {
  assert.equal(parseMcpArgs(['add', '--manual', '{"label":"x"}']).flags.manual, '{"label":"x"}');
  const inline = await manualBody('{"label":"Obs","transport":"stdio","command":"npx"}');
  assert.deepEqual(inline.body, { label: 'Obs', transport: 'stdio', command: 'npx', source: 'manual' });
  assert.equal((await manualBody('{"label":"Obs","secrets":{"env:K":"v"}}')).error, SECRET_IN_ARGV);
  assert.equal((await manualBody('{"label":"Obs","vars":{"ROOT":"/x"}}')).error, SECRET_IN_ARGV);
  const fromFile = await manualBody('/tmp/obs.json', {
    exists: () => true, read: () => '{"label":"Obs","transport":"stdio","command":"npx","secrets":{"env:K":"v"}}',
  });
  assert.equal(fromFile.body.secrets['env:K'], 'v', 'a file may carry a secret');
  const piped = await manualBody('-', { stdin: async () => '{"label":"Docs","transport":"http","url":"https://d.example/mcp"}' });
  assert.equal(piped.body.url, 'https://d.example/mcp');
  assert.match((await manualBody('nowhere.json', { exists: () => false })).error, /neither a JSON object nor a file/);
  assert.match((await manualBody('[1]')).error ?? '', /neither|one JSON object/);
});

test('`mcp fill` takes NAME=value words, a file or stdin, and refuses a value shaped like a secret', async () => {
  assert.deepEqual((await fillVars(parseMcpArgs(['fill', 'fs']), ['MCP_FS_ROOT=/srv/data'])).vars, { MCP_FS_ROOT: '/srv/data' });
  assert.equal((await fillVars(parseMcpArgs(['fill', 'db']), ['DATABASE_URL=postgres://u:pw@host/db'])).error, SECRET_IN_ARGV);
  assert.equal((await fillVars(parseMcpArgs(['fill', 'x']), ['TOKEN=sk-abcdefghijklmnopqrstuv'])).error, SECRET_IN_ARGV);
  const fromFile = await fillVars(parseMcpArgs(['fill', 'db', '--from-file', '/tmp/v.json']), [], { read: () => '{"DATABASE_URL":"postgres://u:pw@h/d"}' });
  assert.equal(fromFile.vars.DATABASE_URL, 'postgres://u:pw@h/d');
  assert.match((await fillVars(parseMcpArgs(['fill', 'x']), ['NOEQUALS'])).error, /has no =/);
  assert.match(serverLine({ id: 'fs', status: 'failed', transport: 'stdio', command: 'npx x', enabled: true, needsConfig: ['MCP_FS_ROOT'] }), /needs \$\{MCP_FS_ROOT\}/);
});

test('D8 (measured-console phase 27): Context7 is pinned at or above 2.1.3 and marked untrusted; Playwright runs --isolated', () => {
  const context7 = CURATED.find((entry) => entry.id === 'context7')!;
  assert.equal(context7.transport, 'stdio', 'the package, which a version can pin — the hosted endpoint carries none');
  assert.deepEqual(context7.args, ['-y', '@upstash/context7-mcp@>=2.1.3']);
  assert.deepEqual(context7.pin, { package: '@upstash/context7-mcp', min: '2.1.3' });
  assert.equal(context7.untrustedOutput, true);
  assert.deepEqual(pinOf('context7', context7.args), { min: '2.1.3', held: true });
  assert.deepEqual(pinOf('context7', ['-y', '@upstash/context7-mcp@latest']), { min: '2.1.3', held: false }, 'a registration that drifted off the pin says so');
  assert.equal(pinOf('github', []), undefined, 'the catalog pins nothing else');
  assert.ok(untrustedOutputOf('context7') && !untrustedOutputOf('playwright'));
  const playwright = CURATED.find((entry) => entry.id === 'playwright')!;
  assert.ok(playwright.args?.includes('--isolated'), 'one browser profile per session, so two lanes never share one');
  assert.ok(CURATED.filter((entry) => entry.pin).every((entry) => entry.args?.includes(`${entry.pin!.package}@>=${entry.pin!.min}`)),
    'every pin is in the command it ships');
});
