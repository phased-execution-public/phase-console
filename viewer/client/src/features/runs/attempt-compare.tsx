/**
 * Two attempts of one phase, side by side.
 *
 * A phase that took four boardings leaves four of everything in the journal
 * and one row on the page. The question afterwards is never "how many
 * attempts" — the run table already says four — it is **what was different
 * about the one that worked**, and answering it today means reading NDJSON.
 *
 * The comparison is by COMMAND, not by position: a §Verification that gained
 * or lost a command between attempts would otherwise line `npm test` up
 * against `npm run lint` and report both as flipped. A command present on one
 * side only flips to or from `absent`, which is a real change and usually the
 * interesting one — it is what a repaired §Verification looks like.
 *
 * Two numbers are allowed to be absent rather than zero. `costUsd` is `null`
 * when a boarding recorded no session (it parked at the gate, or died before
 * the CLI reported), and `$0.00` there would read as "this was free", which is
 * the one thing it certainly was not — the same posture `costUnknown` takes on
 * the record. Same for turns.
 */

import { useEffect, useState } from 'react';

import {
  Badge,
  Button,
  Empty,
  Sheet,
  SheetContent,
  Spinner,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
  fieldSurface,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { useAttempts } from '@/lib/queries';
import { phaseHref } from '@shared/routes.js';
import { duration, money } from '@/lib/format';
import type { AttemptComparison, AttemptSummary, VerificationFlip } from '@/lib/api';

/** A figure that may legitimately be unknown, never silently zero. */
function Figure({ value, render }: { value: number | null; render: (n: number) => string }) {
  return value === null ? (
    <span className="text-ink-faint" title="Nothing was recorded for this attempt — not the same as zero">
      not recorded
    </span>
  ) : (
    <span className="tabular-nums">{render(value)}</span>
  );
}

/**
 * Which way it moved, in a glyph as well as a hue.
 *
 * Colour was the ONLY thing saying "worse" here — WCAG 1.4.1, and the two
 * hues this uses (`--status-failed` against `--status-done`) are exactly the
 * pair the most common colour blindness collapses. The arrow carries the same
 * fact, and the title says it in words for anyone reading with their ears.
 */
function Delta({ value, render }: { value: number | null; render: (n: number) => string }) {
  if (value === null) return null;
  if (value === 0) return <span className="text-ink-faint"> (no change)</span>;
  const worse = value > 0;
  return (
    <span
      className={worse ? 'text-failed' : 'text-done'}
      title={worse ? 'more than before' : 'less than before'}
    >
      {' '}
      (<span aria-hidden>{worse ? '▲' : '▼'}</span>
      <span className="sr-only">{worse ? 'up ' : 'down '}</span>
      {render(Math.abs(value))})
    </span>
  );
}

const FLIP_TONE: Record<VerificationFlip['to'], 'ok' | 'bad' | 'neutral'> = {
  pass: 'ok',
  fail: 'bad',
  absent: 'neutral',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TR>
      <TH scope="row" className="whitespace-nowrap text-left align-top text-2xs font-normal text-ink-faint">
        {label}
      </TH>
      <TD className="align-top text-xs">{children}</TD>
    </TR>
  );
}

function Comparison({ diff }: { diff: AttemptComparison }) {
  const { verification } = diff;
  return (
    <div className="flex flex-col gap-3">
      {/* `scrolls={false}` on all three: this dialog's body is already the
          scroller (`SheetContent`/`DialogContent` since 3.0), and a scroll
          container inside a scroll container is two scrollbars for one
          gesture — the inner one swallows the flick that was meant to move
          the dialog. Every column here is either a label or a figure, so
          there is nothing to scroll to. */}
      {/* hand-rolled because: a label/value table, not a list of records —
          two columns, one row per fact, no identity to pin, nothing to fold and
          nothing a card rendering would add. `DataTable` describes many rows of
          one shape; this describes one row each of many shapes. */}
      <TableWrap scrolls={false}>
        <Table aria-label="What changed between the two attempts">
          <TBody>
            <Row label="outcome">
              <span className={diff.outcome.changed ? 'text-ink' : 'text-ink-faint'}>
                {diff.outcome.from} → <span className="font-medium">{diff.outcome.to}</span>
              </span>
            </Row>
            <Row label="model">
              {diff.model.changed ? (
                <>
                  {diff.model.from ?? 'unrecorded'} →{' '}
                  <span className="font-medium">{diff.model.to ?? 'unrecorded'}</span>
                </>
              ) : (
                <span className="text-ink-faint">{diff.model.to ?? 'unrecorded'} (unchanged)</span>
              )}
            </Row>
            <Row label="duration">
              <Figure value={diff.durationMs.from} render={duration} /> →{' '}
              <Figure value={diff.durationMs.to} render={duration} />
              <Delta value={diff.durationMs.deltaMs} render={duration} />
            </Row>
            <Row label="spend">
              <Figure value={diff.costUsd.from} render={money} /> →{' '}
              <Figure value={diff.costUsd.to} render={money} />
              <Delta value={diff.costUsd.deltaUsd} render={money} />
            </Row>
            <Row label="turns">
              <Figure value={diff.turns.from} render={String} /> →{' '}
              <Figure value={diff.turns.to} render={String} />
            </Row>
            <Row label="ladder rungs">
              {diff.rungs.from.length || diff.rungs.to.length ? (
                <>
                  {diff.rungs.from.join(', ') || 'none'} →{' '}
                  <span className="font-medium">{diff.rungs.to.join(', ') || 'none'}</span>
                </>
              ) : (
                <span className="text-ink-faint">neither attempt climbed a rung</span>
              )}
            </Row>
            <Row label="verification">
              {verification.from === null && verification.to === null ? (
                <span className="text-ink-faint">neither attempt reached verification</span>
              ) : (
                <>
                  {verification.from === null ? 'none' : verification.from ? 'passed' : 'failed'} →{' '}
                  <span className="font-medium">
                    {verification.to === null ? 'none' : verification.to ? 'passed' : 'failed'}
                  </span>
                </>
              )}
            </Row>
          </TBody>
        </Table>
      </TableWrap>

      <div>
        <h4 className="mb-1 text-2xs text-ink-faint">
          Per-command flips {verification.unchanged ? `· ${verification.unchanged} unchanged` : ''}
        </h4>
        {/* Inside a `max-w-2xl` dialog, so the command column is the only one
            that can give — declared tracks make it the one that does, instead
            of the whole table leaving the dialog sideways. */}
        {verification.flips.length ? (
          <TableWrap scrolls={false}>
            {/* `min-w-0` and declared tracks: the command column is the only
                one that can give, and it is the one that must — a phone's
                dialog is 358px wide and five columns of content-driven width
                would push it sideways. */}
            {/* hand-rolled because: it is the one table in this dialog with
                columns, and it lives beside two label/value tables that share
                its frame — a `DataTable` here would bring a card rendering,
                a fold affordance and an identity rail into a 358px dialog that
                already scrolls as one box.

                `w-20` below `sm`, not `w-14`. This column's whole vocabulary is
                `FLIP_TONE`'s three words, and the widest is `absent`: 53px of
                border box, with `--tile-pad-x` added on both sides by the cell.
                56px was a track four pixels narrower than the thing it
                held, and under `table-fixed` that does not widen the column, it
                escapes it — this dialog's own version of the 13px that cost the
                issues board its sticky header. And the two numeric columns are
                dropped below `sm` rather than squeezed: five columns do not fit
                a phone's dialog, and command-was-now is the sentence this table
                exists to say.

                Dropped from the ROW, not from the phone. `hidden` is
                `display: none`, so below `sm` the two columns simply were not
                there and nothing said so — a phone could see that a command's
                result changed and never what the exit code or the timing
                changed TO. `DataTable` folds a dropped column into the row's
                own detail and counts it ("a column that leaves without saying
                so is the whole defect this table was rebuilt for"); this
                hand-rolled sibling has no fold, so the two facts move onto a
                second line of the command cell, shown only where the columns
                are not. */}
            <Table fixed className="min-w-0" aria-label="Commands whose result changed">
              <THead>
                <TR>
                  <TH className="text-left">command</TH>
                  <TH className="w-20 text-left">was</TH>
                  <TH className="w-20 text-left">now</TH>
                  <TH className="hidden w-16 text-right sm:table-cell sm:w-24">exit</TH>
                  <TH className="hidden w-20 text-right sm:table-cell sm:w-28">time</TH>
                </TR>
              </THead>
              <TBody>
                {verification.flips.map((flip) => (
                  <TR key={flip.command}>
                    <TD className="font-mono text-2xs" title={flip.command}>
                      <span className="block truncate">{flip.command}</span>
                      <span className="mt-0.5 block text-ink-faint tabular-nums sm:hidden">
                        {`exit ${flip.fromCode ?? '—'} → ${flip.toCode ?? '—'} · ` +
                          `${flip.fromMs === null ? '—' : duration(flip.fromMs)} → ` +
                          `${flip.toMs === null ? '—' : duration(flip.toMs)}`}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={FLIP_TONE[flip.from]}>{flip.from}</Badge>
                    </TD>
                    <TD>
                      <Badge tone={FLIP_TONE[flip.to]}>{flip.to}</Badge>
                    </TD>
                    <TD className="hidden text-right font-mono text-2xs tabular-nums sm:table-cell">
                      {flip.fromCode ?? '—'} → {flip.toCode ?? '—'}
                    </TD>
                    <TD className="hidden text-right font-mono text-2xs tabular-nums sm:table-cell">
                      {flip.fromMs === null ? '—' : duration(flip.fromMs)} →{' '}
                      {flip.toMs === null ? '—' : duration(flip.toMs)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        ) : (
          <p className="text-2xs text-ink-faint">
            No command changed its result between these two attempts
            {verification.unchanged ? ` — all ${verification.unchanged} ran the same way.` : '.'}
          </p>
        )}
      </div>
    </div>
  );
}

/** One attempt's own facts, for a phase that has only been boarded once. */
function Single({ attempt }: { attempt: AttemptSummary }) {
  // hand-rolled because: a label/value table, not a list of records — see the
  // sibling above.
  return (
    <TableWrap scrolls={false}>
      <Table aria-label="What this attempt did">
        <TBody>
          <Row label="outcome">{attempt.outcome}</Row>
          <Row label="model">{attempt.model ?? 'unrecorded'}</Row>
          <Row label="duration">
            <Figure value={attempt.durationMs} render={duration} />
          </Row>
          <Row label="spend">
            <Figure value={attempt.costUsd} render={money} />
          </Row>
          <Row label="turns">
            <Figure value={attempt.turns} render={String} />
          </Row>
          <Row label="verification">
            {attempt.verification
              ? `${attempt.verification.ok ? 'passed' : 'failed'} · ${attempt.verification.ran.length} command(s)`
              : 'never reached verification'}
          </Row>
        </TBody>
      </Table>
    </TableWrap>
  );
}

export function AttemptCompare({
  slug,
  phase,
  runId,
  onClose,
}: {
  slug: string;
  /** `null` closes the drawer. */
  phase: number | null;
  runId?: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useAttempts(slug, phase ?? undefined, runId, phase !== null);
  const comparisons = data?.comparisons ?? [];
  // Default to the NEWEST pair: the question is almost always "what did the
  // last attempt do differently", not "what happened between one and two".
  const [pair, setPair] = useState(0);
  useEffect(() => {
    setPair(Math.max(0, comparisons.length - 1));
  }, [comparisons.length, phase]);
  const diff = comparisons[Math.min(pair, comparisons.length - 1)];

  return (
    <Sheet
      open={phase !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        showTitle
        title={phase === null ? 'Attempts' : `Phase ${phase} — attempt comparison`}
        description="Every figure is read from this run's journal. A boarding is one attempt; the inner session retries are counted separately."
        className="w-full max-w-2xl"
      >
        {isLoading ? (
          <Spinner />
        ) : !data || data.attempts.length === 0 ? (
          <Empty
            title="No attempts recorded"
            body="This phase has no boarding in the journal of the run being read. A phase that never started, or a run whose journal was rotated, both look like this."
            action={
              phase === null ? undefined : (
                <Button size="sm" variant="default" asChild>
                  <a href={phaseHref(slug, phase)}>Open phase {phase}</a>
                </Button>
              )
            }
          />
        ) : comparisons.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-ink-faint">
              One boarding, so there is nothing to compare yet. Here is what it did.
            </p>
            <Single attempt={data.attempts[0]!} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xs text-ink-faint">{data.attempts.length} attempts · comparing</span>
              <label className="sr-only" htmlFor="pe-attempt-pair">
                Which pair of attempts to compare
              </label>
              <select
                id="pe-attempt-pair"
                // The shared class, not a fifth hand-rolled look: it carries the
                // coarse-pointer thumb floor and the `min-w-0` that stops a
                // `<select>` from sizing to its widest option in a flex row.
                // Written out here, this control had neither — 22px tall on a
                // phone, inside a Sheet that is reachable on one.
                className={cn(fieldSurface, 'h-7 py-0 text-2xs')}
                value={Math.min(pair, comparisons.length - 1)}
                onChange={(event) => setPair(Number(event.target.value))}
              >
                {comparisons.map((option, i) => (
                  <option key={`${option.from}-${option.to}`} value={i}>
                    attempt {option.from} → {option.to}
                  </option>
                ))}
              </select>
            </div>
            {diff ? <Comparison diff={diff} /> : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default AttemptCompare;
