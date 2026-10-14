/**
 * The card's middle (turn-by-turn phase 8) — what the person reads to do it:
 *
 *   - *From the AI* — what it tried first and its last word;
 *   - the numbered steps on the line (`../guide.tsx`'s track): the authored
 *     guide whole when the item carries one, else the composer's steps (an
 *     errands row, the step's own lines, the situation's ask, the minimal
 *     guide), with "If it goes wrong";
 *   - the link between a plan's item and the session item that covers it —
 *     "Steps from Phase N's session" — linked, never merged;
 *   - *How it's checked*, in words;
 *   - *Goes to* and *Checked by*.
 */

import type { ReactNode } from 'react';
import { KIND_META, type HumanStepKind } from '@shared/human-step-model.js';
import { ROUTE_META, type ProofType } from '@shared/turn-model.js';
import { GUIDE_DEFAULT_LANG, type Guide } from '@shared/guide-grammar.js';
import type { TurnItem } from '@/data/turn';
import { turnHref } from '@/shell/routes';
import { GuideView } from '../guide';

/** From the AI: what it tried before asking, and its last word. */
export function FromTheAI({
  tried,
  note,
  overruled,
}: {
  tried?: string | undefined;
  note?: string | undefined;
  overruled?: boolean | undefined;
}) {
  if (!tried && !note) return null;
  return (
    <section
      data-testid="turn-ai-note"
      aria-label="From the AI"
      className="flex max-w-prose flex-col gap-1 border-s-2 border-rule-strong ps-3 text-body text-ink"
    >
      <p className="text-meta font-medium text-ink-muted">From the AI</p>
      {tried && (
        <p>
          <span className="font-medium">What it tried first. </span>
          {tried}
          {overruled ? ' It asked anyway, past the guard.' : ''}
        </p>
      )}
      {note && (
        <p>
          <span className="font-medium">Its last word. </span>
          {note}
        </p>
      )}
    </section>
  );
}

/** The steps the composer wrote, as the one guide grammar draws them — a guide with no paragraph of its own. */
export function composedGuide(item: Pick<TurnItem, 'steps' | 'trouble'>): Guide | null {
  if (!item.steps?.length) return null;
  return {
    version: 1,
    lang: GUIDE_DEFAULT_LANG,
    dir: 'ltr',
    summary: '',
    steps: [...item.steps],
    trouble: [...(item.trouble ?? [])],
  };
}

/** The steps: the item's guide, else the composer's, else the step's own lines. */
export function Steps({
  item,
  guide,
  lines,
  fallback,
}: {
  item: TurnItem;
  /** The item's own guide, whole, when it carries one. */
  guide: Guide | null;
  /** A 7.0 step's own lines, when nothing else says the steps. */
  lines: readonly string[];
  /** What to draw when there are no steps at all (a command block, say). */
  fallback?: ReactNode;
}) {
  const drawn = guide ?? composedGuide(item);
  if (drawn) return <GuideView guide={drawn} itemId={item.item} />;
  return (
    <>
      {lines.length > 0 && (
        <ol
          data-testid="turn-lines"
          className="flex max-w-prose list-decimal flex-col gap-1 ps-5 text-body text-ink"
        >
          {lines.map((line, index) => (
            <li key={`${index}-${line}`}>{line}</li>
          ))}
        </ol>
      )}
      {fallback}
    </>
  );
}

type Link = { id: string; phase: number; title: string };

const link = 'tap-row text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink';

/**
 * A plan's item and the session item that covers it (turn-by-turn phase 7):
 * the plan item says whose steps to follow, the session item what it covers —
 * linked both ways, never merged.
 */
export function CoverLinks({
  coveredBy,
  covers,
}: {
  coveredBy?: Link | undefined;
  covers?: readonly Link[] | undefined;
}) {
  if (!coveredBy && !covers?.length) return null;
  return (
    <div data-testid="turn-cover-links" className="flex max-w-prose flex-col gap-1 text-body text-ink">
      {coveredBy && (
        <p data-testid="turn-covered-by">
          <span className="font-medium">Steps from Phase {coveredBy.phase}’s session. </span>
          It raised the same act with its own guide:{' '}
          <a className={link} href={turnHref(coveredBy.id)}>
            {coveredBy.title}
          </a>
          . Doing either does both.
        </p>
      )}
      {covers?.map((plan) => (
        <p key={plan.id} data-testid="turn-covers">
          <span className="font-medium">It covers the plan’s own errand. </span>
          <a className={link} href={turnHref(plan.id)}>
            {plan.title}
          </a>{' '}
          is the same act, written in the plan.
        </p>
      ))}
    </div>
  );
}

/** How it is checked, in words: the composer's sentence, else one said from the proof type. */
export function HowChecked({
  check,
  proofType,
  proof,
  proofWords,
  kind,
}: {
  check?: string | undefined;
  proofType: ProofType | null | undefined;
  proof: string | undefined;
  proofWords: string | undefined;
  kind: HumanStepKind;
}) {
  let words: ReactNode = check;
  if (!words) {
    switch (proofType) {
      case 'probe':
        words = (
          <>
            The console checks it itself: it runs{' '}
            {proof ? <code className="font-mono wrap-anywhere text-ink">{proof}</code> : 'the proof'} and
            passes when that answers yes.{proofWords ? ` ${proofWords}` : ''}
          </>
        );
        break;
      case 'judgement':
        words = (
          <>A checking session reads what you did against this: {proofWords ?? KIND_META[kind].proof}.</>
        );
        break;
      case 'answer':
        words = 'Your answer is the result: the session carries on with it.';
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
  }
  return (
    <p data-testid="turn-check-words" className="max-w-prose text-body text-ink">
      <span className="font-medium">How it’s checked. </span>
      {words}
    </p>
  );
}

/** *Goes to* and *Checked by* — where a press goes and who decides it is done. */
export function Routing({ route, checkedBy }: { route: TurnItem['route']; checkedBy: string | undefined }) {
  const goes = route
    ? (ROUTE_META as Partial<Record<string, { label: string; resumes: string }>>)[route]
    : undefined;
  if (!goes && !checkedBy) return null;
  return (
    <dl data-testid="turn-routing" className="grid min-w-0 gap-x-6 gap-y-1.5 sm:grid-cols-[auto_1fr]">
      {goes && (
        <div data-testid="turn-goes-to" className="contents">
          <dt className="text-meta text-ink-muted">Goes to</dt>
          <dd className="min-w-0 text-body text-ink">
            <span className="font-medium">{goes.label}</span> — {goes.resumes}.
          </dd>
        </div>
      )}
      {checkedBy && (
        <div data-testid="turn-checked-by" className="contents">
          <dt className="text-meta text-ink-muted">Checked by</dt>
          <dd className="min-w-0 text-body text-ink">{checkedBy}</dd>
        </div>
      )}
    </dl>
  );
}
