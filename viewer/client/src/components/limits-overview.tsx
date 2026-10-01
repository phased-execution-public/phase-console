/**
 * The usage dialog's body, and Settings ▸ Accounts' meters: every account ×
 * every window, with resets and staleness, what each account is now, and the
 * duplicate-identity banner's action (control-tower phases 13, 25, 92).
 *
 * Its own module since phase 25: the header's usage button is first paint,
 * this is behind a press, and first paint is held to its budget — so the
 * widget lazy-loads it and Settings imports it directly.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys, useAccounts, useConsoleState } from '@/lib/queries';
import { api } from '@/lib/api';
import type { AccountView } from '@/lib/api';
import { countdown, relativeTime } from '@/lib/format';
import { Banner, Button, Badge, ConfirmButton, Empty, toast } from '@/components/ui';
import { RefreshMeters } from '@/components/refresh-meters';
import { AccountRepair, needsRepair } from '@/components/account-repair';
import { RetirementEvidence } from '@/components/retirement-evidence';
import { planHref } from '@shared/routes.js';
import { Meter, accountName, bucketLabel } from './limits-widget';

/** Every account × every bucket, with resets and staleness. Reused by Settings. */
/**
 * Registered accounts that are really the SAME Claude identity.
 *
 * Two entries pointing at one login look like failover and are not: their
 * windows are the same windows, so `onLimit: 'switch'` moves a run onto the
 * wall it just hit, and `auto` picks between two identical scores. It happens
 * for an ordinary reason — signing the machine's own `claude` login in as the
 * account you also registered as a profile — and nothing in the console said
 * so, because each entry reads correctly on its own.
 *
 * Matched on email, which is the only identity the usage endpoint gives us.
 */
function duplicateIdentities(accounts: AccountView[]): { email: string; ids: string[] }[] {
  const byEmail = new Map<string, string[]>();
  for (const account of accounts) {
    const email = account.email?.trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, [...(byEmail.get(email) ?? []), account.id]);
  }
  return [...byEmail.entries()].filter(([, ids]) => ids.length > 1).map(([email, ids]) => ({ email, ids }));
}

export function LimitsOverview({
  accounts,
  repair = true,
}: {
  accounts: AccountView[] | undefined;
  /** The repair verbs beside each diagnosis — off where the host already offers them per row. */
  repair?: boolean;
}) {
  // The mute renders even with nothing to meter. A console with no REGISTERED
  // account still runs work as the default one, and still announces when that
  // hits a window — so "no accounts to meter yet" must not be a page with no
  // way to switch those announcements off.
  if (!accounts?.length) {
    return (
      <div className="flex flex-col gap-4">
        <Empty title="No accounts to meter yet" />
        <RefreshMeters />
        <UsageAlerts />
      </div>
    );
  }
  const duplicates = duplicateIdentities(accounts);
  return (
    <div className="flex flex-col gap-4">
      {duplicates.map(({ email, ids }) => (
        <Banner key={email} severity="warn" data-testid="duplicate-identity">
          <span>
            <strong>{ids.join(' and ')}</strong> are the same Claude account ({email}). They share one set of
            windows, so switching between them buys no headroom — a run set to{' '}
            <code className="font-mono">switch</code> at a limit will move onto the wall it just hit. For real
            failover, register a second account with a different login.
          </span>
          <DuplicateAction accounts={accounts.filter((account) => ids.includes(account.id))} />
        </Banner>
      ))}
      {/* The numbers below are polled on a courtesy budget — up to ten minutes
          old on an idle account. One press re-reads every one of them. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-2xs text-ink-faint">
          Polled on a budget: ~90s while a session is running, ten minutes when idle.
        </span>
        <RefreshMeters />
      </div>
      {accounts.map((account) => {
        const buckets = Object.entries(account.usage?.buckets ?? {});
        const fetched = account.usage?.fetchedAt ? Date.parse(account.usage.fetchedAt) : undefined;
        return (
          <section key={account.id} className="flex flex-col gap-2">
            <header className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{accountName(account)}</span>
              {/* The email everywhere (#33): a named account's name says whose
                  it is to the person who named it, and nobody else. */}
              {account.email && account.email !== accountName(account) ? (
                <span className="text-xs text-ink-muted">{account.email}</span>
              ) : null}
              {account.paying?.length ? (
                <Badge data-testid="paying">{`pays for ${account.paying.map((p) => p.slug).join(', ')}`}</Badge>
              ) : null}
              {account.plan ? <Badge>{account.plan}</Badge> : null}
              {account.kind === 'token' ? <Badge>token</Badge> : null}
              {account.kind === 'profile' && account.signedIn === false ? <Badge>not signed in</Badge> : null}
              {account.authState === 'expired' ? <Badge tone="bad">login expired</Badge> : null}
              {account.authState === 'signed-out' && account.signedIn !== false ? (
                <Badge tone="bad">signed out</Badge>
              ) : null}
              {fetched !== undefined ? (
                <span className="text-2xs text-ink-faint">as of {relativeTime(fetched)}</span>
              ) : null}
              {/* The repair beside the diagnosis (phase 13, #33): re-reading
                  the numbers of a broken login is the one thing that cannot help. */}
              {repair && needsRepair(account) ? <AccountRepair account={account} /> : null}
              <RefreshMeters accountId={account.id} variant="ghost" className="ml-auto" />
            </header>
            <AccountFacts account={account} />
            {account.usage?.unsupported ? (
              <p className="text-xs text-ink-muted">
                The usage endpoint does not serve this credential — limits are learned when a run hits one.
              </p>
            ) : buckets.length ? (
              buckets.map(([key, bucket]) => (
                /* The label takes its own line on a phone. Four `shrink-0`
                   boxes — a 160px label, 36px of percentage and an 80px
                   countdown — left the one `flex-1` element in the row with
                   about two pixels at 360: a meter rendered as a sliver, on the
                   screen where the number matters most. `flex-wrap` and a floor
                   on the bar make the bar the last thing to give rather than
                   the first. */
                <div key={key} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="w-full shrink-0 truncate text-ink-muted sm:w-40">{bucketLabel(key)}</span>
                  <Meter pct={bucket.utilization} className="min-w-24 flex-1" />
                  <span className="w-9 shrink-0 text-right">{Math.round(bucket.utilization)}%</span>
                  <span
                    className="w-20 shrink-0 truncate text-right text-ink-faint"
                    title={new Date(bucket.resetsAt).toLocaleString()}
                  >
                    {countdown(Date.parse(bucket.resetsAt)) || '—'}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-xs text-ink-faint">
                No usage data{account.usage?.error ? ` — ${account.usage.error}` : ' yet'}.
              </p>
            )}
            {Object.entries(account.limitedUntil ?? {}).map(([bucket, iso]) => (
              <p key={bucket} className="text-xs font-medium text-ink-muted">
                Hit its {bucketLabel(bucket).toLowerCase()} limit —{' '}
                {countdown(Date.parse(iso)) || 'reset due'} (
                {new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).
              </p>
            ))}
          </section>
        );
      })}

      <UsageAlerts />
    </div>
  );
}

/**
 * The mute, put where the noise is.
 *
 * The switch itself is not new — `notify.limits` has always been one of the
 * eleven categories on Notifications ▸ Settings, and the server gates on it
 * before the inbox record, the live event, `PHASE_CONSOLE_NOTIFY` and push
 * alike. What was missing is that nobody forms the intention "stop telling me
 * about usage" while reading a list of notification categories. They form it
 * looking at the meter that just buzzed them, which is here.
 *
 * So this is the same preference, written from the place the irritation
 * happens. It reads server state rather than keeping its own, because a
 * preference that governs a server process has to render what that process
 * holds — a local copy would show the operator their intention instead of the
 * setting.
 *
 * It says what stays audible, deliberately. The category also carries a run
 * that parked waiting for a window, an account that could not sign in, and a
 * run refused before it started — silence about those looks exactly like a
 * console that has stopped working.
 */
function UsageAlerts() {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const on = state?.prefs?.notify?.limits !== false;

  const save = useMutation({
    // A delta, not the whole map: the server merges it over what is stored, so
    // two tabs toggling different categories do not overwrite each other.
    mutationFn: (next: boolean) => api.savePrefs({ notify: { limits: next } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.state() });
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  if (!state) return null;

  return (
    <div className="flex flex-col gap-1.5 border-t border-rule pt-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Usage alerts</span>
        <Button
          size="sm"
          variant={on ? 'ghost' : 'default'}
          disabled={save.isPending}
          aria-pressed={on}
          onClick={() => save.mutate(!on)}
        >
          {on ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
      <p className="text-2xs text-ink-faint">
        {on
          ? 'The console announces a window that was hit, a run that parked waiting for one to ' +
            'reopen, and an account that could not sign in. Turning this off silences all of ' +
            'them everywhere — inbox, push and any notify command. The meters above keep ' +
            'updating, and the early "usage climbing" warning has its own switch under ' +
            'Notifications (off unless you turn it on).'
          : 'Silenced everywhere — inbox, push and any notify command. Runs still wait, switch ' +
            'account or pause as you asked; they just do it without telling you. The meters ' +
            'above keep updating.'}
      </p>
    </div>
  );
}

/**
 * What an account IS now, under its bars (phase 25): the identity the id
 * resolves to this minute (a re-login can change it — phase 91), where its
 * burn walls it and which runs are burning it (phase 92), and a retirement's
 * evidence with the read that contradicted it (phase 54).
 */
function AccountFacts({ account }: { account: AccountView }) {
  const forecast = account.forecast;
  const walls = forecast?.wallsAt
    ? new Date(forecast.wallsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <div className="flex flex-col gap-0.5">
      {account.email ? (
        <p className="text-2xs text-ink-faint" data-testid="identity">
          {`Resolves to ${account.email}${account.org ? ` · ${account.org}` : ''} now.`}
        </p>
      ) : null}
      {walls ? (
        <p className="text-2xs text-ink-muted" data-testid="forecast-walls">
          {`At this burn the ${forecast?.bucket ? bucketLabel(forecast.bucket) : 'first'} window walls ≈${walls}.`}
        </p>
      ) : null}
      {forecast?.burning?.length ? (
        <p className="text-2xs text-ink-muted" data-testid="forecast-burning">
          {'Burning it: '}
          {forecast.burning.map((run, index) => (
            <span key={run.runId}>
              {index ? ', ' : ''}
              <a className="text-action underline" href={planHref(run.slug, 'run')}>
                {run.slug}
              </a>
              {run.lanes.length ? ` (${run.lanes.length} lane${run.lanes.length === 1 ? '' : 's'})` : ''}
            </span>
          ))}
        </p>
      ) : null}
      <RetirementEvidence entitlement={account.entitlement} />
    </div>
  );
}

/**
 * The duplicate banner's action (phase 25, #33): remove the registration
 * that adds nothing. The built-in machine login cannot be removed, so the
 * offer is the registered one — the later, when both are registered.
 */
function DuplicateAction({ accounts }: { accounts: AccountView[] }) {
  const client = useQueryClient();
  const { data } = useAccounts();
  const removable = accounts.filter((account) => !account.builtIn);
  const target = removable[removable.length - 1];
  const remove = useMutation({
    mutationFn: (id: string) => api.accountDelete(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.accounts() }),
    onError: (error: Error) => toast(error.message, 'error'),
  });
  if (!target) return null;
  const allowed = data?.allowAccounts === true;
  return (
    <ConfirmButton
      size="sm"
      variant="ghost"
      destructive
      title={`Remove ${accountName(target)}?`}
      description="It is the same Claude login as the other entry, so no run loses headroom. What this machine has learned about the login stays."
      disabled={!allowed || remove.isPending}
      busy={remove.isPending}
      onConfirm={() => remove.mutate(target.id)}
    >
      {`Remove ${accountName(target)}`}
    </ConfirmButton>
  );
}
