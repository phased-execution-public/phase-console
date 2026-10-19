/**
 * Settings ▸ Accounts — which Claude account a session runs as, how much of
 * each window is left, and why the console will or will not spend each one
 * (7.0, quiet-console phase 22).
 *
 * ```
 * 2 accounts. The fullest 5-hour window is work’s, at 82 %.      [Refresh every account]
 * Every account
 * ● Signed in   machine login  me@example.com     5-hour 42 %    read 2 min ago   [Refresh] ▾
 * ● Signed in   work           work@example.com   5-hour 82 %    read 1 min ago   [Refresh] ▾
 *     Windows      5-hour window   ▬▬▬▬▬▬▬▬──  82 %  resets in 2h
 *     Login        ● Signed in
 *     Entitlement  ● Entitled   checked 3 days ago        [Probe entitlement]
 *     Credits      Off; credits are available          [Use credits past plan limits]
 *     …                                                 [Rename] [Remove]
 * Add an account
 * Removed, still remembered
 * What this machine holds          ● OK  gh      ● Fail  env:STRIPE_KEY   [Check again]
 * ```
 *
 * Each account is one line — its login, its 5-hour window, when it was read,
 * one action — and opens in place to everything the console knows and decides
 * by: every window with its reset and its burn, the walls this machine
 * learned, who it resolves to, the breaker's word and the last check, its
 * place in the rank, its credits. Every sentence is the server's; nothing
 * here re-derives a rule.
 *
 * Registering, signing in, probing, clearing a retirement, switching credits
 * on, renaming and removing each change what a future run may spend, so each
 * needs `--allow-accounts`; READING never does — a console without the flag
 * still meters the machine login and says what the flag adds. Last comes
 * what this machine holds (`credentials.tsx`): every credential a plan names,
 * held or not, asked again on a press that is a read and needs no flag.
 *
 * Since 7.0 the breaker's two verbs, the credits switch and the tombstones are
 * the free tree's too; Pro adds one group, the quota plan of a plan and a run
 * (`accounts-dashboard.tsx`).
 *
 * The list sits under the one toolbar (design.md principle 8): search, Filter
 * by kind, and Everything, which opens every line. Since one-pool phase 9 Pro
 * makes the section the POOL DESK: an API key is one more line
 * (`accounts-inspect.tsx` `ApiAccountItem`), every line inspects in the panel
 * on four tabs with every control the account has, the Pool card says how the
 * console spends its accounts and what the next session would get
 * (`accounts-pool-card.tsx`), and Add an account offers an API key
 * (`accounts-add.tsx`).
 */

import { useMemo, useState } from 'react';
import { burnPhrase, trendPhrase } from '@shared/ops-vocab.js';
import { RetirementEvidence } from '@/cards/retirement-evidence';
import {
  clearRetired,
  probeEntitlement,
  useAccountRefresh,
  useAccounts,
  useAccountsCache,
} from '@/data/accounts';
import {
  api,
  type AccountProbe,
  type AccountStanding,
  type AccountView,
  type BucketForecast,
  type UsageBucket,
} from '@/data/api';
import { useConsoleState } from '@/data/console';
import { duration, plural } from '@/lib/format';
import { accountName, bucketLabel, meterWords } from '@/shell/limits';
import { planHref, settingsHref } from '@/shell/routes';
import { Button, Input, KeyValue, Mono, RelativeTime, Row, Skeleton, Banner, Empty, toast } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { useEverything } from '@/ui/everything';
import { NativeSelect } from '@/ui/native-select';
import { Toolbar, type ToolbarVerb } from '@/ui/toolbar';
import { Dialog, DialogContent } from '@/ui/dialog';
import { AccountStatus, OpsStatus } from '@/ui/status';
import { LoadMeter } from '@/ui/track/meter';
import { AccountRepair, loginStarted, needsRepair } from './account-repair';
import { CredentialsGroup } from './credentials';
import { CreditsControl, creditWords, spendWords } from './credits';
import { SettingRow, SettingsGroup, failureWords, useSetting } from './setting';
import { TombstonesGroup } from './tombstones';

/** Why a press that changes what a run may spend cannot be made here. */
const NEEDS_FLAG = 'Start the console with --allow-accounts to change an account.';

/** A link in a sentence. */
const link = 'tap-line text-ink underline decoration-ink-faint underline-offset-2 hover:decoration-ink';

/* ------------------------------------------------------------------ *
 * The words — pure, so a test reads the same ones the page draws
 * ------------------------------------------------------------------ */

/** What kind of login an account is, in words. */
export function accountKindWords(account: Pick<AccountView, 'kind' | 'builtIn'>): string {
  if (account.builtIn || account.kind === 'default') return 'This machine’s own claude login';
  return account.kind === 'token' ? 'A long-lived setup token' : 'A profile signed in from this console';
}

/**
 * An account's windows in a stable order: the session window first (it moves
 * fastest and stops a run mid-phase), then the all-model week, then each
 * per-model week by name. Bucket names are data, not schema — whatever ships
 * next is drawn by its key.
 */
export function orderedWindows(account: AccountView): { key: string; bucket: UsageBucket }[] {
  const rank = (key: string): number =>
    key === 'five_hour' ? 0 : key === 'seven_day' ? 1 : key.startsWith('seven_day') ? 2 : 3;
  return Object.entries(account.usage?.buckets ?? {})
    .map(([key, bucket]) => ({ key, bucket }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

/**
 * A window's forecast in words (control-tower phase 92, #33): "and climbing,
 * +4 %/h, walls at about 10:50", "and flat", or nothing while its burn is not
 * measured. The rail's bar and this list say it the same way.
 */
export function forecastWords(forecast: BucketForecast | undefined): string {
  const trend = trendPhrase(forecast);
  if (!forecast || !trend) return '';
  if (forecast.trend !== 'climbing') return trend;
  const burn = burnPhrase(forecast.burnPctPerHour);
  const walls = forecast.wallsAt
    ? `walls at about ${new Date(forecast.wallsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';
  return [trend, burn, walls].filter(Boolean).join(', ');
}

/** Why a reading is stale: its window has reset since, or the read is simply old (#109). */
export function staleWords(resetsAt: string, now = Date.now()): string {
  const resets = Date.parse(resetsAt);
  return Number.isFinite(resets) && resets <= now ? 'reset since this read' : 'stale';
}

/** The rank's verdict on an account, in words: its place, or why it is out. */
export function standingWords(standing: AccountStanding | undefined): string | null {
  if (!standing) return null;
  if (standing.candidate)
    return standing.rank
      ? `Number ${standing.rank} in the rank an automatic pick walks`
      : 'A candidate for an automatic pick';
  return `Out of the rank: ${standing.why}`;
}

/** What a one-turn check found, as a person reads it: its verdict, the server's reason, and the breaker's move. */
export function probeSentence(
  name: string,
  probe: Pick<AccountProbe, 'status' | 'reason'>,
  moved?: { from: string; to: string },
): string {
  const verdict =
    probe.status === 'ok'
      ? 'it may run work'
      : probe.status === 'fail'
        ? 'it was refused'
        : 'it could not be asked';
  const reason = probe.reason.trim();
  return [
    `Checked ${name}: ${verdict}.`,
    reason && (/[.!?]$/.test(reason) ? reason : `${reason}.`),
    moved && `The breaker moved from ${moved.from} to ${moved.to}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** A moment ahead as a clock: today's time, or the date and time when it is further off. */
export function wallClockWords(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return at.toDateString() === new Date(now).toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

/** When a setup token stops working, in the reader's own calendar. */
export function replaceByWords(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? iso
    : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Registered accounts that are really ONE Claude identity: their windows are
 * the same windows, so a switch at a wall moves a run onto the wall it just
 * hit. It happens for an ordinary reason — signing the machine login in as the
 * account also registered as a profile — and each entry reads correctly on its
 * own. Matched on email, the only identity the usage endpoint gives.
 */
export function duplicateIdentities(accounts: readonly AccountView[]): { email: string; ids: string[] }[] {
  const byEmail = new Map<string, string[]>();
  for (const account of accounts) {
    const email = account.email?.trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, [...(byEmail.get(email) ?? []), account.id]);
  }
  return [...byEmail.entries()].filter(([, ids]) => ids.length > 1).map(([email, ids]) => ({ email, ids }));
}

/** The section's lead: how many accounts, and the window closest to its wall. */
export function accountsSituation(accounts: readonly AccountView[]): string {
  if (!accounts.length) return 'No account answered yet.';
  let worst: { account: AccountView; pct: number } | null = null;
  for (const account of accounts) {
    const five = account.usage?.buckets.five_hour?.utilization;
    if (typeof five === 'number' && (!worst || five > worst.pct)) worst = { account, pct: five };
  }
  const count = `${plural(accounts.length, 'account')}.`;
  if (!worst) return `${count} No 5-hour window has been read yet.`;
  // A window credits carry past is not spent (control-tower phase 93, #146): said, as the opened row says it.
  const carried = worst.account.credits?.carrying === true && worst.pct >= 99 ? ', and credits carry it' : '';
  return `${count} The fullest 5-hour window is ${accountName(worst.account)}’s, at ${Math.round(worst.pct)} %${carried}.`;
}

/** The kinds the list's Filter narrows to, in the toolbar's words. */
export const ACCOUNT_FILTERS = [
  ['all', 'Every account'],
  ['login', 'Logins'],
  ['token', 'Setup tokens'],
] as const;
export type AccountFilter = (typeof ACCOUNT_FILTERS)[number][0];

/** Does an account belong under a filter word? A login is the machine's own or a signed-in profile. */
export function accountMatchesFilter(account: AccountView, filter: AccountFilter): boolean {
  if (filter === 'all') return true;
  const kind = account.kind as string;
  if (filter === 'login') return account.builtIn || kind === 'default' || kind === 'profile';
  return kind === filter;
}

/** Does an account answer to the search: its name, its email, its id — and, for a key, its provider? */
export function accountMatchesSearch(account: AccountView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const said = [accountName(account), account.email ?? '', account.id, account.plan ?? ''];
  return said.some((text) => text.toLowerCase().includes(needle));
}

/** Warn at 80, alert at 95 — the thresholds the server announces at, and the rail's bar's. */
const windowPaint = (pct: number, carried: boolean) =>
  carried
    ? ('running' as const)
    : pct >= 95
      ? ('failed' as const)
      : pct >= 80
        ? ('needs-you' as const)
        : ('done' as const);

/* ------------------------------------------------------------------ *
 * One account, opened
 * ------------------------------------------------------------------ */

/**
 * "until" a moment: ahead, its clock and how far off; behind, how long ago.
 * `RelativeTime` words only the past, and read a cooling hour as "just now".
 */
function Until({ at, className }: { at: string; className?: string }) {
  const left = Date.parse(at) - Date.now();
  if (!(left > 0))
    return (
      <span className={className}>
        until <RelativeTime at={at} live={false} />
      </span>
    );
  return (
    <span className={className} title={new Date(at).toLocaleString()}>
      until {wallClockWords(at)}, in {duration(left)}
    </span>
  );
}

function Windows({ account }: { account: AccountView }) {
  const usage = account.usage;
  const windows = orderedWindows(account);
  const walls = Object.entries(account.limitedUntil ?? {});
  // A window credits carry past is not spent (control-tower phase 93, #146).
  const carried = account.credits?.carrying === true;
  const forecast = account.forecast;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-windows={account.id}>
      {usage?.unsupported ? (
        <span className="text-meta text-ink-muted">
          The usage endpoint does not serve this credential — a limit is learned when a run meets one.
        </span>
      ) : windows.length ? (
        windows.map(({ key, bucket }) => {
          const pct = Math.round(bucket.utilization);
          const onCredit = carried && bucket.utilization >= 99;
          const trend = forecastWords(forecast?.buckets[key]);
          return (
            <div key={key} data-window={key} className="flex min-w-0 flex-col gap-0.5">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[10rem_minmax(6rem,1fr)_auto]">
                <span className="col-span-2 min-w-0 text-meta text-ink-muted sm:col-span-1">
                  {bucketLabel(key)}
                </span>
                <LoadMeter
                  value={bucket.utilization}
                  max={100}
                  label={`${accountName(account)}: ${bucketLabel(key)}`}
                  valueText={onCredit ? 'on credit' : `${pct} %`}
                  paint={windowPaint(bucket.utilization, carried)}
                />
                <span className="text-meta tabular-nums text-ink">{onCredit ? 'on credit' : `${pct} %`}</span>
              </div>
              <span className="flex min-w-0 flex-wrap gap-x-3 text-meta text-ink-muted">
                <span title={new Date(bucket.resetsAt).toLocaleString()}>
                  {Date.parse(bucket.resetsAt) > Date.now()
                    ? `resets in ${duration(Date.parse(bucket.resetsAt) - Date.now())}`
                    : 'reset due'}
                </span>
                {trend && <span>{trend}</span>}
                {bucket.stale && <span>{staleWords(bucket.resetsAt)}</span>}
              </span>
            </div>
          );
        })
      ) : (
        <span className="text-meta text-ink-muted">
          No usage read yet{usage?.error ? `: ${usage.error}` : ''}.
        </span>
      )}
      {walls.map(([bucket, until]) => {
        // Ahead, in the resets' own words: `RelativeTime` says only the past,
        // and read a wall two hours off as "just now".
        const left = Date.parse(until) - Date.now();
        return (
          <span
            key={bucket}
            className="text-meta text-ink"
            data-testid="wall"
            title={new Date(until).toLocaleString()}
          >
            Hit its {bucketLabel(bucket)} limit; it reopens {left > 0 ? `in ${duration(left)}` : 'now'}.
          </span>
        );
      })}
      {forecast?.wallsAt && (
        <span className="text-meta text-ink-muted" data-testid="forecast-walls">
          At this burn its {forecast.bucket ? bucketLabel(forecast.bucket) : 'first window'} walls at about{' '}
          {new Date(forecast.wallsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
        </span>
      )}
      {forecast?.burning?.length ? (
        <span className="text-meta text-ink-muted" data-testid="forecast-burning">
          Burning it:{' '}
          {forecast.burning.map((run, index) => (
            <span key={run.runId}>
              {index ? ', ' : ''}
              <a className={link} href={planHref(run.slug, 'run')}>
                {run.slug}
              </a>
              {run.lanes.length ? ` (${plural(run.lanes.length, 'lane')})` : ''}
            </span>
          ))}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-wrap gap-x-3 text-meta text-ink-muted">
        <span>
          {usage?.fetchedAt ? (
            <>
              read <RelativeTime at={usage.fetchedAt} />
            </>
          ) : (
            'never read here'
          )}
        </span>
        {account.pollEveryMs ? <span>read every {duration(account.pollEveryMs)}</span> : null}
        {account.lastErrorAt ? (
          <span>
            a read failed <RelativeTime at={account.lastErrorAt} live={false} />
          </span>
        ) : null}
      </span>
      {usage?.error && !usage.unsupported && windows.length > 0 && (
        <span className="max-w-(--measure) break-words text-meta text-ink-muted">{usage.error}</span>
      )}
    </div>
  );
}

function LoginFacts({ account, allowed }: { account: AccountView; allowed: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
        <AccountStatus auth={account.authState} />
        {account.kind === 'token' && account.tokenExpiresAt && (
          <span
            className="text-meta text-ink-muted"
            title="A setup token lasts a year from when it was added"
          >
            replace it by {replaceByWords(account.tokenExpiresAt)}
          </span>
        )}
      </span>
      {needsRepair(account) && (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <AccountRepair account={account} allowed={allowed} />
        </span>
      )}
    </div>
  );
}

function EntitlementFacts({ account, allowed }: { account: AccountView; allowed: boolean }) {
  const cache = useAccountsCache();
  const [busy, setBusy] = useState(false);
  const entitlement = account.entitlement;
  const probe = account.probe;
  const retired = entitlement?.state === 'retired';
  const name = accountName(account);

  const onProbe = async () => {
    setBusy(true);
    try {
      const out = await probeEntitlement(account.id);
      cache.put(out.account);
      toast(
        probeSentence(accountName(out.account), out.probe, out.moved),
        out.probe.status === 'fail' ? 'error' : out.probe.status === 'ok' ? 'ok' : 'info',
      );
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(false);
      void cache.reread();
    }
  };

  const onClear = async () => {
    try {
      const out = await clearRetired(account.id);
      cache.put(out.account);
      toast(`${accountName(out.account)} is ${out.account.entitlement?.state ?? 'cleared'} again.`, 'ok');
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      void cache.reread();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-entitlement={account.id}>
      {entitlement ? (
        <>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <AccountStatus entitlement={entitlement.state} />
            {entitlement.via === 'org' && (
              <span className="text-meta text-ink-muted">through its organisation</span>
            )}
            {entitlement.class && <span className="text-meta text-ink-muted">{entitlement.class}</span>}
          </span>
          {entitlement.reason && (
            <span className="max-w-(--measure) break-words text-meta text-ink-muted">
              {entitlement.reason}
            </span>
          )}
          <RetirementEvidence entitlement={entitlement} />
          {(entitlement.at || entitlement.by) && (
            <span className="flex min-w-0 flex-wrap gap-x-3 text-meta text-ink-muted">
              {entitlement.at && (
                <span>
                  since <RelativeTime at={entitlement.at} live={false} />
                </span>
              )}
              {entitlement.by && <span>by {entitlement.by}</span>}
              {entitlement.until && <Until at={entitlement.until} />}
            </span>
          )}
        </>
      ) : (
        <span className="text-meta text-ink-muted">This server does not report the breaker.</span>
      )}
      {probe ? (
        <span className="flex min-w-0 flex-col gap-0.5" data-testid="last-check">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <span className="text-meta text-ink-muted">Last check</span>
            <OpsStatus vocab="probe" word={probe.status} />
            <span className="text-meta text-ink-muted">
              <RelativeTime at={probe.at} live={false} />
            </span>
            <span className="text-meta text-ink-muted">by {probe.by}</span>
            <span className="text-meta text-ink-muted">{plural(probe.count, 'check')} in all</span>
            {typeof probe.costUsd === 'number' && (
              <span className="text-meta tabular-nums text-ink-muted">${probe.costUsd.toFixed(4)}</span>
            )}
          </span>
          <span className="max-w-(--measure) break-words text-meta text-ink-muted">{probe.reason}</span>
        </span>
      ) : (
        <span className="text-meta text-ink-muted">Never checked.</span>
      )}
      <span className="flex min-w-0 flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!allowed || busy}
          title={
            allowed
              ? 'Runs one declared one-turn session under this account and records whether the API took its work'
              : NEEDS_FLAG
          }
          onClick={() => void onProbe()}
        >
          {busy ? 'Probing…' : 'Probe entitlement'}
        </Button>
        {retired && (
          <ConfirmButton
            size="sm"
            variant="ghost"
            disabled={!allowed || busy}
            title={`Clear the retirement of ${name}?`}
            confirmLabel="Clear retired"
            cancelLabel="Keep it retired"
            description={`The breaker opens to unknown for this login${
              entitlement?.via === 'org' || account.orgId ? ' and every account in its organisation' : ''
            }. The next good read or spend proves it again, and a run may board on it from now.`}
            onConfirm={() => void onClear()}
          >
            Clear retired
          </ConfirmButton>
        )}
      </span>
    </div>
  );
}

function CreditsFacts({ account, allowed }: { account: AccountView; allowed: boolean }) {
  const credits = account.credits;
  const spend = spendWords(credits);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-body text-ink">{creditWords(credits)}</span>
      {spend && <span className="text-meta text-ink-muted">{spend}</span>}
      {credits?.onCredit && <span className="text-meta text-ink">A session is running on credit now.</span>}
      <CreditsControl account={account} allowed={allowed} />
    </div>
  );
}

function RenameField({ account, allowed }: { account: AccountView; allowed: boolean }) {
  const cache = useAccountsCache();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.name ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setEditing(false);
    if ((draft.trim() || '') === (account.name ?? '')) return;
    setBusy(true);
    try {
      await api.accountRename(account.id, draft.trim());
      toast('Renamed. The id underneath never changes.', 'ok');
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(false);
      void cache.reread();
    }
  };
  if (editing) {
    return (
      <form
        className="flex min-w-0 flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          aria-label={`A name for ${accountName(account)}`}
          value={draft}
          placeholder={account.builtIn ? 'machine login' : account.id}
          className="w-full sm:w-56"
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false);
          }}
        />
        <Button type="submit" size="sm" variant="ghost">
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </form>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="min-w-0 break-words text-body text-ink">{account.name ?? 'No name of its own'}</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={!allowed || busy}
        title={allowed ? 'The display name only — the id underneath never changes' : NEEDS_FLAG}
        onClick={() => {
          setDraft(account.name ?? '');
          setEditing(true);
        }}
      >
        Rename
      </Button>
    </span>
  );
}

function RemoveAccount({ account, allowed }: { account: AccountView; allowed: boolean }) {
  const cache = useAccountsCache();
  const name = accountName(account);
  if (account.builtIn) return null;
  const goes =
    account.kind === 'profile'
      ? ', its profile directory and that directory’s login (on macOS, its keychain entry too)'
      : account.kind === 'token'
        ? ' and the stored token'
        : '';
  return (
    <ConfirmButton
      size="sm"
      variant="ghost"
      destructive
      disabled={!allowed}
      title={`Remove ${name}?`}
      confirmLabel="Remove account"
      cancelLabel="Keep it"
      description={`What goes: this console’s registration of it${goes}. What stays: the Anthropic account itself, what this machine learned about its login, and every recorded run. A run paying as it refuses the removal — pause or switch it first.`}
      onConfirm={() =>
        void api
          .accountDelete(account.id)
          .then(
            () => toast(`Removed ${name}.`, 'ok'),
            (error: unknown) => toast(failureWords(error), 'error'),
          )
          .finally(() => void cache.reread())
      }
    >
      Remove
    </ConfirmButton>
  );
}

function AccountItem({
  account,
  allowed,
  defaultExpanded,
  expanded,
}: {
  account: AccountView;
  allowed: boolean;
  defaultExpanded: boolean;
  /** Everything is on: every line stands open. */
  expanded?: boolean;
}) {
  const { refresh, busy } = useAccountRefresh(account.id);
  const name = accountName(account);
  const five = account.usage?.buckets.five_hour;
  const paying = account.paying ?? [];
  return (
    <Row
      data-account={account.id}
      mark={<AccountStatus auth={account.authState} />}
      name={
        <span className="flex min-w-0 items-baseline gap-2" title={account.email ?? account.id}>
          <span className="min-w-0 truncate">{name}</span>
          {account.email && account.email !== name && (
            <span className="min-w-0 truncate text-meta text-ink-muted">{account.email}</span>
          )}
        </span>
      }
      // One line of text: the Row truncates its fact with an ellipsis, which a box of two spans defeats —
      // on a phone they drew over each other.
      fact={[
        !five
          ? meterWords(account)
          : account.credits?.carrying === true && five.utilization >= 99
            ? '5-hour on credit'
            : `5-hour ${Math.round(five.utilization)} %`,
        paying.length > 0 ? `pays for ${paying.map((run) => run.slug).join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(', ')}
      clock={
        account.usage?.fetchedAt ? (
          <>
            read <RelativeTime at={account.usage.fetchedAt} />
          </>
        ) : undefined
      }
      action={
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Reading…' : 'Refresh'}
        </Button>
      }
      expandLabel={`details of ${name}`}
      defaultExpanded={defaultExpanded}
      {...(expanded ? { expanded: true } : {})}
    >
      <div className="flex min-w-0 flex-col gap-4 pb-2">
        <KeyValue
          items={[
            ['Windows', <Windows key="windows" account={account} />],
            [
              'Identity',
              <span key="identity" className="flex min-w-0 flex-col gap-0.5" data-testid="identity">
                <span>{accountKindWords(account)}</span>
                {account.email && (
                  <span className="text-meta text-ink-muted">
                    Resolves to {account.email}
                    {account.org ? `, ${account.org}` : ''} now.
                  </span>
                )}
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-meta text-ink-muted">
                  {account.plan && <span>{account.plan} plan</span>}
                  <Mono value={account.id} />
                  {account.orgId && (
                    <span title="Hashed: accounts that show one share an organisation">
                      organisation {account.orgId}
                    </span>
                  )}
                  {account.credential && (
                    <Mono
                      value={account.credential}
                      chars={12}
                      title="The login’s fingerprint: two accounts that show one are one login"
                    />
                  )}
                </span>
              </span>,
            ],
            ['Login', <LoginFacts key="login" account={account} allowed={allowed} />],
            ['Entitlement', <EntitlementFacts key="entitlement" account={account} allowed={allowed} />],
            standingWords(account.breaker) !== null && [
              'Rank',
              <span key="rank" className="flex min-w-0 flex-col gap-0.5">
                <span>{standingWords(account.breaker)}</span>
                {account.breaker && !account.breaker.candidate && account.breaker.until && (
                  <Until at={account.breaker.until} className="text-meta text-ink-muted" />
                )}
              </span>,
            ],
            account.credits && [
              'Credits',
              <CreditsFacts key="credits" account={account} allowed={allowed} />,
            ],
            account.lastLeftAt && [
              'Last moved off',
              <span key="left" className="flex min-w-0 flex-wrap gap-x-3">
                <RelativeTime at={account.lastLeftAt.at} live={false} />
                <span className="text-meta text-ink-muted">by {account.lastLeftAt.by}</span>
                <span className="text-meta text-ink-muted">{account.lastLeftAt.reason}</span>
              </span>,
            ],
            ['Name', <RenameField key="name" account={account} allowed={allowed} />],
          ]}
        />
        <div className="flex min-w-0 flex-wrap gap-2">
          <RemoveAccount account={account} allowed={allowed} />
        </div>
      </div>
    </Row>
  );
}

/* ------------------------------------------------------------------ *
 * The section
 * ------------------------------------------------------------------ */

/** The duplicate banner's action: remove the registration that adds nothing — the later one, never the machine login. */
function DuplicateAction({ accounts, allowed }: { accounts: readonly AccountView[]; allowed: boolean }) {
  const cache = useAccountsCache();
  const removable = accounts.filter((account) => !account.builtIn);
  const target = removable[removable.length - 1];
  if (!target) return null;
  return (
    <ConfirmButton
      size="sm"
      variant="ghost"
      destructive
      disabled={!allowed}
      title={`Remove ${accountName(target)}?`}
      description="It is the same Claude login as the other entry, so no run loses headroom. What this machine has learned about the login stays."
      onConfirm={() =>
        void api.accountDelete(target.id).then(
          () => void cache.reread(),
          (error: unknown) => toast(failureWords(error), 'error'),
        )
      }
    >
      {`Remove ${accountName(target)}`}
    </ConfirmButton>
  );
}

function AddTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const cache = useAccountsCache();
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await api.accountAdd(name.trim(), token.trim());
      onOpenChange(false);
      setName('');
      setToken('');
      toast('Account added. Its meters appear once the endpoint answers.', 'ok');
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(false);
      void cache.reread();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add a token account"
        description="Run claude setup-token in any terminal signed in to the account, and paste the token it prints. The name is required: a token carries no email to show."
      >
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && token.trim()) void add();
          }}
        >
          <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
            Name
            <Input
              value={name}
              placeholder="spare max account"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
            Token
            <Input
              value={token}
              type="password"
              autoComplete="off"
              className="font-mono"
              placeholder="sk-ant-oat01-…"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || !token.trim() || busy}>
              {busy ? 'Adding…' : 'Add account'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddAccountGroup({ accounts, allowed }: { accounts: readonly AccountView[]; allowed: boolean }) {
  const cache = useAccountsCache();
  const [loginName, setLoginName] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  // The unattended path, offered (control-tower phase 91, #147): a login's
  // access token lapses every few hours and is renewed while the console runs;
  // a long-lived token never needs renewing. The sentence is the server's.
  const offer = accounts.find((account) => account.unattended)?.unattended;
  const offered = offer && !accounts.some((account) => account.kind === 'token');

  const signIn = async () => {
    setBusy(true);
    try {
      const started = await api.accountLogin(loginName.trim() ? { name: loginName.trim() } : {});
      setLoginName('');
      void cache.reread();
      loginStarted(started);
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup id="add-account" title="Add an account">
      {!allowed && (
        <p className="max-w-(--measure) text-body text-ink-muted" data-testid="accounts-flag">
          Start the console with <code className="font-mono">--allow-accounts</code> to sign more Claude
          accounts in, paste setup tokens, and pick an account per run. Reading the meters works without it.
        </p>
      )}
      <SettingRow
        label="Sign another account in"
        hint="A profile this console keeps: a terminal opens for its claude login, and the console reads it from then on."
      >
        {({ id, describedBy }) => (
          <form
            className="flex min-w-0 flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void signIn();
            }}
          >
            <Input
              id={id}
              aria-describedby={describedBy}
              value={loginName}
              disabled={!allowed}
              placeholder="a name for it"
              className="w-full sm:w-44"
              onChange={(event) => setLoginName(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              disabled={!allowed || busy}
              title={allowed ? undefined : NEEDS_FLAG}
            >
              {busy ? 'Opening…' : 'Sign in'}
            </Button>
          </form>
        )}
      </SettingRow>
      <SettingRow
        label="Paste a setup token"
        hint="A long-lived token from claude setup-token, for an account this machine is not signed in to. It lasts a year and never needs renewing between sessions."
      >
        <Button
          size="sm"
          disabled={!allowed}
          title={allowed ? undefined : NEEDS_FLAG}
          onClick={() => setAdding(true)}
        >
          Paste a token
        </Button>
      </SettingRow>
      {offered && (
        <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="unattended-offer">
          {offer}
        </p>
      )}
      <AddTokenDialog open={adding} onOpenChange={setAdding} />
    </SettingsGroup>
  );
}

/** Usage alerts are a kind of announcement: said here, switched in Notifications — one control for one fact. */
function UsageAlertsLine() {
  const setting = useSetting<boolean>('notify.limits');
  const on = setting.value !== false;
  return (
    <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="usage-alerts">
      {on
        ? 'The console announces a window that was hit, a run parked waiting for one to reopen, and an account that could not sign in.'
        : 'Usage alerts are off: runs still wait, switch or pause as asked, and say nothing about it.'}{' '}
      <a href={settingsHref('notifications')} className={link}>
        {on ? 'Turn usage alerts off in Notifications' : 'Turn usage alerts on in Notifications'}
      </a>
      .
    </p>
  );
}

export function AccountsSection() {
  const { data, isPending } = useAccounts();
  const { data: state } = useConsoleState();
  const { refresh, busy } = useAccountRefresh();
  const allowed = data?.allowAccounts ?? state?.allowAccounts ?? false;
  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const duplicates = duplicateIdentities(accounts);
  const everything = useEverything('settings-accounts');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AccountFilter>('all');
  const shown = accounts.filter(
    (account) => accountMatchesFilter(account, filter) && accountMatchesSearch(account, query),
  );
  const verbs: ToolbarVerb[] = [];
  const filterPicker = (
    <NativeSelect
      aria-label="Show"
      className="w-full md:w-48"
      value={filter}
      onChange={(event) => setFilter(event.target.value as AccountFilter)}
    >
      {ACCOUNT_FILTERS.map(([id, words]) => (
        <option key={id} value={id}>
          {words}
        </option>
      ))}
    </NativeSelect>
  );
  const rowOf = (account: AccountView) => {
    return (
      <AccountItem
        key={account.id}
        account={account}
        allowed={allowed}
        defaultExpanded={accounts.length === 1}
        expanded={everything.on}
      />
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="settings-accounts">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 max-w-(--measure) text-body text-ink" data-testid="accounts-situation">
          {isPending && !data ? 'Reading the accounts.' : accountsSituation(accounts)}
        </p>
        <Button size="sm" disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Reading…' : 'Refresh every account'}
        </Button>
      </div>
      {duplicates.map(({ email, ids }) => (
        <Banner
          key={email}
          severity="warn"
          data-testid="duplicate-identity"
          action={
            <DuplicateAction
              accounts={accounts.filter((account) => ids.includes(account.id))}
              allowed={allowed}
            />
          }
        >
          {ids.join(' and ')} are the same Claude account ({email}). They share one set of windows, so
          switching between them buys no headroom — a run set to switch at a limit moves onto the wall it just
          hit. For real failover, register an account with a different login.
        </Banner>
      ))}
      <div className="flex min-w-0 flex-col gap-6">
        <SettingsGroup
          id="accounts"
          title="Every account"
          lead="Each is read on a budget: about every 90 seconds while a session runs on it, every ten minutes when idle."
        >
          <Toolbar
            label="Accounts"
            search={{
              value: query,
              onChange: setQuery,
              placeholder: 'Search accounts',
              label: 'Search the accounts by name, email or id',
            }}
            filter={{
              label: 'Show',
              value: ACCOUNT_FILTERS.find(([id]) => id === filter)![1],
              active: filter === 'all' ? 0 : 1,
              panel: filterPicker,
              inline: filterPicker,
            }}
            {...(verbs.length ? { more: verbs } : {})}
            everything={everything}
            {...(shown.length !== accounts.length
              ? { note: <span>{`${shown.length} of ${plural(accounts.length, 'account')} shown`}</span> }
              : {})}
          />
          {isPending && !data ? (
            <Skeleton className="h-24" aria-busy="true" aria-label="Reading the accounts" />
          ) : accounts.length === 0 ? (
            <p className="text-body text-ink-muted">
              Not even the machine login answered — is the server current?
            </p>
          ) : shown.length === 0 ? (
            <Empty
              title="No account matches."
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                >
                  Show every account
                </Button>
              }
            />
          ) : (
            <div className="flex min-w-0 flex-col gap-1" data-testid="account-list">
              {shown.map(rowOf)}
            </div>
          )}
          <UsageAlertsLine />
        </SettingsGroup>
        <AddAccountGroup accounts={accounts} allowed={allowed} />
        <TombstonesGroup rows={data?.tombstones ?? []} />
        <CredentialsGroup />
      </div>
    </div>
  );
}
