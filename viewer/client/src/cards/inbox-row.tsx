/**
 * One thing that needs a person — the row, and the one place a remedy is
 * performed (7.0 in quiet-console phase 5).
 *
 * ## What the row is allowed to decide
 *
 * Almost nothing. `server/inbox.ts` decided which item exists, how loud it is,
 * what is needed, how to give it, what was already tried, and which remedies
 * apply — including which of them this console cannot perform (`action.flag`).
 * `splitActions` decides which remedy leads. This file renders that and
 * performs a press.
 *
 * The one rule it owns is a rendering rule: **a remedy that cannot be taken is
 * shown, disabled, with the reason** — never hidden. A console started without
 * `--allow-run` still has to be told its run is parked on a permission card;
 * hiding the button because it would not work is the dead end these rows were
 * built to end.
 *
 * ## A press goes through the owner door
 *
 * Every verb here — a remedy, an acknowledgement, a bulk acknowledgement —
 * goes through `press()` (`data/press.ts`), the one place a 202 `{requested}`
 * is told from a done press and a 401 `{reassert}` touches the owner key once.
 * A press the owner must confirm is said ONCE, here, as asked of the owner —
 * never as done.
 */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { INBOX_KIND_LABELS, SEVERITY_UI } from '@shared/attention-model.js';
import { OPERATOR_ISSUE_SCOPE } from '@shared/issue-modes.js';
import { api, flagReason, splitActions, type InboxAction, type InboxItem } from '@/data/api';
import { keys } from '@/data/keys';
import { press, type Pressed } from '@/data/press';
import { useWindowLeft } from '@/ui/clock';
import { cn } from '@/lib/cn';
import { navigate, sessionsHref, toHash } from '@/shell/routes';
import { Button, RelativeTime, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Disclosure } from '@/ui/disclosure';
import { MicField } from '@/ui/mic-field';
// By its own path, never the family's index: it reads no status table.
import { SeverityMark } from '@/ui/status/severity';
import { LazyStepCard } from './lazy-step-card';
import { nextStepOf, setNextStep } from './next-step';
import { NextStepNote } from './next-step-note';
import { TurnRowWords } from './turn/row-words';

/* ------------------------------------------------------------------ *
 * Performing one
 * ------------------------------------------------------------------ */

/** A refusal in the server's own words — the honest floor when it said nothing. */
const failed = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : 'The press failed and said nothing.';

/**
 * Press a remedy, acknowledge an item, or put an acknowledgement back.
 *
 * Three rules:
 *
 *  - **one press in flight per row and verb**, keyed `${item.id}:${verb}`, so
 *    a row cannot be double-fired and the button that is working says so;
 *  - **the result is a toast, always, including the failures** — a row that
 *    silently does nothing is what these were before;
 *  - **the inbox is re-read when the press settles**, failed or not, because
 *    the case where re-reading matters most is the one where the request
 *    failed: a card answered in another tab 404s here, and without the re-read
 *    the phantom stays on screen and the next press 404s again.
 *
 * The endpoint, the method and the body are the SERVER's words, taken off the
 * action verbatim. Nothing here maps a verb to a URL.
 */
export function useInboxActions(): {
  /**
   * `says` is the operator's own words, and it only goes anywhere when the
   * ACTION declared a field for them (`InboxAction.says`). Resolves `true`
   * once the server did it — never for a press asked of the owner, a refusal
   * or a flagged action — so a card can hold itself as sent.
   */
  perform: (item: InboxItem, action: InboxAction, says?: string) => Promise<boolean>;
  ack: (item: InboxItem) => void;
  /**
   * Acknowledge a whole selection, with an undo. Only what this press changed
   * is what Undo changes back: an item acknowledged days ago stays so.
   */
  ackMany: (items: InboxItem[], onUndone?: () => void) => void;
  /** Put acknowledged rows back in the list — the bar's *Put back*. */
  unackMany: (ids: string[], onUndone?: () => void) => void;
  busy?: string;
  /** True while a bulk press is in flight — the bar disables itself on it. */
  bulkBusy: boolean;
} {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [bulkBusy, setBulkBusy] = useState(false);

  /*
   * `keys.afterInboxAct()` is the bundle, not five keys written out again. It
   * is the widest one in the console and honestly so: an inbox verb can
   * approve a permission, recover a run, unblock a phase and clear a badge in
   * one press.
   */
  const reread = useCallback(() => {
    for (const queryKey of keys.afterInboxAct()) void client.invalidateQueries({ queryKey });
  }, [client]);

  const perform = useCallback(
    (item: InboxItem, action: InboxAction, says?: string): Promise<boolean> => {
      if (action.flag) return Promise.resolve(false);
      setBusy(`${item.id}:${action.verb}`);
      return press(() => api.inboxAct(action, says) as Promise<{ outcome?: string; detail?: string } | null>)
        .then((pressed: Pressed<{ outcome?: string; detail?: string } | null>) => {
          if (pressed.state === 'asked') {
            // A 2xx that did nothing yet: the owner confirms it on Your turn.
            toast(`${action.label} — asked of the owner.`, 'info', 8000);
            return false;
          }
          // The RESULT decides the word, not the status code. `/recover`
          // answers 200 for every outcome it has — including `errand` ("a
          // person is needed") and `nothing-to-do` — so a blanket success
          // toast once reported a wedged run recovered when nothing happened.
          const result = pressed.result;
          // An answer that is a next step (#368) — a sign-in's terminal, an
          // errand tree's paths — is read the way the verb's own page reads it
          // and kept on the card; a terminal is opened at once.
          const stalled = result?.outcome === 'errand' || result?.outcome === 'nothing-to-do';
          const next = nextStepOf(action, result, sessionsHref);
          setNextStep(item.id, next);
          if (next) {
            toast(next.words, stalled ? 'warn' : 'info', 8000);
            if (next.href) navigate(next.href);
            // A next step is more for the person to do, not a press the item is settled by.
            return false;
          }
          toast(
            result?.detail ?? `${action.label} — done.`,
            stalled ? 'warn' : 'ok',
            stalled ? 8000 : undefined,
          );
          return !stalled;
        })
        .catch((cause: unknown) => {
          toast(failed(cause), 'error');
          return false;
        })
        .finally(() => {
          setBusy(undefined);
          reread();
        });
    },
    [reread],
  );

  const ack = useCallback(
    (item: InboxItem) => {
      const wasAcked = Boolean(item.ack);
      setBusy(`${item.id}:ack`);
      press(() => (wasAcked ? api.inboxUnack(item.id) : api.inboxAck(item.id)))
        .then((pressed) => {
          if (pressed.state === 'asked') toast(pressed.words, 'info', 8000);
          else
            toast(
              wasAcked
                ? 'Back in the list.'
                : // Said out loud because it is the one verb here that does
                  // NOT fix anything: it comes back with a newer clock.
                  'Acknowledged — seen, not cleared. It returns if it changes.',
              'ok',
            );
        })
        .catch((cause: unknown) => toast(failed(cause), 'error'))
        .finally(() => {
          setBusy(undefined);
          reread();
        });
    },
    [reread],
  );

  const unackMany = useCallback(
    (ids: string[], onUndone?: () => void) => {
      setBulkBusy(true);
      press(() => api.inboxUnackMany(ids))
        .then(() => {
          toast('Back in the list.', 'ok');
          onUndone?.();
        })
        .catch((cause: unknown) => toast(failed(cause), 'error'))
        .finally(() => {
          setBulkBusy(false);
          reread();
        });
    },
    [reread],
  );

  const ackMany = useCallback(
    (items: InboxItem[], onUndone?: () => void) => {
      // Acknowledging something already acknowledged is a no-op the server
      // would happily perform; excluding it here is what keeps Undo exact.
      const ids = items.filter((item) => !item.ack).map((item) => item.id);
      if (!ids.length) {
        toast('Those are all acknowledged already.', 'warn');
        return;
      }
      setBulkBusy(true);
      press(() => api.inboxAckMany(ids))
        .then((pressed) => {
          if (pressed.state === 'asked') {
            toast(pressed.words, 'info', 8000);
            return;
          }
          const refused = pressed.result.results.filter((row) => !row.ok);
          if (refused.length) {
            // One refusal must not hide behind fifteen successes — the whole
            // reason the endpoint answers per item.
            toast(
              `${pressed.result.acked ?? 0} acknowledged, ${refused.length} refused: ${refused[0]?.error ?? 'unknown'}`,
              'warn',
              8000,
            );
            return;
          }
          // Long enough to actually undo: an offer you have to read first is
          // not a confirmation.
          toast(`${ids.length} acknowledged — seen, not cleared.`, 'ok', 10000, {
            label: 'Undo',
            onSelect: () => unackMany(ids, onUndone),
          });
        })
        .catch((cause: unknown) => toast(failed(cause), 'error'))
        .finally(() => {
          setBulkBusy(false);
          reread();
        });
    },
    [reread, unackMany],
  );

  return { perform, ack, ackMany, unackMany, bulkBusy, ...(busy ? { busy } : {}) };
}

/* ------------------------------------------------------------------ *
 * The row
 * ------------------------------------------------------------------ */

export interface InboxRowProps {
  item: InboxItem;
  /** Keyboard triage: this row is the cursor. */
  selected?: boolean;
  onSelect?: () => void;
  perform: (item: InboxItem, action: InboxAction, says?: string) => void;
  ack?: (item: InboxItem) => void;
  /** `${item.id}:${verb}` of whatever is in flight. */
  busy?: string;
  /**
   * Multi-select: whether this row is TICKED — a different question from
   * `selected` (where am I), and a row can answer them differently.
   */
  checked?: boolean;
  /** Present ⟺ this surface offers selection at all. */
  onCheck?: (extend: boolean) => void;
  /** Drop the plan and phase words — a narrow list whose titles already name the plan. */
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

/** A plain left press on a link: the row navigates in place; any modifier keeps the browser's own. */
const plainPress = (event: React.MouseEvent) =>
  !(event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0);

/**
 * One line per thing (design.md §1): the kind and how loudly it asks, the
 * name, one clock — then what is needed, and the remedies. Its leading edge
 * wears the severity's paint, so a summons reads from the edge of the list; an
 * acknowledged row loses it, seen and quiet, and stays a row.
 */
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
  const [said, setSaid] = useState('');
  const { primary, rest } = splitActions(item);
  const says = item.actions.find((action) => action.says)?.says;
  const paint = SEVERITY_UI[item.severity] ?? 'queued';
  const since = Date.parse(item.since);
  // A relayed question's window (phase 14): the console answers by rule when it
  // closes. Only a question's — any other row's clock is not an answer by rule (#341).
  const windowLeft = useWindowLeft(item.kind === 'question' ? item.expiresAt : undefined);
  const href = hrefFor ? hrefFor(item) : toHash(item.href);
  // An operator's own issue draft belongs to no plan: its slug is the ledger's
  // name, `_operator`, which says nothing to a person.
  const scope = item.slug === OPERATOR_ISSUE_SCOPE ? 'from the issues board' : item.slug;
  // On a list merged across consoles the console comes first — "which console"
  // is the question before "which plan".
  const where = [item.console?.name, scope, item.phase != null ? `phase ${item.phase}` : null].filter(
    Boolean,
  );
  // A person's turn — a ledger step or a card folded into its family — draws
  // as ONE card, folded to its row and expanded in place. The row keeps its
  // edge, its pick, its link and its acknowledgement; the card owns the rest.
  const step = item.humanStep;
  const reasons = [...new Set(item.actions.map((action) => flagReason(action.flag)).filter(Boolean))];
  const open = (event: React.MouseEvent) => {
    if (!onOpen || !plainPress(event)) return;
    event.preventDefault();
    onOpen(href);
  };

  return (
    <li
      data-testid="inbox-row"
      data-kind={item.kind}
      data-severity={item.severity}
      data-selected={selected || undefined}
      data-checked={checked || undefined}
      className={cn(
        `state-${paint}`,
        'flex min-w-0 flex-col gap-2 border-s-2 py-2.5 pe-1 ps-3',
        item.ack ? 'border-rule-strong' : 'border-state',
        selected && 'bg-surface-raised',
        // Ticked reads as a quiet shift, never as amber: picking a row has not
        // made it more urgent.
        checked && 'bg-surface-raised',
      )}
      onFocusCapture={onSelect}
    >
      <div className="flex min-w-0 items-start gap-3">
        {onCheck && (
          <Checkbox
            checked={checked}
            // Radix hands back the next state; the range press needs the
            // modifier, which only the raw event carries.
            onClick={(event) => onCheck(event.shiftKey)}
            onCheckedChange={() => {}}
            className="mt-1"
            aria-label={`${checked ? 'Unpick' : 'Pick'} ${item.title}`}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {/* The card's words first (turn-by-turn phase 10): NOW or NOT YET, and the type. */}
          <TurnRowWords turn={item.turn} />
          {step ? (
            <LazyStepCard
              item={item}
              variant="row"
              perform={perform}
              {...(busy ? { busy } : {})}
              className="min-w-0 flex-1"
            />
          ) : (
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <SeverityMark severity={item.severity}>
                  {INBOX_KIND_LABELS[item.kind] ?? item.kind}
                </SeverityMark>
                {/* The halt family of the stop, named by the server so this row
                  loads none of the family's tables. */}
                {item.category && (
                  <span
                    data-halt-category={item.category.word}
                    className="shrink-0 text-meta font-medium text-ink-muted"
                  >
                    {item.category.label}
                  </span>
                )}
                {/*
                 * `min-w-48` is the title saying what it is worth: beside a
                 * badge and a clock that cannot shrink, `min-w-0` alone shrank
                 * the one thing that says WHICH errand this is to nothing. The
                 * line wraps, so the clock takes the next line instead.
                 * `relative`: a positioned link hit-tests above the pick box's
                 * thumb-floor overlay, which overhangs its 16 px box.
                 */}
                <a
                  href={href}
                  onClick={open}
                  className="min-w-48 flex-1 truncate font-medium text-ink hover:underline relative"
                  title={item.title}
                >
                  {item.title}
                </a>
                {/* An empty `since` is a fact with no clock (an account signed
                  out; nothing records WHEN), never "just now". */}
                {Number.isFinite(since) && (
                  <RelativeTime at={since} className="shrink-0 text-meta text-ink-faint" />
                )}
                {/* A window ends in somebody else's answer, so it ticks. */}
                {windowLeft !== null && (
                  <span data-testid="inbox-window" className="shrink-0 text-meta text-ink-muted tabular-nums">
                    {windowLeft > 0 ? `${windowLeft} s to answer` : 'answering by rule'}
                  </span>
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 text-meta text-ink-muted md:line-clamp-none">{item.need}</p>
              {/* Muted, not faint: which console, plan and phase is read before acting. */}
              {!compact && where.length > 0 && (
                <p data-testid="inbox-where" className="mt-0.5 text-meta text-ink-muted">
                  {where.join(', ')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {!step && (item.how || item.tried?.length) && (
        <Disclosure
          label={item.tried?.length ? `How, and what was tried (${item.tried.length})` : 'How'}
          openLabel="Hide how"
          variant="inline"
          bodyClassName="mt-1 flex max-w-prose flex-col gap-1.5 text-meta"
        >
          <p className="text-ink-muted">{item.how}</p>
          {item.tried?.length ? (
            <>
              <p className="text-ink-muted">Already tried, so nobody tries it again by hand:</p>
              <ul className="flex list-disc flex-col gap-0.5 ps-4 text-ink-muted">
                {item.tried.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}
        </Disclosure>
      )}

      {/* The operator's words, when an action takes them: ONE box per row, not
          per button, named by the first action that takes words. A press sends
          it only to an action that declared a field; the rest carry nothing. */}
      {!step && says && (
        <MicField
          label={says.label}
          placeholder={says.placeholder}
          value={said}
          onChange={setSaid}
          disabled={Boolean(busy)}
        />
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {!step && primary && (
          <ActionButton item={item} action={primary} primary perform={perform} busy={busy} said={said} />
        )}
        {!step &&
          rest.map((action) => (
            <ActionButton
              key={action.verb}
              item={item}
              action={action}
              perform={perform}
              busy={busy}
              said={said}
            />
          ))}
        <Button size="sm" variant="ghost" asChild>
          <a href={href} onClick={open}>
            Open
          </a>
        </Button>
        {ack && (
          <Button
            size="sm"
            variant="ghost"
            className="ms-auto"
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
      {!step && reasons.length > 0 && <p className="text-meta text-ink-muted">{reasons.join(' ')}</p>}
      {/* What the last press answered that is a next step (#368), kept on the row. */}
      <NextStepNote id={item.id} />
    </li>
  );
}

/** One remedy, exactly as the server spelled it; disabled, with the reason, when its flag is off. */
function ActionButton({
  item,
  action,
  primary = false,
  perform,
  busy,
  said,
}: {
  item: InboxItem;
  action: InboxAction;
  primary?: boolean;
  perform: (item: InboxItem, action: InboxAction, says?: string) => void;
  busy?: string | undefined;
  /** The row's box, handed only to an action that declared a field for it. */
  said: string;
}) {
  return (
    <Button
      size="sm"
      variant={primary ? 'primary' : 'default'}
      disabled={Boolean(action.flag) || busy === `${item.id}:${action.verb}`}
      title={flagReason(action.flag)}
      data-verb={action.verb}
      onClick={() => (action.says ? perform(item, action, said) : perform(item, action))}
    >
      {busy === `${item.id}:${action.verb}` ? 'Working…' : action.label}
    </Button>
  );
}
