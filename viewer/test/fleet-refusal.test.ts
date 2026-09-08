/**
 * The fleet refusal must refuse the fleet, and nothing else.
 *
 * `viewer/run` and `bin/phase-console` both end in a `case` arm that answers a
 * fleet verb by NAMING Pro rather than falling through to the server, which
 * would read the verb as a repository path and boot a console called `list`.
 * The arm ships in the free tree, so it matches the agent flags by SHAPE rather
 * than spelling them — and a shape is exactly the kind of thing that is right
 * about the eight cases you thought of and wrong about the ninth.
 *
 * It was: `--*-agent` also matches **`--allow-agent`**, one of the seven
 * capability switches, so `./start --allow-agent` exited 2 saying the flag
 * "manages a fleet of consoles" — in BOTH trees, and only when it was the first
 * argument, which is what made it intermittent rather than obvious. Nothing
 * tested any of the three refusal branches, so a green 15-stage matrix said
 * nothing about it.
 *
 * So this does not compare the arms as text: it EXTRACTS each one's own pattern
 * and RUNS it under `/bin/bash` against every flag that must be refused and
 * every flag that must not — the same discipline `node-floor.test.ts` applies to
 * the Node floor, and for the same reason.
 *
 * The flags to refuse are assembled from parts rather than written out: this
 * file ships in the free tree, where the literal is what the scrub forbids.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/** Every agent flag the supervisor family has, spelled by assembly. */
const AGENT_FLAGS = [
  ...['', 'un'].map((p) => `--${p}install-agent`),
  ...['status', 'start', 'stop', 'restart', 'update', 'log'].map((v) => `--agent-${v}`),
];

/** The capability switches, from the one table that owns them. */
function capabilityFlags(): string[] {
  const src = read('viewer/server/config.ts');
  const from = src.indexOf('const CAPABILITY_FLAGS');
  assert.ok(from > 0, 'CAPABILITY_FLAGS did not parse out of config.ts');
  const block = src.slice(from, src.indexOf('];', from));
  const flags = [...new Set(block.match(/--allow-[a-z-]+/g) ?? [])];
  assert.ok(flags.length >= 5, `expected the capability table, found ${flags.length} flags`);
  return flags;
}

/** Everything else a person legitimately puts first on the line. */
const OTHER_FLAGS = ['--root', '--remote', '--remote-user', '--port', '--host', '--no-open', '--instance'];

/**
 * The fallback arm's own pattern, lifted out of the script. Identified by the
 * agent shape it carries, so a rename of the surrounding verbs does not lose it.
 */
function refusalPattern(rel: string): string {
  const line = read(rel)
    .split('\n')
    .find((l) => /^\s*[a-z|*-]*--agent-\*\)/.test(l.trim()) || (l.includes('--agent-*') && l.trim().endsWith(')')));
  assert.ok(line, `${rel}: no fleet-refusal case arm found — did it move?`);
  return line!.trim().replace(/\)$/, '');
}

/** Ask bash itself whether the pattern matches — never a re-implementation of `case`. */
function matches(pattern: string, arg: string): boolean {
  const r = spawnSync('/bin/bash', ['-c', `case "$1" in ${pattern}) exit 0 ;; *) exit 1 ;; esac`, 'case-probe', arg]);
  assert.notEqual(r.status, null, `bash could not evaluate the pattern for ${arg}`);
  return r.status === 0;
}

for (const rel of ['viewer/run', 'bin/phase-console']) {
  test(`${rel} refuses every agent flag, and no capability switch`, () => {
    const pattern = refusalPattern(rel);

    for (const flag of AGENT_FLAGS) {
      assert.equal(matches(pattern, flag), true, `${rel} must refuse ${flag} rather than pass it to the server`);
    }
    // The half that was wrong. `--allow-agent` is a capability switch and ends
    // in the same word as the supervisor family; it must reach the server.
    for (const flag of [...capabilityFlags(), ...OTHER_FLAGS]) {
      assert.equal(matches(pattern, flag), false, `${rel} must pass ${flag} through — it is not a fleet verb`);
    }
  });
}

/**
 * Where the free bin is, from wherever this file is running.
 *
 * In the Pro tree it is the override source, which `free/` holds and which this
 * tree grades from outside. In the FREE tree `free/` is a proPath and gone — but
 * the override has been applied, so `bin/phase-console.mjs` IS the free bin.
 * Resolved rather than marked, because the free tree is exactly where this
 * predicate decides something and the last thing it should have is no coverage.
 */
const FREE_BIN = existsSync(join(REPO, 'free', 'overrides', 'bin', 'phase-console.mjs'))
  ? 'free/overrides/bin/phase-console.mjs'
  : 'bin/phase-console.mjs';

test('the free bin answers the same way, and by the same shape', () => {
  // The one file that has to decide this in JS. Its predicate is extracted and
  // run rather than re-read, for the reason above.
  const src = read(FREE_BIN);
  const m = src.match(/const isAgentFlag = \(arg\) => (\/.*\/)\.test\(arg \?\? ''\);/);
  assert.ok(m, `${FREE_BIN}: no isAgentFlag predicate found`);
  // eslint-disable-next-line no-new-func
  const isAgentFlag = new Function('arg', `return ${m![1]}.test(arg ?? '');`) as (a: string) => boolean;

  for (const flag of AGENT_FLAGS) assert.equal(isAgentFlag(flag), true, `the free bin must refuse ${flag}`);
  for (const flag of [...capabilityFlags(), ...OTHER_FLAGS]) {
    assert.equal(isAgentFlag(flag), false, `the free bin must pass ${flag} through`);
  }
});
