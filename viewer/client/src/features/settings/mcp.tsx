/**
 * MCP servers — what this instance's sessions may connect to.
 *
 * Two halves, because they answer two different questions. **Registry** is
 * "what do I have, and is it working" — the one a person opens when a phase
 * parked. **Catalog** is "what could I have" — the one they open once, when
 * setting a machine up. The catalog lives in its own module (`./mcp-catalog`).
 *
 * Registration is gated by `--allow-mcp`; READING is not. Without the flag the
 * section still shows the registry, the statuses and the catalog, and says what
 * the flag would add — a capability that hides when disabled looks like a bug.
 *
 * The section is deliberately opinionated about restraint. Every attached
 * server costs context on every turn and adds tool names that can collide, so
 * the header states the working range rather than leaving people to discover
 * it, and a phase's own call counts (on the run page) are what settle the
 * argument.
 *
 * 3.0 folded `#/mcp` and `#/mcp/catalog` in here (`#/settings/mcp` and
 * `?tab=catalog`). The tab is a QUERY value rather than a path segment because
 * `#/settings/:section` is the address space now: a second segment would mean
 * every section could invent its own sub-path vocabulary, and the redirect that
 * carries the old links needs somewhere to put the half of the address that
 * survived — the `#/ready` → `?focus=next` rule.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { keys, toastError, useConsoleState, useMcp } from '@/lib/queries';
import { api, automationPrefs, type McpServerView } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  ConfirmButton,
  Dialog,
  DialogContent,
  Empty,
  RelativeTime,
  Skeleton,
  field,
  copy,
  toast,
} from '@/components/ui';
import { navigate } from '@/app/router';
import type { Route } from '@/app/router';
import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { SettingsSectionFrame, sectionFor } from './nav';
import { Catalog } from './mcp-catalog';

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

export function McpSection({ route }: { route: Route }) {
  const section = sectionFor('mcp')!;
  const tab = route.query.tab === 'catalog' ? 'catalog' : 'registry';
  const { data, isPending } = useMcp();
  const { data: state } = useConsoleState();
  const servers = data?.servers ?? [];
  const allowed = data?.allowMcp ?? false;

  const refresh = useMutation({
    mutationFn: () => api.mcpRefresh(),
    onSuccess: () => toast('Re-checked every enabled server.', 'ok'),
    onError: toastError,
  });

  const attached = servers.filter((server) => server.enabled);
  // Two different problems, and the banner used to state them as one.
  //
  // `needs-auth`/`failed` is a server that cannot be reached; `toolsChanged`
  // is one that connects perfectly and now advertises a different tool list.
  // Lumping them made a healthy server read as broken.
  const unreachable = attached.filter(cannotConnect);
  const drifted = attached.filter((server) => Boolean(server.toolsChanged) && !cannotConnect(server));

  // …and what an unreachable server COSTS depends on the resolved policy. The
  // shipped default is `continue`: the phase boards WITHOUT the server, names
  // it in the prompt and records an errand. Parking needs an explicit
  // `require` on the run, the plan or the phase. The banner claimed parking
  // unconditionally, which is the more alarming of the two readings and the
  // wrong one on a default console.
  const policy = automationPrefs(state).mcpPolicy;
  const consequence =
    policy === 'require' ? 'will park at boarding' : 'will run without it and record an errand';

  return (
    <SettingsSectionFrame section={section}>
      {unreachable.length > 0 && (
        <Banner severity="error">
          {unreachable.length === 1
            ? `${unreachable[0].label} cannot be reached — a phase naming it ${consequence}.`
            : `${unreachable.length} servers cannot be reached — a phase naming one ${consequence}.`}
        </Banner>
      )}
      {drifted.length > 0 && (
        <Banner severity="warn">
          {drifted.length === 1
            ? `${drifted[0].label} connects, but advertises different tools than it did when it was attached.`
            : `${drifted.length} servers connect, but advertise different tools than they did when they were attached.`}
        </Banner>
      )}

      <Tabs.Root
        value={tab}
        onValueChange={(next) => navigate(next === 'catalog' ? 'settings/mcp?tab=catalog' : 'settings/mcp')}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule">
          <Tabs.List className="flex min-w-0 gap-1">
            {(['registry', 'catalog'] as const).map((id) => (
              <Tabs.Trigger
                key={id}
                value={id}
                className="-mb-px min-h-(--tap-min) border-b-2 border-transparent px-3 py-1.5 text-sm text-ink-muted
                  data-[state=active]:border-accent data-[state=active]:text-ink"
              >
                {id === 'registry' ? `Registered (${servers.length})` : 'Catalog'}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Button
            size="sm"
            className="mb-1.5 shrink-0"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || !attached.length}
          >
            {refresh.isPending ? 'Checking…' : 'Re-check all'}
          </Button>
        </div>

        <Tabs.Content value="registry" className="mt-3">
          {isPending ? (
            <div className="grid gap-3">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          ) : (
            <Registry servers={servers} allowed={allowed} />
          )}
        </Tabs.Content>

        <Tabs.Content value="catalog" className="mt-3">
          <Catalog allowed={allowed} registered={new Set(servers.map((server) => server.id))} />
        </Tabs.Content>
      </Tabs.Root>
    </SettingsSectionFrame>
  );
}
/** Cannot be reached at all — as opposed to reachable but drifted. */
function cannotConnect(server: McpServerView): boolean {
  return server.status === 'needs-auth' || server.status === 'failed';
}

/* ---------------- registry ---------------- */

function Registry({ servers, allowed }: { servers: McpServerView[]; allowed: boolean }) {
  const attached = servers.filter((server) => server.enabled).length;

  if (!servers.length) {
    return (
      <>
        <Empty
          title="No MCP servers registered"
          body="Sessions here run with whatever MCP configuration this machine already has. Register a
                server to attach it deliberately — to a plan, to a run, or to one phase."
        />
        {!allowed && <FlagNote />}
      </>
    );
  }

  return (
    <>
      {attached > COMFORTABLE && (
        <Banner severity="warn" className="mb-3">
          {attached} servers are switched on. Every one of them costs context on every turn and adds tool
          names that can collide with another server's — three to six is the range people settle at. The run
          page shows which ones a phase actually called.
        </Banner>
      )}
      <div className="grid gap-3">
        {servers.map((server) => (
          <ServerCard key={server.id} server={server} allowed={allowed} />
        ))}
      </div>
      {!allowed && <FlagNote />}
    </>
  );
}

function FlagNote() {
  return (
    <p className="mt-3 border-t border-rule pt-3 text-xs text-ink-muted">
      Start the console with <code>--allow-mcp</code> to register servers, hold their credentials and attach
      them to plans. Reading the registry, the statuses and the catalog works without it.
    </p>
  );
}

function ServerCard({ server, allowed }: { server: McpServerView; allowed: boolean }) {
  const client = useQueryClient();
  const [secretFor, setSecretFor] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  /** A sign-in the console could not run for this server — and what would. */
  const [byHand, setByHand] = useState<{
    detail?: string;
    commands: string[];
    configDir?: string;
    accountLabel?: string;
  } | null>(null);

  const invalidate = () => client.invalidateQueries({ queryKey: keys.mcp() });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.mcpPatch(server.id, { enabled }),
    onSuccess: () => {
      void invalidate();
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: () => api.mcpDelete(server.id),
    onSuccess: () => {
      void invalidate();
      toast(`${server.label} removed, with anything it held.`, 'ok');
    },
    onError: toastError,
  });
  const login = useMutation({
    mutationFn: () => api.mcpLogin(server.id),
    onSuccess: (started) => {
      void invalidate();
      if (started.mode === 'embedded' && started.terminal) {
        setByHand(null);
        toast('Finish the sign-in in the terminal that just opened.', 'info');
        navigate(`sessions/${started.terminal.sessionId}`);
        return;
      }
      if (started.mode === 'external') {
        setByHand(null);
        toast('A terminal opened — finish the sign-in there.', 'info');
        return;
      }
      // No flow could start, or there is no terminal to start it in. This used
      // to be a toast and a clipboard write, which is the wrong shape for the
      // answer: the operator has to READ these commands, and a message that
      // disappears in four seconds is not something anybody reads. It stays on
      // the card until the sign-in works.
      setByHand({
        detail: started.detail,
        commands: started.commands?.length ? started.commands : [started.command],
        configDir: started.configDir,
        accountLabel: started.accountLabel,
      });
    },
    onError: toastError,
  });
  const setSecretValue = useMutation({
    mutationFn: (ref: string) => {
      const [kind, ...rest] = ref.split(':');
      return api.mcpPatch(server.id, {
        secretRef: { kind, name: rest.join(':') },
        secret: secret.trim(),
      });
    },
    onSuccess: () => {
      setSecretFor(null);
      setSecret('');
      void invalidate();
      toast('Stored. Re-checking the connection…', 'ok');
      void api.mcpRefresh().catch(() => {
        /* the card will say if it did not help */
      });
    },
    onError: toastError,
  });
  const acknowledge = useMutation({
    mutationFn: () => api.mcpAcknowledge(server.id),
    onSuccess: () => {
      void invalidate();
    },
    onError: toastError,
  });

  return (
    <Card className={server.enabled ? undefined : 'opacity-60'}>
      <CardHeader>
        <CardTitle>
          {server.label}
          <code className="ml-2 text-xs font-normal text-ink-faint">{server.id}</code>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip server={server} />
          <Chip>{server.transport}</Chip>
          {server.toolCount ? <Chip>{server.toolCount} tools</Chip> : null}
        </div>
      </CardHeader>

      <CardBody className="grid gap-2 text-sm">
        {/* `break-all`, not `truncate`. A stdio server's command is
            `npx -y @modelcontextprotocol/server-filesystem <root>` — one long
            token with nothing to break at — and it measured 184px past its own
            card at 360, because `truncate` on the `<p>` never reached the
            `<code>` inside it. It is a command the operator has to be able to
            READ and copy, so it wraps. */}
        <p className="min-w-0 text-xs text-ink-muted">
          <code className="break-all">{server.url ?? server.command}</code>
        </p>

        {server.issue && <Banner severity="error">{server.issue}</Banner>}

        {server.toolsChanged && (
          <Banner severity="warn">
            <p>
              This server now advertises different tools than it did{' '}
              <RelativeTime at={server.toolsChanged.seenAt} />.
              {server.toolsChanged.added.length ? ` Added: ${server.toolsChanged.added.join(', ')}.` : ''}
              {server.toolsChanged.removed.length
                ? ` Removed: ${server.toolsChanged.removed.join(', ')}.`
                : ''}
            </p>
            <p className="mt-1">
              A server whose tools change under you is how a trusted integration becomes an untrusted one.
              Check what changed before the next run attaches it.
            </p>
            <Button size="sm" className="mt-2" onClick={() => acknowledge.mutate()}>
              I have checked it
            </Button>
          </Banner>
        )}

        {server.interactiveTools?.length ? (
          <Banner severity="warn">
            {server.interactiveTools.join(', ')} require a person to approve every call, which an unattended
            run can never do. A phase that needs{' '}
            {server.interactiveTools.length === 1 ? 'that tool' : 'those tools'} will stall rather than
            finish.
          </Banner>
        ) : null}

        {server.auth.secrets.map((held) => (
          <p key={held.ref} className="text-xs text-ink-muted">
            <code>{held.ref}</code> — {held.held ? 'held in the keychain' : 'not set'}
            {allowed && (
              <Button
                size="sm"
                className="ml-2"
                onClick={() => {
                  setSecretFor(held.ref);
                  setSecret('');
                }}
              >
                {held.held ? 'Replace' : 'Set'}
              </Button>
            )}
          </p>
        ))}

        <p className="text-xs text-ink-faint">
          {server.checkedAt ? (
            <>
              Checked <RelativeTime at={server.checkedAt} />
            </>
          ) : (
            'Never checked'
          )}
          {server.lastUsed ? (
            <>
              {' · '}last used <RelativeTime at={server.lastUsed} />
            </>
          ) : null}
        </p>

        {server.auth.kind === 'oauth' && !SIGNABLE_TRANSPORTS.includes(server.transport) && (
          <p className="text-xs text-ink-muted">
            A <code>{server.transport}</code> server cannot be signed in from here — the Claude CLI's{' '}
            <code>mcp add</code> takes stdio, sse and http, and the sign-in works by registering the server
            with it first. Give it a header this console holds instead.
          </p>
        )}

        {byHand && (
          <div className="rounded border border-rule bg-surface-raised p-3">
            <p className="text-xs font-medium text-ink">
              This console cannot run the sign-in for {server.label}.
            </p>
            {byHand.detail && <p className="mt-1 text-xs text-ink-muted">{byHand.detail}</p>}
            {byHand.commands.length > 0 ? (
              <>
                <p className="mt-2 text-xs text-ink-muted">
                  Run {byHand.commands.length > 1 ? 'these' : 'this'} in a terminal, then press Re-check.
                  {byHand.configDir && (
                    <>
                      {' '}
                      The token lands in <code>{byHand.configDir}</code>
                      {byHand.accountLabel ? ` — ${byHand.accountLabel}'s config dir.` : '.'}
                    </>
                  )}
                </p>
                <pre className="mt-2 overflow-x-auto rounded bg-surface p-2 text-xs text-ink">
                  {byHand.commands.join('\n')}
                </pre>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void copy(byHand.commands.join('\n'), 'Commands copied')}>
                    Copy
                  </Button>
                  <Button size="sm" onClick={() => setByHand(null)}>
                    Dismiss
                  </Button>
                </div>
              </>
            ) : (
              <div className="mt-2">
                <Button size="sm" onClick={() => setByHand(null)}>
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        )}

        {allowed && (
          <div className="flex flex-wrap gap-2 border-t border-rule pt-2">
            <Button size="sm" onClick={() => toggle.mutate(!server.enabled)} disabled={toggle.isPending}>
              {server.enabled ? 'Switch off' : 'Switch on'}
            </Button>
            {/* `http` and `sse` only, and not because of what they are: those are
                the transports `claude mcp add` takes, and the sign-in works by
                bridging the definition into the CLI's registry so `mcp login`
                can resolve the name. A `ws` server has no spelling there, so
                offering the button would be issue #8 with a different message —
                the note below the row says so instead. */}
            {SIGNABLE_TRANSPORTS.includes(server.transport) && server.auth.kind === 'oauth' && (
              <Button size="sm" onClick={() => login.mutate()} disabled={login.isPending}>
                {server.status === 'connected' ? 'Sign in again' : 'Sign in'}
              </Button>
            )}
            <ConfirmButton
              size="sm"
              title={`Remove ${server.label}?`}
              confirmLabel="Remove server"
              cancelLabel="Keep it"
              destructive
              details={
                <>
                  <p className="text-sm">
                    The registration and anything this console holds for it — keychain entries, stored headers
                    — are deleted. Any plan that names <code>{server.id}</code> will park at boarding until it
                    is registered again or the name is dropped from the plan.
                  </p>
                  <p className="mt-2 text-sm text-ink-muted">
                    An OAuth sign-in stays where it is: <code>claude mcp logout {server.id}</code> is what
                    clears that, because the CLI owns it and this console never writes to its credential
                    store.
                  </p>
                </>
              }
              onConfirm={() => remove.mutate()}
            >
              Remove
            </ConfirmButton>
          </div>
        )}
      </CardBody>

      <Dialog
        open={secretFor !== null}
        onOpenChange={(open) => {
          if (!open) setSecretFor(null);
        }}
      >
        <DialogContent title={`Set ${secretFor ?? ''}`}>
          <p className="text-sm text-ink-muted">
            Stored in this machine's keychain, never in the registry file and never shown again.
          </p>
          <input
            className={cn(field, 'mt-2 w-full')}
            type="password"
            autoFocus
            value={secret}
            placeholder="Paste the token"
            onChange={(event) => setSecret(event.target.value)}
          />
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={!secret.trim() || setSecretValue.isPending}
              onClick={() => secretFor && setSecretValue.mutate(secretFor)}
            >
              Store it
            </Button>
            <Button size="sm" onClick={() => setSecretFor(null)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * The status, in the words the CLI itself uses.
 *
 * `pending` is deliberately not an alarm: a remote server with a cached tool
 * list reports pending and connects on its first tool call, which is normal.
 */
function StatusChip({ server }: { server: McpServerView }) {
  if (!server.enabled) return <Chip>switched off</Chip>;
  switch (server.status) {
    case 'connected':
      return <Chip tone="ok">connected</Chip>;
    case 'needs-auth':
      return <Chip tone="bad">needs sign-in</Chip>;
    case 'failed':
      return <Chip tone="bad">will not connect</Chip>;
    case 'pending':
      return <Chip>connects on first use</Chip>;
    default:
      return <Chip>not checked</Chip>;
  }
}
