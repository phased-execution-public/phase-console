/**
 * Sessions' one vocabulary — every process this console owns or can see,
 * folded into one row (7.0, quiet-console phase 15; the fold since 3.0).
 *
 * Four kinds of process, one list:
 *
 *   - **lane** — an autopilot lane of a live run. The console owns the process
 *     but not through the pty registry, so its row goes to the run, where its
 *     approvals, its console and its replay live.
 *   - **agent** / **shell** — a pty this console minted. `#/sessions/<id>` is
 *     its address, and the page there is the terminal.
 *   - **foreign** — a `claude` the session-presence hook reported: someone's
 *     own CLI, another console's lane. Nothing here can take over a tty
 *     somebody else is typing at; its page offers to resume the CONVERSATION
 *     in a terminal here, and says exactly what that does first.
 *
 * The fold is pure so it is testable without a pty, and it reads the lane and
 * foreign models of `data/lanes.ts` rather than minting a second vocabulary
 * for the same facts. Lanes come from the SLIM run list (#234): a lane's
 * status, process and clock are on the glance; its tasks are the whole
 * record's, read when the row is opened.
 *
 * Since one-pool phase 17 (#369) the row also carries what the run record
 * holds about a lane's session — the account it runs on, its model and
 * effort, what it has spent, its context against the model's window, its
 * task progress, its worked clock against the estimate, its attempts and
 * turns — read ONCE here from the whole record of each live run
 * (`GET /api/run/<slug>`, `records`) and the plan detail (`details`), so the
 * list, the inspector and the phone's records read one row. A slim lane's
 * own live facts (its model, its session's context and unbooked dollars)
 * stand in until the record lands; its zeroes never do.
 *
 * Two clocks, because they answer different questions: `startedAt` is the
 * LAST thing that happened to a row (a pty's exit or last output, a foreign
 * session's last sighting) and `createdAt` is when it began — "what has gone
 * quiet" against "what has been running all afternoon". A session stopped on
 * a PERSON is pinned to the top of every order: whatever you sorted by, the
 * thing that cannot proceed without you is the row you came to see.
 */

import { describeWord, type StatusView } from '@shared/status-model.js';
import { taskSummary } from '@shared/task-model.js';
import type { SessionVocab } from '@/ui/status';
import type {
  AccountView,
  ForeignSession,
  LaneLiveness,
  PhaseRecord,
  PhaseTask,
  PlanDetail,
  RunDetail,
  RunState,
  TerminalSession,
} from '@/data/api';
import { checkLabel } from '@/data/check-words';
import { endedLabel, foreignVehicle, otherSessions, type NowLane } from '@/data/lanes';
import { defineFilters, defineSorts, matchesWords, words } from '@/lib/list-model';
import { accountName } from '@/shell/limits';
import { phaseHref, runHref, sessionsHref } from '@/shell/routes';

/* ------------------------------------------------------------------ *
 * The kinds
 * ------------------------------------------------------------------ */

/**
 * How the list GROUPS what it shows — a UI grouping, not what a session is
 * (`server/terminal.ts`'s `shell | claude` is that, under another name).
 */
export type SessionGroupKind = 'lane' | 'agent' | 'shell' | 'foreign';

/**
 * The four kinds in list order: the section heading, the short word a filter
 * offers, and the one sentence saying what the kind is — the filter's
 * description and the inspector's, never a paragraph under a heading.
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
    blurb: 'Phases this console is running. Their console, approvals and replay are on the run.',
  },
  { kind: 'agent', title: 'Agent sessions', short: 'Agents', blurb: 'Claude sessions this console started.' },
  {
    kind: 'shell',
    title: 'Shells',
    short: 'Shells',
    blurb: 'Plain shells on this machine, from here or a phone.',
  },
  {
    kind: 'foreign',
    title: 'Other sessions on this machine',
    short: 'Others',
    blurb: 'Reported by the session-presence hook — someone’s own CLI, or another console’s lane.',
  },
];

/** Where a kind falls, derived from the list so a fifth kind is one edit. */
export const KIND_ORDER: Readonly<Record<SessionGroupKind, number>> = Object.freeze(
  Object.fromEntries(SESSION_GROUPS.map((group, index) => [group.kind, index])),
) as Record<SessionGroupKind, number>;

/** The heading for one kind — for a row with no heading over it. */
export const KIND_LABEL: Readonly<Record<SessionGroupKind, string>> = Object.freeze(
  Object.fromEntries(SESSION_GROUPS.map((group) => [group.kind, group.title])),
) as Record<SessionGroupKind, string>;

/**
 * What a session IS, finer than its group: a lane, a shell, an agent — and
 * the two agents the console mints for a purpose, a QA reviewer and a
 * recovery session — or somebody else's. The row draws it as a quiet
 * outlined word beside what it works on, never as a status (#369).
 */
export type SessionBadge = SessionGroupKind | 'qa' | 'recovery';

/** Each badge's word and the one sentence a hover says. */
export const SESSION_BADGES: Readonly<Record<SessionBadge, { label: string; blurb: string }>> = Object.freeze(
  {
    lane: { label: 'Lane', blurb: 'An autopilot lane: a phase this console is running.' },
    shell: { label: 'Shell', blurb: 'A plain shell on this machine.' },
    agent: { label: 'Agent', blurb: 'A Claude session this console started.' },
    qa: { label: 'QA', blurb: 'A QA reviewer: a session checking a finished phase.' },
    recovery: { label: 'Recovery', blurb: 'A session started to mend a stopped run or phase.' },
    foreign: {
      label: 'Foreign',
      blurb: 'Someone’s own Claude, or another console’s lane, reported by the session-presence hook.',
    },
  },
);

/* ------------------------------------------------------------------ *
 * The row
 * ------------------------------------------------------------------ */

export interface SessionRow {
  /** Stable across re-sorts, which is what keys React and names the inspected record. */
  key: string;
  kind: SessionGroupKind;
  label: string;
  /** The one fact beside the name: a lane's phase title, everything else's directory. */
  detail?: string;
  /** What it is doing when not simply live — `ended`, `frozen`, `stopping`, a lane's word. */
  note?: string | null;
  /** Where the row goes. */
  href: string;
  /** The pty id, when THIS console owns the process — what `#/sessions/:id` opens and Close closes. */
  id?: string;
  /**
   * The CLAUDE conversation id, on a foreign row — a different thing from
   * `id`. `#/sessions/<conversation>` opens it too: the session page resolves
   * a pty, then a pty already resuming that conversation, then the registry
   * record, which is the page that offers to resume it. Kept apart from `id`
   * because a foreign session has no pty to close.
   */
  sessionId?: string;
  /** The run and phase a lane works — what its expanded row reads the whole record for. */
  lane?: { slug: string; phase: number; runId: string };
  live: boolean;
  /** The LAST thing that happened to it — what "N ago" and the default order read. Epoch ms. */
  startedAt?: number;
  /** When it BEGAN. Epoch ms. */
  createdAt?: number;
  /** Which vocabulary its word is in — a lane's phase, a pty's `terminal`, a registry presence. */
  vocab: SessionVocab;
  /** Its own word, through the one status model. */
  view: StatusView;
  /** Stopped on a PERSON — a pending permission card (lanes) or the registry's waiting flag — and since when. */
  attention?: { kind: 'permission' | 'elicitation' | 'input'; since?: string };
  /** The session's own task list, on the rows that carry one (a lane's record, a QA reviewer's pty). */
  tasks?: readonly PhaseTask[];

  /* ---- What the run record holds (#369) — absent where nothing says it ---- */

  /** What it is, finer than its group — the row's kind badge. */
  badge: SessionBadge;
  /** The account the session runs on, named as the registry names it (its id when the registry does not know it). */
  account?: { id: string; name: string };
  /** What it runs on — the session's own `init` word over what it was asked for. */
  model?: string;
  effort?: string;
  /** Dollars: what the record booked, plus the session in flight's unbooked spend. */
  spendUsd?: number;
  /** The newest context, against the window the server judged it by (null when it knew none). */
  context?: { tokens: number; window: number | null; stage?: 'wrap-up' | 'checkpoint' };
  /** The session's task list, counted. */
  progress?: { done: number; total: number; active: string | null };
  /** The phase's worked clock (attempt windows less frozen time), as its record says. */
  workedMs?: number;
  /** The server's own estimate of that clock, for this phase. Never computed here. */
  estimateMs?: number;
  attempts?: number;
  turns?: number;
  /** The Claude conversation the session is — a lane's, an agent pty's, a reported session's. */
  conversation?: string;
  /** A lane's run's own checkout, when it has one. */
  worktree?: string;
  /**
   * The record the row was BUILT FROM — printed in the inspector's Raw tab,
   * never read: a branch on it would make it a fifth view of the same facts.
   */
  record?: unknown;
}

/** What a session waiting on a person waits for, in words. */
export function attentionWords(attention: NonNullable<SessionRow['attention']>): string {
  return attention.kind === 'permission' ? 'needs your permission' : 'needs your answer';
}

/** A pty's word in the `terminal` vocabulary. */
export function terminalWord(
  session: TerminalSession,
): 'running' | 'frozen' | 'stopping' | 'exited' | 'failed' {
  // The exit CODE decides, as it always has: a pty the operator closed dies by
  // signal, and "you closed it" is not "it failed".
  if (session.exited) return session.exited.code ? 'failed' : 'exited';
  if (session.frozen) return 'frozen';
  if (session.stopping) return 'stopping';
  return 'running';
}

/** What a pty is doing when it is not simply live — the switcher's and the row's note. */
export function sessionStateNote(session: TerminalSession): string | null {
  if (session.exited) return 'ended';
  if (session.frozen) return 'frozen';
  if (session.stopping) return 'stopping';
  return null;
}

/** What the page calls a foreign session: the plan it works, else who owns it, else what it is. */
export function foreignLabel(session: Pick<ForeignSession, 'plan' | 'owner' | 'kind'>): string {
  return session.plan
    ? `${session.plan.slug} P${session.plan.phase}`
    : (session.owner ?? foreignVehicle(session));
}

/**
 * Every process, in one list: waiting on a person first, then live, then by
 * kind, then most recent.
 *
 * `otherSessions` drops a registry row that IS a lane already drawn (the same
 * session id) and keeps an hour of recently ended ones; a lane whose run and
 * phase a pending approval names is a session waiting on a person.
 */
export function sessionRows(input: {
  terminals?: readonly TerminalSession[] | undefined;
  lanes?: readonly NowLane[] | undefined;
  foreign?: readonly ForeignSession[] | undefined;
  approvals?: readonly { status: string; runId: string; phase: number | null; createdAt: string }[];
  /** The whole record of each live run, by plan slug — what a lane's facts are read from (#369). */
  records?: ReadonlyMap<string, RunDetail> | undefined;
  /** The plan detail, by slug — a slim lane's phase title and estimate. */
  details?: ReadonlyMap<string, PlanDetail> | undefined;
  /** The registry's accounts — what names an account id. */
  accounts?: readonly AccountView[] | undefined;
  now?: number;
}): SessionRow[] {
  const now = input.now ?? Date.now();
  const rows: SessionRow[] = [];
  const pending = (input.approvals ?? []).filter((card) => card.status === 'pending');

  for (const lane of input.lanes ?? []) {
    const card = pending.find((a) => a.runId === lane.runId && (a.phase == null || a.phase === lane.phase));
    // The console's own check on the phase, when one runs (control-tower phase
    // 105, #193): which line of which pass, and it is live.
    const check = lane.check ? checkLabel(lane.check) : null;
    const started = lane.startedAt ? Date.parse(lane.startedAt) : undefined;
    const facts = laneFacts(lane, input);
    const title = lane.title ?? phaseTitle(input.details?.get(lane.slug), lane.phase);
    rows.push({
      key: `lane:${lane.key}`,
      kind: 'lane',
      label: `${lane.planTitle} P${lane.phase}`,
      ...(title ? { detail: title } : check ? { detail: check } : {}),
      note: lane.frozen ? 'frozen' : (check ?? (lane.status === 'running' ? null : lane.status)),
      href: runHref(lane.slug),
      lane: { slug: lane.slug, phase: lane.phase, runId: lane.runId },
      live: lane.status === 'running' || check != null,
      ...(started != null && Number.isFinite(started) ? { startedAt: started, createdAt: started } : {}),
      vocab: 'phase',
      view: describeWord('phase', lane.status),
      ...facts,
      ...(card ? { attention: { kind: 'permission' as const, since: card.createdAt } } : {}),
      record: lane,
    });
  }

  for (const session of input.terminals ?? []) {
    const claude = (session.kind ?? 'shell') === 'claude';
    rows.push({
      key: `pty:${session.id}`,
      kind: claude ? 'agent' : 'shell',
      badge: !claude ? 'shell' : session.meta?.qa ? 'qa' : session.meta?.recovery ? 'recovery' : 'agent',
      ...(session.meta?.model ? { model: session.meta.model } : {}),
      ...(session.meta?.effort ? { effort: session.meta.effort } : {}),
      ...(session.meta?.claudeSessionId ? { conversation: session.meta.claudeSessionId } : {}),
      label: session.label,
      detail: session.cwd,
      note: sessionStateNote(session),
      href: sessionsHref(session.id),
      id: session.id,
      live: !session.exited,
      startedAt: session.exitedAt ?? session.lastOutputAt ?? session.createdAt,
      createdAt: session.createdAt,
      vocab: 'terminal',
      view: describeWord('terminal', terminalWord(session)),
      // A QA reviewer's list, folded by the server from its inbox — the one
      // pty whose list the console can see.
      ...(session.tasks?.length ? { tasks: session.tasks, ...progressOf(session.tasks) } : {}),
      record: session,
    });
  }

  for (const session of otherSessions(input.foreign, input.lanes ?? [], now)) {
    rows.push({
      key: `foreign:${session.sessionId}`,
      kind: 'foreign',
      badge: 'foreign',
      conversation: session.sessionId,
      // A count the registry could not make is not a zero (REG-9).
      ...(session.turnsSource !== 'unknown' ? { turns: session.turns } : {}),
      label: foreignLabel(session),
      detail: session.cwd,
      // A live waiting session's own words beat the silence of a bare row; an
      // end the probe INFERRED reads differently from one the session reported (REG-9).
      note:
        session.presence === 'live'
          ? (session.waiting?.note ?? null)
          : (endedLabel(session) ?? session.presence),
      // The PHASE a correlated session works — never the plan's run tab, and
      // never back to this page: an uncorrelated one goes to its own page.
      href: session.plan ? phaseHref(session.plan.slug, session.plan.phase) : sessionsHref(session.sessionId),
      sessionId: session.sessionId,
      live: session.presence === 'live',
      startedAt: Date.parse(session.lastSeen),
      createdAt: Date.parse(session.startedAt),
      vocab: 'presence',
      view: describeWord('presence', session.presence),
      ...(session.presence === 'live' && session.waiting
        ? { attention: { kind: session.waiting.kind, since: session.waiting.since } }
        : {}),
      record: session,
    });
  }

  return rows.sort(
    (a, b) =>
      Number(Boolean(b.attention)) - Number(Boolean(a.attention)) ||
      Number(b.live) - Number(a.live) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
      a.label.localeCompare(b.label),
  );
}

/** A phase's title in its plan's detail, when the detail has landed. */
function phaseTitle(detail: PlanDetail | undefined, phase: number): string | undefined {
  return detail?.phases?.find((view) => view.phase === phase)?.title || undefined;
}

/** A task list, counted — `taskSummary`'s figures, nothing for an empty list. */
function progressOf(tasks: readonly PhaseTask[]): Pick<SessionRow, 'progress'> {
  const summary = taskSummary(tasks as PhaseTask[]);
  return summary.total
    ? { progress: { done: summary.done, total: summary.total, active: summary.active } }
    : {};
}

/** An account id, named the way the registry names it — its id when the registry does not know it. */
function accountOf(id: string | undefined, accounts: readonly AccountView[] | undefined) {
  if (!id) return {};
  const known = accounts?.find((account) => account.id === id);
  return { account: { id, name: known ? accountName(known) : id } };
}

/**
 * What the run record holds about one lane's session (#369), read once.
 *
 * The WHOLE record answers when it is this lane's run (`run.id`): a newer run
 * of the same plan is another run's phase 3, never this one's. A SLIM lane's
 * own live facts stand in until it lands — its model and effort (the run's),
 * its session's context and unbooked dollars (the slim liveness) — but never
 * its `costUsd: 0` and `attempts: 0`, which on a slim row mean "not read".
 */
function laneFacts(
  lane: NowLane,
  input: {
    records?: ReadonlyMap<string, RunDetail> | undefined;
    details?: ReadonlyMap<string, PlanDetail> | undefined;
    accounts?: readonly AccountView[] | undefined;
  },
): Partial<SessionRow> & Pick<SessionRow, 'badge'> {
  const whole = input.records?.get(lane.slug);
  const run: RunState | undefined = whole?.run && whole.run.id === lane.runId ? whole.run : undefined;
  const record: PhaseRecord | undefined = run?.phases?.[String(lane.phase)];
  // The detail's liveness is fresher than the record's copy; the lane's own is the slim row's.
  const beat: LaneLiveness | undefined =
    (run ? whole?.liveness?.find((one) => one.phase === lane.phase) : undefined) ??
    lane.liveness ??
    record?.liveness;
  const read = record != null || !lane.slim;

  const model = record?.actualModel ?? record?.model ?? lane.model;
  const effort = record?.effort ?? lane.effort;

  const booked = record ? (record.costUsd ?? 0) : read ? lane.costUsd : undefined;
  const unbooked = record?.live?.spentUsd ?? beat?.spentUsd;
  const spendUsd = booked == null && unbooked == null ? undefined : (booked ?? 0) + (unbooked ?? 0);

  const tokens = record?.live?.contextTokens ?? beat?.tokens?.context;
  const counters = record?.tokens;
  const window =
    beat?.tokens?.window ?? counters?.[counters.length - 1]?.window ?? record?.contextWrapup?.window ?? null;

  const tasks = record?.tasks ?? lane.tasks;
  const counted = tasks?.length ? progressOf(tasks) : {};
  const liveTasks = record?.live?.tasks;
  const progress =
    liveTasks && liveTasks.total > 0
      ? { done: liveTasks.done, total: liveTasks.total, active: counted.progress?.active ?? null }
      : counted.progress;

  const worked = (record?.live?.phaseClocks ?? record?.phaseClocks)?.workedMs ?? record?.durationMs;
  const estimate =
    (run ? whole?.phaseEta?.find((eta) => eta.phase === lane.phase)?.estMs : undefined) ??
    lane.eta?.estMs ??
    input.details?.get(lane.slug)?.eta?.perPhase?.find((eta) => eta.phase === lane.phase)?.estMs;

  const attempts = record?.attempts ?? (read ? lane.attempts : undefined);
  const turns = record?.turns ?? lane.turns;
  const conversation = lane.child?.sessionId ?? record?.sessionId;

  return {
    badge: lane.qa ? 'qa' : 'lane',
    ...accountOf(record?.sessionAccountId ?? run?.accountId, input.accounts),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(spendUsd != null ? { spendUsd } : {}),
    ...(tokens != null
      ? { context: { tokens, window, ...(beat?.tokens?.stage ? { stage: beat.tokens.stage } : {}) } }
      : {}),
    ...(tasks?.length ? { tasks } : {}),
    ...(progress ? { progress } : {}),
    ...(worked != null ? { workedMs: worked } : {}),
    ...(estimate != null ? { estimateMs: estimate } : {}),
    ...(attempts != null ? { attempts } : {}),
    ...(turns != null ? { turns } : {}),
    ...(conversation ? { conversation } : {}),
    ...(run?.workRoot ? { worktree: run.workRoot } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Ordering
 * ------------------------------------------------------------------ */

const byLive = (a: SessionRow, b: SessionRow) => Number(b.live) - Number(a.live);
const byLabel = (a: SessionRow, b: SessionRow) => a.label.localeCompare(b.label);
const byRecency = (a: SessionRow, b: SessionRow) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || byLabel(a, b);

export type SessionSortId = 'activity' | 'created' | 'kind';

export const { SORTS, isSortId, sortRows } = defineSorts<SessionRow, SessionSortId>(
  {
    activity: {
      label: 'Activity',
      hint: 'most recently active first',
      blurb: 'Live first, then whatever last printed, answered or was last seen.',
      // The kind tiebreak keeps a grouped list the same order as an ungrouped one, section by section.
      compare: (a, b) => byLive(a, b) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byRecency(a, b),
    },
    created: {
      label: 'Started',
      hint: 'newest session first',
      blurb: 'When each session began — the oldest live one is at the bottom.',
      compare: (a, b) => byLive(a, b) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || byLabel(a, b),
    },
    kind: {
      label: 'Kind',
      hint: 'lanes, then sessions, then shells, then everyone else',
      blurb: 'The four kinds in the order the groups use, each newest first.',
      compare: (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byLive(a, b) || byRecency(a, b),
    },
  },
  { pin: (row) => Boolean(row.attention) },
);

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

/** ⚠️ A type alias, never an `interface`: `defineFilters` needs the implicit index signature. */
export type SessionFilters = {
  /** Free text over the name, the directory and both kinds of id. */
  query: string;
  /** One `SessionGroupKind`, or every kind. A word the list does not offer reads as every kind. */
  kind: string;
};

export const { NO_FILTERS, applyFilters, activeCount } = defineFilters<SessionRow, SessionFilters>({
  query: {
    initial: '',
    prepare: (value) => words(String(value)),
    inert: (value) => !words(String(value)).length,
    keep: (row, terms) =>
      // The directory is the only thing that tells eight `zsh` shells apart,
      // and an id is what a lock, a journal line or a `--resume` command hands you.
      matchesWords(
        `${row.label} ${row.detail ?? ''} ${row.id ?? ''} ${row.sessionId ?? ''} ${row.conversation ?? ''}`,
        terms as string[],
      ),
  },
  kind: {
    initial: '',
    keep: (row, value) => row.kind === value,
  },
});

/** A stored kind the list offers, else every kind. */
export function kindOf(value: string | undefined): SessionGroupKind | '' {
  return SESSION_GROUPS.some((group) => group.kind === value) ? (value as SessionGroupKind) : '';
}

/** How many of each kind exist — counted over everything, never over what a filter left. */
export function kindCounts(rows: readonly SessionRow[]): Record<SessionGroupKind, number> {
  const counts = Object.fromEntries(SESSION_GROUPS.map((group) => [group.kind, 0])) as Record<
    SessionGroupKind,
    number
  >;
  for (const row of rows) counts[row.kind]++;
  return counts;
}

/* ------------------------------------------------------------------ *
 * Grouping and the situation
 * ------------------------------------------------------------------ */

/** The list's two shapes — a section per kind (the shape it has always had), or one list in the chosen order. */
export type SessionGroupBy = 'kind' | 'none';

export const SESSION_GROUPINGS: readonly { id: SessionGroupBy; label: string; blurb: string }[] = [
  { id: 'kind', label: 'Kind', blurb: 'A section per kind: lanes, sessions, shells, everyone else.' },
  { id: 'none', label: 'None', blurb: 'One list, in the chosen order.' },
];

/** `prefs.sessionsGroup` is a boolean, written since 3.0; true is the sections. */
export const groupOf = (grouped: boolean | undefined): SessionGroupBy =>
  grouped === false ? 'none' : 'kind';

/** The rows by kind, in the kinds' order, with no section for a kind that has none. */
export function groupSessionRows(
  rows: readonly SessionRow[],
  by: SessionGroupBy,
): { key: string; label: string; rows: SessionRow[] }[] {
  if (by === 'none') return [{ key: 'all', label: 'Sessions', rows: [...rows] }];
  return SESSION_GROUPS.map((group) => ({
    key: group.kind,
    label: group.title,
    rows: rows.filter((row) => row.kind === group.kind),
  })).filter((group) => group.rows.length > 0);
}

/**
 * The page's situation in one sentence — only the figures that are not zero:
 * "1 needs you, 3 running, 1 waiting and 2 ended." A summons is counted once,
 * under "needs you", whatever its own word is. A frozen process is live until
 * it exits, but the operator holds it, so it is waiting — as its mark says.
 */
export function situationWords(rows: readonly SessionRow[]): string {
  let needs = 0;
  let running = 0;
  let waiting = 0;
  let ended = 0;
  for (const row of rows) {
    if (row.attention) needs++;
    else if (row.live && row.note !== 'frozen') running++;
    else if (row.view.tense === 'settled') ended++;
    else waiting++;
  }
  const parts = [
    needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : '',
    running ? `${running} running` : '',
    waiting ? `${waiting} waiting` : '',
    ended ? `${ended} ended` : '',
  ].filter(Boolean);
  if (!parts.length) return '';
  const last = parts.pop()!;
  return `${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}

/** The strip's figures (#369): what is live, by kind, who waits on a person, and how many accounts the live ones spend. */
export interface SessionSummary {
  lanes: number;
  shells: number;
  agents: number;
  foreign: number;
  /** Sessions stopped on a person — live or not, the summons is the point. */
  waiting: number;
  /** Distinct accounts the LIVE sessions run on. */
  accounts: number;
}

export function sessionSummary(rows: readonly SessionRow[]): SessionSummary {
  const out: SessionSummary = { lanes: 0, shells: 0, agents: 0, foreign: 0, waiting: 0, accounts: 0 };
  const accounts = new Set<string>();
  for (const row of rows) {
    if (row.attention) out.waiting++;
    if (!row.live) continue;
    if (row.kind === 'lane') out.lanes++;
    else if (row.kind === 'shell') out.shells++;
    else if (row.kind === 'agent') out.agents++;
    else out.foreign++;
    if (row.account) accounts.add(row.account.id);
  }
  out.accounts = accounts.size;
  return out;
}
