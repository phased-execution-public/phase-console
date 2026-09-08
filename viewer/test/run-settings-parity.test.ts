/**
 * The accepted-fields list and the door that accepts them, held together.
 *
 * Phase 4 made both run doors 400 on a field they do not understand instead of
 * dropping it. That fixed the SERVER's half. The other half is the form: a
 * field the route accepts and no control can send is a capability nobody can
 * reach, and a field the form sends that the route never reads is a control
 * that silently does nothing. Neither shows up in a type check, because a
 * request body is `unknown` on the wire.
 *
 * So this suite reads `server/api/routes.ts` as TEXT — the two `case` blocks,
 * every `body.<field>` and `'<field>' in body` inside them — and holds that
 * set equal to `shared/run-settings.js`. The client's zod schema is built from
 * the same module (`features/run-setup/schema.ts`, pinned by
 * `schema-parity.test.ts` on the vitest side), so all three agree or this
 * fails.
 *
 * Reading source text is deliberate and not a shortcut. The alternative is
 * importing the route module and probing it with real requests, which pins
 * behaviour rather than vocabulary — and the failure mode here is a field
 * nobody wired, which a behaviour probe cannot see because nobody wrote the
 * probe either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AGENT_TICKET_FIELDS,
  PHASE_OPTION_FIELDS,
  RUN_SETTINGS_FIELDS,
  RUN_START_FIELDS,
  START_ONLY_FIELDS,
} from '../shared/run-settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = readFileSync(join(HERE, '..', 'server', 'api', 'routes.ts'), 'utf8');
const AGENT = readFileSync(join(HERE, '..', 'server', 'agent.ts'), 'utf8');

/**
 * The body of one `case '<verb>': {` block, to its matching closing brace.
 *
 * Brace counting rather than a regex to the next `case`, because the block
 * contains object literals, template strings and nested switches — and a
 * regex that stopped at the first `}` would silently read a third of the door
 * and call the rest of the fields missing.
 */
function braceBlock(source: string, opener: string, what: string): string {
  const start = source.indexOf(opener);
  assert.ok(start >= 0, `no \`${opener}\` in routes.ts — did ${what} move?`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after \`${opener}\``);
}

/**
 * A function's body — the block after its parameter list AND its return type.
 *
 * `braceBlock` takes the first `{` after the opener, which for a function
 * whose return type is an inline object literal (`): { ok: true; … } | X {`)
 * is the TYPE's brace: the block it returns ends before the body opens, reads
 * no `body.*`, and a coverage loop over it never runs. (P14 QA round 1, High —
 * the ticket-door test passed with every field removed.) This skips the
 * parameter list, then walks to the first `{` at depth 0 whose previous
 * non-blank character is `)` or `}` — the body — and returns that block.
 */
function functionBody(source: string, opener: string, what: string): string {
  const start = source.indexOf(opener);
  assert.ok(start >= 0, `no \`${opener}\` — did ${what} move?`);
  // The parameter list: from the opener's own `(` to its matching `)`.
  let i = start + opener.length - 1;
  assert.equal(source[i], '(', `${what}'s opener must end with its parameter list's \`(\``);
  let parens = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') { parens -= 1; if (parens === 0) break; }
  }
  // Then the body brace: the first `{` at depth 0 that is not in a TYPE
  // position. A type's brace follows `:`, `|`, `&`, `(`, `,`, `<`, `=` or an
  // arrow (`=>`); the body's follows `)` (no return type), `}` (an object type
  // just closed), an identifier (`| AgentRefusal {`) or a generic's `>`.
  let depth = 0;
  let bodyStart = -1;
  for (i += 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) {
        let j = i - 1;
        while (j >= 0 && /\s/.test(source[j])) j -= 1;
        const prev = source[j];
        const typeBrace = ':|&(,<='.includes(prev) || (prev === '>' && source[j - 1] === '=');
        if (!typeBrace) { bodyStart = i; break; }
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    }
  }
  assert.ok(bodyStart >= 0, `no body found for ${what}`);
  depth = 0;
  for (i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(bodyStart, i + 1); }
  }
  throw new Error(`unbalanced braces in ${what}`);
}

const caseBlock = (source: string, verb: string): string =>
  braceBlock(source, `case '${verb}': {`, `the \`${verb}\` door`);

/** Every field name the block reads off the request body, either spelling. */
function fieldsRead(block: string): Set<string> {
  const found = new Set<string>();
  for (const [, name] of block.matchAll(/\bbody\.([A-Za-z_$][\w$]*)/g)) found.add(name);
  for (const [, name] of block.matchAll(/'([A-Za-z_$][\w$]*)'\s+in\s+body/g)) found.add(name);
  return found;
}

/** Not settings: the audit attribution the route stamps on a patch. */
const NOT_A_SETTING = new Set(['by']);

test('shared/run-settings.js lists exactly what POST /start reads', () => {
  const read = fieldsRead(caseBlock(ROUTES, 'start'));
  const declared = new Set(RUN_START_FIELDS);
  for (const name of read) {
    if (NOT_A_SETTING.has(name)) continue;
    assert.ok(declared.has(name), `\`start\` reads body.${name}, which RUN_START_FIELDS does not list`);
  }
  for (const name of declared) {
    assert.ok(read.has(name), `RUN_START_FIELDS lists "${name}", which \`start\` never reads`);
  }
});

test('shared/run-settings.js lists exactly what POST /settings reads', () => {
  const read = fieldsRead(caseBlock(ROUTES, 'settings'));
  const declared = new Set(RUN_SETTINGS_FIELDS);
  for (const name of read) {
    if (NOT_A_SETTING.has(name)) continue;
    assert.ok(declared.has(name), `\`settings\` reads body.${name}, which RUN_SETTINGS_FIELDS does not list`);
  }
  for (const name of declared) {
    assert.ok(read.has(name), `RUN_SETTINGS_FIELDS lists "${name}", which \`settings\` never reads`);
  }
});

test('the start-only fields are the four a patch must never carry', () => {
  // Named rather than merely derived: this is the sentence the form's `live`
  // mode obeys, and a silent change to it would let a settings sheet try to
  // mint a run, flip a plan's QA gate, or retroactively unstart a run.
  //
  // `startAfter` joined the three in console-concurrent-plans P17. A chain
  // says where a run BEGINS, and a run already mid-plan cannot un-begin: the
  // settings door reading one would either do nothing or claim to.
  assert.deepEqual([...START_ONLY_FIELDS].sort(), ['accountId', 'qa', 'resumeRunId', 'startAfter']);
});

test('PHASE_OPTION_FIELDS matches the route filter that keeps a phase honest', () => {
  // `onePhaseOptions()` in the route builds ONE phase's object key by key; the
  // set it builds is the set a per-phase row may offer. It was the body of
  // `phaseOptions()` until Retry-with-edits needed exactly this table for a
  // single phase — the anchor follows the coercer, because the coercer is what
  // this gate is about. A second copy of it is what would break the gate; a
  // rename is not.
  const filter = braceBlock(ROUTES, 'function onePhaseOptions(', 'the per-phase filter');
  for (const name of PHASE_OPTION_FIELDS) {
    assert.ok(
      filter.includes(`${name}:`) || filter.includes(`'${name}'`) || filter.includes(`.${name}`),
      `PHASE_OPTION_FIELDS lists "${name}", which the route's phaseOptions() never keeps`,
    );
  }
});

test('AGENT_TICKET_FIELDS covers what the ticket door reads', () => {
  // A looser pin than the run doors on purpose: the ticket's fields are read
  // in two places — the route resolves the ones that need the Service (the
  // recovery and QA briefings, the account), `buildAgentLaunch` validates the
  // rest — so this asserts COVERAGE (nothing a launch sends is unlisted)
  // rather than equality.
  //
  // The anchor used to be `ROUTES.indexOf("head === 'agent'")`, and there has
  // never been a `head === 'agent'` in `routes.ts`: the door is
  // `POST /api/terminal` with `kind: 'claude'`. `indexOf` answered -1,
  // `slice(-1)` took the file's last character, the inner `indexOf` answered
  // -1 too, and the loop ran over an empty set — so this test passed on every
  // field anyone ever failed to list, including `brief`. It now reads the
  // ticket's own validator, which is the file that decides what a field means.
  const validator = functionBody(AGENT, 'export function buildAgentLaunch(', 'the ticket validator');
  const read = fieldsRead(validator);
  // The scan must have reached the body: a validator that reads nothing off
  // the ticket is not this function. (Round 1 found the loop below running
  // over an empty set, because the block ended before the body opened.)
  assert.ok(read.size >= 5, `the validator body reads ${read.size} fields — the scan missed the body`);
  const declared = new Set(AGENT_TICKET_FIELDS);
  for (const name of read) {
    assert.ok(declared.has(name), `the agent ticket reads body.${name}, unlisted in AGENT_TICKET_FIELDS`);
  }
});
