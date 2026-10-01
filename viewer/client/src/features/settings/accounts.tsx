/**
 * Claude accounts — this INSTANCE's registration system.
 *
 * Each console keeps its own registry (a per-instance fact, like its push
 * keys): the machine login is always row one, profiles are directories the
 * operator signs into, tokens are pasted from `claude setup-token`. The card
 * shows the meters beside the identities because that is the question the
 * registry exists to answer — which login has quota left for the next run.
 *
 * Registration is gated by `--allow-accounts`; READING is not. On a console
 * without the flag the card still meters the machine login and says what the
 * flag would add — a capability that hides when disabled looks like a bug.
 *
 * Pro draws one more card under this one: every account's breaker, the rank's
 * verdict, the meters' age and the per-run quota plan. This file is its one
 * import site, and the free tree keeps this card exactly as it is.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { keys, toastError, useAccounts, useConsoleState } from '@/lib/queries';
import { api, type AccountLoginStart, type AccountView } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CardSkeleton,
  Badge,
  ConfirmButton,
  Dialog,
  DialogContent,
  field,
  copy,
  toast,
} from '@/components/ui';
import { LimitsOverview } from '@/components/limits-overview';
import { navigate } from '@/app/router';
import { AccountRepair, needsRepair } from '@/components/account-repair';
import { RetirementEvidence } from '@/components/retirement-evidence';

/** The Accounts section's cards: the registry card, and (Pro) the dashboard under it. */
export function AccountsCard() {
  return (
    <>
      <RegistryCard />
    </>
  );
}

function RegistryCard() {
  const client = useQueryClient();
  const { data, isPending } = useAccounts();
  const { data: state } = useConsoleState();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [loginName, setLoginName] = useState('');

  const invalidate = () => client.invalidateQueries({ queryKey: keys.accounts() });

  const startLogin = useMutation({
    mutationFn: (body: { accountId?: string; name?: string }) => api.accountLogin(body),
    onSuccess: (started: AccountLoginStart) => {
      void invalidate();
      setLoginName('');
      if (started.mode === 'embedded' && started.terminal) {
        toast('Sign in inside the terminal that just opened.', 'info');
        navigate(`sessions/${started.terminal.sessionId}`);
      } else if (started.mode === 'external') {
        toast('A terminal opened — finish `claude auth login` there, then Refresh.', 'info');
      } else {
        void copy(started.command, 'Command copied — run it in any terminal, then Refresh');
      }
    },
    onError: toastError,
  });

  const addToken = useMutation({
    mutationFn: () => api.accountAdd(name.trim(), token.trim()),
    onSuccess: () => {
      setAdding(false);
      setName('');
      setToken('');
      void invalidate();
      toast('Account added. Its meters appear once the endpoint answers.', 'ok');
    },
    onError: toastError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.accountDelete(id),
    onSuccess: () => {
      void invalidate();
    },
    onError: toastError,
  });

  const refresh = useMutation({
    mutationFn: (id?: string) => api.accountRefresh(id),
    onSuccess: () => {
      void invalidate();
    },
    onError: toastError,
  });

  const rename = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string }) => api.accountRename(id, next),
    onSuccess: () => {
      void invalidate();
    },
    onError: toastError,
  });

  if (isPending && !data) return <CardSkeleton loading h="64" />;

  const allowed = data?.allowAccounts ?? state?.allowAccounts ?? false;
  const accounts = data?.accounts ?? [];
  const busy = startLogin.isPending || addToken.isPending || remove.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Claude accounts</CardTitle>
        {allowed ? <Badge tone="accent">registration enabled</Badge> : null}
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {/* Its rows below carry the sign-in and token verbs, so the overview does not repeat them. */}
        <LimitsOverview accounts={accounts} repair={false} />

        {allowed ? (
          <div className="flex flex-col gap-3 border-t border-rule pt-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                <span className="text-2xs uppercase tracking-wide text-ink-faint">
                  Sign another account in
                </span>
                <input
                  value={loginName}
                  onChange={(event) => setLoginName(event.target.value)}
                  placeholder="a name for it — work, personal…"
                  className={field}
                />
              </label>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => startLogin.mutate(loginName.trim() ? { name: loginName.trim() } : {})}
              >
                Sign in…
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAdding(true)}>
                Paste a token…
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              {accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  busy={busy}
                  onSignIn={() => startLogin.mutate({ accountId: account.id })}
                  onRefresh={() => refresh.mutate(account.id)}
                  onRemove={() => remove.mutate(account.id)}
                  onRename={(next) => rename.mutate({ id: account.id, next })}
                />
              ))}
            </div>
            <UnattendedOffer accounts={accounts} busy={busy} onAdd={() => setAdding(true)} />
          </div>
        ) : (
          <p className="border-t border-rule pt-3 text-xs text-ink-muted">
            Start the console with <code>--allow-accounts</code> to sign additional Claude accounts in (or
            paste <code>claude setup-token</code> tokens) and pick an account per run. The meters above work
            without it.
          </p>
        )}
      </CardBody>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent
          title="Add a token account"
          description="Run `claude setup-token` in any terminal signed into the account, then paste the token it prints. The name is required — a token carries no email to show."
        >
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="spare max account"
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Token</span>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="sk-ant-oat01-…"
                type="password"
                autoComplete="off"
                className={cn(field, 'font-mono')}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button
                disabled={!name.trim() || !token.trim() || addToken.isPending}
                onClick={() => addToken.mutate()}
              >
                Add account
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * The unattended path, offered (control-tower phase 91, #147): a login-backed
 * account's access token lapses every few hours and is renewed through the CLI
 * while this console runs, but a long-lived token never needs renewing — the
 * steadier choice for a run left alone for days. The sentence is the server's
 * (`AccountView.unattended`), so the card and the start door say one thing;
 * once a token account exists the path is taken and the offer steps back.
 */
function UnattendedOffer({
  accounts,
  busy,
  onAdd,
}: {
  accounts: AccountView[];
  busy: boolean;
  onAdd: () => void;
}) {
  const offer = accounts.find((account) => account.unattended)?.unattended;
  if (!offer || accounts.some((account) => account.kind === 'token')) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
      <p className="min-w-0 flex-1">{offer}</p>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onAdd}>
        Add a long-lived token…
      </Button>
    </div>
  );
}

/** "replace by 5 Oct" — when a setup-token stops working, in the reader's own calendar. */
function replaceBy(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? iso
    : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * One account's row: name (renameable — the display name only, ids are keys),
 * its login state, and the verbs that fit its kind. The machine login renames
 * and refreshes but never removes; a profile that lost its login says so and
 * offers the sign-in right here, where the badge is.
 */
function AccountRow({
  account,
  busy,
  onSignIn,
  onRefresh,
  onRemove,
  onRename,
}: {
  account: AccountView;
  busy: boolean;
  onSignIn: () => void;
  onRefresh: () => void;
  onRemove: () => void;
  onRename: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.name ?? '');
  const label = account.builtIn
    ? (account.name ?? 'machine login')
    : (account.name ?? account.email ?? account.id);
  const broken =
    account.authState === 'expired' || (account.authState === 'signed-out' && account.signedIn !== false);

  const save = () => {
    setEditing(false);
    if ((draft.trim() || '') !== (account.name ?? '')) onRename(draft);
  };

  return (
    <span className="flex flex-wrap items-center gap-1 rounded border border-rule px-2 py-1 text-xs">
      {editing ? (
        <>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={account.builtIn ? 'machine login' : account.id}
            className={cn(field, 'w-36')}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
              if (event.key === 'Escape') setEditing(false);
            }}
          />
          <Button size="sm" variant="ghost" disabled={busy} onClick={save}>
            Save
          </Button>
        </>
      ) : (
        <>
          <span className="max-w-40 truncate" title={account.email ?? account.id}>
            {label}
          </span>
          {account.email && label !== account.email ? (
            <span className="max-w-36 truncate text-ink-faint">{account.email}</span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title="Rename — the display name only; the id underneath never changes"
            onClick={() => {
              setDraft(account.name ?? '');
              setEditing(true);
            }}
          >
            Rename
          </Button>
        </>
      )}
      {account.authState === 'expired' ? <Badge tone="bad">login expired</Badge> : null}
      {account.authState === 'refreshable' ? <Badge>idle, renews at its next session</Badge> : null}
      {account.kind === 'token' && account.tokenExpiresAt ? (
        <Badge
          tone={account.authState === 'expiring' || account.authState === 'expired' ? 'accent' : undefined}
          title="A setup-token lasts a year from when it was added; paste a new one before then"
        >
          replace by {replaceBy(account.tokenExpiresAt)}
        </Badge>
      ) : null}
      {account.authState === 'signed-out' && account.signedIn !== false ? (
        <Badge tone="bad">signed out</Badge>
      ) : null}
      {account.kind === 'profile' && (account.signedIn === false || broken) ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onSignIn}>
          {account.signedIn === false ? 'Sign in' : 'Sign in again'}
        </Button>
      ) : null}
      {/* The verb beside the diagnosis for every kind (phase 25, #33): an
          expired machine login signs in again or copies the command; an
          expired or signed-out token is replaced in place, keeping its id. */}
      {account.kind !== 'profile' && needsRepair(account) ? <AccountRepair account={account} /> : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onRefresh}>
        Refresh
      </Button>
      {/* The confirm belongs to the ROW, not to the card: it names this
          account and describes what removing THIS kind takes with it, which a
          shared dialog could only do by carrying the selected account in state
          beside the row that already holds it. */}
      {!account.builtIn ? (
        <ConfirmButton
          size="sm"
          variant="ghost"
          disabled={busy}
          title={`Remove ${label}?`}
          confirmLabel="Remove account"
          cancelLabel="Keep it"
          destructive
          details={
            <>
              <p className="mt-2 text-sm text-ink-muted">
                What goes: this console&rsquo;s registration of it
                {account.kind === 'profile'
                  ? ', its profile directory and that directory’s login state (on macOS, its keychain entry too)'
                  : account.kind === 'token'
                    ? ' and the stored token'
                    : ''}
                .
              </p>
              <p className="mt-2 text-2xs text-ink-faint">
                What stays: the Anthropic account itself, and every recorded run. A run currently paying as
                this account refuses the removal — pause or switch it first.
              </p>
            </>
          }
          onConfirm={onRemove}
        >
          Remove
        </ConfirmButton>
      ) : null}
      <span className="basis-full empty:hidden">
        <RetirementEvidence entitlement={account.entitlement} />
      </span>
    </span>
  );
}
