/**
 * Logs ▸ Access — who this console has served (control-tower phase 25).
 *
 * ```
 * Served since this process booted
 *   On this machine   1,204 requests
 *   Remotely          36 requests
 *   A phone last reached it   9 Oct, 21:14
 * Phones seen
 *   Host               Login (hashed)   First seen   Last seen   Requests
 * ```
 *
 * `state.access` counts every request by scope and remembers each phone login
 * that reached the console — hashed, never in clear — with when it was first
 * and last seen. It answers "has the phone path ever worked?", and since 7.0's
 * header carries no presence chip this is its only home.
 */

import { useConsoleState } from '@/data/console';
import type { ConsoleState } from '@/data/api';
import { Empty, KeyValue, Mono, SectionHeading, Skeleton } from '@/ui';
import type { Column } from '@/ui/grid/column';
import { Grid } from '@/ui/grid/grid';
import type { Route } from '@/shell/routes';

type Identity = NonNullable<ConsoleState['access']>['identities'][number];

/**
 * A count of requests, grouped like the Requests column below: a busy desk
 * serves tens of thousands, and "32825" has to be counted by eye.
 */
const requests = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'request' : 'requests'}`;

/** A moment as this reader's clock says it — or that it never happened. */
export function when(at: string | null | undefined): string {
  if (!at) return 'never';
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

const COLUMNS: Column<Identity>[] = [
  {
    id: 'host',
    head: 'Host',
    identity: true,
    flex: true,
    min: 160,
    priority: 1,
    card: 'title',
    cell: (row) => <span className="break-words">{row.host}</span>,
    value: (row) => row.host,
  },
  {
    id: 'login',
    head: 'Login (hashed)',
    min: 128,
    priority: 2,
    card: 'meta',
    cell: (row) => <Mono value={row.loginHash} chars={12} />,
    value: (row) => row.loginHash,
  },
  {
    id: 'first',
    head: 'First seen',
    min: 168,
    priority: 3,
    cell: (row) => when(row.first),
    value: (row) => row.first,
  },
  {
    id: 'last',
    head: 'Last seen',
    min: 168,
    priority: 1,
    cell: (row) => when(row.last),
    value: (row) => row.last,
  },
  {
    id: 'count',
    head: 'Requests',
    min: 88,
    priority: 2,
    align: 'end',
    cell: (row) => <span className="tnum">{row.count.toLocaleString()}</span>,
    value: (row) => row.count,
  },
];

export default function AccessSection(_props: { route: Route }) {
  const { data: state, isPending } = useConsoleState();
  if (isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Reading who this console served">
        <Skeleton className="h-20 max-w-md" />
      </div>
    );
  }
  const access = state?.access;
  if (!access) {
    return (
      <Empty title="This console does not report who it serves: an older server sends no access ledger. Restart it onto this build to count requests." />
    );
  }
  const identities = [...access.identities].sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
  return (
    <div className="flex min-w-0 flex-col divide-y divide-rule" data-testid="access">
      <section aria-labelledby="access-served" className="flex min-w-0 flex-col gap-3 pb-6">
        <SectionHeading id="access-served">Served since this process booted</SectionHeading>
        <KeyValue
          items={[
            ['On this machine', requests(access.served.local)],
            ['Remotely', requests(access.served.remote)],
            ['A phone last reached it', when(access.lastRemoteAt)],
          ]}
        />
      </section>
      <section aria-labelledby="access-phones" className="flex min-w-0 flex-col gap-3 pt-6">
        <SectionHeading id="access-phones">Phones seen</SectionHeading>
        {identities.length === 0 ? (
          <p className="text-body text-ink-muted">
            No phone has reached this console; only this machine has.
          </p>
        ) : (
          <Grid
            label="Phones seen"
            columns={COLUMNS}
            rows={identities}
            getRowKey={(identity) => `${identity.host}:${identity.loginHash}`}
            rowProps={() => ({ 'data-testid': 'access-identity' })}
          />
        )}
      </section>
    </div>
  );
}
