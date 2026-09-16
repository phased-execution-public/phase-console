/**
 * `#/approve` — the phone surface.
 *
 * ## Why a second view of the inbox
 *
 * Now already renders the inbox, and renders it well on a laptop. But the
 * journey this page exists for starts on a lock screen at 2am: a push arrives,
 * the notification's own buttons cover the two verbs a notification may carry
 * (`push/actions.ts`), and everything else — an errand, a sign-in, an MCP
 * wall, a gate you want to leave evidence on — needs a screen. What it does
 * NOT need is the whole console: the rail, the four bands, the portfolio
 * strip, the plan chunk with `marked` and the DAG maths in it.
 *
 * So this is the same list, filtered to what can be acted on, rendered as one
 * column of cards big enough to hit with a thumb. Every push links here, which
 * is why the address is short and why it is a head of its own rather than a
 * `?focus=` on Now: it is a bookmark and a deep link before it is navigation.
 *
 * ## What it shows, and what it deliberately does not
 *
 * **Only what this console can actually do something about.** An item is here
 * when it is not `fyi`, not acknowledged, and carries at least one action
 * whose capability is ON. The rest are counted in one line at the foot rather
 * than listed: a phone screen of rows you cannot press is the thing that
 * teaches people to stop opening the link. `session-ask` is the honest example
 * — a Claude session stopped at its own terminal prompt has no action at all,
 * because the console genuinely cannot answer for it.
 *
 * **No triage keyboard, no filters, no grouping.** All three are Now's, and
 * all three assume a keyboard and a scroll wheel.
 *
 * The list, the identity and the remedies are entirely the server's
 * (`server/inbox.ts`): this file adds a layout and a text box, and nothing
 * here maps a verb to a URL.
 */

import { useMemo, useState } from 'react';
import { CheckCheck } from 'lucide-react';
import { useWindowLeft } from '@/lib/clock';
import { INBOX_KIND_LABELS, SEVERITY_UI } from '@shared/attention-model.js';
import { Button, Empty, RelativeTime, Skeleton, StatusBadge } from '@/components/ui';
import { useAttentionInbox } from '@/lib/queries';
import { useInboxActions } from '@/features/now/inbox-row';
import { nowHref, toHash } from '@/app/routes';
import { plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { InboxAction, InboxItem } from '@/lib/api';
import { MicField } from './mic-field';

/**
 * Can this console press it?
 *
 * `flag` is present ONLY when the capability that gates the action is off
 * (`server/inbox.ts` says why it is present-only-when-off), so its absence is
 * the whole test. An item whose every action is gated is not actionable from
 * here however urgent it is — the honest thing to do with it is say so at the
 * foot, not draw a row of dead buttons.
 */
export function pressable(item: InboxItem): InboxAction[] {
  return item.actions.filter((action) => !action.flag);
}

/** What belongs on a phone: waiting on a person, not seen off, and answerable. */
export function actionable(items: readonly InboxItem[]): InboxItem[] {
  return items.filter((item) => item.severity !== 'fyi' && !item.ack && pressable(item).length > 0);
}

export default function ApprovePage() {
  const { data, isLoading, isError, refetch } = useAttentionInbox();
  const { perform, busy } = useInboxActions();
  const items = useMemo(() => actionable(data?.items ?? []), [data]);
  const waiting = (data?.items ?? []).filter((item) => item.severity !== 'fyi' && !item.ack).length;

  if (isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3 p-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-xl p-3">
        <Empty
          title="The console did not answer"
          body="This page needs the console it was opened from. Reconnect and reload."
          action={<Button onClick={() => refetch()}>Try again</Button>}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 p-3" data-testid="approve-page">
      <header className="flex items-baseline justify-between gap-2">
        <h1 className="text-md font-semibold text-ink">Needs you</h1>
        {/* The same floor as the card's own link below, for the same reason and
            so this page has one answer rather than two: an overlay that hangs
            12.5px past its host is a hazard wherever the host has a neighbour,
            and the header's does reach the first card. The box carries it. */}
        <a href={nowHref()} className="tap-row w-fit text-2xs text-ink-muted underline underline-offset-2">
          Open the console
        </a>
      </header>

      {items.length === 0 ? (
        <Empty
          icon={<CheckCheck aria-hidden className="size-6" />}
          title="Nothing to answer"
          body={
            waiting
              ? `${plural(waiting, 'item')} still need a person, but none can be answered from here.`
              : 'Nothing is waiting on you.'
          }
          // The one useful move from a phone with nothing to answer: the full
          // console, which can. An empty screen is an invitation to act.
          action={
            <Button asChild>
              <a href={nowHref()}>Open the console</a>
            </Button>
          }
        />
      ) : (
        <ul className="flex list-none flex-col gap-3 p-0">
          {items.map((item) => (
            <ApproveCard key={item.id} item={item} perform={perform} busy={busy} />
          ))}
        </ul>
      )}

      {items.length > 0 && waiting > items.length && (
        <p className="text-2xs text-ink-muted">
          {waiting - items.length} more need a person but cannot be answered from this console — open it to
          see them.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One card
 * ------------------------------------------------------------------ */

export function ApproveCard({
  item,
  perform,
  busy,
}: {
  item: InboxItem;
  perform: (item: InboxItem, action: InboxAction, says?: string) => void;
  busy?: string;
}) {
  const [said, setSaid] = useState('');
  const actions = pressable(item);
  const ui = SEVERITY_UI[item.severity] ?? 'queued';
  const where = [item.slug, item.phase != null ? `phase ${item.phase}` : null].filter(Boolean).join(' · ');
  // One box per card, not per button: `Allow` and `Deny` on the same card both
  // take `reason`, and two boxes asking the same question is a card nobody
  // reads. The first action that takes words decides the label.
  const says = actions.find((action) => action.says)?.says;
  const windowLeft = useWindowLeft(item.expiresAt);

  return (
    <li
      data-testid="approve-card"
      data-kind={item.kind}
      className={cn(`state-${ui}`, 'flex flex-col gap-2 rounded-lg border border-state/45 bg-surface p-3')}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <StatusBadge state={ui} label={INBOX_KIND_LABELS[item.kind] ?? item.kind} />
        {where && <span className="text-2xs text-ink-muted">{where}</span>}
        {windowLeft === null ? (
          <RelativeTime at={item.since} className="ml-auto text-2xs text-ink-muted" />
        ) : (
          <span className="ml-auto text-2xs text-ink-muted" aria-live="polite" data-testid="approve-window">
            {windowLeft > 0 ? `${windowLeft} s to answer` : 'answering by rule'}
          </span>
        )}
      </div>

      <p className="text-sm font-medium text-ink">{item.title}</p>
      <p className="text-2xs text-ink-muted">{item.need}</p>
      {item.how && <p className="text-2xs text-ink-muted">{item.how}</p>}

      {says && (
        <MicField
          label={says.label}
          placeholder={says.placeholder}
          value={said}
          onChange={setSaid}
          disabled={Boolean(busy)}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action.verb}
            size="lg"
            variant={action.verb === 'deny' || action.verb === 'stop' ? 'danger' : 'action'}
            // The tap target every phone platform asks for. `lg` is 44px tall
            // already; the token keeps it honest if that ever changes.
            className="min-h-(--tap-min) flex-1"
            disabled={busy === `${item.id}:${action.verb}`}
            onClick={() => perform(item, action, said)}
          >
            {action.label}
          </Button>
        ))}
      </div>

      {/* The floor is this link's own BOX, not an overlay above its neighbours.
          `tap-line` centres a 44px `::before` on the line, which over a 19px
          link overhangs it by 12.5px at each end — and this link sits `gap-2`
          (8px) below the Allow / Deny / Stop row. Measured against the shipped
          stylesheet with the coarse-pointer branch live: the overlay's top edge
          landed at y=497 while the button row's bottom edge was y=502, and
          because the `::before` is a positioned descendant it hit-tested above
          those non-positioned buttons — `elementFromPoint` 3px inside every one
          of the three buttons' bottom edge answered THIS LINK. Five pixels, on
          the one surface where a mis-tap grants or denies a run.

          So `tap-row` takes the floor instead — the drawn box is 44 tall under
          a coarse pointer and nothing at all under a fine one — and `w-fit`
          keeps the target the width of the words, since a flex item is
          otherwise stretched to the card's full width. Nothing overhangs, so
          nothing can be stolen. */}
      <a
        href={toHash(item.href)}
        className="tap-row w-fit text-2xs text-ink-muted underline underline-offset-2"
      >
        Open where it lives
      </a>
    </li>
  );
}
