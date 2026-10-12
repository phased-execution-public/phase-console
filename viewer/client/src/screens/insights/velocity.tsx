/**
 * How fast — how quickly phases have actually been landing, and on which days.
 *
 * One number and two figures answering one question from two sides. The
 * median gap between one phase and the next is the answer, and the number
 * that makes both figures readable: a week of 5 means something different at
 * a one-day median than at a nine-day one. The weekly bars are the trend (is
 * this speeding up), the calendar the texture (steady, or four phases on one
 * Saturday and nothing for a fortnight).
 *
 * The weeks are the server's buckets, drawn as sent (`./model`); nothing here
 * re-buckets the calendar into weeks or counts a week of its own.
 */

import type { Portfolio } from '@/data/api';
import { runsBayHref } from '@/shell/routes';
import { Button, Empty } from '@/ui';
import { Bars, Calendar } from '@/ui/figures/lazy';
import { velocityReading } from './model';
import { FigureBlock, InsightAnswer } from './parts';

export function VelocityPanel({ stats }: { stats: Portfolio }) {
  const reading = velocityReading(stats);
  const answer = reading.gap ? (
    <InsightAnswer>
      {reading.gap === 'the same day'
        ? 'At the median, a phase lands the same day as the one before it.'
        : `At the median, a phase lands ${reading.gap} after the one before it.`}
    </InsightAnswer>
  ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="insights-velocity">
      {answer}
      {reading.empty ? (
        <Empty
          title="No phase has landed in 26 weeks; a handoff marked complete is what draws a bar here."
          action={
            <Button size="sm" asChild>
              <a href={runsBayHref('ready')}>See what could start</a>
            </Button>
          }
        />
      ) : (
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          <FigureBlock
            caption={
              reading.from && reading.to
                ? `Phases completed per week, ${reading.from} to ${reading.to}`
                : 'Phases completed per week'
            }
          >
            <Bars data={reading.weeks} label="phases" />
          </FigureBlock>
          <FigureBlock caption="Completions by day, darker is more">
            <Calendar data={reading.calendar} />
          </FigureBlock>
        </div>
      )}
    </div>
  );
}
