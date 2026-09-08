/**
 * The phase table's grouping must be EXHAUSTIVE over the board vocabulary.
 *
 * It was not. `PHASE_GROUPS` named five of the seven board words, and `groupOf`
 * falls an unrecognised state through to `waiting` on purpose — so `gated` and
 * `blocked`, the two states the shared table calls `needs-you`, filed themselves
 * under Waiting: the one group a reader scrolls past. Nothing failed, because
 * nothing compared the two lists.
 *
 * That fallback is still right (a row that vanishes because the server learned a
 * new word is the worst outcome), which is exactly why it needs a test above it:
 * a default that silently absorbs a missing word cannot also be the thing that
 * tells you a word is missing.
 */

import { describe, expect, it } from 'vitest';

import { PHASE_GROUPS, groupOf } from './phase-table';
import { BOARD_STATES, boardUiState } from '@/lib/status-vocab';

const covered = new Set(PHASE_GROUPS.flatMap((g) => g.states as readonly string[]));

describe('the phase grouping covers the board vocabulary', () => {
  it('names every board state, so none can fall through the default', () => {
    const missing = BOARD_STATES.filter((s) => !covered.has(s));
    expect(missing, `board states no group claims: ${missing.join(', ')}`).toEqual([]);
  });

  it('files every needs-you board state under Needs you', () => {
    const needsYou = BOARD_STATES.filter((s) => boardUiState(s) === 'needs-you');
    // `gated` and `blocked` are the two this test exists for; assert the set
    // rather than the pair, so a new needs-you word is caught the same way.
    expect(needsYou.length).toBeGreaterThanOrEqual(3);
    for (const state of needsYou) {
      expect(groupOf({ phase: 1, state, record: undefined }), `${state} must group under needs-you`).toBe(
        'needs-you',
      );
    }
  });

  it('groups nothing it has not been told about — the fallback still holds', () => {
    expect(groupOf({ phase: 1, state: 'a-word-the-server-just-learned', record: undefined })).toBe('waiting');
  });
});
