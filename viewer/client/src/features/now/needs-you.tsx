/**
 * **Needs you** — the first thing on the home page, and the only place on it
 * that may be amber.
 *
 * ## What earns a row
 *
 * Not this file's decision. `GET /api/inbox` is one deduped list built by one
 * pure function from facts the server already had — the ladder's errands, the
 * permission cards, the gates, the sign-ins, the MCP walls, the QA verdicts,
 * the lock debris, the stalls, the rulings and the console's own health. Eight
 * surfaces used to answer "is anything waiting on me?" and none of them could
 * be counted, because nothing could say whether a halted-run card, the errand
 * under it and the push that announced it were three asks or one.
 *
 * So the section renders what it is sent, in the order it is sent, and the one
 * thing it adds is the ability to answer without leaving the page.
 *
 * ## Triage without a mouse
 *
 * `j`/`k` move, `1`/`2`/`3` press the row's first three remedies, `Enter`
 * opens where it lives. The numbers are printed on the buttons rather than in
 * a legend, because a shortcut nobody can see is a shortcut nobody uses. Keys
 * are ignored while a field has focus — a page that eats `j` in a search box
 * is a page you stop typing in. The guard is `isTypingTarget` from
 * `lib/shortcut.ts`, shared with the palette, because four copies of "is a
 * person typing" is four chances for one of them to be subtly wrong.
 *
 * The handler stays on the LIST rather than on the window: `j` and `x` are
 * bare letters, and a bare letter claimed globally is a letter every other
 * surface on the page has lost. `useShortcut` is for chords that mean the same
 * thing from anywhere, which these deliberately do not.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  Badge,
  Button,
  CountBadge,
  Empty,
  Kbd,
  SectionHeading,
  Skeleton,
} from '@/components/ui';
import { useNavigate } from '@/app/router';
import { scrollIntoScroller } from '@/lib/scroll';
import { isTypingTarget } from '@/lib/shortcut';
import { plural } from '@/lib/format';
import { plansHref, settingsHref } from '@/app/routes';
import type { ConvergeStatusView, InboxItem } from '@/lib/api';
import { useFocusBand } from './focus-band';
import { InboxRow, useInboxActions } from './inbox-row';
import { inboxCounts } from './model';
import { useSelection, sharedVerbs } from './selection';
import { SelectionBar } from './selection-bar';

/**
 * When the loop next looks at all this by itself.
 *
 * The empty state's whole job. "Nothing needs you" on its own reads as "and
 * nothing ever will" — an operator who has watched the console park a run
 * wants to know whether anything is coming back round. A console where the
 * loop is manual says THAT instead, which is a different and more useful fact.
 */
export function nextSweepText(converge: ConvergeStatusView | undefined): string {
  if (!converge) return 'The convergence loop re-reads the board whenever anything changes.';
  if (!converge.automatic) {
    return 'Convergence is manual on this console (runs are off, or --no-converge) — Recover & continue runs a pass.';
  }
  const every = converge.everyMs > 0 ? ` and every ${Math.round(converge.everyMs / 60_000)} min` : '';
  const queued = converge.pending.length ? ` ${plural(converge.pending.length, 'pass')} queued.` : '';
  return `The loop sweeps at boot, on a docs change, a minute after a stop${every}.${queued}`;
}

export interface NeedsYouProps {
  items: InboxItem[] | undefined;
  loading: boolean;
  /** The endpoint is missing (an older server) — say so rather than "all clear". */
  unavailable?: boolean;
  converge?: ConvergeStatusView;
  /** Show acknowledged rows too. */
  showAcked: boolean;
  onShowAcked: (next: boolean) => void;
  /**
   * `?focus=inbox` landed here — scroll the band into view AND take the
   * keyboard without a click.
   *
   * It only did the second thing, which on a page whose first band is already
   * at the top looked like nothing at all — and on a phone, where the strip
   * above it is a screenful, looked like a deep link that had been ignored.
   * The other three bands have scrolled since `useFocusBand` shipped.
   */
  autoFocus?: boolean;
}

export function NeedsYou({
  items,
  loading,
  unavailable = false,
  converge,
  showAcked,
  onShowAcked,
  autoFocus = false,
}: NeedsYouProps) {
  const navigate = useNavigate();
  const { perform, ack, ackMany, busy, bulkBusy } = useInboxActions();
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const rows = useMemo(() => items ?? [], [items]);
  const counts = inboxCounts(rows);
  const pick = useSelection(rows);
  const picked = useMemo(() => rows.filter((row) => pick.has(row.id)), [rows, pick]);
  const verbs = useMemo(() => sharedVerbs(picked), [picked]);
  // Held until confirmed. A bulk remedy is not a bulk annotation: pressing
  // "Recover & continue" on four errands starts four sessions and spends
  // money, and a toolbar button is too small a gesture for that.
  const [confirming, setConfirming] = useState<{ verb: string; label: string } | null>(null);

  const runVerb = useCallback(
    (verb: string) => {
      for (const item of picked) {
        const action = item.actions?.find((candidate) => candidate.verb === verb && !candidate.flag);
        if (action) perform(item, action);
      }
      pick.clear();
    },
    [picked, perform, pick],
  );

  // Never point past the end after a row is answered and the list shortens.
  const index = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1);
  const current = rows[index];

  const move = useCallback(
    (delta: number) => {
      setCursor((c) => {
        const next = Math.max(0, Math.min(rows.length - 1, c + delta));
        const el = listRef.current?.children[next];
        // NEVER `scrollIntoView`: it scrolls every scrollable ancestor, which
        // on a phone is the sideways yank Phase 1 banned. `scrollIntoScroller`
        // finds the one scroller that owns the element.
        if (el) scrollIntoScroller(el, 'nearest');
        return next;
      });
    },
    [rows.length],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (!current) return;
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        navigate(current.href);
      } else if (event.key === 'x') {
        // Gmail's key, and Superhuman's, for the same reason: it is under the
        // left hand while j/k are under the right.
        event.preventDefault();
        pick.toggle(current.id);
        move(1);
      } else if (event.key === 'J' || event.key === 'K') {
        // Shift+j/k extends: move the cursor and take the row with it, which
        // is the keyboard's version of a shift-click range.
        event.preventDefault();
        const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'J' ? 1 : -1)))];
        pick.toggle(current.id);
        if (next && next.id !== current.id) pick.toggle(next.id);
        move(event.key === 'J' ? 1 : -1);
      } else if (event.key === 'a') {
        event.preventDefault();
        pick.toggleAll();
      } else if (event.key === 'Escape' && pick.count > 0) {
        event.preventDefault();
        pick.clear();
      } else if (event.key === '1' || event.key === '2' || event.key === '3') {
        const action = current.actions?.[Number(event.key) - 1];
        // A flagged action is not pressable by mouse either; the key does the
        // same nothing rather than a different nothing.
        if (!action || action.flag) return;
        event.preventDefault();
        perform(current, action);
      }
    },
    [current, index, rows, move, navigate, perform, pick],
  );

  // The band scrolls (`useFocusBand`, like the other three) AND the list takes
  // the keyboard, which is the half this band adds: arriving here means "these
  // are the things waiting on you", and the next keystroke should already be
  // triage.
  const bandRef = useFocusBand<HTMLElement>(autoFocus);
  const tookKeyboard = useRef(false);
  useEffect(() => {
    if (!autoFocus) {
      tookKeyboard.current = false;
      return;
    }
    // `rows.length` is in the deps because the list does not EXIST on the first
    // paint: the inbox is a network read, so on arrival this ran once against a
    // skeleton, found no `<ul>`, and — `autoFocus` never changing again — never
    // ran a second time. `#/now?focus=inbox` therefore focused nothing at all
    // for the life of the parameter.
    if (tookKeyboard.current || !listRef.current) return;
    tookKeyboard.current = true;
    // `preventScroll`, because `useFocusBand` owns the scrolling: a plain
    // `.focus()` moves every scrollable ancestor, which is the sideways yank
    // `scrollIntoScroller` exists to avoid.
    listRef.current.focus({ preventScroll: true });
  }, [autoFocus, rows.length]);

  if (loading && !items) {
    return (
      <Section
        counts={counts}
        showAcked={showAcked}
        onShowAcked={onShowAcked}
        bandRef={bandRef}
        focused={autoFocus}
      >
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </Section>
    );
  }

  if (unavailable) {
    return (
      <Section
        counts={counts}
        showAcked={showAcked}
        onShowAcked={onShowAcked}
        bandRef={bandRef}
        focused={autoFocus}
      >
        <Empty
          icon={<Inbox size={22} />}
          title="This server has no inbox"
          body="It predates the unified inbox, so this console cannot say what is waiting on you. Restart it from Settings to pick the newer server up."
          action={
            <Button asChild>
              <a href={settingsHref('instance')}>Restart the console</a>
            </Button>
          }
        />
      </Section>
    );
  }

  if (!rows.length) {
    return (
      <Section
        counts={counts}
        showAcked={showAcked}
        onShowAcked={onShowAcked}
        bandRef={bandRef}
        focused={autoFocus}
      >
        <Empty
          icon={<Inbox size={22} />}
          title={showAcked ? 'Nothing at all, acknowledged or otherwise' : 'Nothing needs you'}
          body={nextSweepText(converge)}
          action={
            // Two different rooms. With acknowledgements hidden the useful next
            // move is to look under them; with nothing there at all the useful
            // next move is to go and start something.
            showAcked ? (
              <Button asChild>
                <a href={plansHref()}>Open Plans</a>
              </Button>
            ) : (
              <Button onClick={() => onShowAcked(true)}>Show acknowledged</Button>
            )
          }
        />
      </Section>
    );
  }

  return (
    <Section
      counts={counts}
      showAcked={showAcked}
      onShowAcked={onShowAcked}
      bandRef={bandRef}
      focused={autoFocus}
    >
      <ul
        ref={listRef}
        tabIndex={0}
        role="list"
        aria-label="Things that need you"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-2 outline-none focus-visible:ring-2 focus-visible:ring-action/50"
      >
        {rows.map((item, i) => (
          <InboxRow
            key={item.id}
            item={item}
            selected={i === index}
            onSelect={() => setCursor(i)}
            checked={pick.has(item.id)}
            onCheck={(extend) => {
              setCursor(i);
              pick.toggle(item.id, extend);
            }}
            perform={perform}
            ack={ack}
            {...(busy ? { busy } : {})}
            onOpen={(href) => navigate(href)}
          />
        ))}
      </ul>

      <SelectionBar
        className="mt-2"
        count={pick.count}
        state={pick.state}
        onToggleAll={pick.toggleAll}
        onClear={pick.clear}
        verbs={verbs}
        onVerb={(verb) => {
          const found = verbs.find((v) => v.verb === verb);
          if (found) setConfirming(found);
        }}
        onAcknowledge={() => {
          // The set is restored on undo, so the rows come back ticked and the
          // operator is where they left off rather than at the top of a list.
          const undo = pick.ids;
          ackMany(picked, () => pick.restore(undo));
          pick.clear();
        }}
        allAcked={picked.length > 0 && picked.every((item) => item.ack)}
        busy={bulkBusy}
      />

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        {confirming && (
          <AlertDialogContent
            title={`${confirming.label} on ${plural(picked.length, 'ask')}?`}
            description={
              // Named, not counted. "4 asks" is a number; the list is what tells
              // you whether you picked the four you meant to.
              <>
                This presses {confirming.label} once for each of {picked.map((item) => item.title).join(', ')}
                . Some remedies start a session and spend money.
              </>
            }
            confirmLabel={confirming.label}
            onConfirm={() => {
              runVerb(confirming.verb);
              setConfirming(null);
            }}
          />
        )}
      </AlertDialog>

      <p className="mt-1.5 flex flex-wrap items-center gap-1 text-2xs text-ink-faint">
        <Kbd>j</Kbd>
        <Kbd>k</Kbd> to move · <Kbd>1</Kbd>–<Kbd>3</Kbd> to act · <Kbd>Enter</Kbd> to open · <Kbd>x</Kbd> to
        pick
      </p>
    </Section>
  );
}

function Section({
  counts,
  showAcked,
  onShowAcked,
  bandRef,
  focused = false,
  children,
}: {
  counts: ReturnType<typeof inboxCounts>;
  showAcked: boolean;
  onShowAcked: (next: boolean) => void;
  bandRef?: React.Ref<HTMLElement>;
  /** `data-focused` is what the tests read and what a later stylesheet flashes. */
  focused?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      ref={bandRef}
      aria-label="Needs you"
      data-testid="needs-you"
      {...(focused ? { 'data-focused': 'true' } : {})}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* The one amber heading on the page: this band, and only this band,
            is about something blocked on a person. */}
        <SectionHeading tone="action">Needs you</SectionHeading>
        {/* `CountBadge` has no red tone on purpose — the vocabulary's red is a
            STATE, not a count. An urgent total is a word plus a number. */}
        {counts.urgent > 0 && (
          <Badge tone="bad" mono>
            {counts.urgent} urgent
          </Badge>
        )}
        {counts['needs-you'] > 0 && <CountBadge count={counts['needs-you']} tone="accent" label="waiting" />}
        {counts.fyi > 0 && <CountBadge count={counts.fyi} tone="neutral" label="for information" />}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-pressed={showAcked}
          onClick={() => onShowAcked(!showAcked)}
        >
          {showAcked ? 'Hide acknowledged' : 'Show acknowledged'}
        </Button>
      </div>
      {children}
    </section>
  );
}
