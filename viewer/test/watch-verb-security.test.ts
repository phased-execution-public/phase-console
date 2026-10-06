/**
 * A keychain proof is a watch verb (control-tower phase 111, #201).
 *
 * A credential or secret-entry step is proved, naturally, by a read-only
 * keychain lookup that prints the item's attributes and never its secret —
 * `security find-generic-password -s <service>`. The plan's E5.1 proof, the
 * repository's own human-step fixture and `docs/releasing.md` all use it, and
 * the console's command judge refused `security` outright ("is not a
 * recognised command"), so a person's turn could not be proved with the
 * command a person would type: phase 74 wrapped it in a script at an absolute
 * path instead.
 *
 * The rule, gated by subcommand the way `DOCKER_READ_ONLY` gates docker: the
 * two lookups (`find-generic-password`, `find-internet-password`) pass, without
 * `-w` or `-g` — the flags that print the secret. Every other subcommand, and
 * every secret-printing form, stays refused with a reason that says why.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { judgeCommand, extractCommands } from '../server/runner/verify.ts';
import { WatchScheduler } from '../server/watch-scheduler.ts';
import { cmdRefProblem } from '../server/watch-refs.ts';

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * WV-1 — the read-only lookups pass
 * ------------------------------------------------------------------ */

test('WV-1: a keychain lookup that prints attributes only is a command the judge accepts', () => {
  for (const command of [
    'security find-generic-password -s phase-console-npm-token',
    'security find-generic-password -s "Claude Code-credentials"',
    'security find-generic-password -a me -s demo-token',
    'security find-internet-password -s github.com',
    'security find-internet-password -s registry.npmjs.org -a me login.keychain-db',
    '/usr/bin/security find-generic-password -s demo-token',
  ]) {
    assert.equal(judgeCommand(command), null, command);
  }
});

/* ------------------------------------------------------------------ *
 * WV-2 — every secret-printing or writing form stays refused, with its reason
 * ------------------------------------------------------------------ */

test('WV-2: a form that prints the secret is refused, and the reason names the flag', () => {
  for (const command of [
    'security find-generic-password -s demo-token -w',
    'security find-generic-password -w -s demo-token',
    'security find-generic-password -g -s demo-token',
    'security find-internet-password -s github.com -g',
    'security find-generic-password -gs demo-token',
    'security find-generic-password -s demo-token -aw',
  ]) {
    const why = judgeCommand(command);
    assert.ok(why, `${command} must be refused`);
    assert.match(why!, /prints the secret/, command);
  }
});

test('WV-2: an expansion is refused — the shell, not the judge, would decide what `security` is passed', () => {
  // `$'-w'` and `$FLAG` reach `security` as `-w`; the judge reads neither.
  for (const command of [
    "security find-generic-password -s demo-token $'-w'",
    'security find-generic-password -s demo-token $FLAG',
    'security find-generic-password -s demo-token "${FLAG}"',
    'security find-generic-password -s "$SERVICE"',
  ]) {
    const why = judgeCommand(command);
    assert.ok(why, `${command} must be refused`);
    assert.match(why!, /expansion the judge cannot read/, command);
  }
  // Quotes and escapes are read through, so a quoted flag is still the flag.
  for (const command of [
    "security find-generic-password -s demo-token '-w'",
    'security find-generic-password -s demo-token -\\w',
    'security find-generic-password -s demo-token -"w"',
  ]) assert.match(judgeCommand(command) ?? '', /prints the secret/, command);
});

test('WV-2: every other security subcommand is refused, and says it is not a read-only lookup', () => {
  for (const command of [
    'security add-generic-password -s demo-token -a me',
    'security dump-keychain',
    'security dump-keychain -d login.keychain',
    'security unlock-keychain login.keychain',
    'security export -k login.keychain -o out.p12',
    'security find-certificate -a -p',
    'security -i',
    'security -q find-generic-password -s demo-token',
  ]) {
    const why = judgeCommand(command);
    assert.ok(why, `${command} must be refused`);
    assert.match(why!, /read-only keychain lookups/, command);
  }
  // The deny wall reads first: a delete is "mutates", whatever the gate says.
  const del = judgeCommand('security delete-generic-password -s demo-token');
  assert.ok(del);
  assert.match(del!, /mutates something/);
  // A bare `security` names no lookup, so it proves nothing: refused too.
  assert.match(judgeCommand('security') ?? '', /read-only keychain lookups/);
});

/* ------------------------------------------------------------------ *
 * WV-3 — the fixture's proof declares cleanly; a -w proof is refused at declaration
 * ------------------------------------------------------------------ */

/** The `proof: cmd:"…"` of the human-steps fixture's secret-entry step, as written. */
function fixtureProof(): string {
  const text = readFileSync(join(here, '..', '..', 'tests', 'fixtures', 'plans', 'human-steps.md'), 'utf8');
  const line = text.split('\n').find((l) => /secret-entry .*proof: `cmd:"security find-generic-password/.test(l));
  assert.ok(line, 'the fixture still carries its keychain proof');
  const ref = /proof: `(cmd:"[^`]+")`/.exec(line!)?.[1];
  assert.ok(ref);
  return ref!;
}

test('WV-3: the human-steps fixture\'s keychain proof declares cleanly through the real judge', async () => {
  const ref = fixtureProof();
  assert.equal(cmdRefProblem(ref.slice('cmd:"'.length, -1)), null, 'its shape is self-contained');
  let probed = 0;
  const scheduler = new WatchScheduler({
    runs: () => [],
    probe: async (t: { ref: string }) => { probed += 1; return { ref: t.ref, state: 'pending' as const, detail: 'exit 44' }; },
    onLanded: async () => 'done' as const,
    save: () => {},
    judgeCommand,
  } as never);
  try {
    const answer = await scheduler.probeDeclared('demo', 4, [ref], { budgetMs: 2_000 });
    assert.equal(answer.refs.length, 1);
    assert.notEqual(answer.refs[0].state, 'refused', answer.refs[0].detail ?? '');
    assert.equal(answer.refs[0].state, 'pending', 'asked, and not yet landed');
    assert.equal(probed, 1, 'the judge let the probe run');
  } finally { scheduler.close(); }
});

test('WV-3: a proof that would print the secret is refused at declaration, in the judge\'s words', async () => {
  const scheduler = new WatchScheduler({
    runs: () => [],
    probe: async () => { throw new Error('a refused ref is never probed'); },
    onLanded: async () => 'done' as const,
    save: () => {},
    judgeCommand,
  } as never);
  try {
    const answer = await scheduler.probeDeclared('demo', 4,
      ['cmd:"security find-generic-password -s demo-token -w"'], { budgetMs: 2_000 });
    assert.equal(answer.refs[0].state, 'refused');
    assert.match(answer.refs[0].detail ?? '', /prints the secret/);
  } finally { scheduler.close(); }
});

/* ------------------------------------------------------------------ *
 * WV-4 — the verification lane reads it the same way
 * ------------------------------------------------------------------ */

test('WV-4: a §Verification line may prove a keychain item exists, never print it', () => {
  const runs = (command: string) => extractCommands(`\`${command}\``).commands;
  const held = (command: string) => extractCommands(`\`${command}\``).notRun;
  assert.deepEqual(runs('security find-generic-password -s demo-token'), ['security find-generic-password -s demo-token']);
  assert.equal(runs('security find-generic-password -s demo-token -w').length, 0);
  assert.match(held('security find-generic-password -s demo-token -w')[0]?.reason ?? '', /prints the secret/);
});
