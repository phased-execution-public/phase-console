/**
 * Which permission card a Your turn item stands for — the record its Actions
 * tab presses the card's verbs at. The item's own Allow and Deny name the card
 * by their endpoint; a ledger item that projects one names it by the broker
 * grant it would be answered with; any other item names none, and has no tab.
 */

import { describe, expect, it } from 'vitest';
import type { InboxAction } from '@/data/api';
import { approvalIdOf } from './inspector';

const decide = (id: string): InboxAction => ({
  verb: 'deny',
  label: 'Deny',
  endpoint: `/api/approvals/${encodeURIComponent(id)}`,
  method: 'POST',
  body: { decision: 'deny' },
});

describe('approvalIdOf', () => {
  it('reads the card from the item’s own decision, its id unescaped', () => {
    expect(approvalIdOf({ actions: [decide('apr 1/2')] })).toBe('apr 1/2');
  });

  it('falls back to the card a broker grant would answer', () => {
    expect(
      approvalIdOf({
        actions: [],
        permission: { wall: 'ask', grant: { effect: 'broker', approvalId: 'apr-9', label: 'Allow once' } },
      }),
    ).toBe('apr-9');
  });

  it('names no card for an item that answers none', () => {
    const errand: InboxAction = {
      verb: 'done',
      label: 'Done',
      endpoint: '/api/run/demo/phase/3/errand-answered',
      method: 'POST',
    };
    expect(approvalIdOf({ actions: [errand] })).toBeUndefined();
    expect(
      approvalIdOf({
        actions: [],
        permission: { wall: 'capability', grant: { effect: 'capability', label: 'Turn it on' } },
      }),
    ).toBeUndefined();
    // A card's own sub-route is not the card.
    expect(
      approvalIdOf({ actions: [{ ...decide('apr-1'), endpoint: '/api/approvals/apr-1/extend' }] }),
    ).toBeUndefined();
  });
});
