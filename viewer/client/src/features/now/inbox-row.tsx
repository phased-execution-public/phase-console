/**
 * One thing that needs a person — the row, and the one place a remedy is
 * performed.
 *
 * ## Why one row component and not two
 *
 * The same item is read in two places: the **Needs you** section on Now, and
 * the **bell drawer** over whatever page you are on. Before the unified inbox
 * those were separate lists with separate rules — the drawer showed what had
 * been ANNOUNCED and the dashboard showed what was WAITING, and an approval
 * answered on a phone stayed on the laptop's dashboard until a reload. One row
 * component over one query is what makes "the bell drawer shares its rows"
 * true rather than aspirational, and it is why acting from either surface
 * updates the other in the same tick.
 *
 * ## What the row is allowed to decide
 *
 * Almost nothing. `server/inbox.ts` decided which item exists, how loud it is,
 * what is needed, how to give it, what was already tried, and which remedies
 * apply — including which of them this console cannot perform (`action.flag`).
 * `features/now/model.ts` decides which remedy leads. This file renders that
 * and performs a press.
 *
 * The one rule it owns is a rendering rule: **a remedy that cannot be taken is
 * shown, disabled, with the reason** — never hidden. A console started without
 * `--allow-run` still has to be told its run is parked on a permission card;
 * hiding the button because it would not work is the dead end these cards were
 * built to end.
 */

import { useCallback, useState } from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { INBOX_KIND_LABELS, SEVERITY_UI } from '@shared/attention-model.js';
import { api, type InboxAction, type InboxItem } from '@/lib/api';
import { keys, useApiMutation } from '@/lib/queries';
import { cn } from '@/lib/cn';
import { Badge, Button, Checkbox, RelativeTime, StatusBadge, toast } from '@/components/ui';
import { toHash } from '@/app/routes';
import { useWindowLeft } from '@/lib/clock';
import { flagReason, splitActions } from './model';

/* ------------------------------------------------------------------ *
 * Performing one
 * ------------------------------------------------------------------ */

/**
 * Press a remedy, acknowledge an item, or put an acknowledgement back.
 *
 * Three rules, the same three `views/dashboard/actions.tsx` learned from the
 * run page and which this keeps:
 *
 *  - **one press in flight at a time**, keyed `${item.id}:${verb}`, so a row
 *    cannot be double-fired and the button that is working says so;
 *  - **the result is a toast, always, including the failures** — a row that
 *    silently does nothing is what these were before;
 *  - **the queries are invalidated in `finally`**, because the case where
 *    re-reading matters most is the one where the request failed.
 *
 * The endpoint, the method and the body are the SERVER's words, taken off the
 * action verbatim. Nothing here maps a verb to a URL: a client that knew which
 * endpoint answered `recover` would be a second copy of a routing table that
 * already exists, and the first divergence would be a button that 404s.
 */
export function useInboxActions(): {
  /**
   * `says` is the operator's own words, and it only goes anywhere when the
   * ACTION declared a field for them (`InboxAction.says`, minted by
   * `server/inbox.ts`). A caller that has no box to type in passes nothing;
   * `#/approve` is the one that does.
   */
  perform: (item: InboxItem, action: InboxAction, says?: string) => void;
  ack: (item: InboxItem) => void;
  /**
   * Acknowledge a whole selection, with an undo.
   *
   * `already` is what was ALREADY acknowledged before the press, and it is the
   * reason undo is honest: putting all seventeen back would un-acknowledge
   * four the operator had settled days ago. Only what this press changed is
   * what Undo changes back.
   */
  ackMany: (items: InboxItem[], onUndone?: () => void) => void;
  busy?: string;
  /** True while a bulk press is in flight — the bar disables itself on it. */
  bulkBusy: boolean;
} {
  /*
   * `keys.afterInboxAct()` is the bundle, not five keys written out again. It
   * is the widest one in the console and honestly so: an inbox verb can
   * approve a permission, recover a run, unblock a phase and clear a badge in
   * one press. `useApiMutation` invalidates it in `onSettled`, which is what
   * makes the FAILURE path re-read too — a card answered in another tab 404s
   * here, and without the re-read the phantom stays on screen and the next
   * press 404s again.
   */
  const invalidates = keys.afterInboxAct();

  const act = useApiMutation<
    { item: InboxItem; action: InboxAction; says?: string },
    { outcome?: string; detail?: string } | null | undefined
  >({
    fn: ({ action, says }) => api.inboxAct(action, says) as Promise<{ outcome?: string; detail?: string }>,
    invalidates,
    onDone: (result, { action }) => {
      // The RESULT decides the word, not the status code. `/recover` answers
      // 200 for every outcome it has — including `errand` ("nothing was
      // launched, a person is needed") and `nothing-to-do` — so a blanket
      // success toast reported that a wedged run had been recovered when
      // nothing had happened at all. Measured: an operator pressed this three
      // times, was told "done" three times, and the run never moved.
      const stalled = result?.outcome === 'errand' || result?.outcome === 'nothing-to-do';
      toast(
        result?.detail ?? `${action.label} — done.`,
        stalled ? 'warn' : 'ok',
        // A refusal is a thing to read, not a thing to glimpse.
        stalled ? 8000 : undefined,
      );
    },
  });

  const acknowledge = useApiMutation<InboxItem, boolean>({
    fn: async (item) => {
      if (item.ack) await api.inboxUnack(item.id);
      else await api.inboxAck(item.id);
      return Boolean(item.ack);
    },
    invalidates,
    say: (wasAcked) =>
      wasAcked
        ? 'Back in the list.'
        : // Said out loud because it is the one verb here that does NOT fix
          // anything — an operator who reads "Acknowledged" as "handled" will
          // be surprised when it comes back with a newer clock.
          'Acknowledged — seen, not cleared. It returns if it changes.',
  });

  const unackMany = useApiMutation<{ ids: string[]; onUndone?: () => void }, unknown>({
    fn: ({ ids }) => api.inboxUnackMany(ids),
    invalidates,
    say: 'Back in the list.',
    onDone: (_result, { onUndone }) => onUndone?.(),
  });

  const ackAll = useApiMutation<
    { ids: string[]; onUndone?: () => void },
    Awaited<ReturnType<typeof api.inboxAckMany>>
  >({
    fn: ({ ids }) => api.inboxAckMany(ids),
    invalidates,
    onDone: (result, { ids, onUndone }) => {
      const failed = result.results.filter((row) => !row.ok);
      if (failed.length) {
        // One refusal must not hide behind fifteen successes — the whole
        // reason the endpoint answers per item.
        toast(
          `${result.acked ?? 0} acknowledged, ${failed.length} refused: ${failed[0]?.error ?? 'unknown'}`,
          'warn',
          8000,
        );
        return;
      }
      // Long enough to actually undo. The default 2.6s is a confirmation;
      // an offer you have to read first is not the same thing.
      toast(`${ids.length} acknowledged — seen, not cleared.`, 'ok', 10000, {
        label: 'Undo',
        onSelect: () => unackMany.mutate({ ids, ...(onUndone ? { onUndone } : {}) }),
      });
    },
  });

  const perform = useCallback(
    (item: InboxItem, action: InboxAction, says?: string) => {
      if (action.flag) return;
      act.mutate({ item, action, ...(says !== undefined ? { says } : {}) });
    },
    [act],
  );

  const ack = useCallback((item: InboxItem) => acknowledge.mutate(item), [acknowledge]);

  const ackMany = useCallback(
    (items: InboxItem[], onUndone?: () => void) => {
      // Acknowledging something already acknowledged is a no-op the server
      // would happily perform; excluding it here is what keeps Undo exact.
      const fresh = items.filter((item) => !item.ack).map((item) => item.id);
      if (!fresh.length) {
        toast('Those are all acknowledged already.', 'warn');
        return;
      }
      ackAll.mutate({ ids: fresh, ...(onUndone ? { onUndone } : {}) });
    },
    [ackAll],
  );

  /*
   * One press in flight at a time, keyed `${item.id}:${verb}`, so a row cannot
   * be double-fired and the button that is working says so. It is a KEY and
   * not a boolean because the answer the row needs is "which button", and the
   * only place that fact lives is the variables of whichever single-item
   * mutation is running.
   */
  const busy =
    act.isPending && act.variables
      ? `${act.variables.item.id}:${act.variables.action.verb}`
      : acknowledge.isPending && acknowledge.variables
        ? `${acknowledge.variables.id}:ack`
        : undefined;

  return {
    perform,
    ack,
    ackMany,
    bulkBusy: ackAll.isPending || unackMany.isPending,
    ...(busy ? { busy } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * The row
 * ------------------------------------------------------------------ */

export interface InboxRowProps {
  item: InboxItem;
  /** Keyboard triage: this row is the cursor. */
  selected?: boolean;
  onSelect?: () => void;
  perform: (item: InboxItem, action: InboxAction) => void;
  ack?: (item: InboxItem) => void;
  /** `${item.id}:${verb}` of whatever is in flight. */
  busy?: string;
  /**
   * Multi-select: whether this row is TICKED.
   *
   * Deliberately not `selected`, which this row has meant "is the keyboard
   * cursor" since 3.0 and which several tests read as `data-selected`. Two
   * different questions — where am I, and what have I picked — and a row can
   * answer them differently at the same time.
   */
  checked?: boolean;
  /** Present ⟺ this surface offers selection at all. `#/approve` does not. */
  onCheck?: (extend: boolean) => void;
  /** Drop the plan/phase line — the drawer already groups by nothing else. */
  compact?: boolean;
  onOpen?: (href: string) => void;
  /**
   * Where the title links, when the row does not live on this console — a list
   * merged across consoles links each row under its console's mount
   * (`/c/<id>/#/…`), which `toHash` would fold into a hash of THIS page.
   * Default: `toHash(item.href)`.
   */
  hrefFor?: (item: InboxItem) => string;
}

export function InboxRow({
  item,
  selected = false,
  onSelect,
  perform,
  ack,
  busy,
  checked = false,
  onCheck,
  compact = false,
  onOpen,
  hrefFor,
}: InboxRowProps) {
  const [open, setOpen] = useState(false);
  const { primary, rest } = splitActions(item);
  const ui = SEVERITY_UI[item.severity] ?? 'queued';
  const since = Date.parse(item.since);
  // A relayed question's window (phase 14): the console answers by rule when it closes.
  const windowLeft = useWindowLeft(item.expiresAt);
  const href = hrefFor ? hrefFor(item) : toHash(item.href);
  // On a list merged across consoles the console comes first — "which console"
  // is the question before "which plan".
  const where = [item.console?.name, item.slug, item.phase != null ? `phase ${item.phase}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <li
      data-testid="inbox-row"
      data-kind={item.kind}
      data-severity={item.severity}
      data-selected={selected || undefined}
      data-checked={checked || undefined}
      // `state-<ui>` paints the border and every `tone="state"` badge inside it
      // from the ONE status vocabulary — there is no second severity palette.
      className={cn(
        `state-${ui}`,
        'flex flex-col gap-2 rounded-lg border bg-surface px-3 py-2.5',
        item.ack ? 'border-rule opacity-70' : 'border-state/45',
        selected && 'ring-2 ring-action/60',
        // Ticked reads as a quiet shift, not an alarm — amber is reserved for
        // "this needs you", and picking a row has not made it more urgent.
        checked && 'bg-surface-raised shadow-[inset_2px_0_0_0_var(--color-queued)]',
      )}
      onFocusCapture={onSelect}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {onCheck && (
          <Checkbox
            checked={checked}
            // Radix hands back the next state; the range press needs the
            // modifier, which only the raw event carries.
            onClick={(event) => onCheck(event.shiftKey)}
            onCheckedChange={() => {}}
            className="mt-1 shrink-0"
            aria-label={`${checked ? 'Unpick' : 'Pick'} ${item.title}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <StatusBadge state={ui} label={INBOX_KIND_LABELS[item.kind] ?? item.kind} />
            <a
              href={href}
              onClick={(event) => {
                if (!onOpen) return;
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                onOpen(href);
              }}
              /*
               * `min-w-48` is the title saying what it is worth, and it is the
               * fix for a whole family of rows in this client.
               *
               * `min-w-0` alone means "I will shrink to nothing", and beside a
               * `shrink-0` badge and a `shrink-0` timestamp that is exactly
               * what happened: at 360 the title kept 90px — `A session i…` —
               * while the 100px clock stayed whole. The one thing that says
               * WHICH errand this is was the only thing giving way, in a row
               * whose entire job is to be scanned.
               *
               * A floor turns that round. The container already wraps, so the
               * timestamp takes the next line rather than the title taking the
               * ellipsis, and `truncate` still handles the genuinely long name.
               */
              className="min-w-48 flex-1 truncate font-medium text-ink hover:text-action"
              title={item.title}
            >
              {item.title}
            </a>
            {/* An empty `since` is a fact with no clock (an account is signed
                out; nothing records WHEN), never "just now". Saying nothing is
                the honest rendering — see `InboxItem.since`. */}
            {Number.isFinite(since) && (
              <RelativeTime at={since} className="shrink-0 text-2xs text-ink-faint" />
            )}
            {/* A window is a clock that ends in somebody else's answer, so it
                is shown ticking — "55 s" that never moved would read as time
                in hand after the console had already answered by rule. */}
            {windowLeft !== null && (
              <span data-testid="inbox-window" className="shrink-0 font-mono text-2xs text-ink-muted">
                {windowLeft > 0 ? `${windowLeft} s to answer` : 'answering by rule'}
              </span>
            )}
          </div>

          <p className="mt-0.5 line-clamp-2 text-2xs text-ink-muted md:line-clamp-none">{item.need}</p>

          {!compact && where && <p className="mt-0.5 font-mono text-2xs text-ink-faint">{where}</p>}
        </div>
      </div>

      {(item.how || item.tried?.length) && (
        <div>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex items-center gap-1 text-2xs text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
          >
            <ChevronRight size={12} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
            {open ? 'Hide how' : 'How'}
            {item.tried?.length ? ` · ${item.tried.length} already tried` : ''}
          </button>
          {open && (
            <div className="mt-1 rounded border border-rule bg-ground px-2 py-1.5 text-2xs">
              <p className="text-ink-muted">{item.how}</p>
              {item.tried?.length ? (
                <>
                  <p className="mt-1.5 text-ink-faint">Already tried, so nobody tries it again by hand:</p>
                  <ul className="mt-0.5 flex flex-col gap-0.5 text-ink-muted">
                    {item.tried.map((line) => (
                      <li key={line}>· {line}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {primary && (
          <ActionButton item={item} action={primary} primary perform={perform} busy={busy} index={1} />
        )}
        {rest.map((action, i) => (
          <ActionButton
            key={action.verb}
            item={item}
            action={action}
            perform={perform}
            busy={busy}
            index={primary ? i + 2 : i + 1}
          />
        ))}
        <Button size="sm" variant="ghost" asChild>
          <a
            href={href}
            onClick={(event) => {
              if (!onOpen) return;
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              onOpen(href);
            }}
          >
            <ExternalLink size={12} aria-hidden />
            Open
          </a>
        </Button>
        {ack && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={busy === `${item.id}:ack`}
            onClick={() => ack(item)}
            title={
              item.ack
                ? 'Put it back in the list.'
                : 'Seen, not cleared — it comes back if the thing it is about changes.'
            }
          >
            {item.ack ? 'Unacknowledge' : 'Acknowledge'}
          </Button>
        )}
      </div>

      {/* Said once per row rather than per button: three buttons each repeating
          "--allow-run is off" is noise, and none of them says it where a screen
          reader would reach it. */}
      {item.actions.some((action) => action.flag) && (
        <p className="text-2xs text-ink-faint">
          {[...new Set(item.actions.map((a) => flagReason(a.flag)).filter(Boolean))].join(' ')}
        </p>
      )}
    </li>
  );
}

/**
 * One remedy.
 *
 * `index` is the number the keyboard fires (`1`, `2`, `3`) and it is on the
 * button as a hint rather than in a legend somewhere else: a shortcut nobody
 * can see is a shortcut nobody uses.
 */
function ActionButton({
  item,
  action,
  primary = false,
  perform,
  busy,
  index,
}: {
  item: InboxItem;
  action: InboxAction;
  primary?: boolean;
  perform: (item: InboxItem, action: InboxAction) => void;
  busy?: string;
  index: number;
}) {
  const reason = flagReason(action.flag);
  return (
    <Button
      size="sm"
      variant={primary ? 'action' : 'default'}
      disabled={Boolean(action.flag) || busy === `${item.id}:${action.verb}`}
      title={reason}
      data-verb={action.verb}
      onClick={() => perform(item, action)}
    >
      {action.label}
      {index <= 3 && !action.flag && (
        <Badge tone="neutral" mono className="border-transparent px-1 py-0 text-ink-faint">
          {index}
        </Badge>
      )}
    </Button>
  );
}
