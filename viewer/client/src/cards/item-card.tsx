/**
 * One item of Your turn, whole — the board's card in 7.0's language
 * (control-tower phase 137, #214; rebuilt by turn-by-turn phase 8 around the
 * Owner To-Do Board's anatomy, `viewer/docs/design.md` §Your turn).
 *
 * A card, because an item is acted on as a unit, and a quiet one: the server
 * decided what the item is (`GET /api/turn` — its type, the person's status,
 * whether it is due, where a press goes, every word); this file only draws it,
 * top to bottom in the order a person needs it:
 *
 *   1. the head (`turn/head.tsx`): NOW, or NOT YET with its *when*; the type's
 *      mark; the person's status as a dot and a word; the title; the meta;
 *   2. the timing grid on the one page clock (`turn/timing.tsx`);
 *   3. why only the person fits it — once;
 *   4. the verdict BEFORE the steps (`turn/verdict.tsx`): Redo with its numbered
 *      fixes, or the check still running, or how it ended;
 *   5. *From the AI*, the numbered steps on the line, the plan/session link,
 *      *How it's checked*, *Goes to* and *Checked by* (`turn/steps.tsx`);
 *   6. ONE act form per type (`turn/act.tsx`, `decision-card.tsx`), its primary
 *      chosen by the move table (`turn/moves.ts`, IC-v2) — and *Undo: I'm not
 *      finished* while a check runs; an action the console's flags switch off
 *      is drawn disabled with the flag that turns it on;
 *   7. one press in, the history — who raised it and when, every move, every
 *      attempt side by side with its evidence, the questions, the answer — and
 *      one more, the raw record.
 *
 * Never a field for a secret: a `secret-entry` item says where the value goes,
 * and its check takes no note. Every press goes through `data/press.ts` (the
 * owner door); a terminal one — Approve, Deny, Not doing this, Send my
 * decision — waits out the undo window on the page (`data/undo-window.ts`). The
 * pieces a screen draws INSIDE an item — a permission item's own card, the
 * owner's pending requests, the supervisor's card, a link's QR — are lent by
 * the screen (`parts`), and the card says what it can without them.
 */

import { useEffect, useId, useState, type ComponentType, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';

import { humanStepView, type HumanStepState, type HumanStepView } from '@shared/human-step-model.js';
import {
  personStatusOf,
  readinessOf,
  readinessShown,
  typeOf,
  type ItemType,
  type PersonStatus,
  type Readiness,
} from '@shared/turn-model.js';
import { actionBody, type InboxAction, type InboxItem, type TurnOption } from '@/data/api';
import { sendOnLeave } from '@/data/http';
import {
  humanStepsApi as api,
  type HumanStepRecord,
  type PermissionRecord,
  type StepEvidenceInput,
  type StepVerbAnswer,
} from '@/data/human-steps';
import { keys } from '@/data/keys';
import { patchHumanStep } from '@/data/live';
import type { AuthorityRequest } from '@/data/owner';
import { press, type Pressed } from '@/data/press';
import { giveBack, pressOption, undoCheck, type TurnItem } from '@/data/turn';
import { useHeldPress } from '@/data/undo-window';
import { cn } from '@/lib/cn';
import { toHash } from '@/shell/routes';
import { Button, Input, KeyValue, toast, type KeyValueItem } from '@/ui';
import { CodeBlock } from '@/ui/code-block';
import { Disclosure } from '@/ui/disclosure';
import { MicField } from '@/ui/mic-field';
import { OpsStatus } from '@/ui/status';
import { DecisionCard, type DecisionAnswer, type DecisionOption } from './decision-card';
import { guideOf } from './guide';
import { NextStepNote } from './next-step-note';
import {
  BIRTH_WORDS,
  DeviceCode,
  KindMark,
  MoveLine,
  RawRecord,
  SecretWhere,
  WhereWord,
  errorWords,
  stamp,
  useStepVerbs,
} from './human-step-card';
import { primaryActOf, primaryLabel } from './human-step-words';
import { StepTerminalSheet } from './step-terminal-sheet';
import { ApprovalAct, FlaggedActions, HeadsUpAct, HeldLine, TaskAct, UndoAct } from './turn/act';
import { Head, Meta, WhyLine } from './turn/head';
import {
  NONE_WORDS,
  approveLabelOf,
  cardMoveOf,
  denyLabelOf,
  isGrantItem,
  saysNo,
  saysYes,
  type CardMove,
} from './turn/moves';
import { CoverLinks, FromTheAI, HowChecked, Routing, Steps } from './turn/steps';
import { TimingGrid, timingOf } from './turn/timing';
import { CheckingLine, SettledLine, Verdict } from './turn/verdict';

type Perform = (item: InboxItem, action: InboxAction, says?: string) => void;

/* ------------------------------------------------------------------ *
 * The item's facts, as the card reads them
 * ------------------------------------------------------------------ */

/** The inbox row a projected item is pressed as — `perform` keys its busy state on the row's id. */
function rowOf(item: TurnItem): InboxItem {
  return { ...(item as unknown as InboxItem), id: item.rows[0] ?? item.item };
}

/** The step view the verbs press: the row's own, else one read from the ledger's record. */
function viewOf(item: TurnItem, record: HumanStepRecord | undefined, state: HumanStepState): HumanStepView {
  if (item.humanStep) return { ...item.humanStep, state };
  const input: Record<string, unknown> = {
    kind: item.kind,
    title: record?.title ?? item.step?.title ?? item.title,
    state,
  };
  if (item.record === 'ledger') input.stepId = item.item;
  for (const key of ['where', 'openUrl', 'openCommand', 'lines', 'code', 'proof', 'dueWhen'] as const) {
    if (record?.[key] !== undefined) input[key] = record[key];
  }
  return humanStepView(input as Parameters<typeof humanStepView>[0]);
}

/**
 * The card's three words — type, the person's status, readiness — as the
 * server derived them, re-derived from the ledger record when the page holds
 * a newer one (a live patch lands before the next read), and derived here for
 * a 7.0 answer that carries none.
 */
export function cardWordsOf(
  item: TurnItem,
  record: HumanStepRecord | undefined,
  state: HumanStepState,
): { type: ItemType; personStatus: PersonStatus; readiness: Readiness } {
  const verdict = record?.verdict?.state ?? item.verdict?.state ?? null;
  const type =
    item.type ??
    typeOf({
      kind: item.kind,
      source: item.source,
      record: item.record,
      proofType: item.proofType,
      hasOptions: Boolean(item.options?.length || item.step?.options?.length),
      hasApproval: Boolean(item.approval),
    });
  const personStatus = item.settled
    ? item.settled.outcome
    : record || !item.personStatus
      ? personStatusOf({ state: item.record === 'projected' ? null : state, verdict, record: item.record })
      : item.personStatus;
  const readiness =
    record || !item.readiness
      ? readinessOf({ state: item.record === 'projected' ? null : state, dueWhen: record?.dueWhen ?? null })
      : item.readiness;
  return { type, personStatus, readiness };
}

/** Is the act's answer a secret or a code — so its check takes no note, and the card draws no field for one. */
const NO_NOTE_KINDS: ReadonlySet<string> = new Set(['secret-entry', 'one-time-code', 'device-code']);

/** The row verbs that END an item — a yes or a no — held for the undo window before they are sent. */
const HELD_VERBS: ReadonlySet<string> = new Set(['approve', 'allow', 'deny', 'grant']);

/** A run request's act, when the item is one (turn-by-turn phase 6). */
function runActOf(item: TurnItem): string | null {
  const source = item.step?.source;
  return source?.kind === 'run-request' && source.ref ? source.ref : null;
}

/* ------------------------------------------------------------------ *
 * Pressing — the item's own verbs beside the step card's
 * ------------------------------------------------------------------ */

type ItemBusy = 'answer' | 'decline' | 'ask' | 'attach' | 'override' | 'rewrite' | 'undo' | null;

/**
 * The verbs only an item has — answer, decline, ask, attach, the escalation's
 * two, give back and undo — each through the owner door, each answer patched
 * straight into the caches, and the inbox (the turn sits under its key) re-read
 * whatever happened.
 */
function useItemVerbs(id: string | undefined) {
  const client = useQueryClient();
  const [busy, setBusy] = useState<ItemBusy>(null);

  async function run(
    which: Exclude<ItemBusy, null>,
    call: (id: string) => Promise<StepVerbAnswer>,
    said: string,
  ) {
    return runPressed(which, (at) => press(() => call(at)), said);
  }

  async function runPressed(
    which: Exclude<ItemBusy, null>,
    pressIt: (id: string) => Promise<Pressed<StepVerbAnswer>>,
    said: string,
  ) {
    if (!id) return null;
    setBusy(which);
    try {
      const pressed = await pressIt(id);
      if (pressed.state === 'asked') {
        toast(pressed.words, 'info', 8000);
        return null;
      }
      if (pressed.result.step) patchHumanStep(client, pressed.result.step);
      toast(said, 'ok');
      return pressed.result;
    } catch (cause) {
      toast(errorWords(cause), 'warn', 8000);
      return null;
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: keys.inbox() });
    }
  }

  return {
    busy,
    answer: (body: DecisionAnswer) =>
      run('answer', (at) => api.humanStepAnswer(at, body), 'Answer sent — the session carries on with it.'),
    decline: (reason: string) =>
      run('decline', (at) => api.humanStepDecline(at, reason), 'Not doing it — the session is told why.'),
    /** The same answer, sent as the page goes away inside its undo window (#368). */
    answerOnLeave: (body: DecisionAnswer) =>
      id ? sendOnLeave(`/api/human-steps/${encodeURIComponent(id)}/answer`, body) : false,
    declineOnLeave: (reason: string) =>
      id ? sendOnLeave(`/api/human-steps/${encodeURIComponent(id)}/decline`, { reason }) : false,
    ask: (text: string) =>
      run('ask', (at) => api.humanStepAsk(at, text), 'Asked — the session reads it when it resumes.'),
    attach: (evidence: StepEvidenceInput) =>
      run('attach', (at) => api.humanStepAttach(at, evidence), 'Attached to this attempt.'),
    override: () =>
      run(
        'override',
        (at) => api.humanStepOverride(at),
        'Accepted on your word — recorded as yours, unverified.',
      ),
    rewrite: () =>
      run(
        'rewrite',
        (at) => api.humanStepRewrite(at),
        'Withdrawn — the session is asked for a better guide.',
      ),
    /** *Give back to Phase N* (turn-by-turn phase 5) — the phase that raised it takes it back. */
    giveBack: (phase: number) =>
      runPressed('rewrite', (at) => giveBack(at), `Given back — phase ${phase} takes it from here.`),
    /** *Undo: I'm not finished* on a running check (turn-by-turn phase 5) — the item is yours to do again. */
    undo: () => runPressed('undo', (at) => undoCheck(at), 'Check taken back — it is yours to do again.'),
  };
}

/* ------------------------------------------------------------------ *
 * The pieces
 * ------------------------------------------------------------------ */

/** What stopped the AI, why the phase needs it, and what a grant would do — a permission item's own facts. */
function PermissionFacts({ permission }: { permission: PermissionRecord }) {
  return (
    <div data-testid="turn-permission" className="flex min-w-0 max-w-prose flex-col gap-2 text-body text-ink">
      <p>
        <span className="font-medium">What stopped the AI. </span>
        {permission.tool ? <code className="font-mono text-meta">{permission.tool}</code> : 'A tool'}
        {permission.rule ? (
          <>
            {' '}
            under the rule <code className="font-mono text-meta wrap-anywhere">{permission.rule}</code>
          </>
        ) : null}
        .
      </p>
      {permission.need && (
        <p>
          <span className="font-medium">Why the phase needs it. </span>
          {permission.need}
        </p>
      )}
      {permission.command && <CodeBlock code={permission.command} testId="guide-command" />}
      {permission.never ? (
        <p data-testid="turn-permission-never">
          <span className="font-medium">It is never granted. </span>
          {permission.never.why} By hand:{' '}
          <code className="font-mono text-meta wrap-anywhere">{permission.never.manual}</code>
        </p>
      ) : permission.grant ? (
        <p>
          <span className="font-medium">What Approve does. </span>
          {permission.grant.label}
        </p>
      ) : null}
    </div>
  );
}

/** An approval's block: what is asked, who asked, and what each answer does. */
function ApprovalBlock({ approval }: { approval: NonNullable<TurnItem['approval']> }) {
  const rows: KeyValueItem[] = [
    ['What', approval.what],
    ['Asked by', approval.askedBy],
    ['If you approve', approval.ifApproved],
    ['If you deny', approval.ifDenied],
    approval.scopes?.length ? ['Scopes', approval.scopes.join(', ')] : null,
  ];
  return (
    <div data-testid="turn-approval" className="max-w-prose">
      <KeyValue items={rows} />
    </div>
  );
}

/** Three misses: the item asks how it should end, three ways. */
function Escalation({
  attempts,
  busy,
  onRewrite,
  onCannot,
  onOverride,
}: {
  attempts: number;
  busy: boolean;
  onRewrite: () => void;
  onCannot: (reason: string) => void;
  onOverride: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = useId();
  return (
    <div
      data-testid="turn-escalation"
      className="flex min-w-0 max-w-prose flex-col gap-2.5 rounded-md bg-ground px-3 py-3 text-body text-ink"
    >
      <p>{attempts} attempts have not passed. Choose how this ends.</p>
      <ul className="flex list-none flex-col gap-2 p-0">
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button size="sm" disabled={busy} onClick={onRewrite}>
            Rewrite the guide
          </Button>
          <span className="text-meta text-ink-muted">
            The item is withdrawn and the session asked for a better one.
          </span>
        </li>
        <li className="flex flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button size="sm" disabled={busy} aria-expanded={asking} onClick={() => setAsking((was) => !was)}>
              I can’t do this
            </Button>
            <span className="text-meta text-ink-muted">It becomes an errand, with your reason.</span>
          </span>
          {asking && (
            <form
              className="flex min-w-0 flex-wrap items-end gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!reason.trim()) return;
                onCannot(reason.trim());
                setAsking(false);
                setReason('');
              }}
            >
              <label
                htmlFor={reasonId}
                className="flex min-w-0 flex-1 flex-col gap-1 text-meta text-ink-muted"
              >
                Why not? Who can do it, or what is in the way.
                <Input
                  id={reasonId}
                  block
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <Button size="sm" type="submit" disabled={busy || !reason.trim()}>
                Hand it back
              </Button>
            </form>
          )}
        </li>
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {confirming ? (
            <>
              <Button size="sm" variant="danger" disabled={busy} onClick={onOverride}>
                Accept it on my word
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep checking
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
              Accept anyway
            </Button>
          )}
          <span className="text-meta text-ink-muted">
            Recorded as yours and unverified; the session carries on.
          </span>
        </li>
      </ul>
    </div>
  );
}

/**
 * Every attempt, side by side — as many abreast as the card holds, wrapping
 * rather than scrolling: its verdict, what to redo, what the check read, and
 * its evidence.
 */
function Attempts({ record }: { record: HumanStepRecord }) {
  const verdicts = record.verdicts ?? (record.verdict ? [record.verdict] : []);
  const evidence = record.evidence ?? [];
  const numbers = [...new Set([...verdicts.map((v) => v.attempt), ...evidence.map((e) => e.attempt)])].sort(
    (a, b) => a - b,
  );
  if (!numbers.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-meta font-medium text-ink">Every attempt</p>
      <ol
        data-testid="turn-attempts"
        className="grid list-none grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2 p-0"
      >
        {numbers.map((n) => {
          const verdict = verdicts.find((v) => v.attempt === n);
          const files = evidence.filter((e) => e.attempt === n);
          return (
            <li
              key={n}
              data-testid="turn-attempt"
              data-attempt={n}
              className="flex min-w-0 flex-col gap-1 rounded-md bg-surface px-3 py-2 text-meta"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium text-ink">Attempt {n}</span>
                {verdict && <OpsStatus vocab="verdict" word={verdict.state} />}
              </div>
              {verdict ? (
                <>
                  <p className="text-ink">{verdict.note}</p>
                  {verdict.redo.length > 0 && (
                    <p className="text-ink-muted">Redo: {verdict.redo.join('; ')}</p>
                  )}
                  {verdict.read.length > 0 && (
                    <p className="text-ink-muted">Read: {verdict.read.join('; ')}</p>
                  )}
                  <p className="text-ink-muted">
                    {verdict.by}, {stamp(verdict.at)}
                  </p>
                </>
              ) : (
                <p className="text-ink-muted">No verdict yet.</p>
              )}
              {files.length > 0 && (
                <ul className="flex list-none flex-col gap-0.5 p-0" data-testid="turn-evidence">
                  {files.map((file) => (
                    <li key={file.ref} className="min-w-0 break-words text-ink">
                      {file.name ?? file.kind}{' '}
                      <span className="text-ink-muted">
                        ({file.mime}, {file.bytes} bytes{file.by ? `, by ${file.by}` : ''})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One press in: who raised it and when, its kind and where, every move and attempt, the questions, the answer — and the raw record. */
function History({
  item,
  record,
  view,
}: {
  item: TurnItem;
  record: HumanStepRecord | undefined;
  view: HumanStepView;
}) {
  const moves = record?.moves ?? [];
  const questions = record?.question ?? [];
  const answer = record?.answer;
  const birth = record?.birth ?? item.step?.birth;
  const who = birth
    ? birth === 'session' && record?.sessionId
      ? `${BIRTH_WORDS.session} (${record.sessionId})`
      : (BIRTH_WORDS[birth] ?? birth)
    : item.source;
  const source = record?.source ?? item.step?.source;
  const declared = record?.declaredAt ?? item.step?.declaredAt ?? item.since;
  const proof = record?.proof ?? item.step?.proof;
  const facts: KeyValueItem[] = [
    [
      'Raised by',
      <span data-testid="turn-raised-by">
        {who}, {stamp(declared)}
      </span>,
    ],
    ['What it is', <KindMark kind={item.kind} />],
    item.record === 'ledger' ? ['Where', <WhereWord where={view.where} />] : null,
    source && [
      'From',
      <>
        {source.kind}
        {source.ref ? <code className="ms-1.5 font-mono text-meta">{source.ref}</code> : null}
      </>,
    ],
    proof ? ['What proves it', <code className="font-mono text-meta wrap-anywhere">{proof}</code>] : null,
    record?.dueWhen
      ? [
          'Due when',
          <>
            <code className="font-mono text-meta wrap-anywhere">{record.dueWhen}</code>
            {record.dueAt ? ` landed, ${stamp(record.dueAt)}` : ' lands'}
          </>,
        ]
      : null,
    record?.provenBy ? ['Proven by', record.provenBy] : null,
  ];
  return (
    <div data-print="hide">
      <Disclosure
        testId="turn-history-toggle"
        label="The history: who raised it, every move and attempt"
        openLabel="Hide the history"
        bodyClassName="pt-2"
      >
        <div
          data-testid="turn-history"
          className="flex min-w-0 flex-col gap-3 rounded-md bg-ground px-3 py-3 text-meta"
        >
          <KeyValue items={facts} />
          {record && <Attempts record={record} />}
          {moves.length > 0 && (
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium text-ink">Every move</p>
              <ol className="flex list-none flex-col gap-0.5 p-0">
                {moves.map((move, index) => (
                  <MoveLine key={`${move.at}-${index}`} move={move} />
                ))}
              </ol>
            </div>
          )}
          {questions.length > 0 && (
            <div data-testid="turn-questions" className="flex min-w-0 flex-col gap-1">
              <p className="font-medium text-ink">Asked about it</p>
              <ul className="flex list-none flex-col gap-0.5 p-0">
                {questions.map((question, index) => (
                  <li key={`${question.at}-${index}`} className="text-ink">
                    <span className="text-ink-muted tabular-nums">{stamp(question.at)} </span>
                    {question.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {answer && (
            <p data-testid="turn-answer" className="text-ink">
              <span className="font-medium">Answered: </span>
              {[answer.label ?? answer.option, answer.note].filter(Boolean).join(' — ')}
              <span className="text-ink-muted">
                {' '}
                ({answer.by ? `${answer.by}, ` : ''}
                {stamp(answer.at)})
              </span>
            </p>
          )}
          <Disclosure testId="turn-raw-toggle" label="The raw record" openLabel="Hide the raw record">
            <RawRecord testId="turn-raw" value={record ?? item} />
          </Disclosure>
        </div>
      </Disclosure>
    </div>
  );
}

/** A link meant for the device in the person's hand, shown whole to copy — and as a QR where one is lent. */
function PhoneLink({ url, children }: { url: string; children?: ReactNode }) {
  return (
    <div data-testid="turn-qr" className="flex min-w-0 flex-wrap items-center gap-3">
      {children}
      <p className="min-w-0 max-w-prose text-body text-ink">
        Open it on the device in your hand: <code className="font-mono text-meta wrap-anywhere">{url}</code>
      </p>
    </div>
  );
}

/** *Got it* on a heads-up — a mark kept in this browser: nothing checks a heads-up or waits on it. */
const SEEN = (item: string) => `turn:seen:${item}`;
function useSeen(item: string): [boolean, () => void] {
  const [seen, setSeen] = useState(() => {
    try {
      return window.localStorage.getItem(SEEN(item)) === '1';
    } catch {
      return false;
    }
  });
  return [
    seen,
    () => {
      setSeen(true);
      try {
        window.localStorage.setItem(SEEN(item), '1');
      } catch {
        /* a private window keeps it for this visit */
      }
    },
  ];
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

/**
 * The pieces a screen lends the card — drawn INSIDE an item, and owned by the
 * screen that answers them. Each is optional: without a permission card the
 * item says what stopped the AI and offers its own Approve and Deny; without
 * the owner's requests, nothing is drawn for them.
 */
export interface ItemCardParts {
  /** A ledger permission item, answered on a card of its own — the scopes, the risk, the typed rule, the owner key. */
  PermissionCard?: ComponentType<{
    item: TurnItem;
    permission: PermissionRecord;
    row: InboxItem;
    perform: Perform;
    busy?: string | undefined;
    live?: boolean;
  }>;
  /** What other doors asked the owner to press on this item — each confirmed or refused once. */
  OwnerRequests?: ComponentType<{ requests: readonly AuthorityRequest[] | undefined }>;
  /**
   * The outcome of a check just pressed, in words — what the proof read, the
   * exit it saw, what to redo (quiet-console phase 8, #266). Drawn in the
   * verdict's place, before the steps, and the ledger's verdict of the same
   * attempt is not drawn twice.
   */
  CheckOutcome?: ComponentType<{ answer: StepVerbAnswer; record?: HumanStepRecord | undefined }>;
}

export interface ItemCardProps {
  item: TurnItem;
  /** A ledger item's whole record — its moves, verdicts, evidence, questions and answer. */
  record?: HumanStepRecord | undefined;
  /** Presses a row action verbatim (`useInboxActions().perform`). */
  perform: Perform;
  /** `${rowId}:${verb}` of whatever row action is in flight. */
  busy?: string | undefined;
  /** `#/turn/<id>` names this item: drawn open, and marked current. */
  focused?: boolean;
  /** Drawn as its head alone, opening in place — *Coming up* and *Done*. */
  folded?: boolean;
  /** What the screen lends the card. */
  parts?: ItemCardParts;
  /** Inspect — the second door to depth: the screen shows the item in the panel (quiet-console phase 8). */
  onInspect?: (() => void) | undefined;
  /** The screen's own moves on this item (*Withdraw*), drawn after the card's. */
  moves?: ReactNode;
}

const NO_PARTS: ItemCardParts = {};

export function ItemCard({
  item,
  record,
  perform,
  busy,
  focused = false,
  folded = false,
  parts = NO_PARTS,
  onInspect,
  moves,
}: ItemCardProps) {
  const [open, setOpen] = useState(!folded || focused);
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);
  const titleId = useId();
  const state: HumanStepState = record?.state ?? item.step?.state ?? item.humanStep?.state ?? 'notified';
  const view = viewOf(item, record, state);
  const verbs = useStepVerbs(view);
  const extra = useItemVerbs(item.record === 'ledger' ? item.item : undefined);
  const client = useQueryClient();
  // A terminal press waits here for the undo window before it is sent (turn-by-turn phase 5).
  const held = useHeldPress();
  const holding = held.held !== null;
  const [optionBusy, setOptionBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [seen, markSeen] = useSeen(item.item);
  const { PermissionCard, OwnerRequests, CheckOutcome } = parts;

  const ledger = item.record === 'ledger';
  const words = cardWordsOf(item, record, state);
  const card: TurnItem = { ...item, ...words };
  const status = words.personStatus;
  const settled = status === 'passed' || status === 'not-doing' || status === 'closed';
  const live = !settled;
  const notYet = words.readiness === 'not-yet' && readinessShown(status);
  const checking = status === 'checking';
  const proofType = record?.proofType ?? item.step?.proofType ?? item.proofType;
  const why = record?.why ?? item.step?.why ?? item.why;
  const inferred = (record?.whySource ?? item.step?.whySource) === 'inferred';
  const guide = guideOf(record?.guide ?? item.step?.guide);
  const verdict = record?.verdict ?? item.verdict ?? undefined;
  const attempts = record?.attempts ?? item.step?.attempts ?? 0;
  const permission = item.permission ?? item.step?.permission ?? record?.permission;
  // A ledger permission item is answered on its own card where the screen lends
  // one: the scopes, the risk, the typed rule and the owner key.
  const ownCard = Boolean(permission && ledger && PermissionCard);
  const risk = item.permission?.risk ?? item.step?.permission?.risk ?? record?.permission?.risk;
  const row = rowOf(item);
  const timing = timingOf(item, record);

  // The ways on. A ledger decision's options are answered through its own
  // verb; a projected item's are each bound to the verb that takes them
  // (turn-by-turn phase 5), and the row buttons the server derived from them
  // are the same presses, so they are not drawn twice.
  const ledgerOptions: readonly DecisionOption[] = ledger
    ? (record?.options ?? item.step?.options ?? [])
    : [];
  const bound: readonly TurnOption[] =
    live && !item.supervisor && !(ledger && ledgerOptions.length) ? (item.options ?? []) : [];
  const boundTo = (action: InboxAction) =>
    bound.some(
      (option) =>
        option.id === action.verb ||
        (option.verb.endpoint === action.endpoint && option.verb.method === action.method),
    );
  // A ledger item's row carries the step's own verbs, which this card offers in
  // its own form — only a permission's grant, deny and convert are its row's.
  const grantItem = isGrantItem({ kind: item.kind, proofType, record: item.record });
  const rowActions = ledger && !grantItem ? [] : item.actions.filter((action) => !boundTo(action));
  const options: readonly DecisionOption[] = ledgerOptions.length ? ledgerOptions : bound;
  const move: CardMove = cardMoveOf({
    type: words.type,
    personStatus: status,
    readiness: words.readiness,
    record: item.record,
    kind: item.kind,
    proofType,
    actions: rowActions,
    options,
    supervisor: Boolean(item.supervisor),
  });
  const pressable = rowActions.filter((action) => !action.flag);
  const runAct = runActOf(item);
  const escalated = Boolean(record?.escalatedAt) && live && !notYet;
  // The composer's title (#377): sentence case, at most 80 characters, no
  // errand ref — the ledger's raw words only where an item carries none.
  const title = item.title || record?.title || item.step?.title || '';
  // A check just pressed answers in words (#266), where the screen lends the
  // part: its outcome takes the verdict's place, and the ledger's verdict of
  // the same attempt — patched in by the same answer — is not drawn twice.
  const fresh =
    CheckOutcome && verbs.answer && (verbs.answer.check || verbs.answer.verdict) ? verbs.answer : null;
  const echoed = Boolean(
    fresh?.verdict && verdict && fresh.verdict.attempt === verdict.attempt && fresh.verdict.at === verdict.at,
  );
  const notes = item.step?.notes ?? [];
  const lastNote = notes.length ? notes[notes.length - 1] : undefined;
  const giveBackPhase =
    ledger && item.route === 'phase' && item.phase != null && item.phase > 0 ? item.phase : null;
  const opener = (() => {
    if (!ledger || !(view.openUrl || view.openCommand)) return undefined;
    const act = primaryActOf({ kind: item.kind, openUrl: view.openUrl, openCommand: view.openCommand });
    if (act === 'open') return { label: primaryLabel(act, item.kind), onOpen: () => verbs.open('url') };
    if (act === 'terminal' || act === 'machine')
      return { label: primaryLabel(act, item.kind), onOpen: () => verbs.open('command') };
    return { label: view.openUrl ? 'Open the link' : 'Open in terminal', onOpen: () => verbs.open() };
  })();

  /** A row action: a yes or a no waits out the undo window; anything else goes at once. */
  function pressRow(action: InboxAction, words?: string) {
    if (HELD_VERBS.has(action.verb)) {
      held.hold(
        action.label,
        () => perform(row, action, words),
        () => sendOnLeave(action.endpoint, actionBody(action, words), action.method),
      );
    } else perform(row, action, words);
  }

  /** A bound option, sent through the undo window — a refusal said on the item, in the server's sentence. */
  function sendOption(option: TurnOption, typed: string | undefined) {
    setRefusal(null);
    const leave = () =>
      sendOnLeave(
        option.verb.endpoint,
        actionBody({ body: option.verb.body, ...(option.says ? { says: option.says } : {}) }, typed),
        option.verb.method,
      );
    held.hold(
      option.label,
      async () => {
        setOptionBusy(true);
        try {
          const pressed = await pressOption(option, typed);
          if (pressed.state === 'asked') toast(pressed.words, 'info', 8000);
          else toast(`${option.label} — done.`, 'ok');
        } catch (cause) {
          // A stale run, a door that may not press, a rule: the server's sentence, where the press was made.
          setRefusal(errorWords(cause));
        } finally {
          setOptionBusy(false);
          for (const queryKey of keys.afterInboxAct()) void client.invalidateQueries({ queryKey });
        }
      },
      leave,
    );
  }

  /** A decision sent: a ledger answer, or the chosen bound option with its typed words. */
  function sendDecision(answer: DecisionAnswer) {
    if (ledgerOptions.length || (ledger && !bound.length)) {
      held.hold(
        'Your decision',
        () => void extra.answer(answer),
        () => extra.answerOnLeave(answer),
      );
      return;
    }
    const option = bound.find((candidate) => candidate.id === answer.option);
    if (option) sendOption(option, answer.note);
  }

  /** The approval's two presses, from whichever source the item carries them in. */
  function approvalPresses(): {
    onApprove?: (note: string | undefined) => void;
    onDeny?: (note: string | undefined) => void;
    approveLabel?: string;
    denyLabel?: string;
  } {
    const yesOption = options.find((option) => !option.flag && saysYes(option));
    const noOption = options.find((option) => !option.flag && saysNo(option));
    if (yesOption || noOption) {
      const send = (option: DecisionOption) => (note: string | undefined) => {
        if (ledgerOptions.length) {
          held.hold(
            option.label,
            () => void extra.answer({ option: option.id, ...(note ? { note } : {}) }),
            () => extra.answerOnLeave({ option: option.id, ...(note ? { note } : {}) }),
          );
          return;
        }
        const boundOption = bound.find((candidate) => candidate.id === option.id);
        if (boundOption) sendOption(boundOption, boundOption.says ? note : undefined);
      };
      return {
        ...(yesOption ? { onApprove: send(yesOption), approveLabel: approveLabelOf(yesOption.label) } : {}),
        ...(noOption ? { onDeny: send(noOption), denyLabel: denyLabelOf(noOption.label) } : {}),
      };
    }
    const yesRow = pressable.find((action) => saysYes(action));
    const noRow = pressable.find((action) => saysNo(action));
    if (yesRow || noRow) {
      return {
        ...(yesRow
          ? {
              onApprove: (note) => pressRow(yesRow, yesRow.says ? note : undefined),
              approveLabel: approveLabelOf(yesRow.label),
            }
          : {}),
        ...(noRow
          ? {
              onDeny: (note) => pressRow(noRow, noRow.says ? note : undefined),
              denyLabel: denyLabelOf(noRow.label),
            }
          : {}),
      };
    }
    if (ledger) {
      // A check by eye with no options: the answer is the note, said as a yes or a no.
      return {
        onApprove: (note) =>
          held.hold(
            'Approve',
            () => void extra.answer({ note: note ? `Approved: ${note}` : 'Approved.' }),
            () => extra.answerOnLeave({ note: note ? `Approved: ${note}` : 'Approved.' }),
          ),
        onDeny: (note) =>
          held.hold(
            'Deny',
            () => void extra.answer({ note: note ? `Denied: ${note}` : 'Denied.' }),
            () => extra.answerOnLeave({ note: note ? `Denied: ${note}` : 'Denied.' }),
          ),
      };
    }
    return {};
  }

  /** The row actions the act form did not take — drawn beside it, never as a second primary. */
  function restOf(taken: readonly InboxAction[]): InboxAction[] {
    return pressable.filter((action) => !taken.includes(action));
  }

  /** Row actions beside a form — each a plain button, a no in the failed hue. */
  function restButtons(actions: readonly InboxAction[]): ReactNode {
    return actions.map((action) => (
      <Button
        key={action.verb}
        variant={saysNo(action) ? 'danger' : 'default'}
        data-verb={action.verb}
        disabled={busy === `${row.id}:${action.verb}` || (holding && HELD_VERBS.has(action.verb))}
        onClick={() => pressRow(action, action.says ? said : undefined)}
      >
        {action.label}
      </Button>
    ));
  }

  function actForm(): ReactNode {
    switch (move.move) {
      case 'undo':
        return <UndoAct busy={extra.busy === 'undo'} onUndo={() => void extra.undo()} />;
      case 'got-it':
        return <HeadsUpAct done={seen} onGotIt={markSeen} />;
      case 'check':
        return (
          <TaskAct
            redo={move.redo}
            verbs={{
              check: verbs.check,
              snooze: verbs.snooze,
              cannot: verbs.cannot,
              decline: (reason) =>
                held.hold(
                  'Not doing this',
                  () => void extra.decline(reason),
                  () => extra.declineOnLeave(reason),
                ),
              ask: extra.ask,
              attach: extra.attach,
              giveBack: (phase) => void extra.giveBack(phase),
            }}
            busy={{
              check: verbs.busy === 'check',
              snooze: verbs.busy === 'snooze',
              open: verbs.busy === 'open',
              other: extra.busy !== null,
            }}
            noteAllowed={!NO_NOTE_KINDS.has(item.kind)}
            allowDecline={Boolean(record?.allowDecline ?? item.step?.allowDecline)}
            giveBackPhase={giveBackPhase}
            opener={opener}
            onError={(words) => toast(words, 'warn', 8000)}
          />
        );
      case 'decide':
        return (
          <>
            <DecisionCard
              options={options}
              mode={ledgerOptions.length || (ledger && !bound.length) ? 'ledger' : 'bound'}
              busy={extra.busy === 'answer' || optionBusy}
              disabled={holding}
              refusal={refusal}
              onSend={sendDecision}
            />
            {pressable.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="turn-moves" data-print="hide">
                {restButtons(pressable)}
              </div>
            )}
          </>
        );
      case 'grant':
        if (ownCard && PermissionCard && permission) return null;
        return (
          <ApprovalAct
            {...grantPresses()}
            busy={holding}
            noteLabel="Why, if you want to say. The session reads it."
          />
        );
      case 'approve': {
        const presses = approvalPresses();
        const taken = pressable.filter((action) => saysYes(action) || saysNo(action));
        return (
          <ApprovalAct
            {...presses}
            more={restButtons(restOf(taken))}
            busy={holding || optionBusy || extra.busy === 'answer'}
            noteHint={
              runAct === 'raise-budget'
                ? 'To approve, write only how many dollars to add — for example 10 or $12.50.'
                : undefined
            }
            noteRequired={runAct === 'raise-budget'}
          >
            {item.approval && <ApprovalBlock approval={item.approval} />}
          </ApprovalAct>
        );
      }
      case 'row':
        return (
          <div
            data-testid="turn-act"
            data-type={words.type}
            className="flex min-w-0 flex-col gap-3"
            data-print="hide"
          >
            {move.action.says && (
              <MicField
                label={move.action.says.label}
                placeholder={move.action.says.placeholder}
                value={said}
                onChange={setSaid}
                disabled={Boolean(busy)}
              />
            )}
            <div className="flex flex-wrap items-center gap-1.5" data-testid="turn-moves">
              <Button
                variant="primary"
                data-testid="turn-primary"
                data-move="row"
                data-verb={move.action.verb}
                disabled={
                  busy === `${row.id}:${move.action.verb}` ||
                  (move.action.says?.field === 'rule' && !said.trim()) ||
                  (holding && HELD_VERBS.has(move.action.verb))
                }
                onClick={() => pressRow(move.action, move.action.says ? said : undefined)}
              >
                {busy === `${row.id}:${move.action.verb}` ? 'Working…' : move.action.label}
              </Button>
              {restButtons(restOf([move.action]))}
            </div>
          </div>
        );
      case 'none':
        if (move.why === 'checking') return null;
        return (
          <p data-testid="turn-nothing" data-why={move.why} className="max-w-prose text-meta text-ink-muted">
            {NONE_WORDS[move.why]}
          </p>
        );
      default:
        return null;
    }
  }

  /** A permission item with no card lent: its row's grant is Approve, its deny Deny, and *I'll do it myself* beside them. */
  function grantPresses(): {
    onApprove?: (note: string | undefined) => void;
    onDeny?: (note: string | undefined) => void;
    approveLabel?: string;
    denyLabel?: string;
    children?: ReactNode;
  } {
    const grant = pressable.find((action) => action.verb === 'grant');
    const deny = pressable.find((action) => action.verb === 'deny');
    const convert = pressable.find((action) => action.verb === 'convert');
    return {
      ...(grant ? { onApprove: () => pressRow(grant), approveLabel: approveLabelOf(grant.label) } : {}),
      ...(deny ? { onDeny: (note) => pressRow(deny, note), denyLabel: denyLabelOf(deny.label) } : {}),
      ...(convert
        ? {
            children: (
              <Button
                data-verb="convert"
                className="self-start"
                disabled={busy === `${row.id}:convert`}
                onClick={() => perform(row, convert)}
              >
                {convert.label}
              </Button>
            ),
          }
        : {}),
    };
  }

  const flagged = rowActions.filter((action) => action.flag);

  return (
    <article
      id={`turn-item-${item.item}`}
      data-testid="turn-item"
      data-item={item.item}
      data-kind={item.kind}
      data-state={state}
      data-type={words.type}
      data-person-status={status}
      data-readiness={words.readiness}
      data-group={item.group}
      data-record={item.record}
      aria-current={focused ? 'true' : undefined}
      aria-labelledby={titleId}
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-lg border bg-surface p-4 sm:p-5',
        focused ? 'border-ink' : 'border-rule',
      )}
    >
      <Head item={card} titleId={titleId} title={title} when={timing.startWhen} onInspect={onInspect}>
        {risk && <OpsStatus vocab="risk" word={risk} />}
      </Head>

      <Meta item={item} record={record} />

      <TimingGrid timing={timing} notYet={notYet} live={live} />

      <WhyLine item={item} why={why} inferred={inferred} />

      {folded && (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          data-testid="turn-item-toggle"
          data-print="hide"
          className="self-start"
          onClick={() => setOpen((was) => !was)}
        >
          <ChevronDown
            size={14}
            aria-hidden
            className={cn('transition-transform duration-fast ease-transit', open && 'rotate-180')}
          />
          {open ? 'Fold it' : notYet ? 'What it will ask' : 'What it asked, and how it ended'}
        </Button>
      )}

      <div
        data-testid="turn-body"
        data-print="open"
        className={cn('min-w-0 flex-col gap-4', open ? 'flex' : 'hidden')}
      >
        {item.request && (
          <p data-testid="turn-request" className="max-w-prose text-body text-ink">
            {item.request.ask}
          </p>
        )}
        {!ownCard && OwnerRequests && <OwnerRequests requests={item.requests} />}

        {/* The verdict, BEFORE the steps — it changes what they are for. */}
        {fresh && CheckOutcome && <CheckOutcome answer={fresh} record={record} />}
        {verdict && verdict.state !== 'passed' && live && !checking && !echoed && (
          <Verdict verdict={verdict} />
        )}
        {checking && <CheckingLine attempts={attempts} ledger={ledger} />}
        {item.settled && <SettledLine settled={item.settled} />}
        {verdict && verdict.state === 'passed' && !echoed && <Verdict verdict={verdict} />}
        {settled && record?.answer && !verdict && (
          <p className="max-w-prose text-body text-ink">
            <span className="font-medium">Answered: </span>
            {[record.answer.label ?? record.answer.option, record.answer.note].filter(Boolean).join(' — ')}
          </p>
        )}

        <FromTheAI
          tried={record?.tried}
          note={record?.note ?? item.step?.note}
          overruled={record?.overruled}
        />

        {permission && !ownCard && <PermissionFacts permission={permission} />}

        {view.code && <DeviceCode code={view.code} />}
        {view.act && view.path && (
          <p className="max-w-prose text-body text-ink-muted" data-testid="step-protected">
            The edit is to <code className="font-mono text-meta text-ink">{view.path}</code>: {view.act}
          </p>
        )}
        <CoverLinks coveredBy={item.step?.coveredBy} covers={item.step?.covers} />
        <Steps
          item={item}
          guide={guide}
          lines={view.lines}
          fallback={
            view.openCommand && !permission ? (
              <CodeBlock code={view.openCommand} testId="guide-command" />
            ) : undefined
          }
        />
        {!guide &&
          !item.steps?.length &&
          !view.lines.length &&
          item.record !== 'ledger' &&
          !item.supervisor &&
          item.how && <p className="max-w-prose text-body text-ink-muted">{item.how}</p>}
        {view.qr && live && (
          <PhoneLink url={view.qr}>
          </PhoneLink>
        )}
        {item.kind === 'secret-entry' && live && <SecretWhere where={record?.secretWhere} />}
        {(ledger || proofType || item.check) && (
          <HowChecked
            check={item.check}
            proofType={proofType}
            proof={record?.proof ?? item.step?.proof}
            proofWords={record?.proofWords ?? item.step?.proofWords}
            kind={item.kind}
          />
        )}
        <Routing route={item.route} checkedBy={item.checkedBy} />
        {lastNote && (
          <p data-testid="turn-check-note" className="max-w-prose text-body text-ink">
            <span className="font-medium">Your note with attempt {lastNote.attempt}: </span>
            {lastNote.text}
          </p>
        )}

        {/* ONE act form, by the move table — a permission's is the card the screen lends, an approval at a scope. */}
        {ownCard && PermissionCard && permission ? (
          <PermissionCard
            item={item}
            permission={permission}
            row={row}
            perform={perform}
            busy={busy}
            live={live && !notYet && !checking}
          />
        ) : (
          actForm()
        )}
        {live && flagged.length > 0 && <FlaggedActions actions={flagged} />}
        {held.held && <HeldLine held={held.held} onUndo={held.undo} onSendNow={held.sendNow} />}
        {/* What the last press answered that is a next step (#368) — a sign-in's terminal, an errand tree's paths. */}
        {live && <NextStepNote id={row.id} />}



        {moves && (
          <div
            data-testid="turn-more-moves"
            data-print="hide"
            className="flex flex-wrap items-center gap-1.5"
          >
            {moves}
          </div>
        )}

        {escalated && (
          <Escalation
            attempts={attempts}
            busy={extra.busy !== null}
            onRewrite={() => void extra.rewrite()}
            onCannot={verbs.cannot}
            onOverride={() => void extra.override()}
          />
        )}

        {!ledger && (
          <a
            href={toHash(item.href)}
            className="tap-row w-fit text-meta text-ink-muted underline underline-offset-2"
          >
            Open where it lives
          </a>
        )}

        <History item={item} record={record} view={view} />
      </div>

      {view.openCommand && (
        <StepTerminalSheet
          ticket={verbs.ticket}
          command={view.openCommand}
          title={view.title}
          onClose={verbs.closeTerminal}
        />
      )}
    </article>
  );
}
