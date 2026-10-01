/**
 * Which account a run spends, and the verb to move it — one control, every
 * surface that can spend one.
 *
 * It began inside the run page's Controls card, which meant the choice existed
 * only where a run was already being configured. But the moment an operator
 * most needs it is the one where a run has STOPPED: every repair verb
 * (`retry`, `recheck`, `closeout`, `recover`, `resume-phase`) spends the run's
 * stored `accountId` and fires immediately, with no dialog and no choice — so a
 * plan that halted because one login hit its window would be repaired, again
 * and again, on that same login. Only "repair with a new agent" opened a form
 * with an account in it.
 *
 * `switchAccountRun` writes `state.accountId` on a stopped run and checkpoints
 * a live one, so the same control is correct in both places. Living in
 * `components/` is what lets `recovery-actions.tsx` mount it without a
 * feature → component edge pointing the wrong way.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@/components/ui';
import { api, type AccountView } from '@/lib/api';
import { keys, useAccounts } from '@/lib/queries';
import type { SwitchWhen } from '@shared/run-lifecycle.js';

/** Phases as prose: "phase 3", "phases 3 and 5", "phases 3, 5 and 7". */
function phasesText(phases: readonly number[]): string {
  if (phases.length === 1) return `phase ${phases[0]}`;
  return `phases ${phases.slice(0, -1).join(', ')} and ${phases[phases.length - 1]}`;
}

/** What a switch would do to the live lanes, in a sentence — from the server's own preview. */
export function previewText(
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

/** What a switch did, in a sentence — `checkpointed`, `deferred` and `rekeyed` as the verb answered them. */
export function switchedText(outcome: {
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

/** How an account reads in a picker: name, email, plan, and its 5-hour meter. */
function accountOptionLabel(account: AccountView, current: string): string {
  const name = account.builtIn
    ? (account.name ?? 'machine login')
    : (account.name ?? account.email ?? account.id);
  // The built-in row carries its email too (control-tower phase 13, #33): the
  // picker that decides who pays was the one surface that would not say which
  // Claude account "machine login" actually is.
  const email = account.email;
  const five = account.usage?.buckets.five_hour?.utilization;
  return [
    name,
    email && email !== name ? `(${email})` : null,
    account.plan ? `· ${account.plan}` : null,
    typeof five === 'number' ? `· 5h ${Math.round(five)}%` : null,
    account.id === current ? '· current' : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Which account this run spends, and the verb to move it NOW. Not a settings
 * field: settings say what the NEXT phase uses; this checkpoints a live
 * session (SIGTERM, session id kept) and re-attempts under the other login
 * without waiting for anything.
 *
 * EVERY account is listed, the current one marked — the old options-minus-
 * current select read as "the console only knows one account" on a machine
 * with two, which is precisely the question this row exists to answer.
 */
export function SwitchAccountRow({
  slug,
  run,
  disabled,
}: {
  slug: string;
  /**
   * Only `accountId` is read, so the prop asks for only that: `RecoveryCtx`
   * carries a narrow slice of the run and the picker has no business demanding
   * the other eighteen fields to render a select.
   */
  run: { accountId?: string } | null | undefined;
  disabled: boolean;
}) {
  const client = useQueryClient();
  const { data: accountsState } = useAccounts();
  const accounts = accountsState?.accounts ?? [];
  const current = run?.accountId ?? 'default';
  const [choice, setChoice] = useState<string | null>(null);
  const [when, setWhen] = useState<SwitchWhen>('now');
  const [busy, setBusy] = useState(false);
  const pending = choice !== null && choice !== (run?.accountId ?? 'default') ? choice : null;
  // The server's own answer to "what would this cut?" (#107 ask 2) — asked
  // while a choice is pending, never guessed from the lanes on this page.
  const preview = useQuery({
    queryKey: ['switch-preview', slug, pending, when] as const,
    queryFn: () => api.runSwitchPreview(slug, pending!, when),
    enabled: pending !== null,
    staleTime: 5_000,
  });
  if (!run || (accounts.length < 2 && !accountsState?.allowAccounts)) return null;

  const currentView = accounts.find((account) => account.id === current);
  const currentLabel = currentView
    ? accountOptionLabel(currentView, '').replace(/ · current$/, '')
    : current === 'default'
      ? 'machine login'
      : current;

  if (accounts.length < 2) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        <span className="text-2xs uppercase tracking-wide text-ink-faint">
          Account: <span className="normal-case text-ink-muted">{currentLabel}</span>
        </span>
        <a href="#/settings" className="text-2xs text-ink-faint underline hover:text-action">
          Add another account in Settings to switch mid-run
        </a>
      </div>
    );
  }

  // Truthful by construction: the select shows where the run IS until a choice
  // is made, and survives the run switching underneath it.
  const value = choice ?? current;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
      <span className="text-2xs uppercase tracking-wide text-ink-faint">
        Account: <span className="normal-case text-ink-muted">{currentLabel}</span>
      </span>
      <select
        className="h-8 [@media(hover:none)]:min-h-(--tap-min) max-w-72 rounded border border-rule bg-ground px-2 text-xs disabled:opacity-50"
        value={value}
        disabled={disabled || busy}
        onChange={(event) => setChoice(event.target.value)}
        aria-label="Account for this run"
      >
        <option value="auto">auto — most headroom</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {accountOptionLabel(account, current)}
          </option>
        ))}
      </select>
      <select
        className="h-8 [@media(hover:none)]:min-h-(--tap-min) rounded border border-rule bg-ground px-2 text-xs disabled:opacity-50"
        value={when}
        disabled={disabled || busy}
        onChange={(event) => setWhen(event.target.value as SwitchWhen)}
        aria-label="When to switch"
      >
        <option value="now">now</option>
        <option value="boundary">at the next boundary</option>
      </select>
      <Button
        size="sm"
        disabled={disabled || busy || value === current}
        title={
          value === current
            ? 'The run is already on this account — pick another, or auto.'
            : when === 'boundary'
              ? 'No live session is cut: each finishes on the account it started on, and everything after runs on the new one.'
              : 'A live session is checkpointed (its session id kept) and re-attempted under the chosen account right away.'
        }
        onClick={() => {
          setBusy(true);
          api
            .runSwitchAccount(slug, value, when)
            .then((outcome) => {
              toast(
                outcome.ok ? switchedText(outcome) : (outcome.reason ?? 'Could not switch.'),
                outcome.ok ? 'ok' : 'warn',
              );
              if (outcome.ok) setChoice(null);
              void client.invalidateQueries({ queryKey: keys.runs() });
              void client.invalidateQueries({ queryKey: keys.run(slug) });
            })
            .catch((error: Error) => toast(String(error.message ?? error), 'error'))
            .finally(() => setBusy(false));
        }}
      >
        Switch account
      </Button>
      {pending !== null && preview.data ? (
        <p className="basis-full text-2xs text-ink-muted" data-testid="switch-preview">
          {preview.data.ok
            ? previewText(when, preview.data)
            : (preview.data.reason ?? 'This switch would be refused.')}
        </p>
      ) : null}
    </div>
  );
}
