/**
 * The per-phase permission vocabulary, held to the runner's.
 *
 * `phaseOptions[N].permissionMode` is re-validated against `PERMISSION_MODES`
 * on the way in and any other word is DROPPED — silently, because a dropped
 * option is not an error, it is an absent one. So the per-phase select in the
 * wizard shipped offering two words the server discards (`guarded` and
 * `trusted`, which are run-PROFILE words that `permissionModeFor` exists to
 * translate) and not offering `manual`, which is a real mode. An operator
 * picked "Trusted — only the deny list stops it" on phase 7, the More button
 * said "set", the form's provenance said "changed here" — and the phase
 * boarded under the run's profile with no trace of the choice in the run
 * record.
 *
 * ── Updated by console-audit-hardening P23 ────────────────────────────────
 * This test used to PARSE `run-setup/modes.ts` for two literal arrays, because
 * that file imports `@/lib/…` — a Vite alias `node --test` does not resolve —
 * and because the two lists really were hand-copied and really did drift.
 *
 * They are no longer copies: `PHASE_PERMISSION_MODES` and `RUN_PERMISSIONS`
 * now take their MEMBERS from `shared/run-settings.js`, so the parity these
 * first three tests defended holds by construction. What is still worth
 * asserting — and is asserted below — is that it holds *that way*: that the
 * client derives rather than re-declaring, that the label record is total, and
 * that profile words and CLI modes stay disjoint vocabularies. The source is
 * still read, but only to prove the ABSENCE of a literal.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PERMISSION_MODES } from '../server/runner/spawn.ts';
import {
  PERMISSION_MODES as OWNER_MODES,
  PERMISSION_PROFILES,
} from '../shared/run-settings.js';

const MODES_SRC = readFileSync(
  fileURLToPath(new URL('../client/src/features/run-setup/modes.ts', import.meta.url)),
  'utf8',
);

/** The keys of a `export const NAME: … = Object.freeze({ … })` record. */
function recordKeys(name: string): string[] {
  const at = MODES_SRC.indexOf(`export const ${name}`);
  assert.notEqual(at, -1, `${name} is declared in run-setup/modes.ts`);
  const body = MODES_SRC.slice(at, MODES_SRC.indexOf('});', at));
  return [...body.matchAll(/^ {2}([A-Za-z][\w]*):/gm)].map(([, key]) => key);
}

test('the runner and the wizard share ONE mode vocabulary, by identity', () => {
  // `===`, not deepEqual: the server re-exports the owner's array. A copy that
  // matches today is what shipped `guarded` as a CLI mode and lost `manual`.
  assert.equal(PERMISSION_MODES, OWNER_MODES, 'spawn.ts re-exports the owner');
});

test('the per-phase select DERIVES its modes instead of re-declaring them', () => {
  // The literal is the defect. If this regex ever matches again, someone has
  // pasted the list back and the parity above is decorative.
  assert.doesNotMatch(
    MODES_SRC,
    /export const PHASE_PERMISSION_MODES\s*(?::[^=]*)?=\s*\[\s*'/,
    'PHASE_PERMISSION_MODES must derive from PERMISSION_MODES, not list words',
  );
  assert.match(MODES_SRC, /PHASE_PERMISSION_MODES[\s\S]{0,200}PERMISSION_MODES/);
  assert.doesNotMatch(
    MODES_SRC,
    /export const RUN_PERMISSIONS\s*(?::[^=]*)?=\s*\[\s*'/,
    'RUN_PERMISSIONS must derive from PERMISSION_PROFILES, not list words',
  );
});

test('every offered mode has a label, and no label is orphaned', () => {
  // Still a real, independent fact: the label record is hand-written, and a
  // mode added to the owner with no label renders as a blank option.
  assert.deepEqual(recordKeys('PERMISSION_MODE_LABELS').sort(), [...PERMISSION_MODES].sort());
});

test('the run PROFILE words are not CLI modes, which is why they must be translated', () => {
  // `guarded`/`trusted` stay the run and session vocabulary; the defect was
  // writing them RAW into a field validated against PERMISSION_MODES.
  for (const choice of ['guarded', 'trusted']) {
    assert.ok(
      !(PERMISSION_MODES as readonly string[]).includes(choice),
      `${choice} is a profile word and must not be mistaken for a CLI mode`,
    );
    assert.ok(
      (PERMISSION_PROFILES as readonly string[]).includes(choice),
      `${choice} must be a permission PROFILE`,
    );
  }
});
