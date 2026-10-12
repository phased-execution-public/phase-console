/** The Claude accounts this console may spend, with their meters. */

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SwitchWhen } from '@shared/run-lifecycle.js';
import { toast } from '@/ui/toast';
import { api, type AccountView, type AccountsState } from './api';
import { keys } from './keys';

/** The instance's Claude accounts with their meters — live via the `accounts` event. */
export function useAccounts(enabled = true) {
  return useQuery({ queryKey: keys.accounts(), queryFn: api.accounts, enabled });
}

/**
 * "Look again" — ask Claude for current usage now. `POST /api/accounts/refresh`
 * AWAITS the poll, so what comes back is fresher than what was on screen; with
 * no account it re-reads every account in one request, which is the question an
 * operator has ("is anything free right now?") and one round of the endpoint's
 * courtesy budget rather than N.
 */
export function useAccountRefresh(accountId?: string): { refresh: () => Promise<void>; busy: boolean } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await api.accountRefresh(accountId);
      // Both: `accounts` is the meters, `state` is the header's copy of them.
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.accounts() }),
        client.invalidateQueries({ queryKey: keys.state() }),
      ]);
      toast(accountId ? 'Re-read this account.' : 'Re-read every account.', 'ok');
    } catch (error) {
      toast((error as Error).message || 'The meters could not be re-read.', 'error');
    } finally {
      setBusy(false);
    }
  }, [accountId, client]);
  return { refresh, busy };
}

/* ------------------------------------------------------------------ *
 * The verbs that change what a run may spend (quiet-console phase 22: in
 * the free tree too, since 7.0 — they were the Pro dashboard's alone). Each
 * needs `--allow-accounts`, and each answers with the account as it now is,
 * which `useAccountsCache().put` draws before the stream catches up.
 * ------------------------------------------------------------------ */

/**
 * Clear a retired account — the one way out of the breaker's `retired`, a
 * person's, for the credential and every account in its organisation. The
 * server derives who pressed from the request.
 */
export function clearRetired(id: string) {
  return api.accountClearRetired(id);
}

/**
 * Ask the API whether the account may run work: ONE declared one-turn session
 * under it, recorded when it ends. A refusal retires the credential with its
 * organisation, as a phase's refusal would; 409 while a check of the same
 * account is running.
 */
export function probeEntitlement(id: string) {
  return api.accountProbeEntitlement(id);
}

/**
 * "Use credits past plan limits" for one account, or back to its plan limits.
 * The server checks the account's own credit state first and says why not
 * (409). `capUsd` stops the credit spend at that many dollars a month; absent,
 * the account's own spend limit is the only cap.
 */
export function overage(id: string, { allowed, capUsd }: { allowed: boolean; capUsd?: number }) {
  return api.accountOverage(id, allowed, capUsd);
}

/** The accounts list, patched with one account's fresh answer, and re-read. */
export function useAccountsCache() {
  const client = useQueryClient();
  return {
    put: (next: AccountView) =>
      client.setQueryData<AccountsState>(keys.accounts(), (old) =>
        old ? { ...old, accounts: old.accounts.map((row) => (row.id === next.id ? next : row)) } : old,
      ),
    reread: () => client.invalidateQueries({ queryKey: keys.accounts() }),
  };
}

/**
 * What moving a run to another account would do, doing none of it — the
 * server's own preview (`dry: true`): the live lanes it would checkpoint now,
 * and the ones it would leave to finish. Asked only while a choice is pending.
 */
export function useSwitchPreview(slug: string, accountId: string | null, when: SwitchWhen) {
  return useQuery({
    queryKey: keys.switchPreview(slug, accountId ?? '', when),
    queryFn: () => api.runSwitchPreview(slug, accountId ?? '', when),
    enabled: accountId !== null,
    staleTime: 5_000,
  });
}

/**
 * Move a run to another account: a live session still working is checkpointed
 * (its session id kept) and re-attempted under the account at once, or — `when:
 * 'boundary'` — every lane finishes where it started and the rest runs on the
 * new one. The run's caches re-read either way.
 */
export function useSwitchAccount(slug: string) {
  const client = useQueryClient();
  return useCallback(
    async (accountId: string, when: SwitchWhen) => {
      try {
        return await api.runSwitchAccount(slug, accountId, when);
      } finally {
        void client.invalidateQueries({ queryKey: keys.runs() });
        void client.invalidateQueries({ queryKey: keys.run(slug) });
      }
    },
    [client, slug],
  );
}
