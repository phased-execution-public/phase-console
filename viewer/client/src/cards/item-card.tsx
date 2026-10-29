/**
 * One item of Your turn, whole — the board's card in 7.0's language
 * (control-tower phase 137, #214; rebuilt by turn-by-turn phase 8 around the
 * Owner To-Do Board's anatomy, `viewer/docs/design.md` §Your turn).
 *
 * A card, because an item is acted on as a unit, and a quiet one: the server
 * decided what the item is (`GET /api/turn` — its type, the person's status,
 * whether it is due, where a press goes, every word); this file only draws it,
 * top to bottom in the order a person needs it. Since Tower strips
 * (2026-10-20) it is a STRIP — a 4 px leading edge in the person's status's
 * hue, one tinted lead badge, outlined chips for the rest — and a container:
 * it lays itself out by its own width, in a drawer, the panel or the page.
 *
 *   1. the head (`turn/head.tsx`): the type as a neutral plate; NOW, or NOT
 *      YET with its *when*; the person's status as the lead badge; the
 *      errand's ref; the title; the meta as chips;
 *   2. the verdict, right after the head and BEFORE the steps
 *      (`turn/verdict.tsx`): Redo with what the check found and its numbered
 *      fixes, or the check still running, or how it ended; *From the AI*;
 *   3. THE ACT, before the record of it: why only the person fits it — once —
 *      then what they need to do it (a Task's and a Heads-up's steps first, a
 *      Decision's guide paragraph, an Approval's block) and ONE act form per
 *      type (`turn/act.tsx`, `decision-card.tsx`), its primary chosen by the
 *      move table (`turn/moves.ts`, IC-v2) — and *Undo: I'm not finished*
 *      while a check runs; an action the console's flags switch off is drawn
 *      disabled with the flag that turns it on. In the panel its act bar holds
 *      to the foot of the scroller (`inPanel`);
 *   4. THE RECORD, as fold strips (`turn/record.tsx`): *How it's checked*,
 *      *Where it goes*, *Timing* on the one page clock, a Decision's or an
 *      Approval's *Steps* (open at first), and the *History* — who raised it
 *      and when, every move, every attempt side by side with its evidence, the
 *      questions, the answer — and one more press, the raw record.
 *
 * Never a field for a secret: a `secret-entry` item says where the value goes,
 * and its check takes no note. Every press goes through `data/press.ts` (the
 * owner door); a terminal one — Approve, Deny, Not doing this, Send my
 * decision — waits out the undo window on the page (`data/undo-window.ts`). The
 * pieces a screen draws INSIDE an item — a permission item's own card, the
 * owner's pending requests, the supervisor's card, a link's QR — are lent by
 * the screen (`parts`), and the card says what it can without them.
 *
 * It is the ONE human-step card (measured-console phase 32 folded
 * `human-step-card.tsx` into it). A surface that holds a step only as its
 * inbox row — the bell's row, a run strip's expansion — draws it through
 * `StepCard` below, from the row's own `humanStep` view: whole, folded to a
 * line that opens in place (`variant="row"`), or its one action alone
 * (`variant="primary"`). Such a surface reaches this file through
 * `lazy-step-card.tsx`, so a page with no person's turn never downloads it.
 * The pieces both draw from — the kind's mark, a device code, the step's verbs
 * and its one primary — are `turn/step-parts.tsx`; its words and clocks
 * `turn/step-words.ts`.
 */

import { useEffect, useId, useState, type ComponentType, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';

import {
  KIND_META,
  humanStepView,
  type HumanStepState,
  type HumanStepView,
} from '@shared/human-step-model.js';
import {
  HAND_OFF_OPTION_ID,
  personStatusOf,
  readinessOf,
  readinessShown,
  typeOf,
  type ItemType,
  type PersonStatus,
  type Readiness,
} from '@shared/turn-model.js';
import { actionBody, splitActions, type InboxAction, type InboxItem, type TurnOption } from '@/data/api';
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
import {
  cannotItem,
  giveBack,
  handOffItem,
  noteItem,
  noteOnLeave,
  pressOption,
  undoCheck,
  useHumanSteps,
  type TurnItem,
} from '@/data/turn';
import { useHeldPress } from '@/data/undo-window';
import { cn } from '@/lib/cn';
import { useRoute } from '@/shell/router';
import { toHash } from '@/shell/routes';
import { Button, Input, KeyValue, toast, type KeyValueItem } from '@/ui';
import { CodeBlock } from '@/ui/code-block';
import { Disclosure } from '@/ui/disclosure';
import { MicField } from '@/ui/mic-field';
import { OpsStatus } from '@/ui/status';
import { DecisionCard, type DecisionAnswer, type DecisionOption } from './decision-card';
import { GuideSummary, guideOf } from './guide';
import { NextStepNote } from './next-step-note';
import { primaryActOf, primaryLabel } from './human-step-words';
import { StepTerminalSheet } from './step-terminal-sheet';
import {
  ActBar,
  ApprovalAct,
  CannotAct,
  FlaggedActions,
  HeadsUpAct,
  HeldLine,
  SentAct,
  TaskAct,
  UndoAct,
  formBox,
  type SentPress,
} from './turn/act';
import { Head, Meta, WhyLine, edgeOf } from './turn/head';
import {
  MOVE_LABEL,
  NONE_WORDS,
  approveLabelOf,
  cardMoveOf,
  denyLabelOf,
  isGrantItem,
  saysNo,
  saysYes,
  type CardMove,
} from './turn/moves';
import { RecordFolds, TimingSummary, plainStep, type RecordFold } from './turn/record';
import {
  DeviceCode,
  DueLine,
  KindMark,
  MoveLine,
  RawRecord,
  SecretWhere,
  StepCommand,
  StepPrimary,
  StepPrimaryButton,
  WhereWord,
  useStepVerbs,
  type Perform as StepPerform,
} from './turn/step-parts';
import { BIRTH_WORDS, errorWords, isOpenState, stamp, statusParts } from './turn/step-words';
import {
  CheckedBy,
  CoverLinks,
  FromTheAI,
  GoesTo,
  HowChecked,
  Steps,
  checkedByOf,
  composedGuide,
  goesToOf,
  stepsOf,
} from './turn/steps';
import { TimingGrid, timingOf } from './turn/timing';
import { CheckingLine, SettledLine, Verdict } from './turn/verdict';

/**
 * Presses a row action verbatim. A screen whose press reports back
 * (`useInboxActions().perform`) resolves `true` once the server did it — the
 * card then holds itself as sent (`SentAct`) — and `false` when it did not.
 */
type Perform = (item: InboxItem, action: InboxAction, says?: string) => void | Promise<boolean>;

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

/**
 * The act's section, named by what each type asks of the person (Tower strips,
 * 2026-10-20) — the line that tells the act apart from the verdict above it
 * and the record below it.
 */
const ACT_LABEL: Readonly<Record<ItemType, string>> = Object.freeze({
  approve: 'What you approve',
  do: 'What you do',
  decide: 'What you decide',
  know: 'What to know',
});

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
    <div
      data-testid="turn-permission"
      className="flex min-w-0 max-w-(--measure) flex-col gap-2 text-body text-ink"
    >
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

/**
 * An approval's block: what is asked, who asked, and what each answer does —
 * a two-column grid where the card has the room, each label over its value
 * where it has not (Tower strips, 2026-10-20), on the record's ground so the
 * facts read as one thing before Approve and Deny.
 */
function ApprovalBlock({ approval }: { approval: NonNullable<TurnItem['approval']> }) {
  const rows = (
    [
      ['What', approval.what],
      ['Asked by', approval.askedBy],
      ['If you approve', approval.ifApproved],
      ['If you deny', approval.ifDenied],
      ['Scopes', approval.scopes?.length ? approval.scopes.join(', ') : undefined],
    ] as const
  ).filter(([, value]) => value != null && value !== '');
  if (!rows.length) return null;
  return (
    <dl
      data-testid="turn-approval"
      className="grid min-w-0 max-w-(--measure) grid-cols-1 items-baseline gap-x-4 gap-y-0.5 rounded-md bg-ground px-3 py-2.5 @md/card:grid-cols-[max-content_minmax(0,1fr)] @md/card:gap-y-1.5 [&>div:last-child>dd]:pb-0"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="min-w-0 text-meta text-ink-muted">{label}</dt>
          <dd className="min-w-0 pb-1.5 text-body break-words text-ink @md/card:pb-0">{value}</dd>
        </div>
      ))}
    </dl>
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
      className="flex min-w-0 max-w-(--measure) flex-col gap-2.5 rounded-md bg-ground px-3 py-3 text-body text-ink"
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

/** Who raised it, in words — the session's id beside its word where the record has one. */
function raisedBy(item: TurnItem, record: HumanStepRecord | undefined, withSession = true): string {
  const birth = record?.birth ?? item.step?.birth;
  if (!birth) return item.source;
  if (withSession && birth === 'session' && record?.sessionId)
    return `${BIRTH_WORDS.session} (${record.sessionId})`;
  return BIRTH_WORDS[birth] ?? birth;
}

/** The History fold's one line: who raised it and when, and how much happened since. */
function historyWords(item: TurnItem, record: HumanStepRecord | undefined): string {
  const declared = record?.declaredAt ?? item.step?.declaredAt ?? item.since;
  const attempts = record?.attempts ?? item.step?.attempts ?? 0;
  const moves = record?.moves?.length ?? 0;
  return [
    `Raised by ${raisedBy(item, record, false)}, ${stamp(declared)}`,
    attempts ? `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}` : null,
    moves ? `${moves} ${moves === 1 ? 'move' : 'moves'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The History fold's body (one press in): who raised it and when, its kind and
 * where, every move and attempt, the questions, the answer — and, one more
 * press, the raw record.
 */
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
  const source = record?.source ?? item.step?.source;
  const declared = record?.declaredAt ?? item.step?.declaredAt ?? item.since;
  const proof = record?.proof ?? item.step?.proof;
  const facts: KeyValueItem[] = [
    [
      'Raised by',
      <span data-testid="turn-raised-by">
        {raisedBy(item, record)}, {stamp(declared)}
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
  );
}

/** A link meant for the device in the person's hand, shown whole to copy — and as a QR where one is lent. */
function PhoneLink({ url, children }: { url: string; children?: ReactNode }) {
  return (
    <div data-testid="turn-qr" className="flex min-w-0 flex-wrap items-center gap-3">
      {children}
      <p className="min-w-0 max-w-(--measure) text-body text-ink">
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
    /** The card is the panel's: its act row is pinned to the foot of the scroller, as every type's is. */
    pinned?: boolean;
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
  /**
   * The card is the panel's whole subject (`screens/turn/panel-card.tsx`):
   * its title takes the title size, and its act bar is pinned to the foot of
   * the panel's scroller, so the primary is always in reach.
   */
  inPanel?: boolean;
  /** *Everything* is on for the page: the card's record folds all open. */
  everything?: boolean;
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
  inPanel = false,
  everything = false,
}: ItemCardProps) {
  const [open, setOpen] = useState(!folded || focused);
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);
  const titleId = useId();
  const actLabelId = useId();
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
  // A terminal press the server did, and the status the item read when it was pressed.
  const [sent, setSent] = useState<(SentPress & { was: PersonStatus }) | null>(null);
  const [cannotBusy, setCannotBusy] = useState(false);
  const [seen, markSeen] = useSeen(item.item);
  const { PermissionCard, OwnerRequests, CheckOutcome } = parts;

  const ledger = item.record === 'ledger';
  const words = cardWordsOf(item, record, state);
  // A press that went through holds the card as sent — Being checked, nothing
  // to press again — while the server still reads the item as it was when it
  // was pressed; the server's next move of the item ends the hold (2026-10-20:
  // an approved gate's card stayed open, and was pressed four times).
  const sentNow = sent !== null && sent.was === words.personStatus;
  useEffect(() => {
    if (sent && sent.was !== words.personStatus) setSent(null);
  }, [sent, words.personStatus]);
  const status: PersonStatus = sentNow ? 'checking' : words.personStatus;
  const card: TurnItem = { ...item, ...words, personStatus: status };
  const settled = status === 'passed' || status === 'not-doing' || status === 'closed';
  const live = !settled;
  const notYet = words.readiness === 'not-yet' && readinessShown(status);
  const checking = words.personStatus === 'checking';
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
  // are the same presses, so they are not drawn twice. A ledger item the
  // server bound ELSEWHERE — a gate-bound one, whose one way on is its gate's
  // Approve (`optionsOf`) — is pressed as bound: its own options would be
  // answers, and the server refuses an answer to an item only its gate opens.
  // *Hand it to the AI* (2026-10-20) is the server's own last option on an
  // open decision the AI can take, pressed through the turn's verb in every
  // mode — so it is set apart from the options it follows.
  const ownAnswer = `/api/human-steps/${encodeURIComponent(item.item)}/answer`;
  const handOff = live ? item.options?.find((o) => o.id === HAND_OFF_OPTION_ID) : undefined;
  const serverOptions = (item.options ?? []).filter((o) => o.id !== HAND_OFF_OPTION_ID);
  const boundElsewhere =
    ledger && serverOptions.length > 0 && !serverOptions.some((o) => o.verb.endpoint === ownAnswer);
  const ledgerOptions: readonly DecisionOption[] =
    ledger && !boundElsewhere ? (record?.options ?? item.step?.options ?? []) : [];
  const bound: readonly TurnOption[] =
    live && !item.supervisor && !(ledger && ledgerOptions.length) ? serverOptions : [];
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
  const options: readonly DecisionOption[] = [
    ...(ledgerOptions.length ? ledgerOptions : bound),
    ...(handOff ? [handOff] : []),
  ];
  const ledgerMode = ledgerOptions.length > 0 || (ledger && !bound.length);
  const move: CardMove = cardMoveOf({
    type: words.type,
    personStatus: words.personStatus,
    readiness: words.readiness,
    record: item.record,
    kind: item.kind,
    proofType,
    actions: rowActions,
    options,
    supervisor: Boolean(item.supervisor),
  });
  const pressable = rowActions.filter((action) => !action.flag);
  // One of the row's own presses is on its way (`busy` is `${rowId}:${verb}`).
  const rowTravelling = Boolean(busy?.startsWith(`${row.id}:`));
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

  /** A terminal press the server did: the card holds itself as sent until the server moves the item. */
  function markSent(label: string) {
    setSent({ label, at: new Date().toISOString(), was: words.personStatus });
  }

  /** A row action: a yes or a no waits out the undo window; anything else goes at once. */
  function pressRow(action: InboxAction, typed?: string) {
    if (HELD_VERBS.has(action.verb)) {
      held.hold(
        action.label,
        () =>
          void Promise.resolve(perform(row, action, typed)).then((done) => {
            if (done === true) markSent(action.label);
          }),
        () => sendOnLeave(action.endpoint, actionBody(action, typed), action.method),
      );
    } else perform(row, action, typed);
  }

  /**
   * A comment the chosen way on carries no field for (2026-10-20): it goes to
   * whoever the item goes to, before the press, so the AI has read it when it
   * acts. A refusal is said and never stops the press.
   */
  async function sendComment(text: string) {
    try {
      const noted = await noteItem(item.item, text);
      if (noted.state === 'asked') toast(noted.words, 'info', 8000);
    } catch (cause) {
      toast(`Your note was not sent — ${errorWords(cause)}`, 'warn', 8000);
    }
  }

  /**
   * A bound option, sent through the undo window — a refusal said on the item,
   * in the server's sentence; a comment the option takes no words for goes
   * first. `through` presses it by its own typed verb (*Hand it to the AI*).
   */
  function sendOption(
    option: TurnOption,
    typed: string | undefined,
    { comment, through }: { comment?: string | undefined; through?: () => Promise<Pressed<unknown>> } = {},
  ) {
    setRefusal(null);
    const leave = () => {
      if (comment) noteOnLeave(item.item, comment);
      return sendOnLeave(
        option.verb.endpoint,
        actionBody({ body: option.verb.body, ...(option.says ? { says: option.says } : {}) }, typed),
        option.verb.method,
      );
    };
    held.hold(
      option.label,
      async () => {
        setOptionBusy(true);
        try {
          if (comment) await sendComment(comment);
          const pressed = await (through ? through() : pressOption(option, typed));
          if (pressed.state === 'asked') toast(pressed.words, 'info', 8000);
          else {
            toast(`${option.label} — done.`, 'ok');
            markSent(option.label);
          }
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

  /**
   * *I can't do this* on an item the console projects (2026-10-20): the
   * reason goes with it, the item to Done as Not doing, whoever it goes to told.
   */
  async function cannotProjected(reason: string) {
    setCannotBusy(true);
    try {
      const pressed = await cannotItem(item.item, reason);
      if (pressed.state === 'asked') {
        toast(pressed.words, 'info', 8000);
        return;
      }
      const told = pressed.result.told;
      toast(
        told.note || told.chat
          ? 'Handed back with your reason — whoever takes it from here has it.'
          : 'Handed back — your reason is kept on the item.',
        'ok',
      );
      markSent(MOVE_LABEL.cannot);
    } catch (cause) {
      toast(errorWords(cause), 'warn', 8000);
    } finally {
      setCannotBusy(false);
      for (const queryKey of keys.afterInboxAct()) void client.invalidateQueries({ queryKey });
    }
  }

  // *I can't do this*, one press from every open item's card: a ledger item's
  // through its step's own verb, a projected one's through the turn's — never
  // the owner's request or the supervisor's card, which end by their own press.
  const cannotAct =
    !live || notYet || checking || item.supervisor || item.record === 'request' ? null : ledger ? (
      <CannotAct busy={verbs.busy === 'cannot'} onCannot={verbs.cannot} />
    ) : (
      <CannotAct busy={cannotBusy} onCannot={(reason) => void cannotProjected(reason)} />
    );

  /** A ledger answer, sent once the undo window ends — and the card held as sent when the server took it. */
  function holdAnswer(label: string, answer: DecisionAnswer) {
    held.hold(
      label,
      () =>
        void extra.answer(answer).then((got) => {
          if (got) markSent(label);
        }),
      () => extra.answerOnLeave(answer),
    );
  }

  /**
   * A decision sent: *Hand it to the AI* through the turn's verb, a ledger
   * answer, or the chosen bound option — its field carrying the words when it
   * takes them, else the words sent beside it as a note for the AI.
   */
  function sendDecision(answer: DecisionAnswer) {
    if (handOff && answer.option === HAND_OFF_OPTION_ID) {
      sendOption(handOff, answer.note, { through: () => handOffItem(item.item, answer.note) });
      return;
    }
    if (ledgerMode) {
      holdAnswer('Your decision', answer);
      return;
    }
    const option = bound.find((candidate) => candidate.id === answer.option);
    if (!option) return;
    if (option.says) sendOption(option, answer.note);
    else sendOption(option, undefined, { comment: answer.note });
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
          holdAnswer(option.label, { option: option.id, ...(note ? { note } : {}) });
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
        onApprove: (note) => holdAnswer('Approve', { note: note ? `Approved: ${note}` : 'Approved.' }),
        onDeny: (note) => holdAnswer('Deny', { note: note ? `Denied: ${note}` : 'Denied.' }),
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
        return <UndoAct busy={extra.busy === 'undo'} onUndo={() => void extra.undo()} pinned={inPanel} />;
      case 'got-it':
        return <HeadsUpAct done={seen} onGotIt={markSeen} pinned={inPanel} />;
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
                  () =>
                    void extra.decline(reason).then((got) => {
                      if (got) markSent('Not doing this');
                    }),
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
            cannotHere={!escalated}
            pinned={inPanel}
            onError={(words) => toast(words, 'warn', 8000)}
          />
        );
      case 'decide':
        return (
          <>
            <DecisionCard
              options={options}
              mode={ledgerMode ? 'ledger' : 'bound'}
              busy={extra.busy === 'answer' || optionBusy}
              disabled={holding}
              refusal={refusal}
              onSend={sendDecision}
              // The row's own presses no option stands for, beside the primary on its bar.
              more={pressable.length > 0 ? restButtons(pressable) : undefined}
              pinned={inPanel}
            />
            {/* *Hand it to the AI* is the decision's own way out; only a choice the AI cannot take keeps *I can't do this*. */}
            {handOff ? null : cannotAct}
          </>
        );
      case 'grant':
        if (ownCard && PermissionCard && permission) return null;
        return (
          <ApprovalAct
            {...grantPresses()}
            busy={holding || rowTravelling}
            sending={rowTravelling}
            noteLabel="Why, if you want to say. The session reads it."
            pinned={inPanel}
          />
        );
      case 'approve': {
        const presses = approvalPresses();
        const taken = pressable.filter((action) => saysYes(action) || saysNo(action));
        const sending = rowTravelling || optionBusy || extra.busy === 'answer';
        return (
          <>
            <ApprovalAct
              {...presses}
              more={restButtons(restOf(taken))}
              busy={holding || sending}
              sending={sending}
              noteHint={
                runAct === 'raise-budget'
                  ? 'To approve, write only how many dollars to add — for example 10 or $12.50.'
                  : undefined
              }
              noteRequired={runAct === 'raise-budget'}
              pinned={inPanel}
            >
              {item.approval && <ApprovalBlock approval={item.approval} />}
            </ApprovalAct>
            {cannotAct}
          </>
        );
      }
      case 'row':
        return (
          <div data-testid="turn-act" data-type={words.type} className={formBox(inPanel)} data-print="hide">
            {move.action.says && (
              <MicField
                label={move.action.says.label}
                placeholder={move.action.says.placeholder}
                value={said}
                onChange={setSaid}
                disabled={Boolean(busy)}
              />
            )}
            <ActBar pinned={inPanel}>
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
            </ActBar>
            {cannotAct}
          </div>
        );
      case 'none':
        if (move.why === 'checking') return null;
        return (
          <p
            data-testid="turn-nothing"
            data-why={move.why}
            className="max-w-(--measure) text-meta text-ink-muted"
          >
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

  // The act's section, named: what this type asks of the person while it is
  // theirs — what it asked, once it is over.
  const actLabel = settled
    ? 'What it asked'
    : notYet
      ? 'What it will ask'
      : checking
        ? 'What you sent to be checked'
        : ACT_LABEL[words.type];
  // A Task's and a Heads-up's steps ARE the act: drawn first, before the form.
  // A Decision's and an Approval's are the console's own, short: the record's.
  const stepsFirst = words.type === 'do' || words.type === 'know';
  // A decision's guide says its why under *What you decide*; its steps, then, do not again.
  const summaryHere = !(words.type === 'decide' && guide?.summary);
  const fallbackCommand = Boolean(view.openCommand && !permission);
  const howShown =
    !guide &&
    !item.steps?.length &&
    !view.lines.length &&
    item.record !== 'ledger' &&
    !item.supervisor &&
    Boolean(item.how);
  const drawnGuide = guide ?? composedGuide(item);
  // Is there anything for the steps to draw — a fold of the record is never empty.
  const stepsShown =
    (drawnGuide
      ? drawnGuide.steps.length > 0 ||
        drawnGuide.trouble.length > 0 ||
        (summaryHere && Boolean(drawnGuide.summary))
      : view.lines.length > 0 || fallbackCommand) ||
    howShown ||
    Boolean(item.step?.coveredBy || item.step?.covers?.length);
  const stepsPart = (
    <>
      <CoverLinks coveredBy={item.step?.coveredBy} covers={item.step?.covers} />
      <Steps
        item={item}
        guide={guide}
        lines={view.lines}
        withSummary={summaryHere}
        fallback={
          fallbackCommand && view.openCommand ? (
            <CodeBlock code={view.openCommand} testId="guide-command" />
          ) : undefined
        }
      />
      {howShown && <p className="max-w-(--measure) text-body text-ink-muted">{item.how}</p>}
    </>
  );

  const checkedBy = checkedByOf(item.checkedBy, proofType);
  const goes = goesToOf(item.route);
  const steps = stepsOf(item, guide, view.lines);
  const howChecked = ledger || Boolean(proofType) || Boolean(item.check);
  const recordFolds: RecordFold[] = [
    ...(howChecked || item.checkedBy
      ? [
          {
            value: 'check' as const,
            label: 'How it’s checked',
            summary: checkedBy,
            testId: 'turn-check-fold',
            body: (
              <>
                {howChecked && (
                  <HowChecked
                    check={item.check}
                    proofType={proofType}
                    proof={record?.proof ?? item.step?.proof}
                    proofWords={record?.proofWords ?? item.step?.proofWords}
                    kind={item.kind}
                  />
                )}
                <CheckedBy checkedBy={item.checkedBy} />
              </>
            ),
          },
        ]
      : []),
    ...(goes
      ? [
          {
            value: 'route' as const,
            label: 'Where it goes',
            summary: goes.label,
            testId: 'turn-route-fold',
            body: <GoesTo route={item.route} />,
          },
        ]
      : []),
    {
      value: 'timing',
      label: 'Timing',
      summary: <TimingSummary timing={timing} live={live} />,
      testId: 'turn-timing-fold',
      body: <TimingGrid timing={timing} notYet={notYet} live={live} />,
    },
    ...(!stepsFirst && stepsShown
      ? [
          {
            value: 'steps' as const,
            label: 'Steps',
            ...(steps.count ? { count: steps.count } : {}),
            ...(steps.first ? { summary: `First: ${plainStep(steps.first)}` } : {}),
            testId: 'turn-steps-fold',
            body: stepsPart,
          },
        ]
      : []),
    {
      value: 'history',
      label: 'History',
      summary: historyWords(item, record),
      testId: 'turn-history-toggle',
      body: <History item={item} record={record} view={view} />,
    },
  ];

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
        // A container (Tower strips, 2026-10-20): the card lays itself out by
        // its OWN width — in a drawer, the panel's column or the page — never
        // the viewport's. Contained, its content no longer says how wide it
        // would like to be, so it says so itself: the measure and its padding,
        // which a drawer that fits its record reads (`.sheet-fit`).
        '@container/card min-w-0 rounded-lg border bg-surface',
        '[contain-intrinsic-inline-size:calc(var(--measure)+2.5rem)]',
        focused ? 'border-ink' : 'border-rule',
        // A strip: the 4 px leading edge in the hue of the person's status —
        // the lead badge's own paint, so the two never disagree.
        edgeOf(status),
        'border-s-4 border-s-state-vivid',
      )}
    >
      <div className="flex min-w-0 flex-col gap-4 p-4 @xl/card:p-5">
        <Head
          item={card}
          titleId={titleId}
          title={title}
          when={timing.startWhen}
          attempt={verdict?.attempt}
          size={inPanel ? 'title' : 'section'}
          facts={<Meta item={item} record={record} timing={timing} live={live} />}
          onInspect={onInspect}
        >
          {risk && <OpsStatus vocab="risk" word={risk} chrome="badge" />}
        </Head>

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
            <p data-testid="turn-request" className="max-w-(--measure) text-body text-ink">
              {item.request.ask}
            </p>
          )}
          {!ownCard && OwnerRequests && <OwnerRequests requests={item.requests} />}

          {/* The verdict, right after the head and BEFORE the steps — it changes what they are for. */}
          {fresh && CheckOutcome && <CheckOutcome answer={fresh} record={record} />}
          {verdict && verdict.state !== 'passed' && live && !checking && !echoed && (
            <Verdict verdict={verdict} />
          )}
          {checking && <CheckingLine attempts={attempts} ledger={ledger} />}
          {item.settled && <SettledLine settled={item.settled} />}
          {verdict && verdict.state === 'passed' && !echoed && <Verdict verdict={verdict} />}
          {settled && record?.answer && !verdict && (
            <p className="max-w-(--measure) text-body text-ink">
              <span className="font-medium">Answered: </span>
              {[record.answer.label ?? record.answer.option, record.answer.note].filter(Boolean).join(' — ')}
            </p>
          )}
          {lastNote && (
            <p data-testid="turn-check-note" className="max-w-(--measure) text-body text-ink">
              <span className="font-medium">Your note with attempt {lastNote.attempt}: </span>
              {lastNote.text}
            </p>
          )}

          <FromTheAI
            tried={record?.tried}
            note={record?.note ?? item.step?.note}
            overruled={record?.overruled}
          />

          {/* THE ACT, before the record of it (Tower strips): why only the person fits it, what they
              need to do it — a Task's and a Heads-up's steps first — and ONE act form, by the move table. */}
          <div
            data-testid="turn-act-section"
            data-type={words.type}
            role="group"
            aria-labelledby={actLabelId}
            className="flex min-w-0 flex-col gap-3"
          >
            <p id={actLabelId} data-testid="turn-act-label" className="text-meta font-medium text-ink-muted">
              {actLabel}
            </p>
            <WhyLine item={item} why={why} inferred={inferred} />
            {words.type === 'decide' && guide && <GuideSummary guide={guide} />}

            {permission && !ownCard && <PermissionFacts permission={permission} />}

            {view.code && <DeviceCode code={view.code} />}
            {view.act && view.path && (
              <p className="max-w-(--measure) text-body text-ink-muted" data-testid="step-protected">
                The edit is to <code className="font-mono text-meta text-ink">{view.path}</code>: {view.act}
              </p>
            )}
            {stepsFirst && stepsPart}
            {view.qr && live && (
              <PhoneLink url={view.qr}>
              </PhoneLink>
            )}
            {item.kind === 'secret-entry' && live && <SecretWhere where={record?.secretWhere} />}

            {/* ONE act form, by the move table — a permission's is the card the screen lends, an approval at a scope;
              a press that went through, what was sent, until the server moves the item. */}
            {ownCard && PermissionCard && permission ? (
              <PermissionCard
                item={item}
                permission={permission}
                row={row}
                perform={perform}
                busy={busy}
                live={live && !notYet && !checking}
                pinned={inPanel}
              />
            ) : sentNow && sent ? (
              <SentAct sent={sent} onShowAgain={() => setSent(null)} />
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
          </div>

          {/* THE RECORD, after the act, as fold strips: how it is checked, where it goes, its clocks,
              a decision's or an approval's steps (open at first), and its history. */}
          <RecordFolds folds={recordFolds} everything={everything} />
        </div>
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

/* ------------------------------------------------------------------ *
 * The card from an inbox row — a step a surface holds only as its row
 * ------------------------------------------------------------------ *
 *
 * When a run needs an act only a person can do, a surface that holds the
 * row and not the turn's item — the bell, a run strip — says so in one place
 * and one shape: what to do, where, the ONE action for that kind, *Open again*
 * whenever they want it, and the proof when it lands. Every row that is a
 * person's turn carries the same view (`humanStepView`) — a ledger step and
 * each card the console folds into the family (a sign-in, an MCP sign-in, the
 * verification card, a plan to approve, a gate, a relayed question, a QA
 * verdict, a protected edit):
 *
 *   1. its state as a dot and a word, the kind's glyph and plain label — read
 *      from `KIND_META`, the ONE place a kind is named — and where it is done;
 *   2. the step's own words, and its numbered lines;
 *   3. a device code, large, mono, selectable and copyable;
 *   4. ONE primary action chosen by kind (`PRIMARY_ACT`), then *Open again*,
 *      *Check now*, *Snooze* and *I can't do this*;
 *   5. a quiet status line — opened, last checked, next reminder, expiry —
 *      and the proof's own words when a check did not land;
 *   6. one press away, every datum: who declared it and when, each open, each
 *      check and what it read, the proof ref, the window — and the raw record
 *      one more.
 *
 * A folded card (no ledger step behind it) keeps the actions its row carries:
 * its primary is the row's recommended verb, performed exactly as the server
 * spelled it. A `secret-entry` card has no field for its value.
 */

/** The datums of a step — one press away, and the raw record one more. */
function StepDatums({ view, record }: { view: HumanStepView; record: HumanStepRecord | undefined }) {
  const rows: KeyValueItem[] = [];
  if (record) {
    const who =
      record.birth === 'session' && record.sessionId
        ? `${BIRTH_WORDS.session} (${record.sessionId})`
        : (BIRTH_WORDS[record.birth] ?? record.birth);
    rows.push(['Declared by', `${who}, ${stamp(record.declaredAt)}`]);
    rows.push([
      'For',
      // Phase 0 is the plan's own act, under its `## Operator errands`.
      `${record.slug}, ${record.phase ? `phase ${record.phase}` : 'the plan itself'}${record.runId ? ` (run ${record.runId})` : ''}`,
    ]);
  }
  const proof = record?.proof ?? view.proof;
  rows.push(['What proves it', proof ? <code className="font-mono wrap-anywhere">{proof}</code> : '—']);
  const dueWhen = record?.dueWhen ?? view.dueWhen;
  if (dueWhen)
    rows.push([
      'Due when',
      <>
        <code className="font-mono wrap-anywhere">{dueWhen}</code>
        {record?.dueAt ? ` landed, ${stamp(record.dueAt)}` : ' lands'}
      </>,
    ]);
  if (record)
    rows.push([
      'The window',
      record.state === 'upcoming'
        ? 'starts when it is due'
        : `${stamp(record.dueAt ?? record.declaredAt)} until ${stamp(record.windowEnd ?? record.until)}`,
    ]);
  if (record?.provenBy) rows.push(['Proven by', record.provenBy]);
  if (record?.note) rows.push(['Last word', record.note]);
  const moves = record?.moves ?? [];
  return (
    <div data-testid="step-datums" className="flex min-w-0 flex-col gap-3 rounded-md bg-ground px-3 py-2.5">
      <KeyValue items={rows} />
      {view.stepId && !record && <p className="text-meta text-ink-muted">Reading the ledger…</p>}
      {moves.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-meta font-medium text-ink">Every open and every check</p>
          <ol className="flex flex-col gap-0.5">
            {moves.map((move, index) => (
              <MoveLine key={`${move.at}-${index}`} move={move} />
            ))}
          </ol>
        </div>
      )}
      <Disclosure testId="step-raw-toggle" label="The raw record" openLabel="Hide the raw record">
        <RawRecord testId="step-raw" value={record ? { ...record } : view} />
      </Disclosure>
    </div>
  );
}

export interface StepCardProps {
  /** The inbox row that is a person's turn — its `humanStep` view, and its actions. */
  item: InboxItem;
  /** `row` folds the card to a line that expands in place; `primary` is its one action alone (a strip's). */
  variant?: 'full' | 'row' | 'primary';
  /** Performs a folded card's row actions, exactly as the server spelled them. */
  perform?: StepPerform | undefined;
  /** `${item.id}:${verb}` of whatever row action is in flight. */
  busy?: string | undefined;
  className?: string | undefined;
  /** The primary's test id — a strip names its one action `strip-action`. */
  testId?: string | undefined;
}

/** A person's step from its inbox row — whole, folded to a line, or its one action alone. */
export function StepCard({ variant = 'full', ...props }: StepCardProps) {
  const view = props.item.humanStep;
  if (!view) return null;
  if (variant === 'primary') return <StepPrimary {...props} view={view} />;
  return variant === 'row' ? <StepRow {...props} view={view} /> : <StepWhole {...props} view={view} />;
}

function StepRow({ item, view, perform, busy, className }: StepCardProps & { view: HumanStepView }) {
  const [open, setOpen] = useState(false);
  // An act born before it is due is shown, never pressed: the ledger refuses an
  // open or a check until its due-when ref lands.
  const upcoming = view.state === 'upcoming';
  return (
    <div
      data-testid="human-step-row"
      data-kind={view.kind}
      data-state={view.state}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* The row's title is the composer's — the act, as the card heads it
            (turn-by-turn phase 10); the step's own words are the fallback. */}
        <span data-testid="step-title" className="min-w-0 flex-1 basis-48 text-body font-medium text-ink">
          {(item.kind === 'human-step' && item.title) || view.title}
        </span>
        <KindMark kind={view.kind} />
        <WhereWord where={view.where} />
        {item.slug && (
          <span className="text-meta text-ink-muted" data-testid="step-scope">
            {item.slug}
            {item.phase != null ? `, phase ${item.phase}` : ''}
          </span>
        )}
      </div>
      {view.code && <DeviceCode code={view.code} />}
      {upcoming && !open && <DueLine dueWhen={view.dueWhen} />}
      {view.kind === 'operator-act' && view.openCommand && !open && (
        <StepCommand command={view.openCommand} />
      )}
      {/* `relative`: in a row with a pick box, the box's touch overlay overhangs
          its box past the row's gap, and this line starts flush under it — an
          unpositioned primary would lose its corner to the box. */}
      <div className="relative flex flex-wrap items-center gap-1.5">
        {!open && !upcoming && <StepPrimary item={item} view={view} perform={perform} busy={busy} />}
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          data-testid="step-expand"
          onClick={() => setOpen((was) => !was)}
        >
          <ChevronDown
            size={14}
            aria-hidden
            className={cn('transition-transform duration-fast ease-transit', open && 'rotate-180')}
          />
          {open ? 'Fold the step' : 'The whole step'}
        </Button>
      </div>
      {open && (
        <div className="expand-region">
          <div>
            <StepWhole item={item} view={view} perform={perform} busy={busy} embedded />
          </div>
        </div>
      )}
    </div>
  );
}

function StepWhole({
  item,
  view,
  perform,
  busy,
  className,
  embedded = false,
}: StepCardProps & { view: HumanStepView; embedded?: boolean }) {
  const verbs = useStepVerbs(view);
  const { data: list } = useHumanSteps(Boolean(view.stepId));
  const record = view.stepId ? list?.steps.find((step) => step.id === view.stepId) : undefined;
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const state = record?.state ?? view.state;
  const live = isOpenState(state);
  // Coming up: open, but not yet a person's turn — nothing to open, check or
  // snooze until its due-when ref lands.
  const upcoming = state === 'upcoming';
  const due = live && !upcoming;
  const opened = Math.max(record?.opened ?? 0, verbs.answer?.opened?.n ?? 0);
  const act = primaryActOf(view);
  const canOpen = Boolean(view.stepId && (view.openUrl || view.openCommand));
  const read = verbs.answer?.check && !verbs.answer.check.landed ? verbs.answer.check.read : record?.read;
  const unlanded =
    live && Boolean(read) && (verbs.answer?.check ? !verbs.answer.check.landed : (record?.checks ?? 0) > 0);
  const { rest } = splitActions(item);
  const now = Date.now();
  // The card a push pointed at (`#/approve?step=<id>`) says so to a screen reader.
  const pointed = useRoute().query.step === view.stepId && Boolean(view.stepId);

  return (
    <section
      data-testid="human-step-card"
      data-kind={view.kind}
      data-state={state}
      data-fold={view.fold ?? undefined}
      aria-current={pointed ? 'true' : undefined}
      aria-label={`${upcoming ? 'Coming up' : 'Your turn'}: ${KIND_META[view.kind].label}`}
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      {!embedded && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span data-testid="step-state">
            <OpsStatus vocab="step" word={state as HumanStepState} />
          </span>
          <KindMark kind={view.kind} />
          <WhereWord where={view.where} />
          <span className="text-meta text-ink-muted" data-testid="step-scope">
            {item.slug ?? 'no plan named'}
            {item.phase != null ? `, phase ${item.phase}` : ''}
          </span>
        </div>
      )}
      {!embedded && (
        <p data-testid="step-title" className="max-w-prose text-section font-semibold text-ink">
          {view.title}
        </p>
      )}
      {upcoming && <DueLine dueWhen={record?.dueWhen ?? view.dueWhen} />}
      {view.kind === 'operator-act' && view.openCommand && <StepCommand command={view.openCommand} />}
      {view.lines.length > 0 && (
        <ol
          data-testid="step-lines"
          className="flex max-w-prose list-decimal flex-col gap-1 ps-5 text-body text-ink"
        >
          {view.lines.map((line, index) => (
            <li key={`${index}-${line}`}>{line}</li>
          ))}
        </ol>
      )}
      {view.act && view.path && (
        <p className="max-w-prose text-meta text-ink-muted" data-testid="step-protected">
          The edit is to <code className="font-mono text-ink">{view.path}</code>: {view.act}
        </p>
      )}
      {!embedded && view.code && <DeviceCode code={view.code} />}
      {view.kind === 'secret-entry' && live && <SecretWhere where={record?.secretWhere} />}
      {verbs.confirm && (
        <div
          data-testid="step-confirm"
          className="flex min-w-0 flex-col gap-2 rounded-md bg-ground px-3 py-2.5"
        >
          <p className="text-body text-ink">Open this on the machine the console runs on?</p>
          <code dir="ltr" className="font-mono text-meta wrap-anywhere text-ink">
            {verbs.confirm}
          </code>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="primary" onClick={verbs.openOnMachine}>
              Open it there
            </Button>
            <Button variant="ghost" onClick={verbs.cancelConfirm}>
              Not now
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5" data-testid="step-actions">
        {!upcoming && (
          <StepPrimaryButton
            item={item}
            view={{ ...view, state }}
            verbs={verbs}
            perform={perform}
            busy={busy}
            size="md"
          />
        )}
        {canOpen && due && (
          <Button data-testid="step-open-again" disabled={verbs.busy === 'open'} onClick={() => verbs.open()}>
            Open again
          </Button>
        )}
        {view.stepId && due && view.where === 'host' && view.openUrl && list?.can.openHost && (
          <Button variant="ghost" data-testid="step-open-host" onClick={verbs.openOnMachine}>
            Open on the machine
          </Button>
        )}
        {view.stepId && due && act !== 'check' && (
          <Button data-testid="step-check" disabled={verbs.busy === 'check'} onClick={() => verbs.check()}>
            Check now
          </Button>
        )}
        {view.stepId && due && (
          <Button
            variant="ghost"
            data-testid="step-snooze"
            disabled={verbs.busy === 'snooze'}
            onClick={() => verbs.snooze()}
          >
            Snooze
          </Button>
        )}
        {view.stepId && live && (
          <Button
            variant="ghost"
            data-testid="step-cannot"
            aria-expanded={asking}
            onClick={() => setAsking((was) => !was)}
          >
            I can’t do this
          </Button>
        )}
        {!view.stepId &&
          perform &&
          rest.map((action) => (
            <Button
              key={action.verb}
              data-verb={action.verb}
              disabled={Boolean(action.flag) || busy === `${item.id}:${action.verb}`}
              onClick={() => perform(item, action)}
            >
              {action.label}
            </Button>
          ))}
      </div>

      {asking && (
        <form
          className="flex max-w-prose flex-wrap items-end gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            verbs.cannot(reason);
            setAsking(false);
            setReason('');
          }}
        >
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-meta text-ink-muted">
            Why not? It becomes an errand with your words.
            <Input
              data-testid="step-cannot-reason"
              block
              value={reason}
              placeholder="Who can do it, or what is in the way"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={!reason.trim()}>
            Hand it back
          </Button>
        </form>
      )}

      {view.stepId && !upcoming && (
        <p data-testid="step-status" className="flex flex-wrap gap-x-3 gap-y-0.5 text-meta text-ink-muted">
          {statusParts(record ?? { opened }, opened, now).map((part, index) => (
            <span key={part.key} data-part={part.key}>
              {index > 0 && <span className="sr-only">, </span>}
              {part.text}
            </span>
          ))}
        </p>
      )}
      {unlanded && read && (
        <p data-testid="step-read" className="max-w-prose text-meta text-ink">
          The check did not land. The proof read: <span className="text-ink-muted">{read}</span>
        </p>
      )}
      {!live && state === 'proven' && (
        <p data-testid="step-proven" className="text-meta text-ink">
          Proven{record?.provenBy ? ` by ${record.provenBy}` : ''} — the phase carries on.
        </p>
      )}

      <Disclosure
        testId="step-details-toggle"
        label="Details: who asked, each open and check, the proof, the window"
        openLabel="Hide the details"
        bodyClassName="pt-2"
      >
        <StepDatums view={view} record={record} />
      </Disclosure>

      {view.openCommand && (
        <StepTerminalSheet
          ticket={verbs.ticket}
          command={view.openCommand}
          title={view.title}
          onClose={verbs.closeTerminal}
        />
      )}
    </section>
  );
}
