/**
 * A run's ONE action, drawn — shared by the run row on Runs and the plan
 * page's glance, so the two pages can never offer different moves for one
 * run (#278's rule). What the action IS comes from `rowModel` (`./model`);
 * this file only draws it.
 */

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { InboxItem } from '@/data/api';
import { useInboxActions } from '@/cards/inbox-row';
import { LazyItemRow } from '@/cards/lazy-item-row';
import { runRecoverVerb, type RunRecoverVerb } from '@/cards/recover';
import type { Lifecycle } from '@/data/lifecycle';
import { Button } from '@/ui';
import type { RowAction } from './model';

/* ------------------------------------------------------------------ *
 * The one action
 * ------------------------------------------------------------------ */

/**
 * On a phone the one action is the width of the row, at its foot — the
 * thumb's zone (control-tower phase 20). The kit's button is `shrink-0` and
 * one line; a label that may wrap in a narrow cell needs the three words
 * below, or it escapes the cell instead of wrapping.
 */
const THUMB =
  'h-auto min-h-8 shrink whitespace-normal py-1 max-sm:w-full max-sm:min-h-(--tap-min) [@media(hover:none)]:min-h-(--tap-min)';

/**
 * The ONE action. `data-testid="strip-action"` names it for a test and for a
 * phone's `elementFromPoint`; `data-action` says which verb it is.
 *
 * A recovery verb that needs more than a press — words, or a dialog — opens
 * the row instead, where the halt card asks for them; every other verb acts
 * at once through its one door.
 */
export function RowActionButton({
  action,
  lifecycle,
  onExpand,
}: {
  action: RowAction;
  lifecycle: Lifecycle;
  onExpand: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (action.kind === 'step') return <RowStepPrimary item={action.item} />;
  if (action.kind === 'open') {
    return (
      <Button size="sm" className={THUMB} asChild>
        <a href={action.href} data-testid="strip-action" data-action="open" title={action.title}>
          <ExternalLink size={13} aria-hidden /> {action.label}
        </a>
      </Button>
    );
  }
  if (action.kind === 'lifecycle') {
    return (
      <Button
        size="sm"
        className={THUMB}
        data-testid="strip-action"
        data-action={action.verb}
        title={action.title}
        disabled={lifecycle.busy != null}
        onClick={() => void lifecycle.act(action.verb)}
      >
        {lifecycle.busy === action.verb ? 'Working…' : action.label}
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="primary"
      className={THUMB}
      data-testid="strip-action"
      data-action={action.id}
      data-recommended={action.id}
      title={action.title}
      disabled={Boolean(action.disabledReason) || busy}
      onClick={() => {
        if (action.needsMore) return onExpand();
        setBusy(true);
        void runRecoverVerb(action.id as RunRecoverVerb, action.target).finally(() => setBusy(false));
      }}
    >
      {busy ? 'Working…' : action.label}
    </Button>
  );
}

/**
 * The run's oldest item's ONE primary (control-tower phase 139, #216): a step's
 * opener or check, a broker card's Allow, a gate's Approve — or, where a row
 * cannot answer it (a high grant, a choice of options), the item on the page.
 */
function RowStepPrimary({ item }: { item: InboxItem }) {
  const { perform, busy } = useInboxActions();
  return (
    <LazyItemRow
      row={item}
      primaryOnly
      testId="strip-action"
      className={THUMB}
      perform={perform}
      {...(busy ? { busy } : {})}
    />
  );
}
