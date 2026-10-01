/**
 * SV-1 (control-tower phase 101, EC1, #145): `viewer/shared/supervisor-model.js`
 * owns the supervisor's ONE table — the chat's `CHAT_TOOLS`, the remedy rows and
 * the autonomy words — and the table agrees with the verb table it presses
 * through. Phase 27 extends it; these checks are what an extension must keep.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  CHAT_TOOLS, CHAT_TOOL_VERBS, NEVER_PRESSED, POLICY_CONFIRM, REMEDIES, REMEDY_CLASSES, SUPERVISOR_EVENTS,
  SUPERVISOR_INVARIANTS, SUPERVISOR_OUTCOMES, SUPERVISOR_POLICIES, SUPERVISOR_SHIPPED_POLICY, SUPERVISOR_SITUATIONS,
  TOOL_CAPABILITIES, commandFor, isSupervisorPolicy, outcomeFor, remedyFor,
} from '../shared/supervisor-model.js';
import { VERB_NAMES, verbNamed } from '../shared/verb-model.js';
import { parseRowArgs } from '../../bin/run-verb.mjs';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');

test('SV-1: the autonomy words are off · observe · suggest · act, the shipped one is suggest, and they map onto confirm', () => {
  assert.deepEqual([...SUPERVISOR_POLICIES], ['off', 'observe', 'suggest', 'act']);
  assert.equal(SUPERVISOR_SHIPPED_POLICY, 'suggest');
  assert.equal(POLICY_CONFIRM.act, 'never');
  assert.equal(POLICY_CONFIRM.suggest, 'always');
  assert.deepEqual(Object.keys(POLICY_CONFIRM), [...SUPERVISOR_POLICIES]);
  assert.ok(isSupervisorPolicy('observe') && !isSupervisorPolicy('on') && !isSupervisorPolicy(undefined));
  for (const list of [SUPERVISOR_POLICIES, REMEDY_CLASSES, SUPERVISOR_OUTCOMES, SUPERVISOR_EVENTS, SUPERVISOR_SITUATIONS, REMEDIES, CHAT_TOOLS]) {
    assert.ok(Object.isFrozen(list), 'a vocabulary is frozen');
  }
});

test('SV-1: the decision table — off detects, observe dry-runs, suggest cards, act presses only a press row', () => {
  const table = SUPERVISOR_POLICIES.map((policy) => REMEDY_CLASSES.map((cls) => outcomeFor(policy, cls)));
  assert.deepEqual(table, [
    ['detected', 'detected', 'detected', 'detected'],
    ['observed', 'observed', 'observed', 'detected'],
    ['suggested', 'suggested', 'escalated', 'detected'],
    ['acted', 'suggested', 'escalated', 'detected'],
  ]);
});

test('SV-1: one remedy row per situation, in catalogue order, each well formed', () => {
  assert.deepEqual(REMEDIES.map((row) => row.situation), [...SUPERVISOR_SITUATIONS]);
  for (const row of REMEDIES) {
    assert.ok(row.evidence.length > 20 && row.remedy.length > 10, `${row.situation} states its evidence and remedy`);
    assert.ok((REMEDY_CLASSES as readonly string[]).includes(row.autonomy), `${row.situation}: ${row.autonomy}`);
    assert.ok(Number.isInteger(row.cap.perHour) && row.cap.perHour >= 0, `${row.situation} has an hourly cap`);
    assert.equal(remedyFor(row.situation), row);
    if (row.autonomy === 'none') { assert.equal(row.verb, null); continue; }
    assert.ok(row.verb && VERB_NAMES.includes(row.verb), `${row.situation} names a verb of the verb table: ${row.verb}`);
    assert.ok(!NEVER_PRESSED.includes(row.verb!), `${row.situation} names ${row.verb}, which no remedy may press`);
    // A row the supervisor PRESSES goes through the in-process door, which
    // takes only the trigger-pressable rows (`server/verb-press.ts`).
    if (row.autonomy === 'press' || row.autonomy === 'suggest') {
      assert.equal(verbNamed(row.verb!)?.trigger, true, `${row.situation}: ${row.verb} is not pressable in-process`);
    }
    if (row.autonomy === 'press') assert.ok(row.cap.perHour > 0, `${row.situation} presses with a cap of 0`);
  }
  // The watchdog's ten, as the plan names them, are all here.
  for (const key of ['hinted-not-queued', 'ahead-of-dependency', 'lane-lost-at-start', 'hot-account', 'stale-credential',
    'checkout-refused', 'replay-at-cap', 'approval-timed-out', 'quiet-not-stalled', 'machine-load']) {
    assert.ok((SUPERVISOR_SITUATIONS as readonly string[]).includes(key), key);
  }
});

test('SV-1: CHAT_TOOLS — name, read or act, destructive, capability, and every verb a real one', () => {
  const names = CHAT_TOOLS.map((row) => row.name);
  assert.equal(new Set(names).size, names.length, 'a tool is listed once');
  for (const row of CHAT_TOOLS) {
    assert.match(row.name, /^[a-z][a-z0-9-]*$/);
    assert.ok(row.kind === 'read' || row.kind === 'act', row.name);
    assert.equal(typeof row.destructive, 'boolean');
    if (row.kind === 'read') {
      assert.equal(row.capability, null, `${row.name} is a read and needs no flag`);
      assert.equal(row.destructive, false);
    } else {
      assert.ok((TOOL_CAPABILITIES as readonly string[]).includes(row.capability!), `${row.name}: ${row.capability}`);
    }
    if (row.verb) {
      const verb = verbNamed(row.verb);
      assert.ok(verb, `${row.name} names ${row.verb}, which the verb table lacks`);
      assert.equal(verb!.kind, row.kind, `${row.name} and its verb disagree on read/act`);
    }
  }
  for (const verb of CHAT_TOOL_VERBS) assert.ok(VERB_NAMES.includes(verb));
  // §Architecture 8's list, by name.
  for (const name of ['plans', 'boards', 'runs', 'why-halted', 'inbox', 'locks', 'queue', 'accounts', 'doctor', 'journal', 'search',
    'start', 'pause', 'resume', 'hold', 'release', 'stop', 'freeze', 'thaw', 'retry', 'skip', 'recover', 'recheck', 'closeout',
    'resume-phase', 'switch-account', 'settings', 'raise-budget', 'clear-streak', 'approve-gate', 'answer-approval', 'release-lock',
    'clear-retired', 'qa-recover', 'qa-rerun', 'draft-an-issue', 'human-steps', 'human-step-open-again',
    'human-step-check-now']) {
    assert.ok(names.includes(name), `§Architecture 8 names the ${name} tool`);
  }
  // The capability flags are the console's own switches.
  const config = readFileSync(join(VIEWER, 'server', 'config.ts'), 'utf8');
  for (const flag of TOOL_CAPABILITIES) assert.ok(config.includes(`['${flag}'`), `${flag} is a console switch`);
  // A human step may be listed, reopened and re-checked — never completed by the chat.
  assert.ok(!names.some((name) => /complete/.test(name)));
});

test('SV-1: commandFor composes the exact `phase-console run` line from the row, and it parses back', () => {
  const line = commandFor('switch-account', { slug: 'vca-refactor', accountId: 'acct 2', when: 'boundary', reason: 'at 97 % weekly' });
  assert.equal(line, "phase-console run switch-account vca-refactor 'acct 2' --when boundary --reason 'at 97 % weekly'");
  const argv = ['vca-refactor', 'acct 2', '--when', 'boundary', '--reason', 'at 97 % weekly'];
  const parsed = parseRowArgs(verbNamed('switch-account'), argv);
  assert.deepEqual(parsed.positionals, { slug: 'vca-refactor', accountId: 'acct 2' });
  assert.deepEqual(parsed.flags, { when: 'boundary', reason: 'at 97 % weekly' });
  assert.equal(commandFor('clear-streak', { slug: 'trade' }), 'phase-console run clear-streak trade');
  assert.equal(commandFor('retry', { slug: 'x' }), null, 'a missing positional composes nothing rather than a broken line');
  assert.equal(commandFor('repair-checkout', { slug: 'x' }), null, 'a verb with no CLI shape has no command');
  assert.equal(commandFor('note', { slug: 'x', text: "it's", pinned: true }), "phase-console run note x --text 'it'\\''s' --pin true");
});

test('SV-1: the invariants are named once, and no remedy verb can break one', () => {
  const ids = SUPERVISOR_INVARIANTS.map((row) => row.id);
  assert.deepEqual(ids, ['no-only-phases', 'no-stash', 'no-orphan-kill', 'move-never-delete', 'never-block', 'press-only-halts',
    'no-live-switch', 'never-onto-walled', 'never-main']);
  const verbs = new Set(REMEDIES.map((row) => row.verb).filter(Boolean));
  for (const never of ['start', 'stop', 'freeze', 'skip', 'release-lock', 'clear-retired']) assert.ok(!verbs.has(never), never);
});
