/**
 * Open what a surface folds, the way a person would — by pressing it.
 *
 * `Disclosure` and the run strip UNMOUNT folded content (a fold is not a
 * cache), so a test that reads a fact behind a fold must open the fold first,
 * and a datum ledger (`*.datums.test.tsx`, docs/design.md §1) counts those
 * presses: every fact within two interactions. These helpers are the presses.
 */

import { fireEvent } from '@testing-library/react';

/** Open every run strip under `root`, in place — one interaction each. */
export function expandStrips(root: ParentNode = document): number {
  const toggles = [...root.querySelectorAll<HTMLElement>('[data-testid="strip-expand"][aria-expanded="false"]')];
  for (const toggle of toggles) fireEvent.click(toggle);
  return toggles.length;
}

/**
 * Open every fold under `root` — each `aria-expanded="false"` button — until
 * none is left, bounded so a toggle that never reports itself open cannot spin.
 * Returns how many presses it took.
 */
export function expandAll(root: ParentNode = document, rounds = 4): number {
  let presses = 0;
  for (let round = 0; round < rounds; round += 1) {
    const folded = [...root.querySelectorAll<HTMLElement>('button[aria-expanded="false"]')];
    if (!folded.length) break;
    for (const button of folded) fireEvent.click(button);
    presses += folded.length;
  }
  return presses;
}
