/**
 * Settings ▸ MCP servers — what this instance's sessions may connect to (7.0's
 * place since quiet-console phase 23; the basename is kept, so the section
 * stays a chunk of its own, `mcp-*`, held by `check-dist`).
 *
 * ```
 * [Registered (3)]  Catalog
 *
 * Registered servers                                   Re-check all
 * ● Connected   GitHub  github      http · 41 tools · checked 4 min ago   Switch off
 * ● Needs sign-in   Linear  linear   http · never checked                 Switch on
 *   ▾ https://mcp.linear.app/sse
 *     Name  [ Linear      ]  Rename
 *     Sign in for  [ This console ▾ ]  Sign in
 *     Remove
 *
 * When a server cannot be reached
 * When one of a phase's servers cannot be reached   [ continue ▾ ]
 * ```
 *
 * Two halves, two questions: the registry is "what do I have, and is it
 * working" — opened when a phase parked — and the catalog (`?tab=catalog`,
 * `./mcp-catalog`) is "what could I have", opened once, when a machine is set
 * up. Registering, renaming, signing in and removing need `--allow-mcp`;
 * reading never does, and the section says what the flag would add rather
 * than hiding it.
 *
 * A server is ONE row that opens in place: its status, its name and id, its
 * transport, how many tools it advertises and when it was last checked, and
 * its one act (switch it on or off); opened, everything else — the command,
 * what changed in its tools, the secrets it holds, its name, the sign-in and
 * the account it signs in for, and Remove.
 *
 * Signing in for an account (`accountId`, a PROFILE account) puts the token in
 * that account's config dir, so the runs that spend it see the server signed
 * in; absent, the token lands in this console's own, which the health probe
 * reads — the default keeps the sign-in and the status agreeing.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MCP_POLICIES } from '@shared/run-lifecycle.js';
import { useAccounts } from '@/data/accounts';
import { api, type McpLoginStart, type McpServerView } from '@/data/api';
import { keys } from '@/data/keys';
import { useMcp } from '@/data/mcp';
import { useRoute } from '@/shell/router';
import { navigate, sessionsHref, settingsHref } from '@/shell/routes';
import { SectionNav } from '@/shell/section-nav';
import { Banner, Button, Empty, Input, Label, Mono, RelativeTime, Row, Skeleton, toast } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { CopyButton } from '@/ui/copy-button';
import { Dialog, DialogContent } from '@/ui/dialog';
import { NativeSelect } from '@/ui/native-select';
import { McpStatus } from '@/ui/status';
import { McpCatalog } from './mcp-catalog';
import { SettingsGroup, WordSetting, failureWords, useSetting } from './setting';

/** How many servers is a working number, per the ecosystem's own experience. */
const COMFORTABLE = 6;

/**
 * Transports a console sign-in can reach — the ones `claude mcp add` accepts.
 *
 * The server half of this list lives in `server/mcp/login.ts`, which is the
 * authority; this copy exists so the button can be absent rather than present
 * and refusing. They are held together by `mcp-login.test.ts`, which asserts
 * the server refuses exactly what this list omits.
 */
const SIGNABLE_TRANSPORTS: readonly McpServerView['transport'][] = ['http', 'sse'];

/** Why a write cannot be made here. */
const NEEDS_FLAG = 'Start the console with --allow-mcp to register, rename or sign in a server.';

/** What each answer to "a server cannot be reached" does, in a person's words. */
const POLICY_WORDS: Readonly<Record<string, string>> = {
  continue: 'Run without it and record an errand',
  require: 'Park the phase until it is signed in',
};

/** Cannot be reached at all — as opposed to reachable but drifted. */
export function cannotConnect(server: Pick<McpServerView, 'status'>): boolean {
  return server.status === 'needs-auth' || server.status === 'failed';
}

/** One server's facts on its row, in words: switched off, transport, tools. */
export function serverFact(server: McpServerView): string {
  return [
    server.enabled ? null : 'Switched off',
    server.transport,
    server.toolCount ? `${server.toolCount} ${server.toolCount === 1 ? 'tool' : 'tools'}` : null,
    server.needsConfig?.length ? `needs ${server.needsConfig.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One press at a time, the registry read again afterwards. */
function usePresses() {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(which: string, call: () => Promise<T>, after?: (result: T) => void) => {
    setBusy(which);
    try {
      const result = await call();
      after?.(result);
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: keys.mcp() });
    }
  };
  return { busy, run };
}

export function McpServersSection() {
  const route = useRoute();
  const tab = route.query.tab === 'catalog' ? 'catalog' : 'registry';
  const { data, isPending } = useMcp();
  const policy = useSetting<string>('mcpPolicy');
  const servers = data?.servers ?? [];
  const allowed = data?.allowMcp ?? false;
  const attached = servers.filter((server) => server.enabled);
  // Two different problems: a server that cannot be reached, and one that
  // connects perfectly and now advertises a different tool list.
  const unreachable = attached.filter(cannotConnect);
  const drifted = attached.filter((server) => Boolean(server.toolsChanged) && !cannotConnect(server));
  // What an unreachable server COSTS depends on the policy in force: the
  // shipped `continue` boards without it; only `require` parks.
  const consequence =
    policy.value === 'require' ? 'will park at boarding' : 'will run without it and record an errand';

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="mcp-settings">
      {unreachable.length > 0 && (
        <Banner severity="error">
          {unreachable.length === 1
            ? `${unreachable[0]!.label} cannot be reached — a phase naming it ${consequence}.`
            : `${unreachable.length} servers cannot be reached — a phase naming one ${consequence}.`}
        </Banner>
      )}
      {drifted.length > 0 && (
        <Banner severity="warn">
          {drifted.length === 1
            ? `${drifted[0]!.label} connects, but advertises different tools than it did when it was attached.`
            : `${drifted.length} servers connect, but advertise different tools than they did when they were attached.`}
        </Banner>
      )}
      <SectionNav
        label="MCP server views"
        current={tab}
        sections={[
          { id: 'registry', label: `Registered (${servers.length})`, href: settingsHref('mcp') },
          { id: 'catalog', label: 'Catalog', href: settingsHref('mcp', { tab: 'catalog' }) },
        ]}
      />
      {tab === 'catalog' ? (
        <McpCatalog allowed={allowed} registered={new Set(servers.map((server) => server.id))} />
      ) : isPending ? (
        <div className="flex min-w-0 flex-col gap-3" aria-busy="true" aria-label="Reading the servers">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : (
        <>
          <Registry servers={servers} allowed={allowed} attached={attached.length} />
          <SettingsGroup
            id="mcp-policy"
            title="When a server cannot be reached"
            lead="Asked before a phase boards, of every server it names. A plan or a phase may say otherwise, and outranks this."
          >
            <WordSetting
              pref="mcpPolicy"
              label="When one of a phase’s servers cannot be reached"
              options={MCP_POLICIES.map((word) => [word, POLICY_WORDS[word] ?? word] as const)}
            />
          </SettingsGroup>
        </>
      )}
    </div>
  );
}

/* ---------------- the registry ---------------- */

function Registry({
  servers,
  allowed,
  attached,
}: {
  servers: McpServerView[];
  allowed: boolean;
  attached: number;
}) {
  const { busy, run } = usePresses();
  const recheck = (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy !== null || !attached}
      onClick={() =>
        void run(
          'refresh',
          () => api.mcpRefresh(),
          () => toast('Re-checked every server that is switched on.', 'ok'),
        )
      }
    >
      {busy === 'refresh' ? 'Checking…' : 'Re-check all'}
    </Button>
  );

  return (
    <SettingsGroup
      id="mcp-registry"
      title="Registered servers"
      aside={servers.length ? recheck : undefined}
      lead={
        servers.length
          ? `${attached} of ${servers.length} switched on. Every server costs context on every turn — three to six is the range people settle at.`
          : undefined
      }
    >
      {!servers.length ? (
        <Empty
          title="No server is registered: sessions here run with this machine’s own MCP configuration."
          action={
            <Button size="sm" asChild>
              <a href={settingsHref('mcp', { tab: 'catalog' })}>Open the catalog</a>
            </Button>
          }
        />
      ) : (
        <>
          {attached > COMFORTABLE && (
            <Banner severity="warn">
              {attached} servers are switched on. Each adds tool names that can collide with another server’s;
              the run page shows which ones a phase actually called.
            </Banner>
          )}
          <div className="flex min-w-0 flex-col" data-testid="mcp-list">
            {servers.map((server) => (
              <ServerRow key={server.id} server={server} allowed={allowed} />
            ))}
          </div>
        </>
      )}
      {!allowed && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          {NEEDS_FLAG} Reading the registry, the statuses and the catalog works without it.
        </p>
      )}
    </SettingsGroup>
  );
}

function ServerRow({ server, allowed }: { server: McpServerView; allowed: boolean }) {
  const { busy, run } = usePresses();
  return (
    <Row
      data-mcp-server={server.id}
      mark={<McpStatus status={server.status} />}
      name={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate">{server.label}</span>
          <Mono value={server.id} className="min-w-0 truncate text-meta text-ink-muted" />
        </span>
      }
      fact={serverFact(server)}
      clock={
        server.checkedAt ? (
          <>
            checked <RelativeTime at={server.checkedAt} />
          </>
        ) : (
          'never checked'
        )
      }
      action={
        allowed ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void run('toggle', () => api.mcpPatch(server.id, { enabled: !server.enabled }))}
          >
            {server.enabled ? 'Switch off' : 'Switch on'}
          </Button>
        ) : undefined
      }
      expandLabel={`details of ${server.label}`}
    >
      <ServerDetails server={server} allowed={allowed} />
    </Row>
  );
}

/** What a sign-in the console could not run needs instead, kept until it works. */
interface ByHand {
  detail?: string | undefined;
  commands: string[];
  configDir?: string | undefined;
  accountLabel?: string | undefined;
}

function ServerDetails({ server, allowed }: { server: McpServerView; allowed: boolean }) {
  const { busy, run } = usePresses();
  const [secretFor, setSecretFor] = useState<string | null>(null);
  const [byHand, setByHand] = useState<ByHand | null>(null);
  const signable = SIGNABLE_TRANSPORTS.includes(server.transport) && server.auth.kind === 'oauth';

  const signedIn = (started: McpLoginStart) => {
    if (started.mode === 'embedded' && started.terminal) {
      setByHand(null);
      toast('Finish the sign-in in the terminal that just opened.', 'info');
      navigate(sessionsHref(started.terminal.sessionId));
      return;
    }
    if (started.mode === 'external') {
      setByHand(null);
      toast('A terminal opened — finish the sign-in there.', 'info');
      return;
    }
    // No flow could start: the commands that would, kept on the row until the
    // sign-in works — a toast is gone before anybody can read a command.
    setByHand({
      detail: started.detail,
      commands: started.commands?.length ? started.commands : [started.command],
      configDir: started.configDir,
      accountLabel: started.accountLabel,
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 pb-2" data-mcp-details={server.id}>
      <p className="min-w-0 text-meta text-ink-muted">
        <code className="wrap-anywhere font-mono">{server.url ?? server.command}</code>
      </p>
      {server.issue && <Banner severity="error">{server.issue}</Banner>}
      {server.needsConfig?.length ? (
        <Banner severity="warn">
          Its command refers to {server.needsConfig.join(', ')}, which nothing supplies, so it can never
          connect. Register it again with the value filled in.
        </Banner>
      ) : null}
      {server.toolsChanged && (
        <Banner severity="warn">
          <span className="flex min-w-0 flex-col gap-2">
            <span>
              It now advertises different tools than it did <RelativeTime at={server.toolsChanged.seenAt} />.
              {server.toolsChanged.added.length ? ` Added: ${server.toolsChanged.added.join(', ')}.` : ''}
              {server.toolsChanged.removed.length
                ? ` Removed: ${server.toolsChanged.removed.join(', ')}.`
                : ''}{' '}
              A server whose tools change under you is how a trusted integration becomes an untrusted one —
              check what changed before the next run attaches it.
            </span>
            <Button
              size="sm"
              className="self-start"
              disabled={busy !== null}
              onClick={() => void run('acknowledge', () => api.mcpAcknowledge(server.id))}
            >
              I have checked it
            </Button>
          </span>
        </Banner>
      )}
      {server.interactiveTools?.length ? (
        <Banner severity="warn">
          {server.interactiveTools.join(', ')} ask a person to approve every call, which an unattended run
          never can: a phase that needs {server.interactiveTools.length === 1 ? 'that tool' : 'those tools'}{' '}
          stalls rather than finishes.
        </Banner>
      ) : null}
      {server.lastUsed && (
        <p className="text-meta text-ink-muted">
          Last used <RelativeTime at={server.lastUsed} />.
        </p>
      )}

      {server.auth.secrets.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-2" aria-label={`What ${server.label} needs`}>
          {server.auth.secrets.map((held) => (
            <li key={held.ref} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-body">
              <Mono value={held.ref} />
              <span className="text-meta text-ink-muted">
                {held.held ? 'Held in the keychain' : 'Not set'}
              </span>
              {allowed && (
                <Button size="sm" variant="ghost" onClick={() => setSecretFor(held.ref)}>
                  {held.held ? 'Replace' : 'Set'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {server.auth.kind === 'oauth' && !SIGNABLE_TRANSPORTS.includes(server.transport) && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          A <code className="font-mono">{server.transport}</code> server cannot be signed in from here — the
          Claude CLI’s <code className="font-mono">mcp add</code> takes stdio, sse and http, and the sign-in
          works by registering the server with it first. Give it a header this console holds instead.
        </p>
      )}

      {allowed ? (
        <div className="flex min-w-0 flex-col gap-4">
          <RenameServer server={server} busy={busy} run={run} />
          {signable && (
            <SignIn
              server={server}
              busy={busy}
              onSignIn={(accountId) =>
                void run('login', () => api.mcpLogin(server.id, accountId ? { accountId } : {}), signedIn)
              }
            />
          )}
          {byHand && <ByHandPanel server={server} byHand={byHand} onDismiss={() => setByHand(null)} />}
          <ConfirmButton
            size="sm"
            variant="ghost"
            className="self-start"
            title={`Remove ${server.label}?`}
            confirmLabel="Remove server"
            cancelLabel="Keep it"
            destructive
            busy={busy === 'remove'}
            details={
              <span className="mt-2 flex flex-col gap-2 text-body text-ink-muted">
                <span>
                  The registration and anything this console holds for it — keychain entries, stored headers —
                  are deleted. A plan that names <code className="font-mono">{server.id}</code> parks at
                  boarding until it is registered again or the name is dropped from the plan.
                </span>
                <span>
                  An OAuth sign-in stays where it is:{' '}
                  <code className="font-mono">claude mcp logout {server.id}</code> clears that, because the
                  CLI owns it and this console never writes to its credential store.
                </span>
              </span>
            }
            onConfirm={() =>
              void run(
                'remove',
                () => api.mcpDelete(server.id),
                () => toast(`${server.label} removed, with anything it held.`, 'ok'),
              )
            }
          >
            Remove
          </ConfirmButton>
        </div>
      ) : (
        <p className="max-w-(--measure) text-meta text-ink-muted">{NEEDS_FLAG}</p>
      )}

      {secretFor && (
        <SecretDialog
          server={server}
          secretRef={secretFor}
          busy={busy}
          run={run}
          onClose={() => setSecretFor(null)}
        />
      )}
    </div>
  );
}

type Run = <T>(which: string, call: () => Promise<T>, after?: (result: T) => void) => Promise<void>;

/** The name a page shows. The id a plan names never moves. */
function RenameServer({ server, busy, run }: { server: McpServerView; busy: string | null; run: Run }) {
  const [label, setLabel] = useState(server.label);
  const next = label.trim();
  const id = `mcp-name-${server.id}`;
  return (
    <form
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!next || next === server.label) return;
        void run(
          'rename',
          () => api.mcpPatch(server.id, { label: next }),
          () => toast(`Renamed to ${next}. Plans still name it ${server.id}.`, 'ok'),
        );
      }}
    >
      <Label htmlFor={id}>Name</Label>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <Input
          id={id}
          className="w-full sm:w-64"
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy !== null || !next || next === server.label}>
          {busy === 'rename' ? 'Renaming…' : 'Rename'}
        </Button>
      </span>
      <span className="text-meta text-ink-muted">
        What this page and the run page call it. A plan names it by its id, which stays {server.id}.
      </span>
    </form>
  );
}

/** Sign the server in — for this console, or for a profile account whose runs will use it. */
function SignIn({
  server,
  busy,
  onSignIn,
}: {
  server: McpServerView;
  busy: string | null;
  onSignIn: (accountId: string) => void;
}) {
  const { data } = useAccounts();
  const profiles = (data?.accounts ?? []).filter((account) => account.kind === 'profile');
  const [accountId, setAccountId] = useState('');
  const id = `mcp-signin-${server.id}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>Sign in for</Label>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <NativeSelect
          id={id}
          className="w-full sm:w-64"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
        >
          <option value="">This console</option>
          {profiles.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name ?? account.email ?? account.id}
            </option>
          ))}
        </NativeSelect>
        <Button size="sm" disabled={busy !== null} onClick={() => onSignIn(accountId)}>
          {busy === 'login' ? 'Starting…' : server.status === 'connected' ? 'Sign in again' : 'Sign in'}
        </Button>
      </span>
      <span className="max-w-(--measure) text-meta text-ink-muted">
        {profiles.length
          ? 'The token lands in that account’s own config dir, so the runs that spend it see the server signed in. This console’s own is what its health check reads.'
          : 'The token lands in this console’s own config dir, which its health check reads. A profile account added under Accounts can be signed in for too.'}
      </span>
    </div>
  );
}

function ByHandPanel({
  server,
  byHand,
  onDismiss,
}: {
  server: McpServerView;
  byHand: ByHand;
  onDismiss: () => void;
}) {
  const commands = byHand.commands.join('\n');
  return (
    <div className="flex min-w-0 flex-col gap-2 border-s-2 border-s-rule ps-3" role="status">
      <p className="text-body text-ink">This console cannot run the sign-in for {server.label}.</p>
      {byHand.detail && <p className="text-meta text-ink-muted">{byHand.detail}</p>}
      {byHand.commands.length > 0 && (
        <>
          <p className="max-w-(--measure) text-meta text-ink-muted">
            Run {byHand.commands.length > 1 ? 'these' : 'this'} in a terminal, then re-check.
            {byHand.configDir && (
              <>
                {' '}
                The token lands in <code className="wrap-anywhere font-mono">{byHand.configDir}</code>
                {byHand.accountLabel ? `, ${byHand.accountLabel}’s config dir.` : '.'}
              </>
            )}
          </p>
          <pre
            dir="ltr"
            className="whitespace-pre-wrap wrap-anywhere rounded bg-ground p-2 font-mono text-meta text-ink"
          >
            {commands}
          </pre>
        </>
      )}
      <span className="flex flex-wrap gap-2">
        {byHand.commands.length > 0 && <CopyButton text={commands} label="Copy the commands" />}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </span>
    </div>
  );
}

/** A secret, typed once, stored in the keychain — never in the registry file and never shown again. */
function SecretDialog({
  server,
  secretRef,
  busy,
  run,
  onClose,
}: {
  server: McpServerView;
  secretRef: string;
  busy: string | null;
  run: Run;
  onClose: () => void;
}) {
  const [secret, setSecret] = useState('');
  const [kind, ...rest] = secretRef.split(':');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Set ${secretRef}`}
        description="Stored in this machine’s keychain, never in the registry file and never shown again."
      >
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!secret.trim()) return;
            void run(
              'secret',
              () =>
                api.mcpPatch(server.id, {
                  secretRef: { kind: kind ?? '', name: rest.join(':') },
                  secret: secret.trim(),
                }),
              () => {
                onClose();
                toast('Stored. Re-checking the connection…', 'ok');
                void api.mcpRefresh().catch(() => {
                  /* the row says whether it helped */
                });
              },
            );
          }}
        >
          <Input
            type="password"
            autoFocus
            aria-label={secretRef}
            value={secret}
            placeholder="Paste the token"
            onChange={(event) => setSecret(event.target.value)}
          />
          <span className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={!secret.trim() || busy !== null}>
              Store it
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </span>
        </form>
      </DialogContent>
    </Dialog>
  );
}
