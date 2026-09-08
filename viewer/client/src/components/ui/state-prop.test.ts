/**
 * A `state=` prop takes a UI STATE, never a status word.
 *
 * This pattern has now bitten three times in three different files, and each
 * time it was invisible: both `asUiState` (`status-badge.tsx`) and
 * `asPhaseState` (`chip.tsx`) fall back SILENTLY for a word they do not know —
 * to `waiting` in both cases, which is a plausible-looking answer rather than
 * an obviously broken one. So the page renders, nothing logs, and a phase that
 * needs a person reads "Waiting".
 *
 *   1. `features/now/lane-row.tsx` passed a raw phase status into `StatusBadge`.
 *      Every `parked`, `gated` and `awaiting-verification` lane read "Waiting"
 *      on the destination whose whole question is "does anything need me".
 *      Shipped 2026-08-24, found 2026-09-01 by QA round 3.
 *   2. `features/runs/live-strip.tsx` did the same, and was safe only because a
 *      filter upstream happened to admit two words that are also valid UI
 *      states. A fact about the filter, not about the line.
 *   3. `features/runs/ways-forward.tsx` passed a record status into
 *      `StateChip`, whose vocabulary is the five BOARD buckets — so every
 *      stopped phase on the ways-forward strip read "Waiting".
 *
 * The two fallbacks are right and must stay: an unknown word genuinely is
 * "we cannot tell this can move", and neither amber nor green would be honest.
 * What is wrong is feeding them a word from a vocabulary they were never given.
 * So this is the gate: **a `state=` prop is fed a fold, a literal, or a value
 * already of that type — never a bare `.status`.**
 *
 * It reads the SOURCE rather than rendering, deliberately: rendering catches
 * the instance you thought to write a fixture for, and every one of the three
 * above had passing tests around it.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * `state={…}` where the expression ENDS in `.status` — `record.status`,
 * `lane.status`, `r.status`. A call (`phaseUiState(lane.status, …)`), a
 * literal (`'done'`), a board word (`p.state`) and a variable already of the
 * type (`ui`) all pass, because each is either a fold or already the right
 * vocabulary.
 */
const RAW_STATUS_IN_STATE_PROP = /\bstate=\{(?!\s*\w+\()[^}]*\.status\s*\}/;

describe('a state= prop takes a UI state, never a status word', () => {
  it('no component feeds a bare .status into a state= prop', () => {
    const offences: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      // Line by line, so the failure names the line and not just the file.
      text.split('\n').forEach((line, i) => {
        if (RAW_STATUS_IN_STATE_PROP.test(line)) {
          offences.push(`${relative(SRC, file)}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    expect(
      offences,
      'a `state=` prop resolves through asUiState/asPhaseState, which fall back to `waiting` ' +
        'for a word they do not know — so a status word here paints every ask as "Waiting". ' +
        'Pass a fold (`phaseUiState(status, stop)`) or the board word instead:\n  ' +
        offences.join('\n  '),
    ).toEqual([]);
  });

  it('the guard actually catches the three shapes that shipped', () => {
    // Red-proof, inline: the regex must match what really went wrong, and must
    // not match the fixes. A guard nobody has tested against its own subject is
    // the reason this file exists.
    for (const shipped of [
      '<StatusBadge state={lane.status} pulse={running} />',
      '<StateChip state={record.status} board />',
      '          state: record.status,'.replace('state: ', 'state={').replace(',', '}'),
    ]) {
      expect(RAW_STATUS_IN_STATE_PROP.test(shipped), shipped).toBe(true);
    }
    for (const fixed of [
      '<StatusBadge state={phaseUiState(lane.status, lane.stop)} />',
      '<StateChip state={p.state} board />',
      "<StatusBadge state={'done'} />",
      '<StatusBadge state={ui} />',
      '<StatusBadge state={asUiState(phaseUiState(lane.status, lane.stop))} />',
    ]) {
      expect(RAW_STATUS_IN_STATE_PROP.test(fixed), fixed).toBe(false);
    }
  });
});
