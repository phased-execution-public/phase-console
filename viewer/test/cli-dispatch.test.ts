/**
 * Every verb the CLI takes reaches the CLI — never `../start` (#359).
 *
 * `bin/phase-console` is a bash wrapper: a verb on its lists is exec'd into
 * `phase-console.mjs`, and anything else falls through to `../start`, which
 * reads a bare first argument as a REPOSITORY PATH and boots a console on it.
 * So a verb the .mjs learns and the wrapper's list does not is not an error
 * message — it is a console started on a directory named after the verb. That
 * happened to `stop` (the wrapper's own header), to `uninstall-skill`,
 * `uninstall-hooks` and `hooks-status`, and on 2026-10-14 to `fleet`: the form
 * the docs tell an operator to type, `phase-console fleet status`, registered and
 * started an instance called `fleet` on port 4223.
 *
 * Hence no list in this file. The verbs are READ out of the .mjs — every
 * `args[0] === '…'`, every `[…].includes(args[0])`, the FLAG_VERBS and
 * WORD_VERBS tables and the free bin's FLEET_VERBS — and the wrapper itself is
 * RUN against each one in a sandbox whose `phase-console.mjs` and `start` are
 * stubs that say which of them was reached. A verb added to the .mjs and not to
 * the wrapper fails here by name.
 *
 * Both editions. In the Pro tree the wrapper is run as it stands against the Pro
 * bin's verbs, and again with its `!pro:` regions stripped against the free
 * override's (`free/overrides/bin/phase-console.mjs`), whose fleet verbs must be
 * refused by name — by the wrapper or by the free bin, never by a boot. In the
 * free tree the wrapper is already stripped and `bin/phase-console.mjs` IS the
 * free bin, so the free half alone runs, on that tree's own files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

const FREE_OVERRIDE = 'free/overrides/bin/phase-console.mjs';
const IS_PRO_TREE = existsSync(join(REPO, FREE_OVERRIDE));
const FREE_BIN = IS_PRO_TREE ? FREE_OVERRIDE : 'bin/phase-console.mjs';

/** Every first argument a phase-console.mjs dispatches on, read out of its source. */
export function verbsOf(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/args\[0\] === '([^']+)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/\[([^\]]*)\]\.includes\(args\[0\]\)/g)) {
    for (const w of m[1].matchAll(/'([^']+)'/g)) out.add(w[1]);
  }
  for (const m of src.matchAll(/const (?:FLAG_VERBS|WORD_VERBS) = \{([\s\S]*?)\};/g)) {
    for (const k of m[1].matchAll(/(?:^|[\s,{])'?([a-z-]+)'?\s*:/g)) out.add(k[1]);
  }
  return [...out].sort();
}

/** The free bin's own refusals: what it answers "that is Pro" to, by name. */
function freeRefusedVerbs(src: string): string[] {
  const m = src.match(/const FLEET_VERBS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, `${FREE_BIN}: no FLEET_VERBS set found — did it move?`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((w) => w[1]);
}

/** The wrapper with its `!pro:` regions dropped, whole lines, as the free build drops them. */
function stripPro(text: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.includes('!pro:start')) { inside = true; continue; }
    if (line.includes('!pro:end')) { inside = false; continue; }
    if (!inside) out.push(line);
  }
  return out.join('\n');
}

type Reached = { status: number | null; stdout: string; stderr: string };

/**
 * A sandbox holding the wrapper as given, a stub `.mjs` that prints `MJS <args>`
 * and a stub `start` that prints `START <args>`; `run(arg)` runs the wrapper.
 */
function sandbox(wrapper: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-dispatch-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'phase-console'), wrapper);
  chmodSync(join(dir, 'bin', 'phase-console'), 0o755);
  writeFileSync(join(dir, 'bin', 'phase-console.mjs'), "process.stdout.write('MJS ' + process.argv.slice(2).join(' '));\n");
  writeFileSync(join(dir, 'start'), '#!/bin/bash\necho "START $*"\n');
  chmodSync(join(dir, 'start'), 0o755);
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  return {
    run(...args: string[]): Reached {
      // From the sandbox, so no argument that happens to name a directory here is one.
      const r = spawnSync('/bin/bash', [join(dir, 'bin', 'phase-console'), ...args], { cwd: dir, env, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    done() { rmSync(dir, { recursive: true, force: true }); },
  };
}

if (IS_PRO_TREE) {
  test('the Pro wrapper hands every verb of the Pro bin to the bin, never to ../start (#359)', () => {
    const verbs = verbsOf(read('bin/phase-console.mjs'));
    // The extraction itself is what this test stands on; an empty read would pass vacuously.
    for (const known of ['fleet', 'doctor', 'stop', 'accounts', 'profile']) {
      assert.ok(verbs.includes(known), `the verb reader lost '${known}' — it read: ${verbs.join(' ')}`);
    }
    const box = sandbox(read('bin/phase-console'));
    try {
      const missed: string[] = [];
      for (const verb of verbs) {
        const r = box.run(verb, 'status');
        if (!r.stdout.startsWith(`MJS ${verb} status`)) missed.push(`${verb} → ${(r.stdout || r.stderr).trim().split('\n')[0]}`);
      }
      assert.deepEqual(missed, [], `bin/phase-console sent these verbs somewhere other than phase-console.mjs:\n  ${missed.join('\n  ')}`);
    } finally {
      box.done();
    }
  });

  test('the documented fleet form reaches the fleet verb (#359)', () => {
    const box = sandbox(read('bin/phase-console'));
    try {
      const r = box.run('fleet', 'status');
      assert.equal(r.status, 0);
      assert.equal(r.stdout, 'MJS fleet status');
    } finally {
      box.done();
    }
  });
}

test('the free wrapper hands every free verb to the bin and refuses every Pro one by name — none boots a console (#359)', () => {
  const freeSrc = read(FREE_BIN);
  const verbs = verbsOf(freeSrc);
  const refused = freeRefusedVerbs(freeSrc);
  for (const known of ['doctor', 'sessions', 'run', 'mcp']) {
    assert.ok(verbs.includes(known), `the verb reader lost '${known}' from ${FREE_BIN} — it read: ${verbs.join(' ')}`);
  }
  assert.ok(refused.length >= 5, `expected the free bin's FLEET_VERBS, found ${refused.length}`);
  const box = sandbox(stripPro(read('bin/phase-console')));
  try {
    const booted: string[] = [];
    for (const verb of [...verbs, ...refused]) {
      if (verb === 'start') continue; // the one verb that means "run the console", below
      const r = box.run(verb, 'status');
      const toBin = r.stdout.startsWith(`MJS ${verb}`);
      const refusedByName = r.status === 2 && r.stderr.includes('Phase Console Pro');
      if (!toBin && !refusedByName) booted.push(`${verb} → ${(r.stdout || r.stderr).trim().split('\n')[0]}`);
    }
    assert.deepEqual(booted, [], `the free wrapper sent these verbs to ../start:\n  ${booted.join('\n  ')}`);

    // `start` with one console is not a fleet verb: the word is dropped and the console runs.
    assert.equal(box.run('start', '--no-open').stdout.trim(), 'START --no-open');
  } finally {
    box.done();
  }
});

test('a path and a capability switch still reach ../start in both editions', () => {
  const wrappers = IS_PRO_TREE ? [read('bin/phase-console'), stripPro(read('bin/phase-console'))] : [read('bin/phase-console')];
  for (const wrapper of wrappers) {
    const box = sandbox(wrapper);
    try {
      assert.equal(box.run('/tmp/some-repo').stdout.trim(), 'START /tmp/some-repo');
      assert.equal(box.run('--allow-writes', '--no-open').stdout.trim(), 'START --allow-writes --no-open');
      assert.equal(box.run().stdout.trim(), 'START');
    } finally {
      box.done();
    }
  }
});

/**
 * `./start` itself (measured-console phase 13, #385's residual). The wrapper
 * above hands every verb to the bin, but `./start` is also run directly — from
 * a clone, from a launcher, from a Your-turn card a person copies — and there a
 * bare first argument was read as a REPOSITORY PATH whatever it was:
 * `./start run clear-streak …` booted a console on `<cwd>/run`, held the
 * terminal and registered an instance called `run`. A bare first argument that
 * is not a directory is now refused, naming every verb, and boots nothing.
 */
function startBox(startSrc: string) {
  const dir = mkdtempSync(join(tmpdir(), 'start-bare-'));
  mkdirSync(join(dir, 'viewer'));
  mkdirSync(join(dir, 'a-repo'));
  writeFileSync(join(dir, 'start'), startSrc);
  chmodSync(join(dir, 'start'), 0o755);
  writeFileSync(join(dir, 'viewer', 'run'), '#!/bin/bash\necho "RUN $*"\n');
  chmodSync(join(dir, 'viewer', 'run'), 0o755);
  return {
    dir,
    run(...args: string[]): Reached {
      const r = spawnSync('/bin/bash', [join(dir, 'start'), ...args], { cwd: dir, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    done() { rmSync(dir, { recursive: true, force: true }); },
  };
}

test('./start refuses a bare first argument that is no directory, naming the verbs — it boots nothing (#385)', () => {
  const editions: Array<[string, string]> = IS_PRO_TREE
    ? [[read('start'), 'bin/phase-console.mjs'], [stripPro(read('start')), FREE_BIN]]
    : [[read('start'), 'bin/phase-console.mjs']];
  for (const [src, bin] of editions) {
    const box = startBox(src);
    try {
      const r = box.run('run', 'clear-streak', 'demo');
      assert.equal(r.status, 2, `./start run … exited ${r.status}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, '', 'nothing reached viewer/run');
      assert.match(r.stderr, /'run' is not a directory/);
      // Every word verb of this edition's bin is named, so a person finds the one they meant.
      const missing = verbsOf(read(bin)).filter((verb) => !verb.startsWith('-') && !new RegExp(`(^|\\s)${verb}(\\s|$)`, 'm').test(r.stderr));
      assert.deepEqual(missing, [], `./start's refusal (against ${bin}) does not name: ${missing.join(' ')}`);
      // A directory, a path and a switch still start the console.
      assert.equal(box.run('a-repo').stdout.trim(), 'RUN --root a-repo');
      assert.equal(box.run(box.dir, '--no-open').stdout.trim(), `RUN --root ${box.dir} --no-open`);
      assert.equal(box.run('--allow-writes').stdout.trim(), 'RUN --allow-writes');
      assert.equal(box.run().stdout.trim(), 'RUN');
    } finally {
      box.done();
    }
  }
});
