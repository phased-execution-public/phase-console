/**
 * Access — who this console has served (control-tower phase 25).
 *
 * `state.access` has counted every request by scope since the fleet work
 * (FLT-10), and remembered each phone login that reached it — hashed, never in
 * clear — with when it was first and last seen. It answered "has the phone path
 * ever worked?" for anyone who read the JSON, and for nobody else. The header's
 * presence chip opens here.
 */

import { Users } from 'lucide-react';

import type { ViewProps } from '@/app/router';
import { Card, CardBody, CardHeader, CardTitle, Empty, KeyValue, Spinner } from '@/components/ui';
import { DataTable, type Column } from '@/components/data-table';
import type { ConsoleState } from '@/lib/api';
import { useConsoleState } from '@/lib/queries';

type Identity = NonNullable<ConsoleState['access']>['identities'][number];

const COLUMNS: Column<Identity>[] = [
  {
    id: 'host',
    head: 'Host',
    priority: 1,
    min: 140,
    flex: true,
    identity: true,
    card: 'title',
    cell: (row) => row.host,
  },
  {
    id: 'login',
    head: 'Login (hashed)',
    priority: 2,
    min: 120,
    cell: (row) => <span className="font-mono">{row.loginHash.slice(0, 12)}</span>,
  },
  { id: 'first', head: 'First seen', priority: 3, min: 150, cell: (row) => when(row.first) },
  { id: 'last', head: 'Last seen', priority: 1, min: 150, cell: (row) => when(row.last) },
  { id: 'count', head: 'Requests', priority: 2, min: 80, align: 'end', cell: (row) => row.count },
];

function when(at: string | null | undefined): string {
  if (!at) return 'never';
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

export default function AccessSection(_props: { route: ViewProps['route'] }) {
  const { data: state, isPending } = useConsoleState();
  if (isPending)
    return (
      <div className="grid place-items-center py-16">
        <Spinner />
      </div>
    );
  const access = state?.access;
  if (!access)
    return (
      <Empty
        icon={<Users size={20} aria-hidden />}
        title="This console does not report who it serves"
        body="An older server sends no access ledger. Restart onto this build to count requests by scope."
      />
    );
  const identities = [...access.identities].sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
  return (
    <div className="flex flex-col gap-3" data-testid="access">
      <Card>
        <CardHeader>
          <CardTitle>Served since this process booted</CardTitle>
        </CardHeader>
        <CardBody>
          <KeyValue
            items={[
              ['On this machine', `${access.served.local} request${access.served.local === 1 ? '' : 's'}`],
              ['Remotely', `${access.served.remote} request${access.served.remote === 1 ? '' : 's'}`],
              ['A phone last reached it', when(access.lastRemoteAt)],
            ]}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Phones seen</CardTitle>
        </CardHeader>
        <CardBody>
          {identities.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No phone has reached this console. Only this machine has been served.
            </p>
          ) : (
            <DataTable
              label="Phones seen"
              columns={COLUMNS}
              rows={identities}
              getRowKey={(identity) => `${identity.host}:${identity.loginHash}`}
              rowProps={() => ({ 'data-testid': 'access-identity' })}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
