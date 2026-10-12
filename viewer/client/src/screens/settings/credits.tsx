/**
 * An account's credits — whether they carry its runs past its plan windows —
 * and the switch that allows it (7.0, quiet-console phase 22: in the free
 * tree too; control-tower phase 93, #146).
 *
 * ```
 * Credits   Uses credits past its plan limits
 *           12.40 of 40.00 USD used this month, 27.60 left
 *           [Stop using credits]
 * ```
 *
 * "Use credits past plan limits" is the operator's word and off by default;
 * the account's own credit state is the other half, and the server checks it
 * before the switch goes on (409 with its reason, which is the toast). A
 * monthly cap in dollars may ride the switch: absent, the account's own spend
 * limit is the only one. A window credits carry past is not a spent window,
 * which is why the meters say "on credit" there.
 */

import { useState } from 'react';
import { overage, useAccountsCache } from '@/data/accounts';
import type { AccountView, CreditView } from '@/data/api';
import { accountName } from '@/shell/limits';
import { Button, Input, toast } from '@/ui';
import { failureWords } from './setting';

/** What an account's credits are doing, in words: carrying its runs, allowed but stopped and why, or off. */
export function creditWords(credits: CreditView | undefined): string {
  if (!credits) return 'Credit state unknown';
  if (credits.carrying) return 'Uses credits past its plan limits';
  if (credits.allowed) return `Allowed, and stopped: ${credits.reason}`;
  if (credits.available === null) return 'Off; the credit state is unknown';
  return credits.available ? 'Off; credits are available' : `Off: ${credits.reason}`;
}

/** The month's spend against the cap in force, and what it leaves — null when the account says nothing. */
export function spendWords(credits: CreditView | undefined): string | null {
  if (!credits || credits.used === null) return null;
  const unit = credits.currency ? ` ${credits.currency}` : '';
  const of = credits.cap !== null ? ` of ${credits.cap.toFixed(2)}` : '';
  const left = credits.remaining !== null ? `, ${credits.remaining.toFixed(2)} left` : '';
  return `${credits.used.toFixed(2)}${of}${unit} used this month${left}`;
}

/** A typed cap, read: a number of dollars at zero or more, or nothing — the account's own limit. */
function readCap(text: string): { capUsd?: number; problem?: string } {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  const read = Number(trimmed);
  return Number.isFinite(read) && read >= 0
    ? { capUsd: read }
    : { problem: 'Type a number of dollars, 0 or more.' };
}

export function CreditsControl({ account, allowed }: { account: AccountView; allowed: boolean }) {
  const cache = useAccountsCache();
  const credits = account.credits;
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState(credits?.capUsd != null ? String(credits.capUsd) : '');
  const [problem, setProblem] = useState<string | null>(null);
  if (!credits) return null;

  const press = async (allow: boolean) => {
    const read = allow ? readCap(cap) : {};
    if (read.problem) return setProblem(read.problem);
    setProblem(null);
    setBusy(true);
    try {
      const out = await overage(account.id, {
        allowed: allow,
        ...(read.capUsd !== undefined ? { capUsd: read.capUsd } : {}),
      });
      cache.put(out.account);
      toast(
        allow
          ? `${accountName(out.account)} now uses credits past its plan limits.`
          : `${accountName(out.account)} is back on its plan limits.`,
        'ok',
      );
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(false);
      void cache.reread();
    }
  };

  const gate = allowed ? undefined : 'Start the console with --allow-accounts to change this.';
  const capId = `credits-cap-${account.id}`;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-credits={account.id}>
      {!credits.allowed && (
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label htmlFor={capId} className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
            Stop at, in dollars a month
            <Input
              id={capId}
              type="number"
              inputMode="decimal"
              min={0}
              step={1}
              placeholder="its own limit"
              className="w-36"
              value={cap}
              disabled={!allowed || busy}
              aria-invalid={problem ? true : undefined}
              onChange={(event) => setCap(event.target.value)}
            />
          </label>
        </div>
      )}
      {problem && <p className="text-meta text-ink">{problem}</p>}
      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={!allowed || busy}
          title={gate ?? 'Checked against the account’s own credit state before it is switched on'}
          onClick={() => void press(!credits.allowed)}
        >
          {busy ? 'Checking…' : credits.allowed ? 'Stop using credits' : 'Use credits past plan limits'}
        </Button>
      </div>
    </div>
  );
}
