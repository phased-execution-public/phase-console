/**
 * The interface stamp, held to the scripts (measured-console phase 3).
 *
 * `scripts/skill-api.env`'s `PE_API` is the interface the skill's scripts speak, and a run refuses to
 * start when the console's half and the skill's half do not meet (`skillApiVerdict`). The stamp was
 * hand-maintained and drifted: `--run-act` shipped with no bump, so a 7.1 skill against a 7.0 console
 * passed the stamp and failed at exit 2. This ratchet makes the bump mechanical: every session-facing
 * script's interface — the flags its case arms implement, the flag and `a|b|c` vocabulary its `usage()`
 * prints, and for the engine the `--help` table's first two columns — is digested, and the digests are
 * recorded below beside the `PE_API` they were taken at. A digest that moves while `PE_API` stays fails,
 * naming the script; raise `PE_API`, then re-record the lines the failure prints. One bump covers a
 * series: while `PE_API` is above the stamp the last release shipped (`RELEASED_API`), a moved digest
 * still fails, but asks only for the re-record — the release that ships the series moves `RELEASED_API`.
 *
 * Exempt: the scripts `references/scripts.md` lists under §For maintainers — a session is told never to
 * run them, so their flags are no part of the skill's interface.
 *
 * Editions: the free tree is the Pro tree with every `!pro:` region dropped and the Pro-only scripts
 * gone, so the free digests are taken over that view in both trees, and the Pro digests — the whole
 * text — are recorded inside a Pro region the free build strips.
 */
import './state-sandbox.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSkillApi } from '../server/skill-copy.ts';
import { scriptFlags } from './script-flags.ts';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPTS = join(REPO, 'scripts');

/** The `PE_API` the digests below were recorded at. */
const RECORDED_API = 3;

/** The `PE_API` the last release shipped (8.0.0). A release that ships a higher one moves this. */
const RELEASED_API = 2;

/** Each script's interface digest over the FREE view (every `!pro:` region dropped). */
const RECORDED_FREE: Record<string, string> = {
  'amend-plan.sh': '46e04f011c07',
  'close-plan.sh': 'b02f22ffc181',
  'cmd-ref.sh': '0d47fe7cac7c',
  'decisions.sh': '16935e79d4ff',
  'gate-approve.sh': '5c94755a8ce5',
  'handoff-status.sh': '0d47fe7cac7c',
  'instance.sh': '0d47fe7cac7c',
  'new-handoff.sh': 'f0c0d4028de1',
  'new-plan.sh': '0d47fe7cac7c',
  'next-phase-prompt.sh': '92d6e303d3fe',
  'phase-graph.sh': '4b841e57d891',
  'phase-landing.sh': '792a29963c22',
  'phase-lane.sh': '1d0013638c8f',
  'phase-lock.sh': '8a9a32d73c76',
  'phase-outcome.sh': 'c1d40053e310',
  'phase-tasks.sh': 'c5232af146c0',
  'qa-mode.sh': '92d6e303d3fe',
  'qa-record.sh': 'f52edc5b9f85',
  'repair-artefacts.sh': '22b33b6a2b7d',
  'scope.sh': '0d47fe7cac7c',
  'session-hook.sh': '0d47fe7cac7c',
  'guard-hook.sh': '0d47fe7cac7c',
  'validate.sh': '0d47fe7cac7c',
  'wait-budget.sh': '4ac159e24bd3',
};


/** Is `line` a `!pro:` marker? The free build's rule (`scripts/build-free-tree.mjs` `isMarkerLine`). */
const isMarker = (line: string, token: string): boolean => {
  const m = /^\s*\{?\s*(?:\/\/+|#+|<!--|\/\*+|\*+|-{2,}|;+)?\s*(\S+)/.exec(line);
  return !!m && m[1].replace(/(?:-->|\*\/\}?)$/, '') === token;
};

/** The text the free tree ships: `!pro:start` … `!pro:end` regions dropped, whole lines, markers included. */
export const freeView = (text: string): string => {
  const kept: string[] = [];
  let depth = 0;
  for (const line of text.split('\n')) {
    if (isMarker(line, '!pro:start')) { depth++; continue; }
    if (isMarker(line, '!pro:end')) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) kept.push(line);
  }
  return kept.join('\n');
};

/** A script's interface: its case-arm flags, its `usage()` vocabulary, and the engine's `--help` table. */
export const interfaceOf = (src: string): string => {
  const flags = [...scriptFlags(src)].sort();
  const usage = /^usage\(\)\s*\{\n([\s\S]*?)^\}/m.exec(src)?.[1] ?? '';
  const vocabulary = [...new Set(usage.match(/--[a-z][a-z0-9-]*|\b[a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)+/g) ?? [])].sort();
  const table = /^_modes_table\(\)\s*\{\n\s*cat <<'MODES'\n([\s\S]*?)^MODES$/m.exec(src)?.[1] ?? '';
  const modes = table.split('\n').filter(Boolean).map((row) => row.split('\t').slice(0, 2).join('\t'));
  return JSON.stringify({ flags, vocabulary, modes });
};

export const digestOf = (src: string): string => createHash('sha256').update(interfaceOf(src)).digest('hex').slice(0, 12);

/** The scripts `references/scripts.md` §For maintainers names — exempt from the stamp. */
const maintainerScripts = (): Set<string> => {
  const index = readFileSync(join(REPO, 'references', 'scripts.md'), 'utf8');
  const from = index.indexOf('## For maintainers');
  assert.ok(from > 0, 'references/scripts.md lost its §For maintainers');
  return new Set([...index.slice(from).matchAll(/scripts\/([a-z0-9-]+\.sh)/g)].map((m) => m[1]));
};

/** The session-facing scripts that ship in this tree, by name. */
const sessionScripts = (): string[] => {
  const exempt = maintainerScripts();
  return readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh') && !exempt.has(f)).sort();
};

/**
 * What a ratchet says about `current` digests against a record: one finding per script whose
 * interface moved, appeared or went, each naming the script — and a stamp recorded at another
 * `PE_API` than the one in force is itself a finding.
 */
export function ratchetFindings(
  current: Record<string, string>, recorded: Record<string, string>, api: number, recordedApi: number,
  releasedApi = api,
): string[] {
  const findings: string[] = [];
  // An unreleased series already took its bump: the change needs recording, not another number.
  const ask = api > releasedApi ? `re-record it (PE_API ${api} is not released yet, so this series' bump covers it)` : 'raise PE_API';
  if (api !== recordedApi) {
    findings.push(`the digests were recorded at PE_API=${recordedApi} and scripts/skill-api.env says ${api} — re-record them`);
  }
  for (const script of Object.keys(current).sort()) {
    if (!(script in recorded)) findings.push(`${script} is new to the interface — ${ask}`);
    else if (recorded[script] !== current[script]) {
      findings.push(`${script}'s interface changed (${recorded[script]} → ${current[script]}) with PE_API still ${api} — ${ask}`);
    }
  }
  for (const script of Object.keys(recorded).sort()) {
    if (!(script in current)) findings.push(`${script} left the interface — ${ask}`);
  }
  return findings;
}

const recordLines = (digests: Record<string, string>): string =>
  Object.entries(digests).map(([script, digest]) => `  '${script}': '${digest}',`).join('\n');

const current = (view: (text: string) => string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const script of sessionScripts()) out[script] = digestOf(view(readFileSync(join(SCRIPTS, script), 'utf8')));
  return out;
};

const proOnly = (script: string): boolean => {
  const manifest = join(REPO, 'free', 'manifest.json');
  if (!existsSync(manifest)) return false;
  const { proPaths = [] } = JSON.parse(readFileSync(manifest, 'utf8')) as { proPaths?: string[] };
  return proPaths.includes(`scripts/${script}`);
};

test('scripts/skill-api.env speaks interface 3 and still works with a half at 2', () => {
  const stamp = readSkillApi(SCRIPTS);
  assert.ok(stamp, 'scripts/skill-api.env ships and reads as numbers');
  assert.deepEqual([stamp.api, stamp.min], [3, 2]);
});

test('every session-facing script\'s interface is the one recorded at this PE_API', () => {
  const stamp = readSkillApi(SCRIPTS)!;
  const free: Record<string, string> = {};
  for (const [script, digest] of Object.entries(current(freeView))) if (!proOnly(script)) free[script] = digest;
  const findings = ratchetFindings(free, RECORDED_FREE, stamp.api, RECORDED_API, RELEASED_API);
  assert.deepEqual(findings, [], `${findings.join('\n')}\n\nRECORDED_FREE, as this tree reads now:\n${recordLines(free)}`);
});


test('the ratchet fails on a planted flag, naming the script, until PE_API moves', () => {
  const src = readFileSync(join(SCRIPTS, 'phase-outcome.sh'), 'utf8');
  const planted = src.replace(/^(\s*)--reason\)/m, '$1--planted-flag) shift ;;\n$1--reason)');
  assert.notEqual(planted, src, 'the plant found its case arm');
  const before = { 'phase-outcome.sh': digestOf(src) };
  const after = { 'phase-outcome.sh': digestOf(planted) };
  assert.notEqual(after['phase-outcome.sh'], before['phase-outcome.sh'], 'a new flag moves the digest');
  const same = ratchetFindings(after, before, 3, 3);
  assert.equal(same.length, 1);
  assert.match(same[0], /^phase-outcome\.sh's interface changed .* raise PE_API$/);
  // Raised but not re-recorded is still a finding, so the ratchet never goes slack after one bump.
  assert.match(ratchetFindings(after, before, 4, 3)[0], /re-record/);
  // Inside an unreleased series (3 over a released 2) a moved digest still fails, asking for the record.
  const series = ratchetFindings(after, before, 3, 3, 2);
  assert.equal(series.length, 1);
  assert.match(series[0], /^phase-outcome\.sh's interface changed .* re-record it \(PE_API 3 is not released yet/);
  // The release that ships the series moves RELEASED_API, and the next change asks for a bump again.
  assert.match(ratchetFindings(after, before, 3, 3, 3)[0], /raise PE_API$/);
  // A usage() word and a --help row move it too; prose in usage() does not.
  const word = src.replace(/(echo 'usage: phase-outcome\.sh <slug> <phase> <complete)/, '$1|planted');
  assert.notEqual(digestOf(word), digestOf(src), 'a new status word in usage() moves the digest');
  const prose = src.replace(/a decision key from scripts\/decisions\.env/, 'one decision key from scripts/decisions.env');
  assert.equal(digestOf(prose), digestOf(src), 'rewording usage() prose leaves the interface alone');
  const engine = readFileSync(join(SCRIPTS, 'phase-graph.sh'), 'utf8');
  const row = engine.replace(/^--plan-status\t\t/m, '--plan-status\tN\t');
  assert.notEqual(digestOf(row), digestOf(engine), 'a --help row that grows an argument moves the digest');
});

test('the free view drops a Pro region whole, markers included', () => {
  const text = ['a', '# !pro:start', 'b', '# !pro:end', 'c', '<!--!pro:start-->', 'd', '<!--!pro:end-->'].join('\n');
  assert.equal(freeView(text), 'a\nc');
});
