/**
 * Who was asked — how many cards this console has put in front of a person,
 * and since when (zero-touch-console phase 13, TRS-5).
 *
 * The audit found the "Permission needed" channel had carried nothing in 602
 * notifications on two consoles, and no screen could say whether that meant
 * nobody needed asking or nothing COULD ask. A count with the date it started
 * is that screen: "no card raised since" is a reading worth having either
 * way, and beside it the number the console answered by itself.
 */

import type { ApprovalCounts } from '@/data/api';
import { plural } from '@/lib/format';
import { RelativeTime } from '@/ui';
import { FactRows, InsightAnswer, InsightNote } from './parts';

export function ApprovalsPanel({ counts }: { counts: ApprovalCounts | undefined }) {
  if (!counts) {
    return (
      <p className="max-w-(--measure) text-body text-ink-muted">
        This console does not count the cards it raises yet: restart it onto a build from 5.0.0 on.
      </p>
    );
  }
  const since = counts.since.slice(0, 10);
  const last = counts.lastRaisedAt;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="insights-approvals">
      {/* The date kept whole: a phone broke it at its hyphen, "2026-" over "10-10". */}
      <InsightAnswer>
        {counts.raised === 0
          ? 'No card has been raised for a person since '
          : `${plural(counts.raised, 'card')} raised for a person since `}
        <span className="whitespace-nowrap">{since}</span>.
      </InsightAnswer>
      <FactRows
        facts={[
          {
            label: 'Raised for a person',
            value: String(counts.raised),
            hint: 'tool, gate and verification cards, and the ladder’s standing offers',
          },
          {
            label: 'Answered by auto-grant',
            value: String(counts.autoGranted),
            hint: 'asks the console answered itself under a standing setting; nobody was asked',
          },
          { label: 'Waiting now', value: String(counts.pending), hint: 'cards up at this moment' },
        ]}
      />
      <p className="text-meta text-ink-muted">
        Last raised{' '}
        {last ? (
          <>
            <RelativeTime at={last} className="text-ink" />, {last.slice(0, 16).replace('T', ' ')}
          </>
        ) : (
          <span className="text-ink">never</span>
        )}
      </p>
      {counts.raised === 0 && (
        <InsightNote>
          That is a reading, not a verdict: it is what a console that never needed a person looks like, and
          also what one that could not ask anybody looks like.
        </InsightNote>
      )}
    </div>
  );
}
