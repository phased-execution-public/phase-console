/**
 * The one sessions list — every process this console owns or can see.
 *
 * ## Four kinds, one list
 *
 * Until 3.0 there were two pages (`#/terminal`, `#/agent`), each showing the
 * half of the pty registry that was its own kind, and two OTHER surfaces that
 * knew about processes neither page did: the run page's lane strip, and the
 * session-presence registry's report of every `claude` alive on this machine.
 * Four lists, no page that answered "what is running right now".
 *
 * `sessionRows` folds all four into one vocabulary:
 *
 *   - **lane** — an autopilot lane of a live run. The console owns the process
 *     but not through the pty registry, so the row links to the run page,
 *     where its approvals, ask box and replay live.
 *   - **agent** / **shell** — a pty this console minted. `#/sessions/<id>` is
 *     its address, and the pane on that page is the terminal.
 *   - **foreign** — a `claude` the session-presence hook reported: someone's
 *     own CLI, another console's lane. The row says it exists, which was the
 *     whole point of it (it is what a scope conflict is) — and since Phase 8
 *     it also has a page, `#/sessions/<conversation id>`, from which the
 *     conversation can be RESUMED in a terminal here. Nothing takes over the
 *     tty of a `claude` someone else is typing at: there is no multiplexer in
 *     this tree, so resuming starts a second process on the same conversation,
 *     and the page says exactly that before it does it.
 *
 * The derivation is pure and exported so the fold is testable without a pty,
 * and it reuses `features/now`'s lane + foreign models rather than minting a
 * second vocabulary for the same facts — the `groupOf` rule from Phase 9.
 *
 * ## The strip is this list, collapsed
 *
 * `SessionStrip` is the same list rendered as one row above a pane: tabs on a
 * desktop (Radix owns the roving focus; `ui/tabs.tsx` adds the scroll-into-view
 * and the trailing fade a hidden-scrollbar strip needs), and on a phone **the
 * open session and a chevron** — the strip used to be 489 px of tabs at 390 px
 * with "New plan with AI" off the screen and nothing saying so. The chevron
 * opens a bottom sheet with every session, the open one's controls and facts,
 * and the actions that did not fit the row; the sheet is also where a phone
 * gets the explanations a desktop reads as hover titles (`hints`), since a
 * `title=` alone is unreachable by a finger.
 */

import { useState, type ReactNode } from 'react';
import { ArrowUpRight, Bot, ChevronDown, Cpu, Info, TerminalSquare, Users, X } from 'lucide-react';
import { phaseHref, planHref } from '@shared/routes.js';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { relativeTime } from '@/lib/format';
import {
  Duration,
  RelativeTime,
  Sheet,
  SheetContent,
  StatusBadge,
  StatusDot,
  Tabs,
  TabsList,
  TabsTrigger,
  asUiState,
} from '@/components/ui';
import { foreignVehicle, otherSessions, type NowLane } from '@/features/now/model';
import type { ForeignSession, PhaseTask, TerminalSession } from '@/lib/api';
import { TaskLine } from '@/features/runs/task-summary';
import { sessionsHref } from '@/app/routes';
import { sessionStateNote } from './session-controls';
import { SessionInspector } from './session-inspector';
import { phaseUiState, type UiState } from '@/lib/status-vocab';

/**
 * What the session controls and vitals mean — the sentences a desktop reads
 * as hover titles, said in the sheet on a phone.
 */
export const SESSION_HINTS: readonly string[] = [
  'Freeze stops the session’s processes where they stand (SIGSTOP), losing nothing; Continue resumes them mid-token.',
  'Stop sends SIGTERM and force-ends only after a 15-second grace it ignored; the record — and a session’s resume id — stay in the list.',
  'The clock is how long the session has run; an estimate beside it is the phase’s own, and past it the honest word is “over”.',
];

/* ---------------- the fold (pure, exported for tests) ---------------- */

/**
 * How the Sessions page GROUPS what it shows — a UI grouping, not a session's
 * kind. It was called `SessionKind`, which is also the name of
 * `server/terminal.ts`'s `'shell'|'claude'` (what a terminal session IS).
 * Two vocabularies under one name is how a reader ends up unifying the wrong
 * pair, so P23 renamed this one before anything else touched it.
 */
export type SessionGroupKind = 'lane' | 'agent' | 'shell' | 'foreign';

/**
 * The four kinds in list order, with the heading each group carries.
 *
 * `short` is the same word with the room a filter chip has: the headings are
 * sentences ("Other sessions on this machine") because a section explains
 * itself, and a chip cannot. Both live here so a fifth kind is one edit.
 */
export const SESSION_GROUPS: readonly {
  kind: SessionGroupKind;
  title: string;
  short: string;
  blurb: string;
}[] = [
  {
    kind: 'lane',
    title: 'Autopilot lanes',
    short: 'Lanes',
    blurb: 'Phases this console is running. The console, approvals and replay are on the run page.',
  },
  {
    kind: 'agent',
    title: 'Agent sessions',
    short: 'Agents',
    blurb: 'Interactive Claude sessions this console started.',
  },
  {
    kind: 'shell',
    title: 'Shells',
    short: 'Shells',
    blurb: 'Plain shells on this machine, from here or from a phone.',
  },
  {
    kind: 'foreign',
    title: 'Other sessions on this machine',
    short: 'Others',
    blurb:
      'Reported by the session-presence hook — someone’s own CLI, or another console’s lane. Open one to resume its conversation in a terminal here.',
  },
];

export interface SessionRow {
  /** Stable across re-sorts, which is what keys React. */
  key: string;
  kind: SessionGroupKind;
  label: string;
  /** The one-line "what it is" under the label. */
  detail?: string;
  /** What it is doing when not simply live — `ended`, `frozen`, `stopping…`. */
  note?: string | null;
  /** Where the row goes. */
  href: string;
  /** The pty id, when THIS console owns the process — what `#/sessions/:id` opens. */
  id?: string;
  /**
   * The CLAUDE conversation id, on a foreign row — a different thing from `id`,
   * which is a pty this console owns and can close.
   *
   * `#/sessions/<conversation>` opens it too: the session page resolves a pty
   * first, then a pty already resuming that conversation, then the registry
   * record — which is the page that offers to resume it. Kept apart from `id`
   * on purpose: a foreign session has no pty to close, and handing this to the
   * close button would offer an action that cannot exist.
   */
  sessionId?: string;
  live: boolean;
  /**
   * The row's own clock — what "N ago" reads off, and the recency the default
   * order uses. Epoch ms.
   *
   * Deliberately the LAST thing that happened rather than the first: a pty's is
   * its exit, else its last output; a foreign session's is when the hook last
   * vouched for it. Only a lane, which has nothing newer to report, is its
   * start. `createdAt` below is the other question.
   */
  startedAt?: number;
  /**
   * When the session BEGAN, for the order that asks that. Epoch ms.
   *
   * Separate from `startedAt` because for three of the four kinds they are
   * different instants, and "the oldest thing still running" is a different
   * question from "the quietest".
   */
  createdAt?: number;
  /** The row's standing through the ONE status vocabulary — the dot's word. */
  state?: UiState;
  /**
   * The session is stopped waiting on a PERSON — a pending permission card
   * (lanes) or the registry's waiting flag (everyone else) — and since when.
   * An attention row sorts first and wears the needs-you badge.
   */
  attention?: { kind: 'permission' | 'input'; since?: string };
  /**
   * The session's own task list, on the rows that have one — lanes.
   *
   * A pty's list is its own business and the registry cannot see it; a lane's
   * is on the run record this row was built from. Carried as the rows rather
   * than the summary so the ONE `taskSummary` renders it, here and on Now.
   */
  tasks?: readonly PhaseTask[];
  /**
   * The record this row was BUILT FROM — the L3 rung (`docs/design.md` §1).
   *
   * A `SessionRow` is a view model: four different shapes are flattened into
   * one so the list can draw them together, and that flattening is exactly what
   * an operator wants to see past when a row does not say what they expected. A
   * lane, a pty and a registry record answer different questions and none of
   * them survives the flattening whole.
   *
   * `unknown` on purpose: it is printed, never read. Typing it as a union would
   * invite a caller to branch on it, and the moment anything branches this
   * stops being the raw record and becomes a fifth view of it.
   */
  record?: unknown;
}

/**
 * Where a kind falls, derived from the group list rather than declared beside
 * it: two spellings of one order is how a fifth kind ends up first in the
 * sections and last in the sort.
 */
export const KIND_ORDER: Readonly<Record<SessionGroupKind, number>> = Object.freeze(
  Object.fromEntries(SESSION_GROUPS.map((group, index) => [group.kind, index])),
) as Record<SessionGroupKind, number>;

/** The heading word for one kind, from the same list — for a row with no heading over it. */
export const KIND_LABEL: Readonly<Record<SessionGroupKind, string>> = Object.freeze(
  Object.fromEntries(SESSION_GROUPS.map((group) => [group.kind, group.title])),
) as Record<SessionGroupKind, string>;

/** The lucide glyph for a kind — one table, so the list and the strip agree. */
export const KIND_ICON = { lane: Cpu, agent: Bot, shell: TerminalSquare, foreign: Users } as const;

/**
 * Every process, in one list: live first, then by kind, then most recent.
 *
 * `lanes` and `foreign` come straight from `features/now`'s models — the same
 * `nowLanes()` the home page ranks and the same `otherSessions()` it uses to
 * drop a registry row that duplicates a lane we already drew. Console-owned
 * ptys are ordered live-before-ended within their kind so eight dismissable
 * records never bury the shell you are typing in.
 */
export function sessionRows(input: {
  terminals?: readonly TerminalSession[] | undefined;
  lanes?: readonly NowLane[] | undefined;
  foreign?: readonly ForeignSession[] | undefined;
  /**
   * Pending approval cards, Pick-shaped so a test can hand a stub: a lane
   * whose run+phase a pending card names is a session waiting on a PERSON.
   */
  approvals?: readonly { status: string; runId: string; phase: number | null; createdAt: string }[];
  now?: number;
}): SessionRow[] {
  const now = input.now ?? Date.now();
  const rows: SessionRow[] = [];
  const pending = (input.approvals ?? []).filter((a) => a.status === 'pending');

  for (const lane of input.lanes ?? []) {
    const card = pending.find((a) => a.runId === lane.runId && (a.phase == null || a.phase === lane.phase));
    rows.push({
      key: `lane:${lane.key}`,
      kind: 'lane',
      label: `${lane.planTitle} · P${lane.phase}`,
      ...(lane.title ? { detail: lane.title } : {}),
      note: lane.frozen ? 'frozen' : lane.status === 'running' ? null : lane.status,
      href: planHref(lane.slug, 'run'),
      live: lane.status === 'running',
      ...(lane.startedAt
        ? { startedAt: Date.parse(lane.startedAt), createdAt: Date.parse(lane.startedAt) }
        : {}),
      state: card ? 'needs-you' : asUiState(phaseUiState(lane.status, lane.stop)),
      ...(lane.tasks?.length ? { tasks: lane.tasks } : {}),
      ...(card ? { attention: { kind: 'permission' as const, since: card.createdAt } } : {}),
      record: lane,
    });
  }

  for (const session of input.terminals ?? []) {
    rows.push({
      key: `pty:${session.id}`,
      kind: (session.kind ?? 'shell') === 'claude' ? 'agent' : 'shell',
      label: session.label,
      detail: session.cwd,
      note: sessionStateNote(session),
      href: sessionsHref(session.id),
      id: session.id,
      live: !session.exited,
      startedAt: session.exitedAt ?? session.lastOutputAt ?? session.createdAt,
      createdAt: session.createdAt,
      state: session.exited
        ? session.exited.code
          ? 'failed'
          : 'done'
        : session.frozen || session.stopping
          ? 'waiting'
          : 'running',
      // A QA reviewer's list, folded by the server from its inbox — the one
      // pty whose list the console can see. Same key a lane row carries.
      ...(session.tasks?.length ? { tasks: session.tasks } : {}),
      record: session,
    });
  }

  // `otherSessions` drops a registry row that is a lane we have already drawn
  // (same session id) and keeps an hour of recently-ended ones.
  for (const session of otherSessions(input.foreign, input.lanes ?? [], now)) {
    rows.push({
      key: `foreign:${session.sessionId}`,
      kind: 'foreign',
      // The plan it works, else who owns it, else WHAT it is. The bare `kind`
      // was the first draft and the live page showed four rows saying
      // "foreign" — true, and no help at all.
      label: session.plan
        ? `${session.plan.slug} · P${session.plan.phase}`
        : (session.owner ?? foreignVehicle(session)),
      detail: session.cwd,
      // A live waiting session's own words beat the silence of a bare row;
      // a dead or unvouched-for one still prints its presence.
      note: session.presence === 'live' ? (session.waiting?.note ?? null) : session.presence,
      // The PHASE, not the plan's run tab. A correlated session is a session
      // working one phase, and the row that said `plan: null` in the incident
      // pointed at the page the operator was already on; sending them to the
      // plan's run tab is the same mistake one step smaller.
      //
      // An UNcorrelated row used to land on `#/sessions` — the page it was
      // clicked from, which is that same defect at its smallest. It now goes
      // to the session's own page, and every foreign row carries the trailing
      // link there as well (`sessionId` below).
      href: session.plan ? phaseHref(session.plan.slug, session.plan.phase) : sessionsHref(session.sessionId),
      sessionId: session.sessionId,
      live: session.presence === 'live',
      startedAt: Date.parse(session.lastSeen),
      createdAt: Date.parse(session.startedAt),
      state:
        session.presence === 'live' && session.waiting
          ? 'needs-you'
          : session.presence === 'live'
            ? 'running'
            : session.presence === 'ended'
              ? 'done'
              : // `unknown` is a claim nobody can vouch for — the UNKNOWN_STATE word.
                'waiting',
      ...(session.presence === 'live' && session.waiting
        ? { attention: { kind: session.waiting.kind, since: session.waiting.since } }
        : {}),
      record: session,
    });
  }

  return rows.sort(
    (a, b) =>
      // A session waiting on a person outranks everything merely live.
      Number(Boolean(b.attention)) - Number(Boolean(a.attention)) ||
      Number(b.live) - Number(a.live) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
      a.label.localeCompare(b.label),
  );
}

/* ---------------- the page list ---------------- */

/**
 * The list as a PAGE section: grouped by kind, every row a link.
 *
 * A group with no rows renders nothing rather than an empty heading — four
 * headings over one shell is a page that looks broken on the console most
 * people run.
 */
export function SessionList({
  rows,
  activeId,
  onClose,
  empty,
  grouped = true,
}: {
  rows: readonly SessionRow[];
  /** The open pty, so the page list marks it while a pane is up beside it. */
  activeId?: string | undefined;
  /** Closing is offered only for a pty this console owns. */
  onClose?: (id: string) => void;
  /** What to say when there is nothing at all. */
  empty?: ReactNode;
  /**
   * Sections per kind, or one flat list in the order the rows arrived in.
   *
   * On by default, which is what every caller but the page itself wants: the
   * strip's sheet and the run page's "elsewhere" list are already a cut of one
   * kind or two. Off is what makes an ORDER over the whole list legible — a
   * list sorted by recency inside four sections is four little orders.
   */
  grouped?: boolean;
}) {
  /* The row the L2 sheet is open on, by KEY — the one field a `SessionRow`
     guarantees and the one that is stable across the re-sorts this list does
     on every poll (attention first, then live, then kind, then recency). An
     index would move under the sheet; `id` is absent on a foreign row and
     `sessionId` on a pty. */
  const [inspecting, setInspecting] = useState<string | null>(null);
  const inspected = rows.find((row) => row.key === inspecting) ?? null;
  /* One sheet for the whole list, mounted beside it: a sheet per row would be
     a dialog's worth of markup per process, and a row that re-sorts out from
     under an open sheet would unmount it mid-read. */
  const sheet = inspected && (
    <SessionInspector row={inspected} open onOpenChange={(next) => !next && setInspecting(null)} />
  );

  if (rows.length === 0) return <>{empty}</>;
  if (!grouped) {
    return (
      <>
        <ul className="flex flex-col gap-1" aria-label="Sessions">
          {rows.map((row) => (
            <SessionListRow
              key={row.key}
              row={row}
              active={Boolean(row.id && row.id === activeId)}
              // Flat, so the section heading that named the kind is gone — the
              // icon carries the word instead, for a pointer and for a reader.
              kindLabel={KIND_LABEL[row.kind]}
              onInspect={setInspecting}
              {...(onClose ? { onClose } : {})}
            />
          ))}
        </ul>
        {sheet}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {SESSION_GROUPS.map((group) => {
        const mine = rows.filter((row) => row.kind === group.kind);
        if (mine.length === 0) return null;
        return (
          <section key={group.kind} aria-label={group.title}>
            <h3 className="text-sm font-medium text-ink">{group.title}</h3>
            <p className="mt-0.5 text-2xs text-ink-faint">{group.blurb}</p>
            <ul className="mt-2 flex flex-col gap-1">
              {mine.map((row) => (
                <SessionListRow
                  key={row.key}
                  row={row}
                  active={Boolean(row.id && row.id === activeId)}
                  onInspect={setInspecting}
                  {...(onClose ? { onClose } : {})}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {sheet}
    </div>
  );
}

function SessionListRow({
  row,
  active,
  onClose,
  kindLabel,
  onInspect,
}: {
  row: SessionRow;
  active: boolean;
  onClose?: (id: string) => void;
  /** Names the kind on the icon, for the flat list where no heading does. */
  kindLabel?: string;
  /** Opens the L2 sheet. Takes the row KEY — see `SessionList`. */
  onInspect: (key: string) => void;
}) {
  const Icon = KIND_ICON[row.kind];
  return (
    <li className="flex items-center gap-1">
      <a
        href={row.href}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex min-h-(--tap-min) min-w-0 flex-1 items-center gap-2 rounded border px-(--tile-pad-x) py-(--tile-pad-y) text-sm',
          active ? 'border-rule-strong bg-surface-raised' : 'border-rule bg-surface hover:bg-surface-raised',
        )}
      >
        <Icon
          size={15}
          className="shrink-0 text-ink-muted"
          {...(kindLabel ? { role: 'img', 'aria-label': kindLabel } : { 'aria-hidden': true })}
        />
        <span className="min-w-0 flex-1">
          {/* `flex-wrap`, and the label given a floor and permission to
              truncate. Neither the label (`truncate`, but no `min-w-0`, so its
              automatic minimum was its whole nowrap width) nor the note
              (`shrink-0`) could give, so a row carrying `Claude needs your
              permission` simply ran past its own box — and the `shrink-0`
              Duration at the end of the row painted over the last 39px of it at
              360. Two overlapping strings is worse than either one truncated. */}
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {row.state && <StatusDot state={row.state} pulse={row.state === 'running' && row.live} />}
            <span className="min-w-32 flex-1 truncate text-ink">{row.label}</span>
            {row.attention && (
              <StatusBadge
                state="needs-you"
                label={row.attention.kind === 'permission' ? 'needs permission' : 'needs input'}
                title={
                  row.attention.since ? `waiting ${relativeTime(Date.parse(row.attention.since))}` : undefined
                }
              />
            )}
            {/* A note is not the record's identity, so it is the thing that
                gives — `min-w-0 truncate`, never `shrink-0`. The full text is
                on the row's own page. */}
            {!row.live && (
              <span className="min-w-0 truncate text-2xs text-ink-faint">{row.note ?? 'ended'}</span>
            )}
            {row.live && row.note && <span className="min-w-0 truncate text-2xs text-warn">{row.note}</span>}
          </span>
          {/* A recorded path has no space in it for eighty characters, and a
              track sized to one scrolls the whole phone page sideways (Phase 9).
              `break-words` inside a `min-w-0` parent is the fix. */}
          {row.detail && (
            <span className="mt-0.5 block truncate font-mono text-2xs break-words text-ink-faint">
              {row.detail}
            </span>
          )}
          {/* What the session says it is doing, under what it was asked to do.
              The list is the only thing on this row the SESSION wrote. */}
          {row.tasks?.length ? <TaskLine tasks={row.tasks} className="mt-0.5 flex" /> : null}
        </span>
        {row.startedAt != null &&
          Number.isFinite(row.startedAt) &&
          // A live session's clock RUNS; a dead one reads "N ago". The ticking
          // interval belongs to the Duration primitive, one per live row.
          (row.live ? (
            <Duration since={row.startedAt} live className="shrink-0 font-mono text-2xs text-ink-faint" />
          ) : (
            <RelativeTime at={row.startedAt} className="shrink-0 text-2xs text-ink-faint" />
          ))}
      </a>
      {/* A foreign row's link goes where the SESSION belongs — its phase, when
          it works one. This is the way in to the session itself: the page that
          says what it is and offers to resume it. A link, not a button, so it
          middle-clicks and copies like every other address here. */}
      {row.sessionId && (
        <a
          href={sessionsHref(row.sessionId)}
          aria-label={`Open ${row.label}`}
          title="Open this session — resume the conversation in a terminal here"
          className="flex size-(--tap-min) shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
        >
          <ArrowUpRight size={16} aria-hidden />
        </a>
      )}
      {/* L2, on every row and every kind — including the three that have
          nowhere else to go. A lane's link opens its run tab and a foreign
          row's opens the phase it works; neither is a page ABOUT the session,
          and for a pty with no plan there was no such page at all. */}
      <button
        type="button"
        aria-label={`Inspect ${row.label}`}
        title="Everything this console knows about this session"
        onClick={() => onInspect(row.key)}
        className="flex size-(--tap-min) shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
      >
        <Info size={16} aria-hidden />
      </button>
      {onClose && row.id && (
        <button
          type="button"
          aria-label={`Close ${row.label}`}
          onClick={() => onClose(row.id!)}
          className="flex size-(--tap-min) shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
        >
          <X size={16} aria-hidden />
        </button>
      )}
    </li>
  );
}

/* ---------------- the strip (the same list, above a pane) ---------------- */

export interface StripSession {
  id: string;
  label: string;
  /** What it is doing when not simply live — `ended`, `frozen`, `stopping…`. */
  note?: string | null;
}

export function SessionStrip({
  sessions,
  activeId,
  onSelect,
  onClose,
  actions,
  details,
  hints,
  more,
  note,
  extra,
}: {
  sessions: readonly StripSession[];
  activeId?: string;
  onSelect(id: string): void;
  onClose(id: string): void;
  /** Creates sessions — after the tabs (desktop) or the picker (phone). */
  actions?: ReactNode;
  /** Controls and facts for the OPEN session: the right side, or the sheet. */
  details?: ReactNode;
  /** Plain sentences explaining `details` — the tap path for desktop titles. */
  hints?: readonly string[];
  /** Actions that only fit the sheet on a phone (the plan wizard). */
  more?: ReactNode;
  /** Why creating is refused right now (the cap) — said in the sheet. */
  note?: string;
  /** Everything this console does NOT own a pty for — lanes and foreign rows. */
  extra?: ReactNode;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const active = sessions.find((session) => session.id === activeId);

  if (!phone) {
    return (
      // 🔴 `flex-wrap`, and `details` without `shrink-0`, are load-bearing.
      // The strip is tabs + actions + the open session's facts, and the facts
      // are a variable-length row (controls, plan · phase, elapsed, an ETA, the
      // launch mode, ⇧Tab, the size). Phase 10 put a second New button on it
      // and the whole row went 122 px past the viewport on a 1440 desktop —
      // which, because `ml-auto` resolves before an overflow, pushed the TAB
      // LIST to x = −25: the one control the strip exists for, off the left
      // edge, with no scrollbar to bring it back. Wrapping costs a row of
      // height on a narrow window and loses nothing.
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-rule bg-ground-deep px-2 py-1.5">
        <Tabs
          value={active?.id ?? ''}
          onValueChange={(value) => {
            if (value) onSelect(value);
          }}
          className="min-w-0"
        >
          <TabsList aria-label="Open sessions" className="border-b-0">
            {sessions.map((session) => {
              const isActive = session.id === active?.id;
              return (
                <span
                  key={session.id}
                  className={cn(
                    'flex shrink-0 items-center rounded border',
                    isActive ? 'border-rule-strong bg-surface-raised' : 'border-rule bg-surface',
                  )}
                >
                  <TabsTrigger
                    value={session.id}
                    className={cn(
                      'min-h-(--tap-min) max-w-56 truncate border-b-0 px-3 py-0 text-sm',
                      'data-[state=active]:border-b-0',
                    )}
                  >
                    {session.label}
                    {session.note && <span className="ml-1.5 text-2xs text-ink-faint">{session.note}</span>}
                  </TabsTrigger>
                  <button
                    type="button"
                    aria-label={`Close ${session.label}`}
                    onClick={() => onClose(session.id)}
                    className="flex size-(--tap-min) items-center justify-center text-ink-faint hover:text-ink"
                  >
                    <X size={14} aria-hidden />
                  </button>
                </span>
              );
            })}
          </TabsList>
        </Tabs>
        {actions}
        {more}
        {active && details && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{details}</div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-rule bg-ground-deep px-2 py-1.5">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={active ? `${active.label} — open the session list` : 'Open the session list'}
          onClick={() => setOpen(true)}
          className="flex min-h-(--tap-min) min-w-0 flex-1 items-center gap-1.5 rounded border border-rule bg-surface px-2 text-left text-sm"
        >
          <span className="truncate text-ink">{active ? active.label : 'No session open'}</span>
          {active?.note && <span className="shrink-0 text-2xs text-ink-faint">{active.note}</span>}
          {sessions.length > 1 && (
            <span className="shrink-0 rounded bg-surface-raised px-1.5 font-mono text-2xs text-ink-faint">
              {sessions.length}
            </span>
          )}
          <ChevronDown size={16} className="ml-auto shrink-0 text-ink-muted" aria-hidden />
        </button>
        {actions}
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent title="Sessions">
          {sessions.length === 0 ? (
            <p className="px-1 py-2 text-sm text-ink-muted">No session is open.</p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Open sessions">
              {sessions.map((session) => {
                const isActive = session.id === active?.id;
                return (
                  <li key={session.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => {
                        onSelect(session.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex min-h-(--tap-min) min-w-0 flex-1 items-center gap-2 rounded px-2 text-left text-sm',
                        isActive ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface',
                      )}
                    >
                      <span className="truncate">{session.label}</span>
                      {session.note && (
                        <span className="shrink-0 text-2xs text-ink-faint">{session.note}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${session.label}`}
                      onClick={() => onClose(session.id)}
                      className="flex size-(--tap-min) shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
                    >
                      <X size={16} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {note && <p className="mt-2 px-1 text-2xs text-ink-faint">{note}</p>}

          {active && details && (
            <div className="mt-3 flex flex-col gap-2 border-t border-rule pt-3">
              <div className="flex flex-wrap items-center gap-2">{details}</div>
              {hints && hints.length > 0 && (
                <ul className="flex flex-col gap-1 px-1 text-2xs text-ink-faint">
                  {hints.map((hint) => (
                    <li key={hint}>{hint}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {extra && <div className="mt-3 border-t border-rule pt-3">{extra}</div>}
          {more && <div className="mt-3 flex flex-wrap gap-2 border-t border-rule pt-3">{more}</div>}
        </SheetContent>
      </Sheet>
    </>
  );
}
