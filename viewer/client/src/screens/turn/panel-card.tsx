/**
 * The selected item's whole card, in the panel (one-pool phase 14, #377) —
 * the detail half of the list: beside the page at 1200 px and up, a sheet
 * below, and on a phone the card as a page of its own.
 *
 * It reads the turn itself rather than holding what the page handed it, so a
 * press in the panel, a check coming back or the round moving redraws the card
 * where it stands — the panel outlives the render that opened it. The card is
 * the same card the Cards view draws, its parts lent, with every press it
 * offers; under it the item's record (its explain view) one press away.
 */

import { useMemo, useState } from 'react';
import { useInboxActions } from '@/cards/inbox-row';
import { useHumanSteps, useTurn } from '@/data/turn';
import { Disclosure } from '@/ui/disclosure';
import { useSettling } from './grants';
import { ExplainOverview } from './inspector';
import { itemOf } from './page-model';
import { TurnItemCard, turnParts } from './parts';
import { readSeen } from './seen';

export function PanelCard({ id }: { id: string }) {
  const [seen] = useState(readSeen);
  const turn = useTurn(true, seen);
  const ledger = useHumanSteps();
  const { perform, busy } = useInboxActions();
  const { settle } = useSettling(turn.data);
  const parts = useMemo(() => turnParts(settle), [settle]);
  const item = itemOf(turn.data, id);
  if (!item) {
    return (
      <p data-testid="turn-panel-gone" className="max-w-(--measure) text-body text-ink-muted">
        {turn.isPending
          ? 'Reading the item.'
          : 'This item is no longer waiting on you. It was done, withdrawn or handed back.'}
      </p>
    );
  }
  const record =
    item.record === 'ledger' ? ledger.data?.steps.find((step) => step.id === item.item) : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="turn-panel-card">
      <TurnItemCard
        item={item}
        record={record}
        perform={perform}
        busy={busy}
        folded={false}
        parts={parts}
        inPanel
      />
      <Disclosure label="Its record" openLabel="Fold its record">
        <ExplainOverview item={item} record={record} />
      </Disclosure>
    </div>
  );
}
