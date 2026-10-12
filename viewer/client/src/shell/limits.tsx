import { Gauge } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AccountView, UsageBucket } from '@/data/api';
import { useAccounts } from '@/data/accounts';
import { useNavigate } from './router';
import { settingsHref } from './routes';

/**
 * The account meter — "how much Claude is left" — in the console's own chrome:
 * the rail's foot on a desk, a row of the More sheet on a phone. It answers
 * one question at a glance, *am I about to hit a wall?*, as the worst 5-hour
 * window of any account and one small bar per account, and it opens
 * Settings ▸ Accounts, where every account, every window, every reset and
 * every repair is. The numbers come from `/api/accounts` and move on the
 * `accounts` event; this draws and never fetches.
 */

/** Warn at 80, alert at 95 — the thresholds the server announces at — through the `.state-*` indirection. */
function tone(pct: number): string {
  if (pct >= 95) return 'state-failed';
  if (pct >= 80) return 'state-needs-you';
  return 'state-done';
}

/** Human names for the endpoint's bucket keys; unknown keys stay readable. */
export function bucketLabel(bucket: string): string {
  if (bucket === 'five_hour') return '5-hour window';
  if (bucket === 'seven_day') return 'weekly, all models';
  const model = /^seven_day_(.+)$/.exec(bucket)?.[1];
  if (model) return `weekly, ${model}`;
  return bucket.replace(/_/g, ' ');
}

export function accountName(account: AccountView): string {
  if (account.builtIn) return account.name ?? account.email ?? 'This machine’s login';
  return account.name ?? account.email ?? account.id;
}

/** Why an account has no window to draw, in words. */
export function meterWords(account: AccountView): string {
  if (account.meter === 'broken')
    return `meter broken${account.usage?.error ? ` (${account.usage.error})` : ''}`;
  if (account.meter === 'unsupported' || account.usage?.unsupported)
    return 'the usage endpoint does not serve this credential';
  return 'no reading yet';
}

/** The account whose five-hour window is closest to its wall. */
export function worstFive(
  accounts: readonly AccountView[],
): { account: AccountView; bucket: UsageBucket } | null {
  let worst: { account: AccountView; bucket: UsageBucket } | null = null;
  for (const account of accounts) {
    const bucket = account.usage?.buckets.five_hour;
    if (!bucket) continue;
    if (!worst || bucket.utilization > worst.bucket.utilization) worst = { account, bucket };
  }
  return worst;
}

/** Every account's windows as one line of words — the title, and the accessible name. */
export function usageWords(accounts: readonly AccountView[]): string {
  return accounts
    .map((account) => {
      const buckets = Object.entries(account.usage?.buckets ?? {});
      if (!buckets.length) return `${accountName(account)}: ${meterWords(account)}`;
      return `${accountName(account)}: ${buckets
        .map(([key, bucket]) => `${bucketLabel(key)} ${Math.round(bucket.utilization)}%`)
        .join(', ')}`;
    })
    .join('. ');
}

/** One bar per account, filled from the bottom, toned on the same thresholds — a glance, never a reading. */
function AccountBars({ accounts, height = 14 }: { accounts: readonly AccountView[]; height?: number }) {
  return (
    <span className="flex items-end gap-1" aria-hidden>
      {accounts.map((account) => {
        const five = account.usage?.buckets.five_hour;
        const pct = five ? Math.max(0, Math.min(100, five.utilization)) : null;
        return (
          <span
            key={account.id}
            data-meter={account.meter ?? (five ? 'ok' : 'none')}
            data-paying={account.paying?.length ? 'true' : undefined}
            className={cn(
              'relative w-[3px] shrink-0 overflow-hidden rounded-[1px]',
              account.meter === 'broken' ? 'state-failed border border-dashed border-state' : 'bg-track',
            )}
            style={{ height }}
          >
            {pct != null && (
              <span
                className={cn('absolute inset-x-0 bottom-0 block bg-state', tone(pct))}
                // A window at 0 % still shows a hairline: an empty bar and a
                // missing bar look identical, and they mean opposite things.
                style={{ height: `${Math.max(pct, 4)}%` }}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

export function Limits({ variant }: { variant: 'rail' | 'row' }) {
  const navigate = useNavigate();
  const { data } = useAccounts();
  const accounts = data?.accounts ?? [];
  const five = worstFive(accounts);
  const stale = accounts.some((account) => account.usage?.error || account.usage?.unsupported);
  const words = accounts.length ? usageWords(accounts) : 'No usage data yet';
  const title = stale ? `${words}. These figures could not be refreshed and may be old.` : words;
  const figure = five ? `${Math.round(five.bucket.utilization)}%` : 'no data';

  if (variant === 'row') {
    return (
      <button
        type="button"
        onClick={() => navigate(settingsHref('accounts'))}
        aria-label={`Claude usage limits: ${title}`}
        className="flex min-h-(--tap-min) w-full items-center justify-between gap-2 rounded px-2 text-body hover:bg-surface-raised"
      >
        <span className="flex items-center gap-2 text-ink">
          <Gauge size={16} aria-hidden /> Usage limits
        </span>
        <span className="flex items-center gap-2 text-meta text-ink-muted">
          {five ? `5h ${figure}` : figure}
          {stale && <span>stale</span>}
          {accounts.length > 0 && <AccountBars accounts={accounts} height={12} />}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => navigate(settingsHref('accounts'))}
      aria-label={`Claude usage limits: ${title}`}
      title={title}
      className="flex min-h-11 w-full flex-col items-center justify-center gap-1 rounded px-1 py-1.5 text-ink-muted transition-colors duration-fast ease-transit hover:bg-surface hover:text-ink"
    >
      <span className="flex items-end gap-1.5">
        <Gauge size={16} aria-hidden />
        {accounts.length > 0 && <AccountBars accounts={accounts} />}
      </span>
      <span className="text-meta leading-none tabular-nums">
        {figure}
        {stale ? ' stale' : ''}
      </span>
    </button>
  );
}
