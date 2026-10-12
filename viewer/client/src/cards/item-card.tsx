/**
 * One item of Your turn, whole (7.0; control-tower phase 137, #214).
 *
 * A card, because an item is acted on as a unit, and a quiet one: the server
 * decided what the item is (`GET /api/turn`); this file only draws it, top to
 * bottom in the order a person needs it —
 *
 *   1. its state as a dot and a word, the verdict's and the risk's beside it,
 *      the kind's mark and where it is done;
 *   2. the title, and "Only you:" with the reason — its sentence from
 *      `REASON_META`, said to be inferred when the raiser named none;
 *   3. the facts — the plan, the phase and the run, each a link; what it
 *      unblocks; a countdown while its window runs; the effort;
 *   4. the verdict, when a check sent it back: the attempt and exactly what to
 *      redo — read BEFORE the guide, because it changes what the guide is for;
 *   5. the guide, on the line (`guide.tsx`) — or, for an item that carries
 *      none, its own numbered lines and its command;
 *   6. how it will be checked, in words, by its proof type;
 *   7. ONE primary move, chosen by `primaryMoveOf` from the kind and the state
 *      — then *Not doing this* (only where the raiser allows it), *I can't*,
 *      *Snooze*, *Ask* and *Attach*; after the third miss, the escalation's
 *      three ways out;
 *   8. what the AI tried first, and its last word;
 *   9. one press in, the history — who raised it and when, every move, every
 *      attempt side by side with its evidence, the questions, the answer — and
 *      one more, the raw record.
 *
 * Never a field for a secret: a `secret-entry` item says where the value goes.
 * A projected item — a gate, an approval card, a relayed question — keeps the
 * actions its row carries, pressed verbatim (`perform`), as every inbox action
 * is; the item's own verbs go through the owner door (`data/press.ts`). The
 * pieces a screen draws INSIDE an item — a permission item's own card, the
 * owner's pending requests, the supervisor's card, a link's QR — are lent by
 * the screen (`parts`), and the card says what it can without them.
 */

import { useEffect, useId, useState, type ComponentType, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Timer } from 'lucide-react';

import {
  HUMAN_STEP_SETTLED_STATES,
  KIND_META,
  humanStepView,
  type HumanStepKind,
  type HumanStepState,
  type HumanStepView,
} from '@shared/human-step-model.js';
import { REASON_META, type ProofType } from '@shared/turn-model.js';
import type { InboxAction, InboxItem } from '@/data/api';
import {
  humanStepsApi as api,
  type HumanStepRecord,
  type PermissionRecord,
  type StepEvidenceInput,
  type StepVerbAnswer,
  type StepVerdictRecord,
} from '@/data/human-steps';
import { keys } from '@/data/keys';
import { patchHumanStep } from '@/data/live';
import type { AuthorityRequest } from '@/data/owner';
import { press } from '@/data/press';
import type { TurnItem, TurnRecord } from '@/data/turn';
import { useNow } from '@/lib/clock';
import { cn } from '@/lib/cn';
import { phaseHref, planHref, runHref, toHash } from '@/shell/routes';
import { Button, Input, KeyValue, toast, type KeyValueItem } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { MicField } from '@/ui/mic-field';
import { OpsStatus } from '@/ui/status';
import { Textarea } from '@/ui/textarea';
import { DecisionCard } from './decision-card';
import { CommandBlock, GuideView, guideOf } from './guide';
import {
  BIRTH_WORDS,
  DeviceCode,
  DueLine,
  KindMark,
  MoveLine,
  RawRecord,
  SecretWhere,
  WhereWord,
  errorWords,
  span,
  stamp,
  useStepVerbs,
} from './human-step-card';
import { CHECK_LABEL, primaryActOf, primaryLabel } from './human-step-words';
import { StepTerminalSheet } from './step-terminal-sheet';

type Perform = (item: InboxItem, action: InboxAction, says?: string) => void;

/* ------------------------------------------------------------------ *
 * The primary move — by kind and state, and nothing else
 * ------------------------------------------------------------------ */

/**
 * What an item's ONE primary action is. `row` presses one of the item's own
 * row actions verbatim; `answer` is *Send my answer*; `open`, `terminal` and
 * `machine` are the kind's own opener; `check` is *I've done this — check*;
 * `none` says why there is nothing to press.
 */
export type PrimaryMove =
  | { move: 'none'; why: 'settled' | 'upcoming' | 'checking' | 'no-action' }
  | { move: 'row'; action: InboxAction }
  | { move: 'answer' }
  | { move: 'open' | 'terminal' | 'machine' }
  | { move: 'check' };

export type PrimaryInput = {
  kind: HumanStepKind;
  state: HumanStepState;
  record: TurnRecord;
  proofType?: ProofType | null | undefined;
  openUrl?: string | undefined;
  openCommand?: string | undefined;
  actions: readonly InboxAction[];
};

const SETTLED: ReadonlySet<string> = new Set(HUMAN_STEP_SETTLED_STATES);

/** A permission item ends by a grant; failing one, by doing it yourself; failing that, by a denial. */
const PERMISSION_ORDER = Object.freeze(['grant', 'convert', 'deny'] as const);

/**
 * The primary move:
 *
 * - a settled item, one not due yet and one being checked have none — the
 *   ledger refuses a press on the second, and a check already holds the third;
 * - a projected item or a request leads with its row's first pressable action;
 * - a permission item with its Grant, else *I'll do it myself*, else *Deny*;
 * - a decision, a person-check, or anything proven by an answer, with
 *   *Send my answer*;
 * - every other item with its kind's own opener while it is declared or
 *   notified, and with the check once it was opened or came back.
 */
export function primaryMoveOf(input: PrimaryInput): PrimaryMove {
  if (SETTLED.has(input.state)) return { move: 'none', why: 'settled' };
  if (input.state === 'upcoming') return { move: 'none', why: 'upcoming' };
  if (input.state === 'checking') return { move: 'none', why: 'checking' };
  const pressable = input.actions.filter((action) => !action.flag);
  if (input.record !== 'ledger') {
    const first = pressable[0];
    return first ? { move: 'row', action: first } : { move: 'none', why: 'no-action' };
  }
  if (input.kind === 'permission' || input.proofType === 'grant') {
    for (const verb of PERMISSION_ORDER) {
      const action = pressable.find((candidate) => candidate.verb === verb);
      if (action) return { move: 'row', action };
    }
    return { move: 'none', why: 'no-action' };
  }
  if (input.kind === 'decision' || input.kind === 'person-check' || input.proofType === 'answer') {
    return { move: 'answer' };
  }
  if (input.state === 'opened' || input.state === 'returned') return { move: 'check' };
  const act = primaryActOf({ kind: input.kind, openUrl: input.openUrl, openCommand: input.openCommand });
  return act === 'open' || act === 'terminal' || act === 'machine' ? { move: act } : { move: 'check' };
}

/** What the primary says — the row's own label, the opener's, or the check's one wording. */
export function primaryMoveLabel(move: PrimaryMove, kind: HumanStepKind): string | null {
  switch (move.move) {
    case 'none':
      return null;
    case 'row':
      return move.action.label;
    case 'answer':
      return 'Send my answer';
    case 'check':
      return CHECK_LABEL;
    default:
      return primaryLabel(move.move, kind);
  }
}

/* ------------------------------------------------------------------ *
 * The item's words
 * ------------------------------------------------------------------ */

/** How the item is checked, said by its proof type — never a verdict, only the method. */
function CheckWords({
  proofType,
  proof,
  proofWords,
  kind,
}: {
  proofType: ProofType | null | undefined;
  proof: string | undefined;
  proofWords: string | undefined;
  kind: HumanStepKind;
}) {
  let words: ReactNode;
  switch (proofType) {
    case 'probe':
      words = (
        <>
          The console checks it itself: it runs{' '}
          {proof ? <code className="font-mono wrap-anywhere text-ink">{proof}</code> : 'the proof'} and passes
          when that answers yes.{proofWords ? ` ${proofWords}` : ''}
        </>
      );
      break;
    case 'judgement':
      words = <>An AI checker reads what you did against this: {proofWords ?? KIND_META[kind].proof}.</>;
      break;
    case 'answer':
      words = 'Your answer is the proof: the session carries on with it.';
      break;
    case 'attest':
      words = 'Your word is the proof: press it once it is done.';
      break;
    case 'grant':
      words =
        'Your grant is the proof: the session carries on under it, and a denial tells it to find another way.';
      break;
    default:
      words = <>What proves it: {proofWords ?? KIND_META[kind].proof}.</>;
  }
  return (
    <p data-testid="turn-check-words" className="max-w-prose text-meta text-ink-muted">
      <span className="font-medium text-ink">How it is checked. </span>
      {words}
    </p>
  );
}

/** What it unblocks: the declared phases and every waiting session's, once each. */
export function unblocksOf(
  item: Pick<TurnItem, 'step'>,
  record?: Pick<HumanStepRecord, 'unblocks' | 'waiters'>,
): { slug: string; phase: number }[] {
  const seen = new Set<string>();
  const out: { slug: string; phase: number }[] = [];
  const all = [
    ...(record?.unblocks ?? item.step?.unblocks ?? []),
    ...(record?.waiters ?? item.step?.waiters ?? []),
  ];
  for (const { slug, phase } of all) {
    const key = `${slug}/${phase}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slug, phase });
  }
  return out;
}

/** The item's window end — the ledger's, else the turn's, else the row's. */
function dueOf(item: TurnItem, record: HumanStepRecord | undefined): string | undefined {
  return record?.windowEnd ?? record?.until ?? item.step?.until ?? item.expiresAt;
}

function effortWords(minutes: number): string {
  return minutes < 60 ? `About ${minutes} min` : `About ${span(minutes * 60_000)}`;
}

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

/* ------------------------------------------------------------------ *
 * Pressing — the item's own verbs beside the step card's
 * ------------------------------------------------------------------ */

type ItemBusy = 'answer' | 'decline' | 'ask' | 'attach' | 'override' | 'rewrite' | null;

/**
 * The verbs only an item has — answer, decline, ask, attach, and the
 * escalation's two — each through the owner door, each answer patched straight
 * into the caches, and the inbox (the turn sits under its key) re-read
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
    if (!id) return null;
    setBusy(which);
    try {
      const pressed = await press(() => call(id));
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
    answer: (body: { option?: string; note?: string }) =>
      run('answer', (at) => api.humanStepAnswer(at, body), 'Answer sent — the session carries on with it.'),
    decline: (reason: string) =>
      run('decline', (at) => api.humanStepDecline(at, reason), 'Declined — the session is told why.'),
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
  };
}

/** A file, as the evidence route takes it: base64, with its type and name. */
function readEvidence(file: File): Promise<StepEvidenceInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.onload = () => {
      const data = String(reader.result ?? '').replace(/^data:[^,]*,/, '');
      resolve(
        file.type.startsWith('image/')
          ? { kind: 'image', data, mime: file.type, name: file.name }
          : { kind: 'file', data, name: file.name },
      );
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ *
 * The pieces
 * ------------------------------------------------------------------ */

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-col" data-testid={testId}>
      <dt className="text-meta text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-body break-words text-ink">{children}</dd>
    </div>
  );
}

const link = 'tap-row text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink';

/** Where it belongs, what it unblocks, when it is due and what it costs — each a fact with its name. */
function Facts({
  item,
  record,
  live,
}: {
  item: TurnItem;
  record: HumanStepRecord | undefined;
  live: boolean;
}) {
  const due = live ? dueOf(item, record) : undefined;
  const now = useNow(Boolean(due), 30_000);
  const end = due ? Date.parse(due) : NaN;
  const unblocks = unblocksOf(item, record);
  const effort = record?.effortMin ?? item.step?.effortMin;
  const runId = item.runId ?? record?.runId;
  return (
    <dl data-testid="turn-facts" className="flex min-w-0 flex-wrap gap-x-6 gap-y-2">
      {item.slug && (
        <Fact label="Plan">
          <a className={link} href={planHref(item.slug)}>
            {item.slug}
          </a>
        </Fact>
      )}
      {item.slug && item.phase != null && (
        <Fact label="Phase">
          {item.phase ? (
            <a className={link} href={phaseHref(item.slug, item.phase)}>
              Phase {item.phase}
            </a>
          ) : (
            'The plan itself'
          )}
        </Fact>
      )}
      {item.slug && runId && (
        <Fact label="Run">
          <a className={cn(link, 'font-mono text-meta')} href={runHref(item.slug)} title={runId}>
            {runId.slice(0, 8)}
          </a>
        </Fact>
      )}
      {unblocks.length > 0 && (
        <Fact label="Unblocks" testId="turn-unblocks">
          {unblocks.map(({ slug, phase }, index) => (
            <span key={`${slug}/${phase}`}>
              {index > 0 && ', '}
              <a className={link} href={phaseHref(slug, phase)}>
                {slug === item.slug ? `phase ${phase}` : `${slug} phase ${phase}`}
              </a>
            </span>
          ))}
        </Fact>
      )}
      {Number.isFinite(end) && (
        <Fact label="Due" testId="turn-due">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Timer size={13} aria-hidden className="shrink-0 text-ink-muted" />
            {end > now ? `in ${span(end - now)}` : `the window closed ${span(now - end)} ago`}
          </span>
        </Fact>
      )}
      {effort != null && (
        <Fact label="Effort" testId="turn-effort">
          {effortWords(effort)}
        </Fact>
      )}
    </dl>
  );
}

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
      {permission.command && <CommandBlock code={permission.command} />}
      {permission.never ? (
        <p data-testid="turn-permission-never">
          <span className="font-medium">It is never granted. </span>
          {permission.never.why} By hand:{' '}
          <code className="font-mono text-meta wrap-anywhere">{permission.never.manual}</code>
        </p>
      ) : permission.grant ? (
        <p>
          <span className="font-medium">What Grant does. </span>
          {permission.grant.label}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A check's answer: what was proven, or exactly what to redo and which attempt
 * it was. Back with the person, it wears the summons on its leading edge — a
 * rule in the hue, never a filled band; passed, it goes quiet.
 */
function Verdict({ verdict }: { verdict: StepVerdictRecord }) {
  const passed = verdict.state === 'passed';
  return (
    <div
      data-testid="turn-verdict"
      data-verdict={verdict.state}
      className={cn(
        'flex min-w-0 max-w-prose flex-col gap-2 border-s-2 ps-3 text-body text-ink',
        passed ? 'border-rule-strong' : 'state-needs-you border-state',
      )}
    >
      <p>
        <span className="font-medium">
          {passed
            ? verdict.unverified
              ? 'Passed on your word, unverified: '
              : 'Passed: '
            : verdict.state === 'needs-info'
              ? `Back to you — attempt ${verdict.attempt} needs one detail: `
              : `Back to you — attempt ${verdict.attempt}: `}
        </span>
        {verdict.note}
      </p>
      {!passed && verdict.redo.length > 0 && (
        <div>
          <p className="font-medium">Redo</p>
          <ol className="list-decimal ps-5" data-testid="turn-redo">
            {verdict.redo.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ol>
        </div>
      )}
      {verdict.read.length > 0 && (
        <p className="text-meta text-ink-muted">The check read: {verdict.read.join('; ')}</p>
      )}
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
  onCannot: () => void;
  onOverride: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
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
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button size="sm" disabled={busy} onClick={onCannot}>
            I can’t do this
          </Button>
          <span className="text-meta text-ink-muted">It becomes an errand, with your reason.</span>
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

/** One press in: who raised it and when, every move, every attempt, the questions, the answer — and the raw record. */
function History({ item, record }: { item: TurnItem; record: HumanStepRecord | undefined }) {
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

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

/**
 * The pieces a screen lends the card — drawn INSIDE an item, and owned by the
 * screen that answers them. Each is optional: without a permission card the
 * item says what stopped the AI and offers its own moves; without the owner's
 * requests, nothing is drawn for them.
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
   * verdict's place, before the guide, and the ledger's verdict of the same
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

type Form = 'decline' | 'cannot' | 'ask' | 'attach' | null;

const FORM_WORDS: Readonly<
  Record<Exclude<Form, null>, { label: string; placeholder: string; submit: string }>
> = {
  decline: {
    label: 'Why not? The session is told, and finds another way.',
    placeholder: 'What should happen instead',
    submit: 'Decline it',
  },
  cannot: {
    label: 'Why not? It becomes an errand with your words.',
    placeholder: 'Who can do it, or what is in the way',
    submit: 'Hand it back',
  },
  ask: {
    label: 'Your question. The session reads it when it resumes.',
    placeholder: 'What is unclear',
    submit: 'Ask',
  },
  attach: {
    label: 'A note for this attempt, or a file below.',
    placeholder: 'What you did, what you saw',
    submit: 'Attach',
  },
};

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
  const formId = useId();
  const state: HumanStepState = record?.state ?? item.step?.state ?? item.humanStep?.state ?? 'notified';
  const view = viewOf(item, record, state);
  const verbs = useStepVerbs(view);
  const extra = useItemVerbs(item.record === 'ledger' ? item.item : undefined);
  const [form, setForm] = useState<Form>(null);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [said, setSaid] = useState('');
  const { PermissionCard, OwnerRequests, CheckOutcome } = parts;

  const ledger = item.record === 'ledger';
  const settled = SETTLED.has(state);
  const upcoming = state === 'upcoming';
  const checking = state === 'checking';
  const live = !settled;
  const proofType = record?.proofType ?? item.step?.proofType ?? item.proofType;
  const why = record?.why ?? item.step?.why ?? item.why;
  const inferred = (record?.whySource ?? item.step?.whySource) === 'inferred';
  const guide = guideOf(record?.guide ?? item.step?.guide);
  const options = record?.options ?? item.step?.options ?? [];
  const allowDecline = Boolean(record?.allowDecline ?? item.step?.allowDecline);
  const verdict = record?.verdict;
  const attempts = record?.attempts ?? item.step?.attempts ?? 0;
  const permission = item.permission ?? item.step?.permission ?? record?.permission;
  // A ledger permission item is answered on its own card where the screen
  // lends one: the scopes, the risk, the typed rule and the owner key — and its
  // moves are that card's.
  const ownCard = Boolean(permission && ledger && PermissionCard);
  const risk = item.permission?.risk ?? item.step?.permission?.risk ?? record?.permission?.risk;
  const row = rowOf(item);
  const move = primaryMoveOf({
    kind: item.kind,
    state,
    record: item.record,
    proofType,
    openUrl: view.openUrl,
    openCommand: view.openCommand,
    actions: item.actions,
  });
  const label = primaryMoveLabel(move, item.kind);
  const pressable = item.actions.filter((action) => !action.flag);
  const rest =
    move.move === 'row' ? pressable.filter((action) => action !== move.action) : ledger ? [] : pressable;
  // A box for words only when a row action THIS card presses asks for them —
  // a ledger step's row carries *I can't do this* with a reason, but the card
  // asks that in its own form, so its row actions are never drawn here.
  const says = (move.move === 'row' ? [move.action, ...rest] : rest).find((action) => action.says)?.says;
  const escalated = Boolean(record?.escalatedAt) && live && !upcoming;
  const tried = record?.tried;
  const note = record?.note ?? item.step?.note;
  const title = record?.title ?? item.step?.title ?? item.title;
  const openable = Boolean(ledger && (view.openUrl || view.openCommand));
  const otherOpener = openable && move.move !== 'open' && move.move !== 'terminal' && move.move !== 'machine';
  // A check just pressed answers in words (#266), where the screen lends the
  // part: its outcome takes the verdict's place, and the ledger's verdict of
  // the same attempt — patched in by the same answer — is not drawn twice.
  const fresh =
    CheckOutcome && verbs.answer && (verbs.answer.check || verbs.answer.verdict) ? verbs.answer : null;
  const echoed = Boolean(
    fresh?.verdict && verdict && fresh.verdict.attempt === verdict.attempt && fresh.verdict.at === verdict.at,
  );

  function pressPrimary() {
    switch (move.move) {
      case 'row':
        perform(row, move.action, says ? said : undefined);
        return;
      case 'open':
        verbs.open('url');
        return;
      case 'terminal':
      case 'machine':
        verbs.open('command');
        return;
      case 'check':
        verbs.check();
        return;
      default:
        return;
    }
  }

  async function submit() {
    const words = text.trim();
    if (form === 'attach') {
      const evidence: StepEvidenceInput | null = file
        ? await readEvidence(file).catch((cause: unknown) => {
            toast(errorWords(cause), 'warn', 8000);
            return null;
          })
        : words
          ? { kind: 'note', text: words }
          : null;
      if (!evidence) return;
      await extra.attach(evidence);
    } else if (!words) {
      return;
    } else if (form === 'decline') {
      await extra.decline(words);
    } else if (form === 'cannot') {
      verbs.cannot(words);
    } else if (form === 'ask') {
      await extra.ask(words);
    }
    setForm(null);
    setText('');
    setFile(null);
  }

  const working =
    (move.move === 'check' && verbs.busy === 'check') ||
    ((move.move === 'open' || move.move === 'terminal' || move.move === 'machine') &&
      verbs.busy === 'open') ||
    (move.move === 'row' && busy === `${row.id}:${move.action.verb}`);
  const needsWords = move.move === 'row' && move.action.says?.field === 'rule' && !said.trim();

  return (
    <article
      id={`turn-item-${item.item}`}
      data-testid="turn-item"
      data-item={item.item}
      data-kind={item.kind}
      data-state={state}
      data-group={item.group}
      data-record={item.record}
      aria-current={focused ? 'true' : undefined}
      aria-labelledby={titleId}
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-lg border bg-surface p-4 sm:p-5',
        focused ? 'border-ink' : 'border-rule',
      )}
    >
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <span data-testid="turn-state">
            <OpsStatus vocab="step" word={state} />
          </span>
          {verdict && <OpsStatus vocab="verdict" word={verdict.state} />}
          {risk && <OpsStatus vocab="risk" word={risk} />}
          <KindMark kind={item.kind} />
          {ledger && <WhereWord where={view.where} />}
          {onInspect && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="turn-inspect"
              data-print="hide"
              className="ms-auto"
              onClick={onInspect}
            >
              Inspect
            </Button>
          )}
        </div>
        <h3 id={titleId} data-testid="turn-title" className="max-w-prose text-section font-semibold text-ink">
          {title}
        </h3>
        <p data-testid="turn-why" className="max-w-prose text-body text-ink">
          <span className="font-medium">Only you: </span>
          {REASON_META[why]?.sentence ?? why}
          {inferred && <span className="text-ink-muted"> (inferred from its kind)</span>}
        </p>
      </header>

      <Facts item={item} record={record} live={live} />

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
          {open ? 'Fold it' : upcoming ? 'What it will ask' : 'What it asked, and how it ended'}
        </Button>
      )}

      <div
        data-testid="turn-body"
        data-print="open"
        className={cn('min-w-0 flex-col gap-4', open ? 'flex' : 'hidden')}
      >
        {upcoming && <DueLine dueWhen={record?.dueWhen ?? view.dueWhen} />}
        {item.record !== 'ledger' && !item.supervisor && (item.need || item.how) && (
          <div className="flex max-w-prose flex-col gap-1 text-body text-ink">
            {item.need && <p>{item.need}</p>}
            {item.how && <p className="text-ink-muted">{item.how}</p>}
          </div>
        )}
        {item.request && (
          <p data-testid="turn-request" className="max-w-prose text-body text-ink">
            {item.request.ask}
          </p>
        )}
        {!ownCard && OwnerRequests && <OwnerRequests requests={item.requests} />}
        {permission &&
          (ownCard && PermissionCard ? (
            <PermissionCard
              item={item}
              permission={permission}
              row={row}
              perform={perform}
              busy={busy}
              live={live && !upcoming && !checking}
            />
          ) : (
            <PermissionFacts permission={permission} />
          ))}
        {fresh && CheckOutcome && <CheckOutcome answer={fresh} record={record} />}
        {verdict && verdict.state !== 'passed' && live && !echoed && <Verdict verdict={verdict} />}
        {view.code && <DeviceCode code={view.code} />}
        {view.act && view.path && (
          <p className="max-w-prose text-body text-ink-muted" data-testid="step-protected">
            The edit is to <code className="font-mono text-meta text-ink">{view.path}</code>: {view.act}
          </p>
        )}
        {guide ? (
          <GuideView guide={guide} itemId={item.item} />
        ) : (
          <>
            {view.lines.length > 0 && (
              <ol
                data-testid="turn-lines"
                className="flex max-w-prose list-decimal flex-col gap-1 ps-5 text-body text-ink"
              >
                {view.lines.map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ol>
            )}
            {view.openCommand && !permission && <CommandBlock code={view.openCommand} />}
          </>
        )}
        {view.qr && live && (
          <PhoneLink url={view.qr}>
          </PhoneLink>
        )}
        {item.kind === 'secret-entry' && live && <SecretWhere where={record?.secretWhere} />}
        {(ledger || proofType) && (
          <CheckWords
            proofType={proofType}
            proof={record?.proof ?? item.step?.proof}
            proofWords={record?.proofWords ?? item.step?.proofWords}
            kind={item.kind}
          />
        )}
        {checking && (
          <p data-testid="turn-checking" className="max-w-prose text-body text-ink">
            Being checked{attempts ? ` — attempt ${attempts}` : ''}. The verdict lands here; nothing to press
            until it does.
          </p>
        )}
        {verdict && verdict.state === 'passed' && !echoed && <Verdict verdict={verdict} />}
        {settled && record?.answer && !verdict && (
          <p className="max-w-prose text-body text-ink">
            <span className="font-medium">Answered: </span>
            {[record.answer.label ?? record.answer.option, record.answer.note].filter(Boolean).join(' — ')}
          </p>
        )}

        {says && live && !upcoming && !ownCard && (
          <MicField
            label={says.label}
            placeholder={says.placeholder}
            value={said}
            onChange={setSaid}
            disabled={Boolean(busy)}
          />
        )}

        {move.move === 'answer' && (
          <DecisionCard
            options={options}
            busy={extra.busy === 'answer'}
            onSend={(answer) => void extra.answer(answer)}
          />
        )}


        {live && !upcoming && !ownCard && !item.supervisor && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="turn-moves" data-print="hide">
            {label && move.move !== 'answer' && (
              <Button
                variant="primary"
                data-testid="turn-primary"
                data-move={move.move}
                {...(move.move === 'row' ? { 'data-verb': move.action.verb } : {})}
                disabled={working || needsWords}
                onClick={pressPrimary}
              >
                {working ? 'Working…' : label}
              </Button>
            )}
            {otherOpener && !checking && (
              <Button disabled={verbs.busy === 'open'} onClick={() => verbs.open()}>
                Open again
              </Button>
            )}
            {rest.map((action) => (
              <Button
                key={action.verb}
                variant={action.verb === 'deny' ? 'danger' : 'default'}
                data-verb={action.verb}
                disabled={busy === `${row.id}:${action.verb}`}
                onClick={() => perform(row, action, says ? said : undefined)}
              >
                {action.label}
              </Button>
            ))}
            {ledger && !permission && (
              <>
                {allowDecline && !checking && (
                  <Button
                    variant="ghost"
                    aria-expanded={form === 'decline'}
                    onClick={() => setForm('decline')}
                  >
                    Not doing this
                  </Button>
                )}
                {!checking && (
                  <Button variant="ghost" aria-expanded={form === 'cannot'} onClick={() => setForm('cannot')}>
                    I can’t
                  </Button>
                )}
                {!checking && (
                  <Button variant="ghost" disabled={verbs.busy === 'snooze'} onClick={verbs.snooze}>
                    Snooze
                  </Button>
                )}
                <Button variant="ghost" aria-expanded={form === 'ask'} onClick={() => setForm('ask')}>
                  Ask
                </Button>
                <Button variant="ghost" aria-expanded={form === 'attach'} onClick={() => setForm('attach')}>
                  Attach
                </Button>
              </>
            )}
          </div>
        )}

        {moves && (
          <div
            data-testid="turn-more-moves"
            data-print="hide"
            className="flex flex-wrap items-center gap-1.5"
          >
            {moves}
          </div>
        )}

        {form && (
          <form
            data-testid={`turn-form-${form}`}
            data-print="hide"
            className="flex max-w-prose flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label htmlFor={`${formId}-words`} className="text-meta text-ink-muted">
              {FORM_WORDS[form].label}
            </label>
            {form === 'attach' || form === 'ask' ? (
              <Textarea
                id={`${formId}-words`}
                rows={2}
                block
                value={text}
                placeholder={FORM_WORDS[form].placeholder}
                onChange={(event) => setText(event.target.value)}
              />
            ) : (
              <Input
                id={`${formId}-words`}
                block
                value={text}
                placeholder={FORM_WORDS[form].placeholder}
                onChange={(event) => setText(event.target.value)}
              />
            )}
            {form === 'attach' && (
              <label className="flex flex-col gap-1 text-meta text-ink-muted">
                A screenshot or a file — kept on this machine, by its hash
                <Input
                  type="file"
                  className="h-auto py-1.5"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </label>
            )}
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="submit"
                disabled={(form === 'attach' ? !text.trim() && !file : !text.trim()) || extra.busy !== null}
              >
                {FORM_WORDS[form].submit}
              </Button>
              <Button variant="ghost" type="button" onClick={() => setForm(null)}>
                Not now
              </Button>
            </div>
          </form>
        )}

        {escalated && (
          <Escalation
            attempts={attempts}
            busy={extra.busy !== null}
            onRewrite={() => void extra.rewrite()}
            onCannot={() => setForm('cannot')}
            onOverride={() => void extra.override()}
          />
        )}

        {(tried || note) && (
          <div
            data-testid="turn-ai-note"
            className="flex max-w-prose flex-col gap-1 text-meta text-ink-muted"
          >
            {tried && (
              <p>
                <span className="font-medium text-ink">What the AI tried first. </span>
                {tried}
                {record?.overruled ? ' It asked anyway, past the guard.' : ''}
              </p>
            )}
            {note && (
              <p>
                <span className="font-medium text-ink">Its last word. </span>
                {note}
              </p>
            )}
          </div>
        )}

        {!ledger && (
          <a
            href={toHash(item.href)}
            className="tap-row w-fit text-meta text-ink-muted underline underline-offset-2"
          >
            Open where it lives
          </a>
        )}

        <History item={item} record={record} />
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
