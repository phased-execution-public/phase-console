/**
 * The frozen session card says what happens, and WHEN.
 *
 * A freeze is held, not ended, so the card's job is two halves: what a freeze
 * is ("continues mid-token, in the same process") and what ends the holding.
 * Only the first half shipped, so the operator could read the promise and not
 * the deadline — the same gap the lane card closed long ago, still open one
 * layer down. `escalateAt` comes off the wire from `terminal.ts`, on the same
 * clock and through the same verdict a lane freeze uses.
 */

import { describe, expect, it } from 'vitest';
import { frozenTitle } from './session-controls';

const AT = Date.UTC(2026, 7, 26, 10, 0);
const NOW = AT + 4 * 60_000;

describe('frozenTitle', () => {
  it('names what a freeze is AND when it converts', () => {
    const title = frozenTitle(
      { at: AT, by: 'the tab strip', escalateAt: new Date(NOW + 11 * 60_000).toISOString() },
      NOW,
    );
    expect(title).toContain('Frozen by the tab strip');
    expect(title).toContain('continues mid-token, in the same process');
    // The half that was missing: a deadline, and how long is left on it.
    expect(title).toMatch(/Left frozen past /);
    expect(title).toMatch(/it is stopped gracefully\.$/);
  });

  it('says a passed deadline is being acted on, not still pending', () => {
    const title = frozenTitle(
      { at: AT, by: 'console', escalateAt: new Date(NOW - 1_000).toISOString() },
      NOW,
    );
    expect(title).toContain('Past its deadline');
    expect(title).not.toMatch(/Left frozen past /);
  });

  it('keeps the old sentence for a record written before deadlines existed', () => {
    // An unreadable or absent `escalateAt` must not become an invented time.
    // A card that guesses a deadline is worse than one that does not show it.
    const title = frozenTitle({ at: AT, by: 'console', escalateAt: 'not a date' } as never, NOW);
    expect(title).toContain('continues mid-token');
    expect(title).not.toContain('Left frozen past');
    expect(title).not.toContain('Past its deadline');
  });
});
