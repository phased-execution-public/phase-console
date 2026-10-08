/**
 * Your turn's one door and one read (control-tower phase 132, #209,
 * §Architecture 19).
 *
 *   - `raiseTurn` — the door every source of a person's turn passes: the only
 *     caller of `declareHumanStep` (a source scan holds it), so the guard, the
 *     ledger line and the ONE push happen in one place. A source the console
 *     raises names itself (`source: {kind, ref}`), and a second raise of the
 *     same source while its item is open answers that item — the errand
 *     announced again, the preflight run again on a retry, the relay refusing
 *     the same question twice — never a second item and never a second push.
 *   - `turnView` — the projection `GET /api/turn` answers: every inbox row that
 *     asks a person for an act, folded into ONE item per thing to do (an errand
 *     and the step it describes are one item), grouped by `groupOf`, with the
 *     ledger's detail. Pure: the inbox and the ledger's steps in, the answer out.
 *
 * The builders of a raise — `errandTurnInput`, `credentialTurnInput`,
 * `mcpTurnInput`, `questionTurnInput` — live here too, so each source's item is
 * spelled once and a test can read the exact declaration a source makes.
 */

import {
  declareHumanStep, sanitiseStep, type DeclareInput, type HumanStep, type HumanStepLedger, type TurnRefused,
} from '../human-steps.ts';
import { HUMAN_STEP_SETTLED_STATES } from '../../shared/human-step-model.js';
import { TURN_GROUPS, type TurnGroup } from '../../shared/turn-model.js';
import { recommendedOption } from '../../shared/relay-model.js';
import { ledgerTurn, type TurnView } from './fold.ts';
import type { InboxAction, InboxItem } from '../inbox.ts';
import { requestView, type AuthorityRequest, type AuthorityRequestView } from '../owner/requests.ts';
import type { HandledRow } from './handled.ts';
import type { RoundState } from './round.ts';
import { headlineOf, type HeadlineFacts } from './headline.ts';

export { errandIsItem, itemOfErrand, ledgerTurn, turnOf, TURN_SOURCES, BELL_KINDS } from './fold.ts';
export type { TurnRecord, TurnSource, TurnView } from './fold.ts';
export { headlineOf, holdsWords, waitedWords, type HeadlineFacts } from './headline.ts';

/* ------------------------------------------------------------------ *
 * The door
 * ------------------------------------------------------------------ */

/** What the door writes through: the ledger, and the item's one announcement. */
export type TurnDoor = { ledger: HumanStepLedger; announce: (step: HumanStep) => boolean };

/** The source a console's raise names, if it names one. */
function sourceOf(step: unknown): { kind: string; ref?: string } | null {
  const source = (step as { source?: { kind?: unknown; ref?: unknown } } | null)?.source;
  return source && typeof source.kind === 'string'
    ? { kind: source.kind, ...(typeof source.ref === 'string' ? { ref: source.ref } : {}) }
    : null;
}

/**
 * The one door into Your turn. A session's declaration is guarded, a plan's
 * bullet is asked at the launch door, and a console's raise is ONE item per
 * source: while an item of the same source is open for the same run's phase,
 * the raise answers it and writes and pushes nothing.
 */
export function raiseTurn(door: TurnDoor, input: DeclareInput): HumanStep | TurnRefused | null {
  // The supervisor's raise (control-tower phase 136) names its source the
  // same way: one escalation is one item while it stands.
  const source = input.birth === 'console' || input.birth === 'supervisor' ? sourceOf(input.step) : null;
  if (source) {
    const open = door.ledger.open().find((step) => step.birth === input.birth && step.slug === input.slug
      && step.phase === input.phase && (step.runId ?? '') === (input.runId ?? '')
      && step.source?.kind === source.kind && (step.source?.ref ?? '') === (source.ref ?? ''));
    if (open) {
      if (open.title === sanitiseStep(input.step, input.birth)?.step.title) return open;
      // The same source asked again in other words — a re-declared errand: the
      // older item is superseded, so nobody is left holding a stale ask.
      door.ledger.move(open.id, 'dismissed', { by: 'console', verb: 'dismiss', note: 'superseded — the same source asked again, in other words' });
    }
  }
  return declareHumanStep(door, input);
}

/* ------------------------------------------------------------------ *
 * The sources' items, spelled once
 * ------------------------------------------------------------------ */

/** The reason a person errand's sub-kind gives its item — a credential is a secret, anything else is reserved for a person. */
function errandReason(situation: string): 'secret' | 'decision' | 'reserved' {
  const sub = situation.split(':')[1] ?? '';
  return sub === 'credential' ? 'secret' : sub === 'ambiguity' ? 'decision' : 'reserved';
}

/**
 * A person errand IS an `operator-act` item (§Architecture 19): the session's
 * own words as its title, the errand's how as its line, no proof — its
 * *I've done this — check* is the person's word, as "Done — continue" was.
 */
export function errandTurnInput(at: { slug: string; phase: number; runId: string; sessionId?: string }, errand: {
  situation: string; need: string; how?: string;
}): DeclareInput {
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId, ...(at.sessionId ? { sessionId: at.sessionId } : {}),
    step: {
      kind: 'operator-act', title: errand.need, why: errandReason(errand.situation),
      ...(errand.how ? { lines: [errand.how] } : {}),
      source: { kind: 'errand', ref: errand.situation },
    },
  };
}

/** The proof a credential's item is given — presence by name, never the value. */
export function credentialProof(id: string): string {
  return `credential:${id}`;
}

/** Where a missing credential's value goes, told in words — the item never takes it. */
function credentialLines(id: string): { lines: string[]; openCommand?: string } {
  const [scheme, rest = ''] = id.includes(':') ? [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)] : [id, ''];
  if (id === 'gh') return { lines: ['Sign the gh CLI in on the machine this console runs on.'], openCommand: 'gh auth login' };
  if (scheme === 'claude' || id === 'claude-login') {
    return { lines: ['Sign the machine\'s claude login in on the machine this console runs on.'], openCommand: 'claude auth login' };
  }
  if (scheme === 'keychain') return { lines: [`Store it in the login keychain as the generic password named ${rest} — it is read by name, never shown.`] };
  if (scheme === 'env') return { lines: [`Set $${rest} in the console's environment, then restart the console.`] };
  if (scheme === 'file') return { lines: [`Write it to ${rest} on the machine this console runs on.`] };
  return { lines: [`Make the credential ${id} available to this console.`] };
}

/**
 * A credential the preflight found missing (§Architecture 19, TS-4): a
 * `secret-entry` item whose proof is `credential:<id>` — presence by name — and
 * which never takes the value; the person stores it where the line says.
 */
export function credentialTurnInput(at: { slug: string; phase: number; runId: string }, id: string, reason: string): DeclareInput {
  const { lines, openCommand } = credentialLines(id);
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId,
    step: {
      kind: 'secret-entry', title: `Make the credential ${id} available to this console`, why: 'secret', where: 'host',
      proof: credentialProof(id), lines: [...lines, `The preflight read: ${reason}`],
      ...(openCommand ? { open_command: openCommand } : {}),
      source: { kind: 'preflight', ref: credentialProof(id) },
    },
  };
}

/** An MCP server the preflight found unreachable under `require`: an `mcp-login` item, the person's word its proof. */
export function mcpTurnInput(at: { slug: string; phase: number; runId: string }, server: { id: string; detail?: string }): DeclareInput {
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId,
    step: {
      kind: 'mcp-login', title: `Sign the MCP server ${server.id} in`, where: 'host',
      lines: [
        ...(server.detail ? [`The preflight read: ${server.detail}`] : []),
        'Open Phase Console ▸ MCP, sign it in, and check it reads connected.',
      ],
      source: { kind: 'preflight', ref: `mcp:${server.id}` },
    },
  };
}

/**
 * A relayed question the console will not answer by rule (TS-5): a `decision`
 * item that keeps the question's options, the one marked `(Recommended)`
 * recommended — never a prose errand with its options gone.
 */
export function questionTurnInput(at: { slug: string; phase: number; runId: string; sessionId?: string }, question: {
  key: string; question: string; options: readonly { label: string; description?: string }[];
}, why: string): DeclareInput {
  const options = question.options.slice(0, 8).map((option, i) => ({
    id: `o${i + 1}`, label: option.label, ...(option.description ? { consequence: option.description } : {}),
  }));
  const marked = recommendedOption(question.options);
  const recommended = options.find((option) => option.label === marked)?.id;
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId, ...(at.sessionId ? { sessionId: at.sessionId } : {}),
    step: {
      kind: 'decision', title: question.question, why: 'decision',
      lines: [`The console will not answer it by rule: ${why}.`],
      options, ...(recommended ? { recommended } : {}),
      source: { kind: 'relay', ref: question.key },
    },
  };
}

/* ------------------------------------------------------------------ *
 * The read
 * ------------------------------------------------------------------ */

/** The ledger's record of a ledger item, as the page reads it — never a value. */
export type TurnStepDetail = Pick<HumanStep, 'id' | 'kind' | 'title' | 'state' | 'why' | 'whySource' | 'proofType' | 'attempts' | 'waiters' | 'declaredAt' | 'birth'>
  & Partial<Pick<HumanStep, 'proof' | 'proofWords' | 'guide' | 'options' | 'allowDecline' | 'effortMin' | 'unblocks' | 'until' | 'source' | 'read' | 'note'
    | 'permission'>>;

/** One thing to do — however many inbox rows stand for it. */
export type TurnItem = TurnView & {
  /** Every inbox row this item stands for: an errand row and its step's row are ONE item. */
  rows: string[];
  title: string;
  need: string;
  how: string;
  severity: string;
  slug?: string;
  phase?: number;
  runId?: string;
  since: string;
  expiresAt?: string;
  href: string;
  /** The endpoints that press it: a ledger item's `/api/human-steps/:id/…`, a projected item's own. */
  actions: InboxAction[];
  humanStep?: InboxItem['humanStep'];
  category?: InboxItem['category'];
  /** A supervisor card's own facts (control-tower phase 139): the page draws the card in the item. */
  supervisor?: InboxItem['supervisor'];
  /** A ledger item's record — its reason, proof, options, waiters and attempts. */
  step?: TurnStepDetail;
  /**
   * The presses another door asked the owner for ON this item (control-tower
   * phase 148): "asked by <label> — confirm?", each confirmed or refused by the
   * owner in one press (`/api/owner/requests/:id/…`).
   */
  requests?: AuthorityRequestView[];
  /** A request that is about no item is an item of its own — a `decision` — and this is it. */
  request?: AuthorityRequestView;
};

/** `GET /api/turn`. */
export type TurnAnswer = {
  /**
   * When this was read, and the console's own round (control-tower phase 136):
   * `n` rises only when a round changed the turn, `ranAt` is the last round,
   * `changedAt` the last one that changed something.
   */
  round: { at: string; n: number; ranAt: string | null; changedAt: string | null };
  /** One sentence, composed by RULES from the state (`headlineOf`) — never by a model. */
  headline: string;
  groups: Record<TurnGroup, TurnItem[]>;
  /** What the AI handled instead of asking, newest first (`turn/handled.ts`). */
  handled: HandledRow[];
  /**
   * How many of each group, the open total, and how many things were handled
   * since `seen` — the person's last look — or, with none, in the last day.
   */
  counts: Record<TurnGroup, number> & { total: number; handled: number };
  /** The last look the handled count is taken from — echoed, or null for the last day. */
  seen: string | null;
  /** Issue drafts wait on Repo ▸ Issues, not here: how many, and the link. */
  issues: { count: number; href: string } | null;
};

/** How long a settled item stays under *Done*. */
export const TURN_DONE_MS = 24 * 60 * 60_000;

const SETTLED = new Set<string>(HUMAN_STEP_SETTLED_STATES as readonly string[]);

function detailOf(step: HumanStep): TurnStepDetail {
  return {
    id: step.id, kind: step.kind, title: step.title, state: step.state, why: step.why, whySource: step.whySource,
    proofType: step.proofType, attempts: step.attempts, waiters: step.waiters, declaredAt: step.declaredAt, birth: step.birth,
    ...(step.proof ? { proof: step.proof } : {}),
    ...(step.proofWords ? { proofWords: step.proofWords } : {}),
    ...(step.guide ? { guide: step.guide } : {}),
    ...(step.options ? { options: step.options } : {}),
    ...(step.allowDecline ? { allowDecline: step.allowDecline } : {}),
    ...(step.effortMin ? { effortMin: step.effortMin } : {}),
    ...(step.unblocks ? { unblocks: step.unblocks } : {}),
    ...(step.until ? { until: step.until } : {}),
    ...(step.source ? { source: step.source } : {}),
    ...(step.read ? { read: step.read } : {}),
    ...(step.note ? { note: step.note } : {}),
    ...(step.permission ? { permission: step.permission } : {}),
  };
}

/** The oldest item that needs the person now, with the lanes it holds. */
function oldestOf(groups: Record<TurnGroup, TurnItem[]>): HeadlineFacts['oldest'] {
  const open = [...groups.now, ...groups.decide].filter((item) => Number.isFinite(Date.parse(item.since)));
  if (!open.length) return null;
  const oldest = open.reduce((a, b) => (Date.parse(b.since) < Date.parse(a.since) ? b : a));
  const lanes = oldest.step?.waiters?.length
    ? oldest.step.waiters.map((waiter) => ({ slug: waiter.slug, phase: waiter.phase }))
    : oldest.slug && oldest.phase != null ? [{ slug: oldest.slug, phase: oldest.phase }] : [];
  // The item's own words when the ledger holds it — "sign gh in", not the inbox row's frame.
  return { title: oldest.step?.title ?? oldest.title, since: oldest.since, holds: lanes.filter((lane) => lane.phase > 0) };
}

/**
 * The turn, projected from the inbox (every person-facing row, acknowledged
 * or not — an ack is "seen", never "done") and the ledger (each ledger item's
 * record; the steps settled in the last day as *Done*).
 */
export function turnView(
  inbox: { items: readonly InboxItem[]; generatedAt: string },
  ledger: {
    steps?: readonly HumanStep[]; now?: number; requests?: readonly AuthorityRequest[];
    /** What the AI handled (phase 136): the newest rows, and how many since the last look. */
    handled?: { rows: readonly HandledRow[]; since: number; seen: string | null };
    round?: RoundState;
  } = {},
): TurnAnswer {
  const now = ledger.now ?? Date.parse(inbox.generatedAt);
  const byId = new Map((ledger.steps ?? []).map((step) => [step.id, step]));
  const items = new Map<string, TurnItem>();
  for (const row of inbox.items) {
    const turn = row.turn;
    if (!turn) continue;
    // A row that does not ask yet is shown only as what is coming up.
    if (row.severity === 'fyi' && turn.group !== 'upcoming') continue;
    const held = items.get(turn.item);
    if (held) {
      held.rows.push(row.id);
      // The step's own row leads: its verbs are the item's.
      if (row.kind === 'human-step') Object.assign(held, leadOf(row, turn), { rows: held.rows });
      continue;
    }
    items.set(turn.item, leadOf(row, turn));
  }
  for (const item of items.values()) {
    const step = item.record === 'ledger' ? byId.get(item.item) : undefined;
    if (step) item.step = detailOf(step);
  }
  // A request the owner has not answered (phase 148): on its item when the turn
  // shows that item, else a `decision` item of its own.
  for (const request of ledger.requests ?? []) {
    if (request.state !== 'open') continue;
    const view = requestView(request);
    const home = requestHome([...items.values()], request);
    if (home) (home.requests ??= []).push(view);
    else items.set(`request:${request.id}`, requestItem(view));
  }
  // *Done*: the ledger's items settled in the last day, nothing to press.
  for (const step of ledger.steps ?? []) {
    if (!SETTLED.has(step.state) || items.has(step.id) || now - Date.parse(step.at) > TURN_DONE_MS) continue;
    const turn = ledgerTurn(step);
    items.set(step.id, {
      ...turn, rows: [], title: step.title, need: step.title, how: step.note ?? '', severity: 'fyi',
      slug: step.slug, phase: step.phase, ...(step.runId ? { runId: step.runId } : {}),
      since: step.at, href: '', actions: [], step: detailOf(step),
    });
  }
  const groups = Object.fromEntries(TURN_GROUPS.map((group) => [group, [] as TurnItem[]])) as Record<TurnGroup, TurnItem[]>;
  for (const item of items.values()) groups[item.group].push(item);
  const counts = Object.fromEntries(TURN_GROUPS.map((group) => [group, groups[group].length])) as TurnAnswer['counts'];
  counts.total = counts.now + counts.decide + counts.checking + counts.upcoming;
  counts.handled = ledger.handled?.since ?? 0;
  const drafts = inbox.items.filter((row) => row.kind === 'issue-draft');
  const seen = ledger.handled?.seen ?? null;
  return {
    round: {
      at: inbox.generatedAt, n: ledger.round?.n ?? 0, ranAt: ledger.round?.at ?? null, changedAt: ledger.round?.changedAt ?? null,
    },
    headline: headlineOf({
      open: counts.now + counts.decide, checking: counts.checking, upcoming: counts.upcoming,
      handled: counts.handled, handledSince: seen ? 'seen' : 'day', oldest: oldestOf(groups), now,
    }),
    groups,
    handled: [...(ledger.handled?.rows ?? [])],
    counts,
    seen,
    issues: drafts.length ? { count: drafts.length, href: drafts[0]!.href } : null,
  };
}

/** The item a request is about, among the ones the turn shows — or none. */
function requestHome(items: readonly TurnItem[], request: AuthorityRequest): TurnItem | undefined {
  const about = request.item;
  if (!about) return undefined;
  if (about.kind === 'human-step') return items.find((item) => item.item === about.id);
  if (about.kind === 'approval') {
    return items.find((item) => item.source === 'approval' && item.actions.some((action) => action.endpoint.startsWith(`/api/approvals/${about.id}`)));
  }
  if (about.kind === 'gate') return items.find((item) => item.source === 'gate' && item.slug === about.slug && item.phase === about.phase);
  return items.find((item) => item.source === about.kind && item.slug === about.slug);
}

/** A request about no item the turn shows: a `decision` only the owner answers. */
function requestItem(view: AuthorityRequestView): TurnItem {
  const sentence = view.ask.charAt(0).toUpperCase() + view.ask.slice(1);
  const answer = (verb: 'confirm' | 'refuse', label: string): InboxAction => ({
    verb, label, endpoint: `/api/owner/requests/${encodeURIComponent(view.id)}/${verb}`, method: 'POST',
  });
  return {
    item: `request:${view.id}`, record: 'request', source: 'request', kind: 'decision', why: 'decision', proofType: 'answer',
    group: 'decide', rows: [], title: sentence, need: view.summary,
    how: 'Confirm presses it now, as the owner; Refuse drops it. Only the owner answers it — sign in with your owner key.',
    severity: 'needs-you', since: view.at, href: '', actions: [answer('confirm', 'Confirm'), answer('refuse', 'Refuse')], request: view,
  };
}

function leadOf(row: InboxItem, turn: TurnView): TurnItem {
  return {
    ...turn, rows: [row.id], title: row.title, need: row.need, how: row.how, severity: row.severity,
    ...(row.slug ? { slug: row.slug } : {}),
    ...(row.phase != null ? { phase: row.phase } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    since: row.since, ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}), href: row.href,
    actions: row.actions,
    ...(row.humanStep ? { humanStep: row.humanStep } : {}),
    ...(row.category ? { category: row.category } : {}),
    ...(row.supervisor ? { supervisor: row.supervisor } : {}),
  };
}
