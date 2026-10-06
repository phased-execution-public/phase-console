/**
 * Which phase of a LOCAL plan fixes an issue (control-tower phase 118).
 *
 * A plan takes an issue with a label (`plan:<slug>`) and names it on the
 * `Fixes:` line of the phase that fixes it (`- **Fixes:** #203.`). The label is
 * on GitHub and the line is on this disk, so "planned in control-tower phase
 * 118" is a JOIN of the two — the issues store asks this module for the second
 * half and `shared/issues-model.js` `planStateOf` does the joining.
 *
 * Read off the plan store's parse — every phase's labelled bullets — never a
 * second walk of the plan files, and cached per plan by the file's mtime, so a
 * board of two thousand issues reads each plan's phases once, not once a row.
 */

import { fixesNumbers } from '../../shared/issues-model.js';

/** A phase as the plan parser keeps it — only its labelled bullets are read here. */
export type PhaseBullets = { bullets: readonly { label: string; body: string }[] };

/** Issue number → the phases whose `Fixes:` line names it, in phase order. */
export function fixesIndexOf(phases: Readonly<Record<number, PhaseBullets>>): Map<number, number[]> {
  const index = new Map<number, number[]>();
  const order = Object.keys(phases).map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b);
  for (const phase of order) {
    const line = phases[phase]?.bullets.find((bullet) => /^fixes$/i.test(bullet.label.trim()));
    if (!line) continue;
    for (const number of fixesNumbers(line.body)) {
      const list = index.get(number) ?? [];
      if (!list.includes(phase)) list.push(phase);
      index.set(number, list);
    }
  }
  return index;
}

/** One plan as the lookup needs it: its phases, and the mtime that says whether a cached index still holds. */
export type PlanPhases = { mtime: number; phases: Readonly<Record<number, PhaseBullets>> };

/**
 * `(slug, number) → phases`, answered from whatever plans the source holds now.
 *
 * `plan` is the store's own read (`PlanRecord.plan.phases` and `planMtime`); a
 * slug the store does not hold answers `undefined`, which `planStateOf` reads
 * as "planned in that plan — phase unknown here".
 */
export function planFixesLookup(
  plan: (slug: string) => PlanPhases | undefined,
): (slug: string, number: number) => number[] | undefined {
  const cache = new Map<string, { mtime: number; index: Map<number, number[]> }>();
  return (slug, number) => {
    const current = plan(slug);
    if (!current) { cache.delete(slug); return undefined; }
    let held = cache.get(slug);
    if (!held || held.mtime !== current.mtime) {
      held = { mtime: current.mtime, index: fixesIndexOf(current.phases) };
      cache.set(slug, held);
    }
    return held.index.get(number);
  };
}
