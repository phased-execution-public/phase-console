/**
 * The guard at the door of Your turn (control-tower phase 130, #207) — TG-1..8.
 * Rules, never a judgement call: the run's policy arrives as a judge.
 *
 *   TG-1  G1 — a reason the kind allows; none named is the default, inferred.
 *   TG-2  G2 — a proof (a ref or words) unless the answer is the result;
 *         `attest` only by name; at ingest an older line reads as attest.
 *   TG-3  G4 — a `permission`/`reserved` act whose every command the run's own
 *         policy allows is refused, exit 4, the commands named.
 *   TG-4  G4 — a command a RULE stops re-shapes the act as a permission item
 *         naming the wall.
 *   TG-5  G4 — `reach` with no `--tried` is refused, exit 4: try it first.
 *   TG-6  G4 judges only the reasons that claim the AI cannot: a sign-in is the
 *         person's even when policy would let its command run.
 *   TG-7  G4 never refuses a guide with no command, nor an inferred reason; a
 *         refusal raised again with `--tried` is accepted and marked.
 *   TG-8  G6 — a secret is refused at the door, and left to redaction at ingest.
 * (G3 is the pre-check's probe, G7 the ledger's — turn-ledger.test.ts.)
 */
import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { guardStep, type CommandJudge, type GuardVerdict } from '../server/turn/guard.ts';
import { parseGuide, type Guide } from '../shared/guide-grammar.js';
import { GUARD_REFUSAL_EXIT } from '../shared/turn-model.js';

const allowAll: CommandJudge = () => ({ verdict: 'allow' });
const denyPush: CommandJudge = (command) =>
  command.startsWith('git push') ? { verdict: 'deny', rule: 'Bash(git push:*)' } : { verdict: 'allow' };
const askDeploy: CommandJudge = (command) => (command.startsWith('vercel') ? { verdict: 'ask' } : { verdict: 'allow' });

function guide(...commands: string[]): Guide {
  const text = `Why it matters.\n\n## Steps\n${commands
    .map((c, i) => `${i + 1}. Run it\n   \`\`\`sh\n   ${c}\n   \`\`\``)
    .join('\n')}\n`;
  const read = parseGuide(text);
  assert.ok(read.ok, JSON.stringify(read));
  return (read as { ok: true; guide: Guide }).guide;
}

function refused(verdict: GuardVerdict): Extract<GuardVerdict, { ok: false }> {
  assert.equal(verdict.ok, false, JSON.stringify(verdict));
  return verdict as Extract<GuardVerdict, { ok: false }>;
}
function passed(verdict: GuardVerdict): Extract<GuardVerdict, { ok: true }> {
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  return verdict as Extract<GuardVerdict, { ok: true }>;
}

test('TG-1: a declaration with no reason gets its kind’s default, marked inferred', () => {
  const v = passed(guardStep({ kind: 'browser-login', title: 'Sign in', proof: 'cmd:"gh auth status"' }, { stage: 'door' }));
  assert.equal(v.why, 'identity');
  assert.equal(v.whySource, 'inferred');
  // Phase 121's --act with no --why keeps working: the act's default is reserved.
  const act = passed(guardStep({ kind: 'operator-act', title: 'Restart', proof: 'cmd:"true"' }, { stage: 'door', judge: allowAll }));
  assert.deepEqual([act.why, act.whySource], ['reserved', 'inferred']);
});

test('TG-1: a reason the kind does not allow is refused by name, exit 2', () => {
  const r = refused(guardStep({ kind: 'browser-login', title: 'Sign in', why: 'money', proof: 'cmd:"x"' }, { stage: 'door' }));
  assert.equal(r.rule, 'G1');
  assert.equal(r.exit, 2);
  assert.match(r.sentence, /browser-login step is not asked for because of money — its reasons are: identity secret/);
  const unknown = refused(guardStep({ kind: 'decision', title: 'Pick', why: 'vibes' }, { stage: 'door' }));
  assert.match(unknown.sentence, /unknown --why vibes/);
});

test('TG-2: a proof, unless the answer is the result; attest only by name', () => {
  const none = refused(guardStep({ kind: 'operator-act', title: 'Flip the DNS' }, { stage: 'door' }));
  assert.deepEqual([none.rule, none.exit], ['G2', 2]);
  assert.match(none.sentence, /--proof-type attest/);
  assert.equal(passed(guardStep({ kind: 'decision', title: 'Pick one' }, { stage: 'door' })).proofType, 'answer');
  assert.equal(passed(guardStep({ kind: 'operator-act', title: 'Flip', proofWords: 'the record resolves' }, { stage: 'door' })).proofType, 'judgement');
  const attest = passed(guardStep({ kind: 'operator-act', title: 'Flip', proofType: 'attest' }, { stage: 'door' }));
  assert.deepEqual([attest.proofType, attest.proofTypeSource], ['attest', 'declared']);
  assert.equal(refused(guardStep({ kind: 'browser-login', title: 'x', proofType: 'probe' }, { stage: 'door' })).rule, 'G2');
  assert.equal(refused(guardStep({ kind: 'browser-login', title: 'x', proofType: 'grant' }, { stage: 'door' })).rule, 'G2');
  // An older line at ingest — no proof, no type — reads as the person's word.
  const old = passed(guardStep({ kind: 'browser-login', title: 'x' }, { stage: 'ingest' }));
  assert.deepEqual([old.proofType, old.proofTypeSource], ['attest', 'inferred']);
});

test('TG-3: a reserved act whose every command the run may already run is refused — exit 4, the commands named', () => {
  for (const why of ['reserved', 'permission']) {
    const r = refused(guardStep(
      { kind: 'operator-act', title: 'Run the tests', why, proof: 'cmd:"true"', guide: guide('npm test', 'npm run build') },
      { stage: 'door', judge: allowAll },
    ));
    assert.deepEqual([r.rule, r.exit], ['G4', GUARD_REFUSAL_EXIT]);
    assert.deepEqual(r.commands, ['npm test', 'npm run build']);
    assert.match(r.sentence, /the AI can do this itself/);
    assert.match(r.sentence, /`npm test`, `npm run build`/);
  }
  // The open command counts as a command the guide asks for.
  const open = refused(guardStep(
    { kind: 'operator-act', title: 'Build', why: 'reserved', proofType: 'attest', openCommand: 'npm run build' },
    { stage: 'ingest', judge: allowAll },
  ));
  assert.equal(open.exit, GUARD_REFUSAL_EXIT);
});

test('TG-4: a command a RULE stops re-shapes the act as a permission item naming the wall', () => {
  const v = passed(guardStep(
    { kind: 'operator-act', title: 'Push it', why: 'reserved', proof: 'cmd:"true"', guide: guide('npm test', 'git push origin main') },
    { stage: 'door', judge: denyPush },
  ));
  assert.deepEqual(v.reshape, { kind: 'permission', why: 'permission', wall: 'deny', command: 'git push origin main', rule: 'Bash(git push:*)' });
  const ask = passed(guardStep(
    { kind: 'operator-act', title: 'Deploy', why: 'permission', proof: 'cmd:"true"', guide: guide('vercel deploy --prod') },
    { stage: 'door', judge: askDeploy },
  ));
  assert.equal(ask.reshape?.wall, 'ask');
});

test('TG-5: reach with no --tried is refused — try it, then say what happened', () => {
  const r = refused(guardStep({ kind: 'operator-act', title: 'Open the VPN', why: 'reach', proofType: 'attest' }, { stage: 'door' }));
  assert.deepEqual([r.rule, r.exit], ['G4', GUARD_REFUSAL_EXIT]);
  assert.match(r.sentence, /^try it, then say what happened/);
  passed(guardStep(
    { kind: 'operator-act', title: 'Open the VPN', why: 'reach', proofType: 'attest', tried: 'curl https://intra.example timed out after 30 s' },
    { stage: 'door' },
  ));
});

test('TG-6: a sign-in whose command policy would allow is NOT refused — G4 never judges identity', () => {
  const v = passed(guardStep(
    { kind: 'browser-login', title: 'Sign gh in', why: 'identity', proof: 'cmd:"gh auth status"', openCommand: 'gh auth login', guide: guide('gh auth login') },
    { stage: 'door', judge: allowAll },
  ));
  assert.equal(v.reshape, undefined);
  // Even under a reason G4 does judge, a sign-in shape is never the AI's to run.
  passed(guardStep(
    { kind: 'operator-act', title: 'Sign in', why: 'reserved', proofType: 'attest', guide: guide('gh auth login') },
    { stage: 'door', judge: allowAll },
  ));
  for (const why of ['secret', 'money', 'legal', 'decision', 'physical']) {
    passed(guardStep({ kind: 'operator-act', title: 'x', why, proofType: 'attest', guide: guide('npm test') }, { stage: 'door', judge: allowAll }));
  }
});

test('TG-7: no command, no judge or an inferred reason is never refused by G4; --tried overrules it, marked', () => {
  passed(guardStep({ kind: 'operator-act', title: 'Click Approve', why: 'reserved', proofType: 'attest' }, { stage: 'door', judge: allowAll }));
  passed(guardStep({ kind: 'operator-act', title: 'Run', why: 'reserved', proofType: 'attest', guide: guide('npm test') }, { stage: 'door', judge: null }));
  passed(guardStep({ kind: 'operator-act', title: 'Run', proofType: 'attest', guide: guide('npm test') }, { stage: 'door', judge: allowAll }));
  const again = passed(guardStep(
    { kind: 'operator-act', title: 'Run', why: 'reserved', proofType: 'attest', guide: guide('npm test'), tried: 'npm test fails: EACCES on /usr/lib' },
    { stage: 'door', judge: allowAll },
  ));
  assert.equal(again.overruled, true, 'accepted, and marked: the guard was overruled by evidence');
});

test('TG-8: a secret is refused at the door, exit 2, and never echoed; at ingest redaction has it', () => {
  const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  const r = refused(guardStep({ kind: 'decision', title: `Use ${token}` }, { stage: 'door' }));
  assert.deepEqual([r.rule, r.exit], ['G6', 2]);
  assert.ok(!r.sentence.includes(token));
  passed(guardStep({ kind: 'decision', title: `Use ${token}` }, { stage: 'ingest' }));
});

test('a refusal is a sink: the commands it names and its journal fields are redacted', async () => {
  const { refusalFields } = await import('../server/turn/guard.ts');
  const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
  // A guide parsed elsewhere could not carry this — the door screens every line — so build one by hand.
  const g = { lang: 'en', dir: 'ltr' as const, summary: 'Why.', steps: [{ text: 'Run', code: `curl -H "x-token: ${token}" https://x.example` }], trouble: [], version: 1 };
  const r = refused(guardStep({ kind: 'operator-act', title: 'x', why: 'reserved', proofType: 'attest', guide: g }, { stage: 'ingest', judge: allowAll }));
  const fields = JSON.stringify(refusalFields(r));
  assert.ok(!fields.includes(token), fields);
  assert.ok(!r.sentence.includes(token));
});

/* ------------------------------------------------------------------ *
 * G5 (control-tower phase 135, #212) — PW-6: a permission item cites a wall
 * the console RECORDED for the declaring lane, or nothing refused it.
 * ------------------------------------------------------------------ */

const { guardWall } = await import('../server/turn/guard.ts');
const { G5_SENTENCE } = await import('../shared/turn-model.js');
type RecordedWall = import('../server/permissions/walls.ts').RecordedWall;

const AT = '2026-10-07T10:00:00.000Z';
const pushWall: RecordedWall = { wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push origin pe/x', at: AT, source: 'hook' };
const mcpWall: RecordedWall = { wall: 'mcp', tool: 'mcp__github__create_issue', rule: 'mcp__github', at: AT, source: 'cli' };

test('PW-6 / G5: a declaration that cites a recorded wall passes with that wall — by rule, by command, or bare', () => {
  const byRule = guardWall({ rule: 'Bash(git push:*)' }, [mcpWall, pushWall]);
  assert.equal(byRule.ok, true);
  assert.equal(byRule.ok && byRule.wall, pushWall, 'the wall the rule names');
  const byCommand = guardWall({ command: 'git push origin pe/x' }, [pushWall, mcpWall]);
  assert.equal(byCommand.ok && byCommand.wall, pushWall, 'a command is matched as a person would read it');
  const quoted = guardWall({ command: '`git push origin pe/x`' }, [pushWall]);
  assert.equal(quoted.ok, true, 'backticks and quotes are not part of the command');
  const bare = guardWall({}, [pushWall, mcpWall]);
  assert.equal(bare.ok && bare.wall, mcpWall, 'a bare declaration cites the newest wall');
});

test('PW-6 / G5: a declaration citing a wall nothing recorded is refused — "nothing refused this — run it", exit 4', () => {
  for (const [declared, walls] of [
    [{ rule: 'Bash(npm publish:*)' }, [pushWall]],
    [{ command: 'npm test' }, [pushWall]],
    [{ rule: 'Bash(git push:*)' }, []],
    [{}, []],
  ] as const) {
    const verdict = guardWall(declared, walls);
    assert.equal(verdict.ok, false, JSON.stringify(declared));
    if (verdict.ok) continue;
    assert.equal(verdict.rule, 'G5');
    assert.equal(verdict.exit, GUARD_REFUSAL_EXIT);
    assert.match(verdict.sentence, /^nothing refused this — run it/);
    assert.equal(verdict.sentence, G5_SENTENCE.replace(/["\\]/g, "'"));
  }
});

/* ------------------------------------------------------------------ *
 * The honest path (turn-by-turn phase 6, #286, §Architecture 5.1): G5 never
 * drops a run-level ask, no errand says Your turn holds an item it does not,
 * and no handled row says "the AI could run it" for a run-level ask.
 * ------------------------------------------------------------------ */

const { answerDeclaredProbe } = await import('../server/declared-probe.ts');
const { runDir, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { askTable } = await import('../server/runner/ladder.ts');
const { G5_ERRAND_HOW } = await import('../shared/turn-model.js');
const { handledOfJournal } = await import('../server/turn/handled.ts');
const { harness: turnHarness, SLUG: TURN_SLUG } = await import('./turn-harness.ts');
const { mkdirSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');

test('RR-G5: a permission block the compatibility rule reads as a run request is never refused at the door, and nothing says the AI runs it', async () => {
  const h = turnHarness();
  try {
    const state = newRun({ slug: TURN_SLUG, root: h.root, onlyPhases: [3] } as never);
    saveRun(state);
    const dir = runDir(h.root, TURN_SLUG);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `run-${state.id}-p3-outcome.json.tmp.4343`);
    writeFileSync(path, JSON.stringify({
      version: 1, slug: TURN_SLUG, phase: 3, status: 'blocked', needs: 'permission',
      reason: 'Operator: stop this run and start it again isolated', watch: [], written_at: new Date().toISOString(),
    }));
    const journalled: { kind: string; data: Record<string, unknown> }[] = [];
    const deps = {
      root: h.root, probe: async () => ({ landed: null, refs: [] }), walls: () => [],
      journal: (_slug: string, _run: string | null, kind: string, data: Record<string, unknown>) => { journalled.push({ kind, data }); },
    };
    const refused = await answerDeclaredProbe({ slug: TURN_SLUG, phase: 3, file: path }, deps);
    assert.equal((refused as { verdict: string }).verdict, 'guard', 'no run request: G5 refuses as before');
    journalled.length = 0;
    const run = await answerDeclaredProbe({ slug: TURN_SLUG, phase: 3, file: path }, { ...deps, runRequest: () => true });
    assert.equal((run as { verdict: string }).verdict, 'pending', 'a run-level ask parks; the runner records it as an isolate request');
    assert.equal(journalled.length, 0, 'no turn-refused line, so no handled row');
    // The handled reading of a G5 line is the only "nothing refused it" row — and a run request writes none.
    const row = handledOfJournal({ slug: TURN_SLUG, runId: state.id, seq: 1, t: Date.now(), event: 'run.run-requested', phase: 3, data: { act: 'isolate' } } as never);
    assert.equal(row, null, 'a run request is never a handled "the AI runs it"');
  } finally { h.cleanup(); }
});

test('RR-G5: no errand says Your turn holds a permission item it does not', async () => {
  const how = askTable()['blocked-declared:permission']!.how;
  assert.doesNotMatch(how, /^Your turn holds a permission item/, 'the ASK never claims the item unconditionally');
  assert.match(how, /When nothing refused it, there is no item/);
  assert.doesNotMatch(G5_ERRAND_HOW, /Your turn holds a permission item for it/);
  const h = turnHarness();
  try {
    const state = newRun({ slug: TURN_SLUG, root: h.root, onlyPhases: [3] } as never);
    const record = phaseRecord(state, 3);
    record.status = 'parked';
    record.declared = { status: 'blocked', needs: 'permission', rule: 'Bash(npm publish:*)', command: 'npm publish', at: new Date().toISOString() } as never;
    saveRun(state);
    (h.svc as unknown as { announceErrand: (data: unknown) => void }).announceErrand({
      slug: TURN_SLUG, runId: state.id, phase: 3,
      errand: { at: 'a1', situation: 'blocked-declared:permission', need: 'A permission the AI lacks', how, tried: [] },
    });
    assert.equal(h.svc.humanStepsNow().open().length, 0, 'G5 refused it at ingest: no item');
    const pushed = JSON.stringify(h.pushes);
    assert.doesNotMatch(pushed, /Your turn holds a permission item for it/, 'the push names no item that does not exist');
    assert.match(pushed, /Your turn holds no/);
  } finally { h.cleanup(); }
});
