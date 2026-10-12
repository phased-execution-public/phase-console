/**
 * Who pays for a run, and the move to another account (7.0, quiet-console
 * phase 22) — the one control every surface that spends an account lends: a
 * recovery whose headline is the account (`cards/recovery-actions.tsx`
 * `parts.AccountRow`) and the run's settings sheet.
 *
 * ```
 * Account   work (work@example.com), Max, 5-hour 42 %        [ work ▾ ]  [ now ▾ ]  [Switch account]
 * Checkpoints phase 3 now (the session id is kept); phase 7 finishes on the old account first.
 * ```
 *
 * Not a setting: settings say what the NEXT phase spends. This acts now — a
 * live session still working is checkpointed (its session id kept) and tried
 * again under the chosen account, or, at the next boundary, every lane
 * finishes where it started. What a switch would cut is the server's own
 * preview, asked while a choice is pending and never guessed from the lanes
 * on the page. Every account is listed with the current one marked: a list
 * of the others read as "the console only knows one account".
 */

import { useState } from 'react';
import { SWITCH_WHEN, type SwitchWhen } from '@shared/run-lifecycle.js';
import type { RecoveryParts } from '@/cards/recovery-actions';
import { useAccounts, useSwitchAccount, useSwitchPreview } from '@/data/accounts';
import type { AccountView } from '@/data/api';
import { accountName } from '@/shell/limits';
import { settingsHref } from '@/shell/routes';
import { Button, toast } from '@/ui';
import { NativeSelect } from '@/ui/native-select';

/** Phases as prose: "phase 3", "phases 3 and 5", "phases 3, 5 and 7". */
function phasesText(phases: readonly number[]): string {
  if (phases.length === 1) return `phase ${phases[0]}`;
  return `phases ${phases.slice(0, -1).join(', ')} and ${phases[phases.length - 1]}`;
}

/** What a switch would do to the live lanes, in a sentence — from the server's own preview. */
export function switchPreviewWords(
  when: SwitchWhen,
  preview: { wouldCheckpoint?: number[]; deferred?: number[] },
): string {
  const cut = preview.wouldCheckpoint ?? [];
  const finish = preview.deferred ?? [];
  if (!cut.length && !finish.length) return 'No session is live — the next one starts on the new account.';
  const parts = [
    cut.length ? `Checkpoints ${phasesText(cut)} now (the session id is kept)` : 'Checkpoints nothing',
    finish.length
      ? `${phasesText(finish)} finish${finish.length === 1 ? 'es' : ''} on the old account first`
      : null,
  ];
  return `${when === 'boundary' ? 'At the next boundary: ' : ''}${parts.filter(Boolean).join('; ')}.`;
}

/** What a switch did, in a sentence — the verb's own `checkpointed`, `deferred` and `rekeyed`. */
export function switchedWords(outcome: {
  checkpointed?: number;
  deferred?: number[];
  rekeyed?: number;
}): string {
  const parts = ['Switched'];
  if (outcome.checkpointed)
    parts.push(`${outcome.checkpointed} live session${outcome.checkpointed === 1 ? '' : 's'} checkpointed`);
  if (outcome.deferred?.length)
    parts.push(`${phasesText(outcome.deferred)} finish${outcome.deferred.length === 1 ? 'es' : ''} first`);
  if (outcome.rekeyed)
    parts.push(`${outcome.rekeyed} queued phase${outcome.rekeyed === 1 ? '' : 's'} moved with it`);
  return `${parts.join(' — ')}. The next session runs under the other account.`;
}

/**
 * How an account reads in the picker: its name, the email when the name is not
 * it (the machine login's too — the picker that decides who pays must say
 * which Claude account "machine login" is), its plan and its 5-hour window.
 */
export function accountChoiceWords(account: AccountView, current: string): string {
  const name = accountName(account);
  const five = account.usage?.buckets.five_hour?.utilization;
  return [
    account.email && account.email !== name ? `${name} (${account.email})` : name,
    account.plan ?? null,
    typeof five === 'number' ? `5-hour ${Math.round(five)} %` : null,
    account.id === current ? 'now' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The words a choice's button title gives: what pressing it will do. */
const SWITCH_TITLES: Readonly<Record<SwitchWhen | 'same', string>> = Object.freeze({
  same: 'The run is already on this account — pick another, or the roomiest.',
  now: 'A live session is checkpointed (its session id kept) and tried again under the chosen account right away.',
  boundary:
    'No live session is cut: each finishes on the account it started on, and everything after runs on the new one.',
});

const WHEN_WORDS: Readonly<Record<SwitchWhen, string>> = Object.freeze({
  now: 'now',
  boundary: 'at the next boundary',
});

export function RunAccountRow({
  slug,
  run,
  disabled = false,
}: {
  slug: string;
  /** Only the account is read: a recovery carries a narrow slice of the run. */
  run: { accountId?: string } | null | undefined;
  disabled?: boolean;
}) {
  const { data: accountsState } = useAccounts();
  const accounts = accountsState?.accounts ?? [];
  const current = run?.accountId ?? 'default';
  const [choice, setChoice] = useState<string | null>(null);
  const [when, setWhen] = useState<SwitchWhen>('now');
  const [busy, setBusy] = useState(false);
  const pending = choice !== null && choice !== current ? choice : null;
  const preview = useSwitchPreview(slug, pending, when);
  const switchAccount = useSwitchAccount(slug);

  if (!run || (accounts.length < 2 && !accountsState?.allowAccounts)) return null;

  const currentView = accounts.find((account) => account.id === current);
  const currentWords = currentView
    ? accountName(currentView)
    : current === 'default'
      ? 'machine login'
      : current;

  if (accounts.length < 2) {
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-meta" data-run-account>
        <span className="text-ink-muted">
          Account <span className="text-ink">{currentWords}</span>
        </span>
        <a
          href={settingsHref('accounts')}
          className="tap-line text-ink-muted underline decoration-ink-faint underline-offset-2 hover:text-ink"
        >
          Add another account to switch mid-run
        </a>
      </div>
    );
  }

  // Truthful by construction: the picker shows where the run IS until a
  // choice is made, and survives the run switching underneath it.
  const value = choice ?? current;
  const press = async () => {
    setBusy(true);
    try {
      const outcome = await switchAccount(value, when);
      toast(
        outcome.ok ? switchedWords(outcome) : (outcome.reason ?? 'The switch was refused and said nothing.'),
        outcome.ok ? 'ok' : 'warn',
      );
      if (outcome.ok) setChoice(null);
    } catch (error) {
      toast((error as Error).message || 'The switch failed and said nothing.', 'error');
    } finally {
      setBusy(false);
    }
  };

  // The server refuses a preview as it refuses the switch — a 409 whose
  // `error` is the reason, which the transport throws — so a failed preview
  // IS the answer, said in its words: an `ok`-only line was a silence exactly
  // where the switch would be refused.
  const previewWords =
    pending === null
      ? null
      : preview.isError
        ? preview.error.message || 'This switch would be refused.'
        : preview.data
          ? preview.data.ok
            ? switchPreviewWords(when, preview.data)
            : (preview.data.reason ?? 'This switch would be refused.')
          : null;

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-run-account>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-meta text-ink-muted">
          Account <span className="text-ink">{currentWords}</span>
        </span>
        <NativeSelect
          aria-label="Account for this run"
          className="w-full sm:w-auto sm:max-w-72"
          value={value}
          disabled={disabled || busy}
          onChange={(event) => setChoice(event.target.value)}
        >
          <option value="auto">The roomiest account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {accountChoiceWords(account, current)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="When to switch"
          className="w-full sm:w-auto"
          value={when}
          disabled={disabled || busy}
          onChange={(event) => setWhen(event.target.value as SwitchWhen)}
        >
          {SWITCH_WHEN.map((word) => (
            <option key={word} value={word}>
              {WHEN_WORDS[word]}
            </option>
          ))}
        </NativeSelect>
        <Button
          size="sm"
          disabled={disabled || busy || value === current}
          title={value === current ? SWITCH_TITLES.same : SWITCH_TITLES[when]}
          onClick={() => void press()}
        >
          {busy ? 'Switching…' : 'Switch account'}
        </Button>
      </div>
      {previewWords !== null && (
        <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="switch-preview">
          {previewWords}
        </p>
      )}
    </div>
  );
}

/** A recovery's account part: the same row, never held — a repair's row is pressed at once. */
function RecoveryAccountRow({ slug, run }: { slug: string; run: { accountId?: string } | null | undefined }) {
  return <RunAccountRow slug={slug} run={run ?? null} />;
}

/** What every surface lends a recovery it draws: the account a repair spends. */
export const ACCOUNT_RECOVERY_PARTS: RecoveryParts = Object.freeze({ AccountRow: RecoveryAccountRow });
