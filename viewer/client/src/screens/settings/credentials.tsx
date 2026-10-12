/**
 * Settings ▸ Accounts, what this machine holds — every credential an open
 * plan names, and the CLI's own two, held or not (`GET /api/credentials`).
 *
 * ```
 * What this machine holds                              [Check every credential again]
 * Read 2 minutes ago. An answer is reused for a minute; Check again asks past it.
 * ● OK         gh               gh auth status exits 0             [Check again] ▾
 * ● Fail       env:STRIPE_KEY   the variable is not set            [Check again] ▾
 *     Reason     the variable is not set in the console's environment
 *     Kind       the console knows how to ask about an id like this
 *     Named by   alpha, alpha P3
 * ```
 *
 * A word and a reason per id, never a value: the probe that checks a token is
 * there must not become the thing that prints it, and the server sends none.
 * Asking is a read — `gh`, the keychain, the environment, a file's presence —
 * so it needs no capability flag. Check again asks past the server's
 * minute-long cache, for one id (`ids: [id]`) or for every one (no ids).
 */

import { Fragment } from 'react';
import { useCredentialProbe, useCredentials, type HeldCredential } from '@/data/machine';
import { phaseHref, planHref } from '@/shell/routes';
import { Button, KeyValue, Mono, RelativeTime, Row, Skeleton, toast } from '@/ui';
import { OpsStatus } from '@/ui/status';
import { SettingsGroup } from './setting';

const LINK = 'tap-line text-ink underline decoration-ink-faint underline-offset-2 hover:decoration-ink';

/** Where an open plan names the id: its own `Credentials:` line, or a phase's bullet. */
function NamedBy({ named }: { named: HeldCredential['named'] }) {
  if (!named.length) return <>No open plan names it; it is one of the CLI’s own.</>;
  return (
    <span className="min-w-0">
      {named.map((where, index) => (
        <Fragment key={`${where.slug}:${where.phase ?? ''}`}>
          {index > 0 && ', '}
          {where.phase === undefined ? (
            <a href={planHref(where.slug)} className={LINK}>
              {where.slug}
            </a>
          ) : (
            <a href={phaseHref(where.slug, where.phase)} className={LINK}>
              {where.slug} P{where.phase}
            </a>
          )}
        </Fragment>
      ))}
    </span>
  );
}

export function CredentialsGroup() {
  const { data, error, isFetching, refetch } = useCredentials();
  const probe = useCredentialProbe();
  const asked = probe.variables?.ids;
  /** Whether the probe in flight is for this id — or, with none named, for every one. */
  const checking = (id?: string): boolean =>
    probe.isPending && (id === undefined ? !asked?.length : asked?.includes(id) === true);
  const check = (ids?: string[]) =>
    probe.mutate(ids ? { ids } : {}, {
      onError: (failure) => toast(`The check could not run: ${failure.message}`, 'error'),
    });

  return (
    <SettingsGroup
      id="credentials"
      title="What this machine holds"
      lead="Each credential an open plan names, and the CLI’s own two: held or not, never a value."
      aside={
        data && data.credentials.length > 0 ? (
          <Button size="sm" variant="ghost" disabled={probe.isPending} onClick={() => check()}>
            {checking() ? 'Checking…' : 'Check every credential again'}
          </Button>
        ) : undefined
      }
    >
      {error ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <p className="max-w-(--measure) text-body text-ink-muted">
            What this machine holds could not be read: {error.message || 'the read failed and said nothing.'}
          </p>
          <Button size="sm" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : !data ? (
        <Skeleton className="h-24" aria-busy="true" aria-label="Reading what this machine holds" />
      ) : !data.credentials.length ? (
        <p className="text-body text-ink-muted">
          No plan names a credential, and the CLI’s own were not asked.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="credentials-read">
            Read <RelativeTime at={data.at} />. An answer is reused for a minute; Check again asks past it.
          </p>
          <div className="flex min-w-0 flex-col gap-1" data-testid="credential-list">
            {data.credentials.map((credential) => (
              <Row
                key={credential.id}
                data-credential={credential.id}
                mark={<OpsStatus vocab="probe" word={credential.status} />}
                name={<Mono value={credential.id} className="text-body text-ink" />}
                fact={credential.reason}
                action={
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={probe.isPending}
                    onClick={() => check([credential.id])}
                  >
                    {checking(credential.id) ? 'Checking…' : 'Check again'}
                  </Button>
                }
                expandLabel={`details of ${credential.id}`}
              >
                <div className="pb-2">
                  <KeyValue
                    items={[
                      ['Reason', credential.reason],
                      [
                        'Kind',
                        credential.known
                          ? 'The console knows how to ask about an id like this.'
                          : 'No probe here knows an id like this, so it is never asked.',
                      ],
                      ['Named by', <NamedBy key="named" named={credential.named} />],
                    ]}
                  />
                </div>
              </Row>
            ))}
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
