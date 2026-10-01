/**
 * The usage meters — "how much Claude is left" in the console's own chrome.
 *
 * Two questions, answered at two depths. The compact widget (rail footer,
 * phone header) answers "am I about to hit a wall?" for the account most runs
 * spend: the 5-hour window and the worst weekly one, as bars. The dialog
 * behind it answers the rest: every registered account, every bucket the
 * usage endpoint reports (rendered by KEY, so a window that ships tomorrow
 * appears tomorrow), reset countdowns, and how stale each answer is.
 *
 * The numbers come from `/api/accounts` and move on the `accounts` SSE event;
 * this module never fetches anything itself. Mounted in the rail AND the
 * phone header — a widget added to one shell is missing on the other form
 * factor, which is the mistake the two variants exist to prevent.
 */

import { lazy, Suspense, useState } from 'react';
import { Gauge } from 'lucide-react';

import { useAccounts } from '@/lib/queries';
import type { AccountView, UsageBucket } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Dialog, DialogContent } from '@/components/ui';
import { burnPhrase, trendPhrase } from '@shared/ops-vocab.js';
import type { BucketForecast } from '@/lib/api/accounts';

const LimitsOverview = lazy(() => import('./limits-overview').then((m) => ({ default: m.LimitsOverview })));

/** Human names for the endpoint's bucket keys; unknown keys stay readable. */
export function bucketLabel(bucket: string): string {
  if (bucket === 'five_hour') return '5-hour session';
  if (bucket === 'seven_day') return 'Weekly (all models)';
  const model = /^seven_day_(.+)$/.exec(bucket)?.[1];
  if (model) return `Weekly (${model[0].toUpperCase()}${model.slice(1)})`;
  return bucket.replace(/_/g, ' ');
}

/**
 * Warn at 80, alert at 95 — the same thresholds the server announces at.
 *
 * Painted through the `.state-<ui>` indirection and `bg-state`, the way
 * `ui/meter.tsx`, `ui/segment-bar.tsx` and `ui/heartbeat.tsx` already do, so
 * the hue is read in the two places CLAUDE.md declares and nowhere else.
 *
 * It used to name the legacy 2.x aliases directly, and the 3.0 rebuild
 * re-pointed those: its `bg-ready` resolved, through the 2.x line alias, to
 * `--status-queued`, one of the two deliberate NEUTRALS. So crossing the 80%
 * warning threshold made the bar go QUIETER than it was at 79 — the one moment
 * it exists to be noticed.
 */
function tone(pct: number): string {
  if (pct >= 95) return 'state-failed';
  if (pct >= 80) return 'state-needs-you';
  return 'state-done';
}

export function Meter({ pct, className }: { pct: number; className?: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-track', className)}
      role="img"
      aria-label={`${Math.round(clamped)}% used`}
    >
      <div className={cn('h-full bg-state', tone(clamped))} style={{ width: `${clamped}%` }} />
    </div>
  );
}

/**
 * An account's buckets in a stable, readable order: the session window first
 * (it moves fastest and is the one that stops a run mid-phase), then the
 * all-model week, then each per-model week by name.
 *
 * Bucket names are DATA, not schema — `seven_day_opus` today, whatever ships
 * next — so this sorts what it is given rather than listing what it expects.
 */
function orderedBuckets(account: AccountView): { key: string; bucket: UsageBucket }[] {
  const rank = (key: string): number =>
    key === 'five_hour' ? 0 : key === 'seven_day' ? 1 : key.startsWith('seven_day') ? 2 : 3;
  return Object.entries(account.usage?.buckets ?? {})
    .map(([key, bucket]) => ({ key, bucket }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

/**
 * Every account, every window, as one small picture.
 *
 * The chrome used to show a single number — the worst 5-hour figure across all
 * accounts — which answers "am I near a wall" and nothing else. It could not
 * say WHICH login was near it, nor that the other one was empty, nor that a
 * weekly window was the real constraint. On a machine with two accounts that is
 * the difference between "stop working" and "switch account", and the widget
 * was silent about it.
 *
 * One column per bucket, grouped per account, filled from the bottom and toned
 * on the same 80/95 thresholds the server announces at. It stays legible at
 * this size because it is not asking to be read precisely: it is asking to be
 * GLANCED at, and the exact numbers are one press away.
 */
/** Why an account has no window to draw, in words — the bar it gets instead says the same. */
export function meterWords(account: AccountView): string {
  if (account.meter === 'broken')
    return `meter broken${account.usage?.error ? ` (${account.usage.error})` : ''}`;
  if (account.meter === 'unsupported' || account.usage?.unsupported)
    return 'the usage endpoint does not serve this credential';
  return 'no reading yet';
}

/** The runs paying as this account, as words for a label — empty when none is. */
function payingWords(account: AccountView): string {
  return account.paying?.length ? ` — paying for ${account.paying.map((p) => p.slug).join(', ')}` : '';
}

function AccountBars({ accounts, height = 14 }: { accounts: AccountView[]; height?: number }) {
  return (
    <span className="flex items-end gap-1.5">
      {accounts.map((account) => {
        const buckets = orderedBuckets(account);
        const label = accountName(account);
        const paying = Boolean(account.paying?.length);
        // The account a live run pays as carries a mark above its bars (#33).
        const mark = paying ? (
          <span aria-hidden className="size-1 self-start rounded-full bg-action" />
        ) : null;
        if (!buckets.length) {
          // Every account has a bar (phase 25, #33): one with no window is drawn
          // as what it is — a broken meter dashed in the failure hue, a
          // credential the endpoint does not serve or no reading yet as an
          // empty track — never left out, which read as "no such account".
          return (
            <span
              key={account.id}
              className="flex items-end gap-px"
              role="img"
              data-meter={account.meter ?? 'none'}
              data-paying={paying ? 'true' : undefined}
              aria-label={`${label}: ${meterWords(account)}${payingWords(account)}`}
            >
              <span
                className={cn(
                  'relative w-[3px] shrink-0 rounded-[1px]',
                  account.meter === 'broken' ? 'state-failed border border-dashed border-state' : 'bg-track',
                )}
                style={{ height }}
              />
              {mark}
            </span>
          );
        }
        return (
          <span
            key={account.id}
            className="flex items-end gap-px"
            role="img"
            data-meter={account.meter ?? 'ok'}
            data-paying={paying ? 'true' : undefined}
            aria-label={`${label}: ${buckets.map((b) => bucketWords(account, b.key, b.bucket)).join(', ')}${payingWords(account)}`}
          >
            {buckets.map(({ key, bucket }) => {
              const pct = Math.max(0, Math.min(100, bucket.utilization));
              // The next hour at the measured burn, drawn faint above the fill
              // (control-tower phase 92, #33): 78 % and climbing has a ghost, 78 %
              // and flat has none. Clipped at the top — the wall is the column's end.
              const forecast = account.forecast?.buckets[key];
              const ahead =
                forecast?.trend === 'climbing' && forecast.burnPctPerHour
                  ? Math.min(100 - pct, forecast.burnPctPerHour)
                  : 0;
              return (
                <span
                  key={key}
                  className="relative w-[3px] shrink-0 overflow-hidden rounded-[1px] bg-track"
                  style={{ height }}
                >
                  <span
                    className={cn('absolute inset-x-0 bottom-0 block', tone(pct))}
                    // A window at 0% still shows a hairline: an empty bar and a
                    // missing bar look identical, and they mean opposite things.
                    style={{ height: `${Math.max(pct, 4)}%` }}
                  />
                  {ahead > 0 ? (
                    <span
                      data-forecast="climbing"
                      className={cn('absolute inset-x-0 block opacity-40', tone(Math.min(100, pct + ahead)))}
                      style={{ bottom: `${Math.max(pct, 4)}%`, height: `${ahead}%` }}
                    />
                  ) : null}
                </span>
              );
            })}
            {mark}
          </span>
        );
      })}
    </span>
  );
}

/**
 * A window's forecast in words (control-tower phase 92, #33's trend): "and
 * climbing · +4 %/h · walls ≈10:50", "and flat", or nothing while its burn is
 * not measured. The card and the bar say it the same way.
 */
export function forecastWords(forecast: BucketForecast | undefined): string {
  const trend = trendPhrase(forecast);
  if (!forecast || !trend) return '';
  // Flat is the whole sentence: a burn under the flat line is noise, not news.
  if (forecast.trend !== 'climbing') return trend;
  const burn = burnPhrase(forecast.burnPctPerHour);
  const walls = forecast.wallsAt
    ? `walls ≈${new Date(forecast.wallsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';
  return [trend, burn, walls].filter(Boolean).join(' · ');
}

/** A bucket's reading and its trend, for a title or a label. */
function bucketWords(account: AccountView, key: string, bucket: UsageBucket): string {
  const trend = forecastWords(account.forecast?.buckets[key]);
  return `${bucketLabel(key)} ${Math.round(bucket.utilization)}%${trend ? ` ${trend}` : ''}`;
}

/** Every account and bucket as one line of text — the title behind the picture. */
function usageTitle(accounts: AccountView[]): string {
  return accounts
    .map((account) => {
      const buckets = orderedBuckets(account);
      if (!buckets.length) return `${accountName(account)}: no usage data yet`;
      return `${accountName(account)} — ${buckets.map((b) => bucketWords(account, b.key, b.bucket)).join(' · ')}`;
    })
    .join('\n');
}

/** The worst weekly bucket — all-models and each per-model one compete. */
function worstWeekly(account: AccountView | undefined): { key: string; bucket: UsageBucket } | null {
  const buckets = account?.usage?.buckets ?? {};
  let worst: { key: string; bucket: UsageBucket } | null = null;
  for (const [key, bucket] of Object.entries(buckets)) {
    if (!key.startsWith('seven_day')) continue;
    if (!worst || bucket.utilization > worst.bucket.utilization) worst = { key, bucket };
  }
  return worst;
}

/**
 * The account whose five-hour window is closest to its wall. The compact bar
 * is an early-warning instrument: it showed only the machine login, so a
 * second account could walk into its wall with every meter in the chrome
 * green. Worst-of-all is the honest headline; the per-account truth is one
 * click away in the dialog.
 */
function worstFive(
  accounts: AccountView[] | undefined,
): { account: AccountView; bucket: UsageBucket } | null {
  let worst: { account: AccountView; bucket: UsageBucket } | null = null;
  for (const account of accounts ?? []) {
    const bucket = account.usage?.buckets.five_hour;
    if (!bucket) continue;
    if (!worst || bucket.utilization > worst.bucket.utilization) worst = { account, bucket };
  }
  return worst;
}

/** The worst weekly bucket across EVERY account — all-models and per-model compete. */
function worstWeeklyAcross(
  accounts: AccountView[] | undefined,
): { account: AccountView; key: string; bucket: UsageBucket } | null {
  let worst: { account: AccountView; key: string; bucket: UsageBucket } | null = null;
  for (const account of accounts ?? []) {
    const weekly = worstWeekly(account);
    if (weekly && (!worst || weekly.bucket.utilization > worst.bucket.utilization)) {
      worst = { account, ...weekly };
    }
  }
  return worst;
}

export function accountName(account: AccountView): string {
  if (account.builtIn) return account.name ?? account.email ?? 'This machine’s login';
  return account.name ?? account.email ?? account.id;
}

export function LimitsWidget({ variant }: { variant: 'header' | 'rail' | 'phone' | 'sheet' }) {
  const [open, setOpen] = useState(false);
  const { data } = useAccounts();
  const accounts = data?.accounts;
  const several = (accounts?.length ?? 0) > 1;
  const five = worstFive(accounts);
  const weekly = worstWeeklyAcross(accounts);
  // Stale is about the number on screen: the account SUPPLYING a meter could
  // not be read, so the bar may be older than it looks.
  const stale = Boolean(
    five?.account.usage?.error ||
    five?.account.usage?.unsupported ||
    weekly?.account.usage?.error ||
    weekly?.account.usage?.unsupported ||
    (!five && accounts?.some((a) => a.usage?.error || a.usage?.unsupported)),
  );

  // Every account that actually reports a window — what the title reads out.
  const metered = (accounts ?? []).filter((account) => orderedBuckets(account).length > 0);
  // Every account gets a bar (phase 25, #33) — the ones with no window drawn as such.
  const drawn = accounts ?? [];
  const fiveTitle = five && several ? `5-hour — ${accountName(five.account)}` : '5-hour window';
  const weeklyTitle =
    weekly && several
      ? `${bucketLabel(weekly.key)} — ${accountName(weekly.account)}`
      : weekly
        ? bucketLabel(weekly.key)
        : undefined;

  const trigger =
    variant === 'header' ? (
      // The 3.0 shell header is ONE 48px row, so this is one row: the gauge,
      // the worst 5-hour figure and a short bar. The rail's two stacked meters
      // are a column and overflow it — the weekly window is in the title and in
      // the dialog behind the click, which is where the detail belongs.
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Claude usage limits"
        title={[
          metered.length ? usageTitle(metered) : 'No usage data yet',
          stale ? 'These figures could not be refreshed and may be old.' : null,
        ]
          .filter(Boolean)
          .join('\n')}
        className="flex min-h-(--tap-min) shrink-0 items-center gap-1.5 rounded px-2 text-2xs text-ink-muted hover:text-ink md:min-h-0 md:py-1"
      >
        <Gauge size={14} className="shrink-0" aria-hidden />
        {five ? (
          <>
            {/* The number is still the worst 5-hour figure — the one that
                stops a run soonest — and the bars behind it say whose, and
                which window, without a click. */}
            <span className="tnum">{Math.round(five.bucket.utilization)}%</span>
            {drawn.length > 0 && (
              <span className="hidden sm:flex">
                <AccountBars accounts={drawn} />
              </span>
            )}
          </>
        ) : (
          // Muted, never faint, like the rest of the button's label: "no
          // data" and "stale" are read — the second is the warning that the
          // figures may be old — and faint fails AA at 12px on the header's
          // ground (the e2e register, on every desk page).
          <span className="text-ink-muted">no data</span>
        )}
        {stale && <span className="text-ink-muted">stale</span>}
      </button>
    ) : variant === 'phone' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-(--tap-min) items-center gap-1.5 px-2 text-xs text-ink-muted"
        aria-label="Claude usage limits"
        title={metered.length ? usageTitle(metered) : fiveTitle}
      >
        <Gauge size={16} aria-hidden />
        {five ? <span className="tnum">{Math.round(five.bucket.utilization)}%</span> : null}
        {drawn.length > 0 && <AccountBars accounts={drawn} height={12} />}
      </button>
    ) : variant === 'sheet' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-(--tap-min) w-full items-center justify-between gap-2 text-sm"
      >
        <span className="flex items-center gap-2">
          <Gauge size={16} aria-hidden /> Usage limits
        </span>
        <span className="flex items-center gap-2 text-xs text-ink-muted">
          {five ? `5h ${Math.round(five.bucket.utilization)}%` : 'no data'}
          {drawn.length > 0 && <AccountBars accounts={drawn} height={12} />}
        </span>
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-surface-raised"
        aria-label="Claude usage limits"
        title={
          several ? 'Claude usage limits — the worst window across every account' : 'Claude usage limits'
        }
      >
        <span className="flex items-center gap-1 text-2xs uppercase tracking-wide text-ink-faint">
          <Gauge size={12} aria-hidden /> Usage
          {stale ? <span className="text-ink-faint">·&nbsp;stale</span> : null}
        </span>
        {five ? (
          <span
            className="flex items-center gap-1.5"
            title={`${fiveTitle} at ${Math.round(five.bucket.utilization)}%`}
          >
            <span className="w-4 text-2xs text-ink-faint">5h</span>
            <Meter pct={five.bucket.utilization} />
          </span>
        ) : (
          <span className="text-2xs text-ink-faint">no data yet</span>
        )}
        {/* Per account, when there IS more than one: the two bars above are the
            worst window anywhere, which is the right alarm and the wrong map.
            This says whose window that was, and whether the other login has
            room — the question the alarm makes you ask. */}
        {several && drawn.length > 0 ? (
          <span className="flex flex-col gap-0.5 pt-1">
            {drawn.map((account) => (
              <span key={account.id} className="flex items-center gap-1.5">
                <span className="max-w-16 truncate text-2xs text-ink-faint" title={accountName(account)}>
                  {accountName(account)}
                </span>
                <AccountBars accounts={[account]} height={10} />
              </span>
            ))}
          </span>
        ) : null}
        {weekly ? (
          <span
            className="flex items-center gap-1.5"
            title={`${weeklyTitle} at ${Math.round(weekly.bucket.utilization)}%`}
          >
            <span className="w-4 text-2xs text-ink-faint">wk</span>
            <Meter pct={weekly.bucket.utilization} />
          </span>
        ) : null}
      </button>
    );

  return (
    <>
      {trigger}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Claude usage limits">
          {/* The overview is its own chunk (phase 25): it is behind a press,
              and first paint is held to its budget. */}
          {open ? (
            <Suspense fallback={null}>
              <LimitsOverview accounts={data?.accounts} />
            </Suspense>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
