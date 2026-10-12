/**
 * The pieces every Insights question is made of: the section, the one-line
 * answer, the facts beside it, a figure under its caption, and the note
 * Everything adds.
 *
 * Kept to four sizes (design.md §1, principle 6): the question is the
 * section's heading (15/600), the answer the body (14), a fact's label, a
 * caption and a note the meta size (12.5) — and a figure under its caption is
 * the one drawing a question gets.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { KeyValue, SectionHeading } from '@/ui';
import type { InsightFact } from './model';

/**
 * A link inside a sentence: kept on one line, because a link wrapped across
 * two at 360 puts its middle between the lines, where no tap lands.
 */
export const PROSE_LINK =
  'tap-line whitespace-nowrap text-ink underline decoration-ink-faint underline-offset-2';

/** One question: its heading, then its answer and figures. The page draws a hairline between questions. */
export function InsightSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const heading = `insights-${id}`;
  return (
    <section
      aria-labelledby={heading}
      data-insight={id}
      className="flex min-w-0 flex-col gap-4 py-6 first:pt-0"
    >
      <SectionHeading id={heading}>{title}</SectionHeading>
      {children}
    </section>
  );
}

/** The answer, in one sentence — what a person reads before deciding whether to read on. */
export function InsightAnswer({ children }: { children: ReactNode }) {
  return <p className="max-w-(--measure) text-body text-ink">{children}</p>;
}

/**
 * Counts on one line, each its label and its figure with a gap between
 * them — separate facts are separate words, never glued with dots. What a
 * figure is goes on hover, and on the line itself with Everything on.
 */
export function FactLine({
  facts,
  everything = false,
}: {
  facts: readonly InsightFact[];
  everything?: boolean;
}) {
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-meta text-ink-muted">
      {facts.map((fact) => (
        <span key={fact.label} {...(fact.hint ? { title: fact.hint } : {})}>
          {fact.label} <span className="tnum text-ink">{fact.value}</span>
          {everything && fact.hint ? `, ${fact.hint}` : null}
        </span>
      ))}
    </p>
  );
}

/** Figures as rows: the label, then the value with what it is beside it. */
export function FactRows({ facts }: { facts: readonly InsightFact[] }) {
  return (
    <KeyValue
      items={facts.map(
        (fact) =>
          [
            fact.label,
            <span key={fact.label} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="tnum">{fact.value}</span>
              {fact.hint ? <span className="text-meta text-ink-muted">{fact.hint}</span> : null}
            </span>,
          ] as const,
      )}
    />
  );
}

/** A figure under its caption — the caption names it, so a screen reader's outline does too. */
export function FigureBlock({
  caption,
  children,
  className,
}: {
  caption: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <h3 className="text-meta font-normal text-ink-muted">{caption}</h3>
      {children}
    </div>
  );
}

/** What a figure stands on, said — Everything's, since a glance is words and figures. */
export function InsightNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('max-w-(--measure) text-meta text-ink-muted', className)}>{children}</p>;
}
