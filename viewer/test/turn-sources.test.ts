/**
 * Every source of a person's turn is ONE item (control-tower phase 132, #209,
 * §Architecture 19's sources table):
 *
 *   TS-1  each LEDGER source — a plan bullet, a session's step, a person errand,
 *         a credential or MCP preflight, a converted stall, an unanswerable
 *         relay question — raises exactly one item through `raiseTurn`, of the
 *         kind, reason and proof type the table names; a console source raised
 *         again while its item is open is that item, never a second, never a
 *         second push
 *   TS-2  each PROJECTED source — the approval broker's card, a gate, a plan to
 *         approve, a QA ask, a live relay question, a person-check — carries a
 *         `turn` view naming its own row and pressing its own endpoints, and
 *         nothing of it is written to the ledger
 *   TS-3  `raiseTurn` is the only caller of `declareHumanStep` (a source scan)
 *   TS-4  a missing credential raises a `secret-entry` item whose proof is
 *         `credential:<id>`; the check reads it by presence, and storing it
 *         proves the item with nothing read back
 *   TS-5  an unanswerable relay question raises a `decision` item that keeps
 *         its options, the one marked (Recommended) recommended
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { SKILL_DIR, INSTANCE_STATE_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { buildInbox } = await import('../server/inbox.ts');
const { probeCredential } = await import('../server/credentials-probe.ts');
const {
  credentialTurnInput, errandTurnInput, ledgerTurn, mcpTurnInput, questionTurnInput,
} = await import('../server/turn/index.ts');

const { turnTagOf } = await import('../server/service-base.ts');
const SERVER = fileURLToPath(new URL('../server/', import.meta.url));
const NOW = Date.parse('2026-10-07T12:00:00.000Z');

const PLAN = `---
slug: alpha
created: 2026-10-07
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | infra | — | — | app | it works |
| 2 | release | 1 | — | app | it ships |

## Phases

### Phase 1 — infra
- **Size:** S

### Phase 2 — release
- **Size:** S
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-turn-sources-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

type Pushed = { category: string; title: string; body: string; tag?: string };

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const pushed: Pushed[] = [];
  svc.push.announce = ((category: string, message: Pushed) => { pushed.push({ ...message, category }); }) as never;
  assert.equal(svc.open(root).ok, true);
  return { svc, pushed };
}

test('TS-1: every ledger source raises ONE item of the kind, reason and proof type the table names', () => {
  const root = scratch();
  try {
    const { svc, pushed } = service(root);
    const at = (runId: string, phase = 2) => ({ slug: 'alpha', phase, runId });
    const rows = [
      {
        source: 'plan', kind: 'browser-login', why: 'identity', proofType: 'probe',
        input: { slug: 'alpha', phase: 1, birth: 'plan' as const, step: { kind: 'browser-login', title: 'Sign in to the dashboard', proof: 'cmd:"true"' } },
      },
      {
        source: 'session', kind: 'device-code', why: 'identity', proofType: 'probe',
        input: { ...at('r-session'), birth: 'session' as const, step: { kind: 'device-code', title: 'Enter the code', code: 'ABCD-EFGH', proof: 'cmd:"true"' } },
      },
      {
        source: 'errand', kind: 'operator-act', why: 'reserved', proofType: 'attest', again: true,
        input: errandTurnInput(at('r-errand'), { situation: 'blocked-declared:human-acts', need: 'Run the two applies.', how: 'Then answer.' }),
      },
      {
        source: 'preflight', kind: 'secret-entry', why: 'secret', proofType: 'probe', again: true,
        input: credentialTurnInput(at('r-cred'), 'keychain:pc-turn-svc', 'no keychain item named pc-turn-svc'),
      },
      {
        source: 'preflight', kind: 'mcp-login', why: 'identity', proofType: 'attest', again: true,
        input: mcpTurnInput(at('r-mcp'), { id: 'ctx', detail: 'needs-auth' }),
      },
      {
        source: 'relay', kind: 'decision', why: 'decision', proofType: 'answer', again: true,
        input: questionTurnInput(at('r-relay'), { key: 'k1', question: 'Which region?', options: [{ label: 'eu' }, { label: 'us' }] }, 'a repeat of the same ask'),
      },
      {
        // A suspected turn a person converted — the console's own birth.
        source: 'stall', kind: 'browser-login', why: 'identity', proofType: 'attest',
        input: { ...at('r-stall'), birth: 'console' as const, step: { kind: 'browser-login', title: 'Finish what phase 2 is waiting on', open_url: 'https://example.com/login' } },
      },
    ];
    for (const row of rows) {
      const before = pushed.length;
      const raised = svc.raiseTurn(row.input as never);
      assert.ok(raised && !('refused' in raised), `${row.source}: an item is raised`);
      const view = ledgerTurn(raised);
      assert.deepEqual(
        { source: view.source, kind: view.kind, why: view.why, proofType: view.proofType, record: view.record, item: view.item },
        { source: row.source, kind: row.kind, why: row.why, proofType: row.proofType, record: 'ledger', item: raised.id },
        `${row.source} → ${row.kind}`,
      );
      assert.equal(pushed.length, before + 1, `${row.source}: one push`);
      if (row.again) {
        const twice = svc.raiseTurn(row.input as never);
        assert.equal(twice && !('refused' in twice) ? twice.id : null, raised.id, `${row.source}: raised again, the same item`);
        assert.equal(pushed.length, before + 1, `${row.source}: and no second push`);
        const open = svc.humanStepsNow().open().filter((step) => step.runId === raised.runId && step.phase === raised.phase);
        assert.equal(open.length, 1, `${row.source}: one open item`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TS-1: a person errand announced by the runner IS one operator-act item, announced once in its own words', () => {
  const root = scratch();
  try {
    const { svc, pushed } = service(root);
    const errand = {
      phase: 2, situation: 'blocked-declared:human-acts', tried: [], at: '2026-10-07T11:00:00.000Z',
      need: 'Nothing merges before the operator runs the two Terraform applies.', how: 'Run them, then answer.',
    };
    const announce = (svc as never as { announceErrand(data: unknown): void }).announceErrand.bind(svc);
    announce({ slug: 'alpha', runId: 'r-ann', phase: 2, errand });
    announce({ slug: 'alpha', runId: 'r-ann', phase: 2, errand: { ...errand, at: '2026-10-07T11:05:00.000Z' } });
    const items = svc.humanStepsNow().open().filter((step) => step.runId === 'r-ann');
    assert.equal(items.length, 1, 'one item for the errand, however often it is announced');
    assert.equal(items[0]!.kind, 'operator-act');
    assert.equal(items[0]!.title, errand.need);
    assert.deepEqual(items[0]!.source, { kind: 'errand', ref: 'blocked-declared:human-acts' });
    const mine = pushed.filter((push) => /alpha · phase 2 needs you/.test(push.title));
    assert.equal(mine.length, 1, 'one push');
    assert.equal(mine[0]!.tag, turnTagOf(items[0]!), 'under the item\'s own tag');
    // A gate, a held plan, a protected path and a permission wall are not person errands of this kind.
    announce({ slug: 'alpha', runId: 'r-gate', phase: 1, errand: { ...errand, phase: 1, situation: 'blocked-declared:gate' } });
    assert.equal(svc.humanStepsNow().open().filter((step) => step.runId === 'r-gate').length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TS-2: each projected source carries a turn view naming its own row, and the ledger is not written', () => {
  const inbox = (facts: Record<string, unknown>) => buildInbox({ plans: [], runs: [], flags: {}, ...facts } as never, NOW).items;
  const items = inbox({
    runs: [{
      id: 'r1', slug: 'demo', status: 'parked', updatedAt: '2026-10-07T10:00:00.000Z',
      phases: { 4: { phase: 4, status: 'parked', planApproval: { state: 'pending', sha: 'abc' } } },
      recoveries: { 4: { errand: { phase: 4, situation: 'blocked-declared:gate', tried: [], need: 'A decision on the plan.', how: 'Approve or reject it.', at: '2026-10-07T10:00:00.000Z' } } },
    }],
    approvals: [
      {
        id: 'q1', runId: 'r1', slug: 'demo', phase: 5, kind: 'question', status: 'pending', createdAt: '2026-10-07T11:00:00.000Z',
        question: { items: [{ key: 'k1', question: 'Which database?', options: [{ label: 'Postgres (Recommended)' }, { label: 'SQLite' }] }] },
      },
      { id: 'v1', runId: 'r1', slug: 'demo', phase: 3, kind: 'verify', title: 'Phase 3: 2 checks only you can make', detail: 'The rest is prose.', createdAt: '2026-10-07T11:00:00.000Z', status: 'pending' },
      { id: 't1', runId: 'r1', slug: 'demo', phase: 3, kind: 'tool', title: 'Run `rm -rf build`?', createdAt: '2026-10-07T11:00:00.000Z', status: 'pending' },
    ],
    plans: [{
      slug: 'demo', closed: false, updatedAt: '2026-10-07T07:00:00.000Z', qaMode: { mode: 'on' },
      qa: [{ phase: 2, result: 'fail', report: 'docs/handoffs/demo/reports/p2.md' }],
      phases: [
        { phase: 2, state: 'done' },
        { phase: 6, state: 'ready', gated: true, gateKind: 'human', gateCheck: 'a human look', gate: { clear: false, kind: 'human', detail: 'nobody has signed this off' } },
      ],
    }],
  });
  const expect: [string, (item: (typeof items)[number]) => boolean, string, string, string, string][] = [
    ['approval', (i) => i.kind === 'approval' && i.title.startsWith('Run'), 'approval', 'permission', 'permission', 'grant'],
    ['person-check', (i) => i.kind === 'approval' && i.title.startsWith('Phase 3'), 'person-check', 'person-check', 'decision', 'answer'],
    ['gate', (i) => i.kind === 'gate', 'gate', 'decision', 'decision', 'answer'],
    ['plan-approval', (i) => i.kind === 'errand' && i.phase === 4, 'plan-approval', 'decision', 'decision', 'answer'],
    ['qa', (i) => i.kind === 'qa', 'qa', 'decision', 'decision', 'answer'],
    ['question', (i) => i.kind === 'question', 'question', 'decision', 'decision', 'answer'],
  ];
  for (const [name, pick, source, kind, why, proofType] of expect) {
    const row = items.find(pick);
    assert.ok(row, `${name}: the row exists`);
    assert.deepEqual(
      { item: row!.turn?.item, record: row!.turn?.record, source: row!.turn?.source, kind: row!.turn?.kind, why: row!.turn?.why, proofType: row!.turn?.proofType },
      { item: row!.id, record: 'projected', source, kind, why, proofType },
      `${name} is a projected item of its own row`,
    );
  }
  // Nothing about a projected item is written: the inbox is pure, and no ledger line exists for it.
  const ledger = join(INSTANCE_STATE_DIR, 'human-steps.ndjson');
  const lines = (() => { try { return readFileSync(ledger, 'utf8'); } catch { return ''; } })();
  for (const id of ['q1', 'v1', 't1']) assert.ok(!lines.includes(`"${id}"`), `no ledger line names ${id}`);
});

test('TS-3: raiseTurn is the only caller of declareHumanStep', () => {
  const callers: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/(?<!function )\bdeclareHumanStep\(/g)) {
        callers.push(`${path.slice(SERVER.length)}:${text.slice(0, match.index).split('\n').length}`);
      }
    }
  };
  walk(SERVER);
  assert.equal(callers.length, 1, `declareHumanStep is called from ${callers.join(', ')}`);
  assert.match(callers[0]!, /^turn\/index\.ts:/, 'and that one call is the door, raiseTurn');
  const door = readFileSync(join(SERVER, 'turn', 'index.ts'), 'utf8');
  assert.match(door, /export function raiseTurn\([^)]*\)[^{]*\{[\s\S]*?return declareHumanStep\(/, 'inside raiseTurn');
});

test('TS-4: a missing credential is a secret-entry item proven by presence — storing it proves it, nothing read back', async () => {
  const root = scratch();
  try {
    const { svc } = service(root);
    const raised = svc.raiseTurn(credentialTurnInput({ slug: 'alpha', phase: 2, runId: 'r-ts4' }, 'keychain:pc-ts4', 'no keychain item named pc-ts4'));
    assert.ok(raised && !('refused' in raised));
    assert.equal(raised.kind, 'secret-entry');
    assert.equal(raised.proof, 'credential:keychain:pc-ts4');
    assert.equal(raised.credential, undefined, 'the item names no registry id to post a value to');
    // The check reads the credential by presence, through the watch clock's own probe.
    let present = false;
    const asked: string[] = [];
    (svc as never as { credentialProbe: (id: string) => Promise<unknown> }).credentialProbe = async (id: string) => {
      asked.push(id);
      return present ? { status: 'ok', reason: 'keychain item pc-ts4 exists' } : { status: 'fail', reason: 'no keychain item named pc-ts4' };
    };
    const first = await svc.checkHumanStep(raised.id, { by: 'operator@test' });
    assert.equal(first.ok, true);
    assert.equal((first as { check?: { landed: boolean } }).check?.landed, false, 'not stored yet: the item waits');
    present = true;
    const second = await svc.checkHumanStep(raised.id, { by: 'operator@test' });
    assert.equal((second as { check?: { landed: boolean; read: string } }).check?.landed, true, 'stored: proven');
    assert.equal(svc.humanStepsNow().get(raised.id)?.state, 'proven');
    assert.deepEqual(asked, ['keychain:pc-ts4', 'keychain:pc-ts4']);
    // The probe itself asks the keychain for the item by NAME — `-w` (print the secret) is never passed.
    const argv: string[][] = [];
    const verdict = await probeCredential('keychain:pc-ts4', {
      platform: 'darwin', exec: async (file: string, args: string[]) => { argv.push([file, ...args]); return { code: 0, stderr: '' }; },
    });
    assert.equal(verdict.status, 'ok');
    assert.deepEqual(argv, [['security', 'find-generic-password', '-s', 'pc-ts4']]);
    assert.ok(!argv.flat().includes('-w'));
    // And the watch clock answers the ref the same way.
    const read = await (svc as never as { watchClock: { probeNow(ref: string): Promise<{ state: string }> } }).watchClock.probeNow('credential:keychain:pc-ts4');
    assert.equal(read.state, 'landed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TS-5: an unanswerable relay question raises a decision item that keeps its options, the recommended one marked', async () => {
  const { defaultCategories } = await import('../server/push/catalogue.ts');
  rmSync(join(INSTANCE_STATE_DIR, 'relay'), { recursive: true, force: true });
  const svc = new Service({ port: 0, host: '127.0.0.1', open: false, allowWrites: false, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null } as never);
  const inner = svc as unknown as { prefs: Record<string, unknown>; runners: Map<string, unknown>; push: { announce: (...args: unknown[]) => void } };
  inner.prefs.notify = defaultCategories();
  const pushed: { title: string; tag?: string }[] = [];
  inner.push.announce = (_category: unknown, message: unknown) => { pushed.push(message as { title: string; tag?: string }); };
  inner.runners.set('turn', {
    isSpending: () => false, busy: () => true, note: () => {}, park: () => true,
    current: () => ({
      id: 'r-q', slug: 'turn', activePhase: 3, permissionProfile: 'trusted', phases: {}, status: 'running',
      relay: 'last-resort', relayArming: { armed: true, version: '2.1.270', floor: '2.1.268', at: new Date().toISOString() },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await svc.decideToolUse({
    tool_name: 'AskUserQuestion', session_id: 'sess-q', tool_use_id: 'toolu_q',
    tool_input: { questions: [{ header: 'Region', multiSelect: true, question: 'Which regions?', options: [{ label: 'eu (Recommended)', description: 'the cheaper one' }, { label: 'us' }] }] },
  } as never, 'r-q');
  const items = svc.humanStepsNow().open().filter((step) => step.runId === 'r-q');
  assert.equal(items.length, 1, 'one decision item');
  const item = items[0]!;
  assert.equal(item.kind, 'decision');
  assert.equal(item.title, 'Which regions?');
  assert.deepEqual(item.options, [
    { id: 'o1', label: 'eu (Recommended)', consequence: 'the cheaper one', recommended: true },
    { id: 'o2', label: 'us' },
  ]);
  assert.equal(ledgerTurn(item).source, 'relay');
  assert.equal(pushed.length, 1, 'announced once');
  assert.match(pushed[0]!.title, /A question needs you — turn phase 3/, 'in the relay\'s own words');
  assert.equal(pushed[0]!.tag, turnTagOf(item), 'under the item\'s tag');
});

test('TS-1: the same source asked again in other words supersedes its item — nobody holds a stale ask', () => {
  const root = scratch();
  try {
    const { svc } = service(root);
    const at = { slug: 'alpha', phase: 2, runId: 'r-again' };
    const first = svc.raiseTurn(errandTurnInput(at, { situation: 'blocked-declared:human-acts', need: 'Run the applies.' }));
    const second = svc.raiseTurn(errandTurnInput(at, { situation: 'blocked-declared:human-acts', need: 'Run the applies, then rotate the key.' }));
    assert.ok(first && !('refused' in first) && second && !('refused' in second));
    assert.notEqual(second.id, first.id);
    assert.equal(svc.humanStepsNow().get(first.id)?.state, 'dismissed');
    assert.match(svc.humanStepsNow().get(first.id)?.note ?? '', /superseded/);
    assert.deepEqual(svc.humanStepsNow().open().filter((step) => step.runId === 'r-again').map((step) => step.id), [second.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TS-2: the approval broker\'s ask is a PROJECTED permission item carrying its record — the call, the rule, the wall, the risk, today\'s Grant (control-tower phase 135)', () => {
  const items = buildInbox({
    plans: [], runs: [], flags: {},
    approvals: [{
      id: 'a-135', runId: 'r1', slug: 'alpha', phase: 4, kind: 'tool', title: 'Bash: vercel deploy --prod', createdAt: new Date(NOW - 60_000).toISOString(),
      status: 'pending', detail: 'Phase 4 of alpha wants to use Bash.', tool: { name: 'Bash', input: { command: 'vercel deploy --prod' } },
      suggestedRule: 'Bash(vercel deploy:*)',
    }],
  } as never, NOW).items;
  const row = items.find((item) => item.kind === 'approval')!;
  assert.equal(row.turn?.record, 'projected', 'the card keeps its held call, its clock and its closure');
  assert.equal(row.turn?.item, row.id);
  assert.equal(row.turn?.kind, 'permission');
  const permission = row.turn?.permission;
  assert.equal(permission?.wall, 'ask');
  assert.equal(permission?.tool, 'Bash');
  assert.equal(permission?.command, 'vercel deploy --prod');
  assert.equal(permission?.rule, 'Bash(vercel deploy:*)');
  assert.equal(permission?.need, 'Phase 4 of alpha wants to use Bash.');
  assert.equal(permission?.risk, 'low');
  assert.equal(permission?.grant?.effect, 'broker');
});
