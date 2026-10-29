// The reds a release carries, as a ratchet (measured-console phase 15).
//
// `viewer/known-reds.json` lists every failing test a release is allowed to
// carry — each by the identity `failureIds` gives it (`server/runner/verify.ts`,
// the same one the verification ledger keys a red by), the gate stage that
// runs it, the issue that owns it and the day it was listed. The ratchet only
// moves one way:
//   - a red NOT listed fails its stage (`gates.sh` asks `gate`);
//   - a listed red that PASSED is fixed, and `lower` takes it out — the file
//     only ever shrinks by itself; a new row is a person's act, with an issue.
//
//   node scripts/reds-ratchet.mjs gate  <stage> <log>   exit 0: every red in the log is known
//   node scripts/reds-ratchet.mjs lower <stage> <log>   drop the stage's known reds the log no longer names
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KNOWN_REDS = join(dirname(fileURLToPath(import.meta.url)), '..', 'known-reds.json');

/**
 * Judge what a stage's run named against what is known for it.
 * @param {{ id: string, stage: string }[]} known every known red (any stage)
 * @param {string} stage the stage that ran
 * @param {string[]} observed the failing tests its output named
 */
export function judgeReds(known, stage, observed) {
  const mine = known.filter((red) => red.stage === stage);
  const ids = new Set(mine.map((red) => red.id));
  const seen = new Set(observed);
  const fresh = [...seen].filter((id) => !ids.has(id));
  const fixed = mine.filter((red) => !seen.has(red.id)).map((red) => red.id);
  return {
    ok: fresh.length === 0,
    fresh,
    fixed,
    carried: [...seen].filter((id) => ids.has(id)),
    next: known.filter((red) => red.stage !== stage || seen.has(red.id)),
  };
}

/** The file's rows, each checked for the four fields a row must carry. */
export function readKnownReds(file = KNOWN_REDS) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const reds = Array.isArray(json.reds) ? json.reds : [];
  for (const red of reds) {
    for (const field of ['id', 'stage', 'issue', 'since']) {
      if (typeof red[field] !== 'string' || !red[field])
        throw new Error(`known-reds.json: a red without its ${field}`);
    }
  }
  return { json, reds };
}

async function main([verb, stage, log]) {
  if ((verb !== 'gate' && verb !== 'lower') || !stage || !log) {
    console.error('usage: reds-ratchet.mjs gate|lower <stage> <log>');
    return 2;
  }
  const { failureIds } = await import('../server/runner/verify.ts');
  const { json, reds } = readKnownReds();
  const verdict = judgeReds(reds, stage, failureIds(readFileSync(log, 'utf8')));
  if (verb === 'lower') {
    writeFileSync(KNOWN_REDS, `${JSON.stringify({ ...json, reds: verdict.next }, null, 2)}\n`);
    console.log(
      `known reds: ${verdict.fixed.length} fixed and taken out (${verdict.fixed.join(', ') || 'none'})`,
    );
    return 0;
  }
  if (!verdict.carried.length || !verdict.ok) {
    if (verdict.fresh.length)
      console.error(`new red(s), not in known-reds.json: ${verdict.fresh.join(', ')}`);
    return 1;
  }
  const lowered = verdict.fixed.length ? `; ${verdict.fixed.length} fixed — lower the ratchet` : '';
  console.log(`carries ${verdict.carried.length} known red(s): ${verdict.carried.join(', ')}${lowered}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
