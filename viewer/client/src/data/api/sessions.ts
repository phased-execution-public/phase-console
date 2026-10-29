/**
 * Sessions — the browser terminal, claude-kind agent sessions, the
 * session-presence registry and the hook that feeds it.
 */

import { request, post, q } from '../http';
import type { RecoveryClass } from '@/lib/recovery';
import type { QaProfile } from '@/lib/qa';
import type { AgentIntent } from '@shared/run-settings.js';
import type {
  LockRow,
  SessionEventsAnswer,
  SessionRegistryView,
  HooksStatusView,
  HooksView,
  HooksWriteView,
  TerminalDeleteAnswer,
  TerminalState,
  TerminalTicket,
  TerminalVerbAnswer,
} from '@shared/wire/sessions.js';
import type { LockFilter } from '../sessions';

/* The shapes are the wire's (measured-console phase 32): `@shared/wire/sessions.js`. */
export type {
  TerminalSession,
  TerminalSessionMeta,
  TerminalState,
  TerminalTicket,
  TerminalVerbAnswer,
  TerminalDeleteAnswer,
  ForeignSession,
  SessionEventLine,
  SessionEventsAnswer,
  LockRow,
  SessionRegistryView,
  HooksStatusView,
  HookRowView,
  HookifyRuleView,
  HookifyOnDiskView,
  HooksView,
  HooksWriteView,
  SessionInventory,
} from '@shared/wire/sessions.js';
export type { LockFilter } from '../sessions';

/** The filter as the route's query — empty when it narrows nothing. */
export function lockQuery(filter: LockFilter): string {
  const query = new URLSearchParams();
  if (filter.held) query.set('held', '1');
  if (filter.lapsed) query.set('lapsed', '1');
  if (filter.scope) query.set('scope', filter.scope);
  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

/** The session fetchers — merged into `api` by `./index`. */
export const sessionsApi = {
  /* ---- the terminal ----
     `terminalTicket` is the handshake: a POST, so it carries the console header
     and the same-origin check that the WebSocket upgrade that follows cannot.
     See `server/terminal.ts` for why the socket alone is not defensible. */
  terminal: () => request<TerminalState>('/api/terminal'),
  terminalTicket: (body: { sessionId?: string; cols?: number; rows?: number }) =>
    post<TerminalTicket>('/api/terminal', body),
  /**
   * Mint a claude-kind session. The server composes and validates the argv —
   * this body is enum choices, a bounded prompt, and nothing executable.
   */
  agentTicket: (body: {
    cols?: number;
    rows?: number;
    model?: string;
    effort?: string;
    permissionMode?: string;
    prompt?: string;
    skills?: string[];
    resume?: string;
    intent?: AgentIntent;
    brief?: string;
    /**
     * The issues a plan-from-issues ticket is about, as `owner/repo#12` REFS.
     *
     * Refs and not text: the server resolves them against its own issue cache
     * and composes the "Issues to solve" section itself, so a long brief and
     * many issues do not compete — the brief is never what gets cut. At most
     * `TICKET_ISSUES_MAX` (20), and only on a `plan` intent.
     */
    issues?: string[];
    /** The standing multi-agent licence, off unless the operator asked. */
    ultracode?: boolean;
    /* A recovery names its TARGET and nothing else — the server reads the
       board, the run and the diagnosis and composes the prompt itself. */
    recoveryClass?: RecoveryClass;
    slug?: string;
    phase?: number;
    runId?: string;
    /* A review names its target the same way. `activate` turns QA on for the
       plan first; `permissionProfile` is the one place bypass is offered, and
       the server refuses it on any other kind of session. */
    activate?: boolean;
    permissionProfile?: QaProfile;
    /* Which account the session runs as — a registered id, validated server-side. */
    accountId?: string;
  }) => post<TerminalTicket>('/api/terminal', { kind: 'claude', ...body }),
  terminalClose: (id: string) =>
    request<Extract<TerminalDeleteAnswer, { closed: boolean }>>(`/api/terminal?id=${q(id)}`, {
      method: 'DELETE',
    }),
  /** Drop the record of a session that has already ended. Refused on a live one. */
  sessionDismiss: (id: string) =>
    request<TerminalVerbAnswer>(`/api/terminal?id=${q(id)}&action=dismiss`, { method: 'DELETE' }),
  /** SIGSTOP the session's process group — the lane-freeze verb at session size. */
  sessionFreeze: (id: string) => post<TerminalVerbAnswer>(`/api/terminal/${q(id)}/freeze`),
  /** SIGCONT — the session picks up exactly where it stopped. */
  sessionThaw: (id: string) => post<TerminalVerbAnswer>(`/api/terminal/${q(id)}/thaw`),
  /**
   * End a session politely: SIGTERM, SIGKILL only after a grace it ignored.
   * Unlike `terminalClose`, the record stays — outcome checks and the
   * `--resume` id survive the stop.
   */
  sessionStop: (id: string) => post<TerminalVerbAnswer>(`/api/terminal/${q(id)}/stop`),

  /* ---- session presence: the registry the hook feeds, and the hook installer ---- */
  sessionRegistry: () => request<SessionRegistryView>('/api/sessions/registry'),
  /** The raw hook payloads of one session, in order — how its registry record came to say what it says. */
  sessionEvents: (id: string, limit = 50) =>
    request<SessionEventsAnswer>(`/api/sessions/${q(id)}/events?limit=${limit}`),
  /** Every phase claim this console can see, worst-first (#24) — narrowed by the server when asked. */
  locks: (filter: LockFilter = {}) => request<{ rows: LockRow[] }>(`/api/locks${lockQuery(filter)}`),
  hooksStatus: () => request<HooksStatusView>('/api/hooks-install'),
  /** Every hook the console knows, and each plan's hookify rules — read-only (measured-console phase 28). */
  hooks: () => request<HooksView>('/api/hooks'),
  hooksInstall: (action: 'install' | 'uninstall') => post<HooksWriteView>('/api/hooks-install', { action }),
};
