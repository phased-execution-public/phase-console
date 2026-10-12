/**
 * The repair beside an account's diagnosis (7.0, quiet-console phase 22;
 * control-tower phase 13, #33).
 *
 * Re-reading the numbers of a broken login is the one thing that cannot help
 * it, so the verb sits next to the diagnosis, by kind:
 *
 *   - a profile signs in again, in the embedded terminal that completes itself;
 *   - the machine login signs in again the same way — the CLI's own login — and
 *     offers its command to copy, because it belongs to a terminal too; while a
 *     live run pays as it the server warns first (#131: a re-login as somebody
 *     else ends that run's sessions), and this asks the person;
 *   - a token is REPLACED, keeping its id and name — re-pasting used to mint a
 *     second account for one identity.
 */

import { useState } from 'react';
import { RELOGIN_CONFIRM } from '@shared/ops-vocab.js';
import { useAccountsCache } from '@/data/accounts';
import { api, type AccountLoginStart, type AccountView } from '@/data/api';
import { navigate, sessionsHref } from '@/shell/routes';
import { Button, Input, copy, toast } from '@/ui';
import { ConfirmDialog } from '@/ui/confirm';
import { failureWords } from './setting';

/** The command that signs the machine login in again, as a person types it. */
export const MACHINE_LOGIN_COMMAND = 'claude auth login';

/** Does this account's diagnosis call for a repair: not signed in, expired, signed out, or a meter that cannot read it? */
export function needsRepair(account: AccountView): boolean {
  return (
    (account.kind === 'profile' && account.signedIn === false) ||
    account.authState === 'expired' ||
    account.authState === 'signed-out' ||
    Boolean(account.usage?.unsupported) ||
    account.meter === 'broken'
  );
}

/** What a started sign-in did, said — and where it went. */
export function loginStarted(started: AccountLoginStart): void {
  if (started.mode === 'embedded' && started.terminal) {
    toast('Sign in inside the terminal that just opened.', 'info');
    navigate(sessionsHref(started.terminal.sessionId));
  } else if (started.mode === 'external') {
    toast('A terminal opened — finish claude auth login there, then refresh.', 'info');
  } else {
    void copy(started.command, 'Command copied — run it in any terminal, then refresh');
  }
}

export function AccountRepair({ account, allowed }: { account: AccountView; allowed: boolean }) {
  const cache = useAccountsCache();
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState<'sign-in' | 'replace' | null>(null);
  const needsFlag = allowed ? undefined : 'Start the console with --allow-accounts to repair an account.';
  const name = account.name ?? account.email ?? account.id;

  const signIn = async (confirm?: string) => {
    setBusy('sign-in');
    try {
      const started = await api.accountLogin({ accountId: account.id, ...(confirm ? { confirm } : {}) });
      if (started.mode === 'warn') {
        setWarning(started.warning ?? 'A run is paying as this login right now.');
        return;
      }
      if (started.mode === 'replace-token') {
        setReplacing(true);
        return;
      }
      void cache.reread();
      loginStarted(started);
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const replace = async () => {
    setBusy('replace');
    try {
      await api.accountReplaceToken(account.id, token.trim());
      setReplacing(false);
      setToken('');
      void cache.reread();
      toast('Token replaced. The account keeps its name, and its meters read again.', 'ok');
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (account.kind === 'token') {
    return replacing ? (
      <form
        className="flex w-full min-w-0 flex-wrap items-center gap-2"
        data-testid="replace-token"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim()) void replace();
        }}
      >
        <Input
          aria-label={`New token for ${name}`}
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="a fresh token from claude setup-token"
          className="min-w-0 flex-1 basis-56 font-mono"
          autoComplete="off"
        />
        <Button size="sm" variant="primary" type="submit" disabled={!token.trim() || busy !== null}>
          {busy === 'replace' ? 'Replacing…' : 'Replace token'}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setReplacing(false)}>
          Cancel
        </Button>
      </form>
    ) : (
      <Button
        size="sm"
        variant="ghost"
        disabled={!allowed}
        {...(needsFlag ? { title: needsFlag } : {})}
        onClick={() => setReplacing(true)}
      >
        Replace token
      </Button>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={!allowed || busy !== null}
        {...(needsFlag ? { title: needsFlag } : {})}
        onClick={() => void signIn()}
      >
        {busy === 'sign-in'
          ? 'Opening…'
          : account.kind === 'profile' && account.signedIn === false
            ? 'Sign in'
            : 'Sign in again'}
      </Button>
      {account.builtIn && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void copy(MACHINE_LOGIN_COMMAND, 'Command copied — run it in a terminal, then refresh')
          }
        >
          Copy the command
        </Button>
      )}
      <ConfirmDialog
        open={warning !== null}
        onOpenChange={(open) => (open ? null : setWarning(null))}
        title="Sign the machine login in again?"
        description={warning ?? ''}
        confirmLabel="Sign in again"
        cancelLabel="Leave it signed in"
        destructive
        onConfirm={() => {
          setWarning(null);
          void signIn(RELOGIN_CONFIRM);
        }}
      />
    </>
  );
}
