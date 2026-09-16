/**
 * Who was asked — how many cards this console has put in front of a person,
 * and since when (zero-touch-console phase 13, TRS-5).
 *
 * The audit found the "Permission needed" channel had carried nothing in 602
 * notifications on two consoles, and no screen could say whether that meant
 * nobody needed asking or nothing COULD ask. A count with the date it started
 * is that screen: "no card raised since" is a reading worth having either way,
 * and beside it the number the console answered by itself.
 */

import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
import type { ApprovalCounts } from '@/lib/api';
import { relativeTime } from '@/lib/format';

export function ApprovalsPanel({ counts }: { counts: ApprovalCounts | undefined }) {
  if (!counts) {
    return (
      <p className="text-2xs text-ink-faint">
        This console does not count the cards it raises yet — restart it onto a build from 5.0.0 on.
      </p>
    );
  }
  const since = counts.since.slice(0, 10);
  const rows: { label: string; value: string; reading: string }[] = [
    {
      label: 'Raised for a person',
      value: String(counts.raised),
      reading: 'Tool, gate and verification cards, and the ladder’s standing offers.',
    },
    {
      label: 'Answered by auto-grant',
      value: String(counts.autoGranted),
      reading: 'Asks the console answered itself under a standing setting — nobody was asked.',
    },
    { label: 'Waiting now', value: String(counts.pending), reading: 'Cards up at this moment.' },
    {
      label: 'Last raised',
      value: counts.lastRaisedAt ? relativeTime(Date.parse(counts.lastRaisedAt)) : 'never',
      reading: counts.lastRaisedAt
        ? counts.lastRaisedAt.slice(0, 16).replace('T', ' ')
        : `Nothing since ${since}.`,
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cards raised</CardTitle>
        <span className="text-2xs text-ink-faint">since {since}</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <dl className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-4">
          {rows.map((row) => (
            <div key={row.label} className="min-w-0">
              <dt className="text-2xs text-ink-faint">{row.label}</dt>
              <dd className="tnum text-lg text-ink">{row.value}</dd>
              <dd className="text-2xs text-ink-muted">{row.reading}</dd>
            </div>
          ))}
        </dl>
        {counts.raised === 0 ? (
          <p className="text-2xs text-ink-muted">
            No card has been raised since {since}. That is a reading, not a verdict: it is what a console that
            never needed a person looks like, and also what one that could not ask anybody looks like.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
