/**
 * The outcome's schema (measured-console phase 12, B4) — `shared/outcome-schema.js`.
 *
 * OS-1  every outcome file the bats suites make `phase-outcome.sh` write validates against
 *       `OUTCOME_FILE_SCHEMA` — the script's whole surface, run, never a copy of its JSON
 * OS-2  the schema's words are the vocabularies' own: the statuses, the run acts, the step kinds
 * OS-3  the session schema is the file less the runner's four fields, plus `none`; `--json-schema`
 *       gets it on one line, and `buildArgv` passes it
 * OS-4  a structured output becomes an outcome through `readOutcome`'s own screen; `none` and a
 *       value the schema would refuse never do
 * OS-5  structured first, the file second: one witness → it; agreeing → the file's copy (`both`);
 *       differing → the structured one, named; `none` never outranks a file
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OUTCOME_FILE_SCHEMA, OUTCOME_NONE, OUTCOME_SESSION_SCHEMA, sessionSchemaArg, validateOutcome,
} from '../shared/outcome-schema.js';
import { OUTCOME_STATUSES } from '../shared/run-lifecycle.js';
import { RUN_ACTS } from '../shared/verb-model.js';
import { HUMAN_STEP_KINDS } from '../shared/human-step-model.js';
import { outcomeFromStructured, readOutcome, reconcileOutcome, type PhaseOutcome } from '../server/runner/outcome.ts';
import { buildArgv } from '../server/runner/spawn.ts';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'phase-outcome.sh');
const UNIT = join(REPO, 'tests', 'unit');

/** Every `run pe_outcome …` invocation in the bats suites, continuation lines joined. */
function batsInvocations(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(UNIT).filter((name) => name.endsWith('.bats'))) {
    const lines = readFileSync(join(UNIT, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].trim();
      if (!head.startsWith('run pe_outcome ')) continue;
      let call = head.slice('run '.length);
      while (call.endsWith('\\') && i + 1 < lines.length) call = `${call.slice(0, -1)} ${lines[++i].trim()}`;
      out.push(call);
    }
  }
  return out;
}

test('OS-1 every outcome file the bats suites make the script write validates against the file schema', () => {
  const calls = batsInvocations();
  assert.ok(calls.length >= 100, `the bats suites declare ${calls.length} invocations`);
  const dir = mkdtempSync(join(tmpdir(), 'pc-outcome-schema-'));
  try {
    // One bash for the lot: each case gets its own directory and outcome file, the
    // bats helper's environment, and its own subshell, so an exit or a `cd` stays there.
    const body = calls.map((call, i) => [
      `( export BATS_TEST_TMPDIR="$ROOT/${i}" PE_OUTCOME_FILE="$ROOT/${i}/outcome.json"`,
      `  export XDG_STATE_HOME="$ROOT/${i}/state" DOCS_ROOT="$ROOT/${i}/work"`,
      `  mkdir -p "$DOCS_ROOT"; cd "$BATS_TEST_TMPDIR"`,
      `  ${call} ) </dev/null >/dev/null 2>&1`,
    ].join('\n')).join('\n');
    const script = join(dir, 'cases.sh');
    writeFileSync(script, [
      'set +e',
      `ROOT=${JSON.stringify(dir)}`,
      'unset PE_SCOPE PE_OWNER PE_SESSION_ID CLAUDE_CODE_SESSION_ID PE_RULINGS_FILE PE_TASKS_FILE PE_MESSAGES_FILE PE_MSG_TOKEN',
      'unset PE_ISSUES_FILE PE_TRACE_ID PE_SPAN_ID TRACEPARENT PE_PROOFS_FILE PE_HANDLED_FILE PE_RUN_ID PE_LOCK_MIRROR',
      'export PHASE_OUTCOME_PROBE=0 PE_NOW="2026-08-10T21:10:03Z"',
      `pe_outcome() { /bin/bash ${JSON.stringify(SCRIPT)} "$@"; }`,
      ...calls.map((_, i) => `mkdir -p "$ROOT/${i}"`),
      body,
    ].join('\n'));
    execFileSync('/bin/bash', [script], { stdio: 'ignore', timeout: 300_000 });
    let written = 0;
    const bad: string[] = [];
    calls.forEach((call, i) => {
      const file = join(dir, String(i), 'outcome.json');
      if (!existsSync(file)) return; // a refusal (exit 2), a ruling, a proof: no outcome file
      written += 1;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { bad.push(`${call}\n  not JSON`); return; }
      const problems = validateOutcome(parsed, OUTCOME_FILE_SCHEMA);
      if (problems.length) bad.push(`${call}\n  ${problems.join('\n  ')}`);
    });
    assert.ok(written >= 40, `only ${written} of ${calls.length} invocations wrote an outcome file`);
    assert.deepEqual(bad, [], 'every outcome file the script writes is the schema’s shape');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OS-2 the schema speaks the vocabularies’ own words', () => {
  const p = OUTCOME_FILE_SCHEMA.properties as Record<string, any>;
  assert.deepEqual(p.status.enum, [...OUTCOME_STATUSES]);
  assert.deepEqual(p.run_act.enum, [...RUN_ACTS]);
  assert.deepEqual(p.step.properties.kind.enum, [...HUMAN_STEP_KINDS]);
  assert.deepEqual(validateOutcome({ version: 1, slug: 's', phase: 1, status: 'done', watch: [], written_at: 'x' }, OUTCOME_FILE_SCHEMA),
    ['$.status: not one of ' + OUTCOME_STATUSES.join(', ')]);
  assert.match(validateOutcome({ version: 1, slug: 's', phase: 1, status: 'partial', watch: [], written_at: 'x', extra: 1 },
    OUTCOME_FILE_SCHEMA).join(), /extra: not a field/);
});

test('OS-3 the session schema is the file less the runner’s four, plus none; buildArgv passes it', () => {
  const file = Object.keys(OUTCOME_FILE_SCHEMA.properties);
  const session = Object.keys(OUTCOME_SESSION_SCHEMA.properties);
  assert.deepEqual(file.filter((key) => !session.includes(key)).sort(), ['phase', 'slug', 'version', 'written_at']);
  assert.deepEqual(session.filter((key) => !file.includes(key)), []);
  assert.deepEqual((OUTCOME_SESSION_SCHEMA.properties as any).status.enum, [...OUTCOME_STATUSES, OUTCOME_NONE]);
  assert.deepEqual(OUTCOME_SESSION_SCHEMA.required, ['status']);
  const arg = sessionSchemaArg();
  assert.ok(!arg.includes('\n'));
  assert.deepEqual(JSON.parse(arg), JSON.parse(JSON.stringify(OUTCOME_SESSION_SCHEMA)));
  const argv = buildArgv({ prompt: 'x', cwd: '/tmp', jsonSchema: arg });
  assert.equal(argv[argv.indexOf('--json-schema') + 1], arg);
  assert.ok(!buildArgv({ prompt: 'x', cwd: '/tmp' }).includes('--json-schema'), 'only a session that can declare gets it');
});

const AT = '2026-10-25T10:00:00.000Z';
const EXPECT = { slug: 'demo', phase: 8, at: AT };

test('OS-4 a structured output becomes an outcome through readOutcome’s own screen', () => {
  const made = outcomeFromStructured({ status: 'waiting-external', reason: 'gate', watch: ['cmd:"test -f /tmp/x"'] }, EXPECT);
  assert.ok(made && made !== 'none');
  assert.equal(made.version, 1);
  assert.equal(made.slug, 'demo');
  assert.equal(made.phase, 8);
  assert.equal(made.written_at, AT);
  assert.deepEqual(made.watch, ['cmd:"test -f /tmp/x"']);
  assert.equal(outcomeFromStructured({ status: OUTCOME_NONE }, EXPECT), 'none');
  assert.equal(outcomeFromStructured({ status: 'finished' }, EXPECT), null, 'a word the schema refuses');
  assert.equal(outcomeFromStructured({ status: 'partial', slug: 'other' }, EXPECT), null, 'the runner’s fields are not the session’s');
  assert.equal(outcomeFromStructured('complete', EXPECT), null);
  // A step the reader would drop is dropped here too: kind unknown → no step, no outcome.
  assert.equal(outcomeFromStructured({ status: 'needs-human', needs: 'credential', step: { kind: 'typo', title: 'x' } }, EXPECT), null);
  // …and the file reader is the same screen: a file of the same shape reads the same.
  const dir = mkdtempSync(join(tmpdir(), 'pc-outcome-schema-read-'));
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'o.json');
    writeFileSync(path, JSON.stringify({ ...made }));
    assert.deepEqual(readOutcome(path, { slug: 'demo', phase: 8 }), made);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function outcome(status: PhaseOutcome['status'], extra: Partial<PhaseOutcome> = {}): PhaseOutcome {
  return { version: 1, slug: 'demo', phase: 8, status, watch: [], written_at: AT, ...extra };
}

test('OS-5 structured first, the file second', () => {
  assert.deepEqual(reconcileOutcome(null, null), { outcome: null, via: null });
  const said = outcome('partial', { reason: 'context' });
  assert.deepEqual(reconcileOutcome(said, null), { outcome: said, via: 'structured' });
  const file = outcome('needs-human', { needs: 'credential', step: { kind: 'browser-login', title: 'Sign in' } as never });
  assert.deepEqual(reconcileOutcome(null, file), { outcome: file, via: 'file' });
  // Agreeing on the word: the file's richer copy, step and all.
  const echo = outcome('needs-human', { needs: 'credential' });
  assert.deepEqual(reconcileOutcome(echo, file), { outcome: file, via: 'both' });
  // Differing: the structured one, and both words named.
  assert.deepEqual(reconcileOutcome(said, file), {
    outcome: said, via: 'structured', disagreed: { structured: 'partial', file: 'needs-human:credential' },
  });
  // `none` never outranks a word — but the disagreement is still named.
  assert.deepEqual(reconcileOutcome('none', file), {
    outcome: file, via: 'file', disagreed: { structured: OUTCOME_NONE, file: 'needs-human:credential' },
  });
  assert.deepEqual(reconcileOutcome('none', null), { outcome: null, via: null });
});

/* ------------------------------------------------------------------ *
 * OS-6 — the runner: the schema rides every declaring session, and a
 * structured word the file contradicts is journalled and acted on
 * ------------------------------------------------------------------ */

test('OS-6 a declaring session is given the schema; a differing file journals phase.outcome-disagreed and the structured word routes', async () => {
  const { Runner } = await import('../server/runner/runner.ts');
  const { journalFile } = await import('../server/runner/run-paths.ts');
  const root = mkdtempSync(join(tmpdir(), 'pc-outcome-schema-run-'));
  try {
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
    writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) echo "done: "; echo "in-progress: "; echo "stuck: "; echo "ready: 1"; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
    writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
    const REF = 'date:2099-01-01T00:00:00Z';
    const asked: { jsonSchema?: string }[] = [];
    let spawns = 0;
    const runner = new Runner({
      scriptsDir,
      spawn: async (req: { env?: Record<string, string>; jsonSchema?: string }) => {
        asked.push({ jsonSchema: req.jsonSchema });
        spawns += 1;
        if (spawns === 1) {
          writeFileSync(req.env!.PE_OUTCOME_FILE, JSON.stringify({
            version: 1, slug: 'demo', phase: 1, status: 'blocked', needs: 'external', reason: 'from the file',
            watch: [REF], written_at: new Date().toISOString(),
          }));
        }
        return {
          signal: { subtype: 'success' as const, code: 0, text: 'done' },
          sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
          structuredOutput: { status: 'waiting-external', reason: 'from the schema', watch: [REF] },
        };
      },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root, autonomy: 'keep-going', maxConsecutiveFailures: 3 } as never);
    await runner.wait();
    assert.equal(asked[0]?.jsonSchema, sessionSchemaArg(), 'the phase session is given the session schema');
    const lines = readFileSync(journalFile(root, state.slug, state.id), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; phase?: number; data: Record<string, unknown> });
    const disagreed = lines.find((l) => l.event === 'phase.outcome-disagreed' && l.phase === 1);
    assert.deepEqual(disagreed?.data, { structured: 'waiting-external', file: 'blocked:external', chose: 'structured' });
    const said = lines.find((l) => l.event === 'phase.outcome' && l.phase === 1);
    assert.equal(said?.data.via, 'structured');
    assert.equal(said?.data.status, 'waiting-external');
    assert.equal(state.phases['1'].declared?.status, 'waiting-external', 'the structured word is the one acted on');
    assert.equal(state.phases['1'].status, 'waiting');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
