/**
 * Grants — every grant this console made, and taking each one back (7.0,
 * quiet-console phase 22; control-tower phase 138, #215, over phase 149's
 * engine, `server/permissions/grants.ts`). Drawn inside Settings ▸ Permissions.
 *
 * ```
 * Grants                                                   2 live   [Revoke all]
 * ● Live   ● High risk   Bash(npm publish:*)                          [Revoke]
 * For this plan. Granted by mobin from this machine, 3 hours ago.
 * Until 2026-10-12 08:00Z at the latest   quiet-console phase 32   The item that asked
 * Changed: run a0de94f2’s settings: allow Bash(npm publish:*).
 * ```
 *
 * Newest first: what it allowed, how far it reaches, who gave it through
 * which door and when, until when, the item that asked, and exactly what it
 * changed. A live grant ends with Revoke, which undoes what its row says and
 * nothing another live grant still holds; Revoke all ends every one, asked
 * once. Each takes a reason, kept on the row and in the journal — "why was
 * this taken back" is the question the row is read for a week later. Neither
 * needs the owner key: taking authority back is any person's door.
 *
 * The `granted` push opens this list AT its grant (`?grant=<id>`, `routeFor`
 * in `server/push/catalogue.ts`): the row is marked current and scrolled to.
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GRANT_SCOPE_WORDS } from '@shared/turn-model.js';
import { keys } from '@/data/keys';
import { GRANTS_QUERY_KEY, useGrants, type GrantChange, type GrantRecord } from '@/data/permissions';
import type { Pressed } from '@/data/press';
import { revokeAll, revokeGrant } from '@/data/turn';
import { scrollIntoScroller } from '@/lib/scroll';
import { useRoute } from '@/shell/router';
import { turnHref } from '@/shell/routes';
import { Banner, Button, Input, Mono, RelativeTime, Skeleton, toast } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { OpsStatus } from '@/ui/status';
import { SettingsGroup, failureWords } from './setting';

/** Who pressed, as a grant's door says it. */
const DOOR_WORDS: Readonly<Record<string, string>> = Object.freeze({
  owner: 'with the owner key',
  device: 'from a paired device',
  local: 'from this machine',
  session: 'from a session',
  supervisor: 'from the supervisor',
  checker: 'from a check',
  console: 'by the console',
});

/** An instant to the minute, in UTC — the words the push and the resumed session use. */
export function grantMinute(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')}Z`;
}

/** One change a grant made, in words — what a revoke undoes. */
export function grantChangeWords(change: GrantChange): string {
  switch (change.kind) {
    case 'hook':
      return `the hook lets it through for run ${change.runId} phase ${change.phase}${change.command ? ` (${change.command})` : ''}`;
    case 'settings':
      return `run ${change.runId}’s settings: ${change.list} ${change.rule}`;
    case 'policy':
      return `the ${change.layer} policy file: ${change.op} ${change.list} ${change.rule}`;
    default:
      return `${change.flag} in ${change.unit}, restarted when idle`;
  }
}

/** Until when a live grant holds, or how an ended one ended — with the reason it was ended for. */
export function grantEndWords(grant: GrantRecord): string {
  if (grant.state === 'live') {
    return grant.until ? `Until ${grantMinute(grant.until)} at the latest` : 'Until you revoke it';
  }
  const how = grant.state === 'spent' ? 'Used' : grant.state === 'expired' ? 'Expired' : 'Revoked';
  const when = grant.endedAt ? ` ${grantMinute(grant.endedAt)}` : '';
  const who = grant.endedBy ? ` by ${grant.endedBy}` : '';
  return `${how}${when}${who}${grant.endReason ? `: ${grant.endReason}` : ''}`;
}

/** The reason field a revoke's question carries — optional, and never a secret (the server refuses one). */
function ReasonField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
      Why — kept on the grant’s row and in the journal
      <Input
        aria-label={label}
        value={value}
        placeholder="optional"
        className="w-full"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function GrantItem({
  grant,
  focused,
  busy,
  onRevoke,
}: {
  grant: GrantRecord;
  focused: boolean;
  busy: boolean;
  onRevoke: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const live = grant.state === 'live';
  return (
    <li
      id={`grant-${grant.id}`}
      data-testid="grant-row"
      data-grant={grant.id}
      data-state={grant.state}
      aria-current={focused ? 'true' : undefined}
      className={
        focused
          ? 'flex min-w-0 flex-col gap-1.5 rounded-sm border-s-2 border-action ps-3 pt-1'
          : 'flex min-w-0 flex-col gap-1.5 border-t border-rule pt-3 first:border-t-0 first:pt-0'
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <OpsStatus vocab="grant" word={grant.state} />
        <OpsStatus vocab="risk" word={grant.risk} />
        <Mono
          value={grant.rule}
          className={live ? 'min-w-0 wrap-anywhere text-ink' : 'min-w-0 wrap-anywhere'}
        />
        {live && (
          <ConfirmButton
            size="sm"
            variant="ghost"
            destructive
            className="ms-auto"
            busy={busy}
            title={`Revoke ${grant.rule}?`}
            description="What this grant changed is undone, and nothing another live grant still holds. A session that relied on it meets its wall again."
            details={
              <ReasonField value={reason} onChange={setReason} label={`Why ${grant.rule} is revoked`} />
            }
            onConfirm={() => onRevoke(reason.trim())}
          >
            Revoke
          </ConfirmButton>
        )}
      </div>
      <p className="max-w-(--measure) text-body">
        For {GRANT_SCOPE_WORDS[grant.scope] ?? grant.scope}. Granted by {grant.by}
        {grant.door ? ` ${DOOR_WORDS[grant.door] ?? `through ${grant.door}`}` : ''},{' '}
        <RelativeTime at={grant.at} live={false} />
        {grant.unkeyed ? ', on the typed rule alone (no owner key)' : ''}.
      </p>
      <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-meta text-ink-muted">
        <span data-testid="grant-end">{grantEndWords(grant)}</span>
        {grant.slug && (
          <span>
            {grant.slug}
            {grant.phase != null ? ` phase ${grant.phase}` : ''}
            {grant.runId ? `, run ${grant.runId}` : ''}
          </span>
        )}
        {grant.item ? (
          <a
            href={turnHref(grant.item)}
            className="tap-line text-ink underline decoration-ink-faint underline-offset-2 hover:decoration-ink"
          >
            The item that asked
          </a>
        ) : grant.card ? (
          <span>From an approval card</span>
        ) : null}
      </p>
      {grant.reason && (
        <p className="max-w-(--measure) text-meta text-ink-muted">Why it was granted: {grant.reason}</p>
      )}
      <p className="max-w-(--measure) text-meta text-ink-muted">
        Changed:{' '}
        {grant.changed.length
          ? grant.changed.map(grantChangeWords).join('; ')
          : 'nothing — it was already so'}
        .
      </p>
    </li>
  );
}

export function GrantsGroup() {
  const client = useQueryClient();
  const route = useRoute();
  const focus = route.query.grant ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [reasonAll, setReasonAll] = useState('');
  const read = useGrants();
  const grants = read.data?.grants ?? [];
  const live = read.data?.live ?? grants.filter((grant) => grant.state === 'live').length;

  // The `granted` push lands here at its grant: scroll to it once it is drawn.
  const found = Boolean(focus && grants.some((grant) => grant.id === focus));
  useEffect(() => {
    if (!found || !focus) return;
    const row = document.getElementById(`grant-${focus}`);
    if (row) scrollIntoScroller(row, 'center');
  }, [found, focus]);

  async function settle<T>(which: string, call: () => Promise<Pressed<T>>, said: string) {
    setBusy(which);
    try {
      const pressed = await call();
      if (pressed.state === 'asked') toast(pressed.words, 'info', 6000);
      else toast(said, 'ok');
    } catch (cause) {
      toast(failureWords(cause), 'warn', 8000);
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: GRANTS_QUERY_KEY });
      void client.invalidateQueries({ queryKey: keys.inbox() });
    }
  }

  return (
    <SettingsGroup
      id="grants"
      title="Grants"
      lead="Every grant made on this console — what it allowed, how far, who gave it and how, and when it ends. Revoke undoes exactly what the grant changed."
      aside={
        read.data ? (
          <span className="flex items-center gap-3">
            <span className="text-meta text-ink-muted">{live} live</span>
            {live > 0 && (
              <ConfirmButton
                size="sm"
                variant="ghost"
                destructive
                busy={busy === 'all'}
                title={`Revoke all ${live} live grant${live === 1 ? '' : 's'}?`}
                description="Each grant’s changes are undone — a rule a grant lowered is raised again, a strike is restored, a capability leaves the unit. A session that relied on one meets its wall again."
                details={
                  <ReasonField
                    value={reasonAll}
                    onChange={setReasonAll}
                    label="Why every live grant is revoked"
                  />
                }
                onConfirm={() => {
                  const reason = reasonAll.trim();
                  setReasonAll('');
                  void settle(
                    'all',
                    () => revokeAll(reason ? { reason } : {}),
                    'Revoked every live grant — what each changed is undone.',
                  );
                }}
              >
                Revoke all
              </ConfirmButton>
            )}
          </span>
        ) : undefined
      }
    >
      {read.isPending ? (
        <Skeleton className="h-20" aria-busy="true" aria-label="Reading the grants" />
      ) : read.isError ? (
        <Banner
          severity="error"
          action={
            <Button size="sm" onClick={() => void read.refetch()}>
              Try again
            </Button>
          }
        >
          {failureWords(read.error)}
        </Banner>
      ) : grants.length === 0 ? (
        <p data-testid="grants-empty" className="max-w-(--measure) text-body text-ink-muted">
          No grant yet. A grant is made on Your turn, from a permission item — one press, at the scope you
          choose.
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-3" aria-label="Every grant" data-testid="grants">
          {grants.map((grant) => (
            <GrantItem
              key={grant.id}
              grant={grant}
              focused={grant.id === focus}
              busy={busy !== null}
              onRevoke={(reason) =>
                void settle(
                  grant.id,
                  () => revokeGrant(grant.id, reason ? { reason } : {}),
                  `Revoked ${grant.rule} — what it changed is undone.`,
                )
              }
            />
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}
