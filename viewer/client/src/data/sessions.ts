/**
 * Sessions: every Claude session the presence hook reports, the console's own
 * shells and agents, the hook's own standing, and the phase locks.
 */

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/ui/toast';
import { api, type ConsoleState, type TerminalSession, type TerminalState, type TerminalTicket } from './api';
import { ApiError } from './http';
import { keys } from './keys';
import { press } from './press';

/**
 * What `GET /api/locks` narrows to (`server/locks.ts` `parseLockFilter`): only
 * the claims still held, only the lapsed ones, and only those whose scope
 * names a repository. `held` and `lapsed` together answer nothing. A query,
 * not a wire shape — `api.locks` spells it with `lockQuery`.
 */
export interface LockFilter {
  held?: true;
  lapsed?: true;
  scope?: string;
}

/** Every Claude session the presence hook reported for this instance — a person's, an agent's, a lane's — with its presence. */
export function useSessionRegistry(enabled = true) {
  return useQuery({ queryKey: keys.sessionRegistry(), queryFn: api.sessionRegistry, enabled });
}

/**
 * The raw hook events behind one registry session, newest last: the registry
 * says what is true now, and this is how it came to say it — the only form in
 * which a presence bug is arguable. Read only while something shows them.
 */
export function useSessionEvents(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.sessionEvents(id ?? ''),
    queryFn: () => api.sessionEvents(id!),
    enabled: Boolean(id) && enabled,
    retry: false,
  });
}


/** The session-presence hook's presence in `~/.claude/settings.json`. */
export function useHooksStatus(enabled = true) {
  return useQuery({ queryKey: keys.hooksStatus(), queryFn: api.hooksStatus, enabled });
}

/** Every hook the console knows — the plugin's, the user's, the project's, a run's — and each plan's hookify rules (Settings ▸ Hooks, measured-console phase 28). */
export function useHooks(enabled = true) {
  return useQuery({ queryKey: keys.hooks(), queryFn: api.hooks, enabled });
}

/**
 * Which sessions exist — live and ended, shells and agents, one registry.
 *
 * This used to be deliberately absent from `EVENT_EFFECTS`, on the reasoning
 * that the socket IS a session's live channel and a list refreshed by unrelated
 * events would be noise. That reasoning was sound for the session's own page and
 * wrong everywhere else: the dashboard's list of what is running, the nav
 * badges, and a second browser you opened all need to know, and none of them
 * holds that socket. So the server emits `sessions` and this follows it.
 */
export function useTerminals(enabled = true) {
  return useQuery({ queryKey: keys.terminal(), queryFn: api.terminal, enabled });
}

/**
 * Read the list again — when an open pane learns of its session, or of its
 * end, before the `sessions` event says so. `void`, never awaited: a refetch
 * awaited in a render path is how a whole test file once deadlocked.
 */
export function useTerminalsRefresh(): () => void {
  const client = useQueryClient();
  return useCallback(() => {
    void client.invalidateQueries({ queryKey: keys.terminal() });
  }, [client]);
}

/**
 * The same list, for the surfaces that want it regardless of which page they
 * are on. Enabled whenever the console can have a session of either kind — the
 * Agent page asks with `allowAgent`, the Terminal page with `allowTerminal`,
 * and the shell wants the union.
 */
export function useSessions(state: ConsoleState | undefined) {
  return useTerminals(state?.allowTerminal === true || state?.allowAgent === true);
}

/* ------------------------------------------------------------------ *
 * The verbs of one session, and starting one
 * ------------------------------------------------------------------ */

/** What can be done to a session this console owns. */
export type SessionVerb = 'freeze' | 'thaw' | 'stop' | 'close' | 'dismiss';

type VerbAnswer = { ok?: boolean; closed?: boolean; reason?: string; state?: TerminalState };

const SESSION_CALLS: Readonly<Record<SessionVerb, (id: string) => Promise<VerbAnswer>>> = {
  freeze: (id) => api.sessionFreeze(id),
  thaw: (id) => api.sessionThaw(id),
  stop: (id) => api.sessionStop(id),
  close: (id) => api.terminalClose(id),
  dismiss: (id) => api.sessionDismiss(id),
};

/** What a verb that went through says — the verbs that move the page away say nothing. */
const SAID: Readonly<Record<SessionVerb, ((label: string) => string) | null>> = {
  freeze: (label) => `${label} frozen where it stood`,
  thaw: (label) => `${label} continued — it picks up mid-token`,
  stop: (label) => `${label} asked to stop — force-ended only if it ignores the grace`,
  close: null,
  dismiss: null,
};

export interface SessionActs {
  /** The verb in flight, or null — one word, so one rule for every button's busy state. */
  busy: SessionVerb | null;
  /**
   * Press one verb on one session, through the one press door. The answer
   * carries the list as it now is, which is authoritative and goes straight
   * into the cache; a refusal is an answered request (`ok: false`, the
   * server's reason), never a thrown one. Resolves true when it was done.
   */
  act: (verb: SessionVerb, session: Pick<TerminalSession, 'id' | 'label'>) => Promise<boolean>;
}

export function useSessionActs(): SessionActs {
  const client = useQueryClient();
  const [busy, setBusy] = useState<SessionVerb | null>(null);
  const act = useCallback(
    async (verb: SessionVerb, session: Pick<TerminalSession, 'id' | 'label'>) => {
      setBusy(verb);
      try {
        const pressed = await press(() => SESSION_CALLS[verb](session.id));
        if (pressed.state === 'asked') {
          toast(pressed.words, 'info');
          return false;
        }
        const answer = pressed.result;
        if (answer.state) client.setQueryData(keys.terminal(), answer.state);
        if (answer.ok === false) {
          toast(String(answer.reason ?? 'refused'), 'error');
          return false;
        }
        const said = SAID[verb];
        if (said) toast(said(session.label), 'ok');
        return true;
      } catch (error) {
        // A refused verb is answered 409 `{ ok: false, reason, state }`, which
        // the transport throws: say the server's reason, and keep its list.
        const refused = error instanceof ApiError ? (error.body as VerbAnswer | undefined) : undefined;
        if (refused?.state) client.setQueryData(keys.terminal(), refused.state);
        toast(refused?.reason ?? (error as Error).message, 'error');
        return false;
      } finally {
        setBusy(null);
        // `void`, never `await`: a refetch must not hold the busy word.
        void client.invalidateQueries({ queryKey: keys.terminal() });
      }
    },
    [client],
  );
  return { busy, act };
}

/** What a claude session is started with — enum choices, a bounded prompt, nothing executable. */
export type AgentLaunch = Parameters<typeof api.agentTicket>[0];

export interface SessionStart {
  busy: 'shell' | 'agent' | null;
  /** Open a shell at this size; the ticket, or null when it was refused (and said so). */
  openShell: (size: { cols: number; rows: number }) => Promise<TerminalTicket | null>;
  /** Start a claude session; the ticket, or null when it was refused (and said so). */
  startAgent: (body: AgentLaunch) => Promise<TerminalTicket | null>;
}

/**
 * Starting a session. The ticket carries the record, so the cache is seeded
 * from it at once — the list and the pane are right on the very next render
 * instead of racing the session's own creation.
 */
export function useSessionStart(): SessionStart {
  const client = useQueryClient();
  const [busy, setBusy] = useState<'shell' | 'agent' | null>(null);
  const run = useCallback(
    async (kind: 'shell' | 'agent', call: () => Promise<TerminalTicket>) => {
      setBusy(kind);
      try {
        const pressed = await press(call);
        if (pressed.state === 'asked') {
          toast(pressed.words, 'info');
          return null;
        }
        const ticket = pressed.result;
        if (ticket.session) {
          client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) =>
            prev
              ? {
                  ...prev,
                  available: 'yes' as const,
                  sessions: [...prev.sessions.filter((one) => one.id !== ticket.session.id), ticket.session],
                }
              : prev,
          );
        }
        return ticket;
      } catch (error) {
        toast((error as Error).message, 'error');
        return null;
      } finally {
        setBusy(null);
        void client.invalidateQueries({ queryKey: keys.terminal() });
      }
    },
    [client],
  );
  const openShell = useCallback(
    (size: { cols: number; rows: number }) => run('shell', () => api.terminalTicket(size)),
    [run],
  );
  const startAgent = useCallback((body: AgentLaunch) => run('agent', () => api.agentTicket(body)), [run]);
  return { busy, openShell, startAgent };
}

/** Install or remove the presence hook (`POST /api/hooks-install`) through the owner door; the status a done write answers goes straight into the cache (Settings ▸ Automation, quiet-console phase 21). */
export function useHooksWrite() {
  const client = useQueryClient();
  const [busy, setBusy] = useState<'install' | 'uninstall' | null>(null);
  const write = useCallback(
    async (action: 'install' | 'uninstall') => {
      setBusy(action);
      try {
        const pressed = await press(() => api.hooksInstall(action));
        if (pressed.state === 'done') client.setQueryData(keys.hooksStatus(), pressed.result.status);
        return pressed;
      } catch (error) {
        // What the file holds now is unknown: read it again.
        void client.invalidateQueries({ queryKey: keys.hooksStatus() });
        throw error;
      } finally {
        setBusy(null);
      }
    },
    [client],
  );
  return { busy, write };
}
