/**
 * Settings ▸ Permissions ▸ Grants (control-tower phase 138, #215; the engine
 * is phase 149's `server/permissions/grants.ts`).
 *
 * Every grant this console made, newest first: what it allowed, how far it
 * reaches, who gave it through which door, when, until when, the item that
 * asked for it, and exactly what it changed. A live grant ends with *Revoke*,
 * which undoes what its row says and nothing another live grant still holds;
 * *Revoke all* ends every one, asked once. Neither needs the owner key —
 * taking authority back is any person's door.
 *
 * The `granted` push opens this list AT its grant (`?grant=<id>`, from
 * `routeFor` in `server/push/catalogue.ts`): the row is marked current and
 * scrolled to.
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { GRANT_SCOPE_WORDS } from '@shared/turn-model.js';
import { useRoute } from '@/app/router';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ConfirmButton,
  PageError,
  RelativeTime,
  Skeleton,
  toast,
} from '@/components/ui';
import { OpsBadge } from '@/components/ui/status/ops-badge';
import { GRANTS_QUERY_KEY, permissionsApi, type GrantChange, type GrantRecord } from '@/lib/api/permissions';
import { cn } from '@/lib/cn';
import { keys } from '@/lib/queries';
import { scrollIntoScroller } from '@/lib/scroll';

/** Who pressed, as the row's door says it. */
const DOOR_WORDS: Readonly<Record<string, string>> = Object.freeze({
  owner: 'with the owner key',
  device: 'from a paired device',
  local: 'from this machine',
  session: 'from a session',
  supervisor: 'from the supervisor',
  checker: 'from a check',
  console: 'by the console',
});

/** An instant, said to the minute, in UTC — the same words the push and the resumed session use. */
export function minuteOf(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')}Z`;
}

/** One change a grant made, in words — what a revoke will undo. */
export function changeWords(change: GrantChange): string {
  switch (change.kind) {
    case 'hook':
      return `the hook lets it through for run ${change.runId} phase ${change.phase}${change.command ? ` (${change.command})` : ''}`;
    case 'settings':
      return `run ${change.runId}'s settings: ${change.list} ${change.rule}`;
    case 'policy':
      return `the ${change.layer} policy file: ${change.op} ${change.list} ${change.rule}`;
    default:
      return `${change.flag} in ${change.unit}, restarted when idle`;
  }
}

/** Until when a live grant holds, or how an ended one ended. */
function endWords(grant: GrantRecord): string {
  if (grant.state === 'live') {
    return grant.until ? `until ${minuteOf(grant.until)} at the latest` : 'until you revoke it';
  }
  const how = grant.state === 'spent' ? 'Used' : grant.state === 'expired' ? 'Expired' : 'Revoked';
  const when = grant.endedAt ? ` ${minuteOf(grant.endedAt)}` : '';
  const who = grant.endedBy ? ` by ${grant.endedBy}` : '';
  return `${how}${when}${who}${grant.endReason ? `: ${grant.endReason}` : ''}`;
}

function GrantRow({
  grant,
  focused,
  busy,
  onRevoke,
}: {
  grant: GrantRecord;
  focused: boolean;
  busy: boolean;
  onRevoke: () => void;
}) {
  const live = grant.state === 'live';
  return (
    <li
      id={`grant-${grant.id}`}
      data-testid="grant-row"
      data-grant={grant.id}
      data-state={grant.state}
      aria-current={focused ? 'true' : undefined}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 border-b border-rule py-3 last:border-b-0',
        focused && '-mx-2 rounded-md border-b-0 bg-action/6 px-2 outline-1 outline-action',
        !live && 'text-ink-muted',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <OpsBadge vocab="grant" word={grant.state} />
        <OpsBadge vocab="risk" word={grant.risk} />
        <code className={cn('min-w-0 font-mono text-xs break-all', live ? 'text-ink' : 'text-ink-muted')}>
          {grant.rule}
        </code>
        {live && (
          <Button
            size="sm"
            variant="danger"
            className="ms-auto min-h-(--tap-min)"
            disabled={busy}
            onClick={onRevoke}
          >
            Revoke
          </Button>
        )}
      </div>
      <p className="text-xs">
        For {GRANT_SCOPE_WORDS[grant.scope] ?? grant.scope} · granted by {grant.by}{' '}
        {grant.door ? (DOOR_WORDS[grant.door] ?? `through ${grant.door}`) : ''}{' '}
        <RelativeTime at={grant.at} className="text-ink-muted" />
        {grant.unkeyed ? ' · on the typed rule alone (no owner key)' : ''}
      </p>
      <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs">
        <span>{endWords(grant)}</span>
        {grant.slug && (
          <span>
            {grant.slug}
            {grant.phase != null ? ` phase ${grant.phase}` : ''}
            {grant.runId ? ` · run ${grant.runId}` : ''}
          </span>
        )}
        {grant.item ? (
          <a
            href={`#/turn/${encodeURIComponent(grant.item)}`}
            className="tap-row text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
          >
            the item that asked
          </a>
        ) : grant.card ? (
          <span>from an approval card</span>
        ) : null}
      </p>
      {grant.reason && <p className="text-xs">Why: {grant.reason}</p>}
      <p className="text-2xs text-ink-muted">
        Changed:{' '}
        {grant.changed.length ? grant.changed.map(changeWords).join('; ') : 'nothing — it was already so'}.
      </p>
    </li>
  );
}

export function GrantsCard() {
  const client = useQueryClient();
  const route = useRoute();
  const focus = route.query.grant ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const read = useQuery({
    queryKey: GRANTS_QUERY_KEY,
    queryFn: () => permissionsApi.grants(),
    retry: false,
    refetchOnMount: 'always',
  });
  const grants = read.data?.grants ?? [];
  const live = read.data?.live ?? grants.filter((grant) => grant.state === 'live').length;

  // The `granted` push lands here at its grant: scroll to it once it is drawn.
  const found = Boolean(focus && grants.some((grant) => grant.id === focus));
  useEffect(() => {
    if (!found || !focus) return;
    const row = document.getElementById(`grant-${focus}`);
    if (row) scrollIntoScroller(row, 'center');
  }, [found, focus]);

  async function settle(which: string, call: () => Promise<unknown>, said: string) {
    setBusy(which);
    try {
      await call();
      toast(said, 'ok');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'warn', 8000);
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: GRANTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: keys.inbox() });
    }
  }

  return (
    <Card className="lg:col-span-2" data-testid="grants-card">
      <CardHeader className="flex-wrap gap-2">
        <CardTitle id="grants">Grants</CardTitle>
        <span className="text-2xs text-ink-faint">{live} live</span>
        {live > 0 && (
          <ConfirmButton
            size="sm"
            variant="danger"
            className="ms-auto min-h-(--tap-min)"
            title={`Revoke all ${live} live grant${live === 1 ? '' : 's'}?`}
            description="Each grant's changes are undone — a rule a grant lowered is raised again, a strike is restored, a capability leaves the unit. A session that relied on one meets its wall again."
            destructive
            busy={busy === 'all'}
            onConfirm={() =>
              void settle(
                'all',
                () => permissionsApi.revokeAll(),
                'Revoked every live grant — what each changed is undone.',
              )
            }
          >
            Revoke all
          </ConfirmButton>
        )}
      </CardHeader>
      <CardBody className="flex flex-col gap-2">
        <p className="max-w-prose text-xs text-ink-muted">
          Every grant made on this console — what it allowed, how far, who gave it and how, and when it ends.
          Revoke undoes exactly what the grant changed.
        </p>
        {read.isLoading ? (
          <Skeleton className="h-20" />
        ) : read.isError ? (
          <PageError error={read.error} retry={() => void read.refetch()} />
        ) : grants.length === 0 ? (
          <p data-testid="grants-empty" className="max-w-prose text-xs text-ink">
            No grant yet. A grant is made on Your turn, from a permission item — one press, at the scope you
            choose.
          </p>
        ) : (
          <ul className="flex min-w-0 flex-col" aria-labelledby="grants">
            {grants.map((grant) => (
              <GrantRow
                key={grant.id}
                grant={grant}
                focused={grant.id === focus}
                busy={busy !== null}
                onRevoke={() =>
                  void settle(
                    grant.id,
                    () => permissionsApi.revoke(grant.id),
                    `Revoked ${grant.rule} — what it changed is undone.`,
                  )
                }
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
