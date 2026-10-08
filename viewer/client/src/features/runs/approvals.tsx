/**
 * The queue: what is waiting on a person, and how to answer it.
 *
 * This is the top of the page because it is the answer to the only question
 * somebody opens this tab on a phone at 11pm to ask — "does this need me?" — so
 * the queue is the first thing drawn and every ask in it is answerable from
 * here in one press, or one press from its whole story.
 *
 * ## The item, not a card of its own (control-tower phase 139, #216)
 *
 * Each broker card and each relayed question is an item of Your turn: the
 * inbox row the server folds it into (`server/turn/fold.ts`). So the queue
 * draws each through the item's row (`LazyItemRow`) — its ONE primary, pressed
 * exactly as the server spelled it, and a link to its place on the page,
 * where the rest lives: a permission's scopes, its risk and the owner key; a
 * question's options side by side with what silence will choose; the
 * deadline's Extend; the evidence. The queue keeps only what is its own — the
 * frame, the count, and the offer to notify.
 *
 * Two kinds of question still get two vocabularies — a permission's Allow and
 * a question's options — because the words are the server's, carried on each
 * row's actions, and the row never renames them.
 */

import { useState } from 'react';
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
import { useInboxActions } from '@/components/inbox-row';
import { askToNotify, notifyState, type NotifyState } from '@/lib/notify';
import { useAttentionInbox } from '@/lib/queries';
import { LazyItemRow } from '@/features/turn/lazy-item-row';
import { approvalRows } from '@/features/turn/surfaces';

export function ApprovalQueue({ runId, slug }: { runId?: string | undefined; slug?: string | undefined }) {
  // Every row, acknowledged ones too: an ack is "seen", never "done" — the
  // session is still parked on the card.
  const { data } = useAttentionInbox(true);
  const { perform, busy } = useInboxActions();
  const rows = approvalRows(data?.items ?? [], { runId, slug });
  if (!rows.length) return null;
  return (
    // The queue IS the summons — a session is parked on every card in it — so its
    // frame is amber through `--accent` (tokens 6.0: `--action` is ink).
    <Card className="border-accent/50" data-testid="approval-queue">
      <CardHeader className="flex-wrap items-center">
        <CardTitle className="flex items-center gap-2">
          Waiting on you
          <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 font-mono text-sm text-accent">
            {rows.length}
          </span>
        </CardTitle>
        <NotifyToggle />
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {rows.map((row) => (
          <LazyItemRow key={row.id} row={row} perform={perform} {...(busy ? { busy } : {})} />
        ))}
      </CardBody>
    </Card>
  );
}

/**
 * Offered here, where the value of it is on screen: you are looking at a queue
 * that waited for you to notice it. Asking on page load instead gets refused by
 * reflex, and that refusal sticks.
 */
function NotifyToggle() {
  const [state, setState] = useState<NotifyState>(() => notifyState());

  if (state === 'unsupported') return null;
  if (state === 'granted') {
    return <span className="text-2xs text-ink-faint">You will be notified when this happens again.</span>;
  }
  if (state === 'denied') {
    return (
      <span className="text-2xs text-ink-faint">
        Notifications are blocked for this site — your browser's settings can undo that.
      </span>
    );
  }
  return (
    <Button size="sm" onClick={async () => setState(await askToNotify())}>
      Notify me next time
    </Button>
  );
}
