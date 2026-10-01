/**
 * The verb beside an account's diagnosis (control-tower phase 13, #33).
 *
 * The usage dialog named four failures — not signed in, login expired, signed
 * out, a credential the usage endpoint does not serve — and the only control
 * beside any of them re-read the numbers, the one thing that cannot help a
 * login that broke. The dialog already knows the diagnosis, so the repair sits
 * next to it, by kind:
 *
 *   - a profile signs in again, in the embedded terminal that completes itself;
 *   - the machine login signs in again the same way — the CLI's own login — and
 *     its command is offered to copy, because it belongs to a terminal too;
 *     while a live run pays as it the server warns first (#131: a re-login as
 *     someone else ends that run's sessions), and this asks the person;
 *   - a token is REPLACED, keeping its id — re-pasting used to mint a second
 *     account for one identity.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RELOGIN_CONFIRM } from '@shared/ops-vocab.js';
import { navigate } from '@/app/router';
import { api, type AccountLoginStart, type AccountView } from '@/lib/api';
import { keys, toastError, useConsoleState } from '@/lib/queries';
import { AlertDialog, AlertDialogContent, Button, copy, field, toast } from '@/components/ui';

/** The command that signs the machine login in again, as a person types it. */
export const MACHINE_LOGIN_COMMAND = 'claude auth login';

/** Does this account's diagnosis call for a repair — one of the dialog's four chips, or a broken meter? */
export function needsRepair(account: AccountView): boolean {
  return (
    (account.kind === 'profile' && account.signedIn === false) ||
    account.authState === 'expired' ||
    account.authState === 'signed-out' ||
    Boolean(account.usage?.unsupported) ||
    account.meter === 'broken'
  );
}

export function AccountRepair({ account }: { account: AccountView }) {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const allowed = state?.allowAccounts ?? false;
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const invalidate = () => client.invalidateQueries({ queryKey: keys.accounts() });

  const signIn = useMutation({
    mutationFn: (confirm?: string) =>
      api.accountLogin({ accountId: account.id, ...(confirm ? { confirm } : {}) }),
    onSuccess: (started: AccountLoginStart) => {
      if (started.mode === 'warn') {
        setWarning(started.warning ?? 'A run is paying as this login right now.');
        return;
      }
      void invalidate();
      if (started.mode === 'embedded' && started.terminal) {
        toast('Sign in inside the terminal that just opened.', 'info');
        navigate(`sessions/${started.terminal.sessionId}`);
      } else if (started.mode === 'external') {
        toast('A terminal opened — finish `claude auth login` there, then Refresh.', 'info');
      } else if (started.mode === 'replace-token') {
        setReplacing(true);
      } else {
        void copy(started.command, 'Command copied — run it in any terminal, then Refresh');
      }
    },
    onError: toastError,
  });

  const replace = useMutation({
    mutationFn: () => api.accountReplaceToken(account.id, token.trim()),
    onSuccess: () => {
      setReplacing(false);
      setToken('');
      void invalidate();
      toast('Token replaced. The account keeps its name, and its meters read again.', 'ok');
    },
    onError: toastError,
  });

  const needsFlag = allowed ? undefined : 'Needs --allow-accounts';

  if (account.kind === 'token') {
    return replacing ? (
      <form
        className="flex w-full flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim()) replace.mutate();
        }}
      >
        <input
          aria-label={`New token for ${account.name ?? account.id}`}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="paste a fresh token from `claude setup-token`"
          className={`${field} min-w-0 flex-1`}
          autoComplete="off"
        />
        <Button size="sm" variant="action" type="submit" disabled={!token.trim() || replace.isPending}>
          {replace.isPending ? 'Replacing…' : 'Replace token'}
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
        disabled={!allowed || signIn.isPending}
        {...(needsFlag ? { title: needsFlag } : {})}
        onClick={() => signIn.mutate(undefined)}
      >
        {signIn.isPending ? 'Opening…' : 'Sign in again'}
      </Button>
      {account.builtIn ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void copy(MACHINE_LOGIN_COMMAND, 'Command copied — run it in a terminal, then Refresh')
          }
        >
          Copy command
        </Button>
      ) : null}
      <AlertDialog open={warning !== null} onOpenChange={(open) => (open ? null : setWarning(null))}>
        {warning !== null ? (
          <AlertDialogContent
            title="Sign the machine login in again?"
            description={warning}
            confirmLabel="Sign in again"
            cancelLabel="Leave it signed in"
            destructive
            onConfirm={() => {
              setWarning(null);
              signIn.mutate(RELOGIN_CONFIRM);
            }}
          />
        ) : null}
      </AlertDialog>
    </>
  );
}
