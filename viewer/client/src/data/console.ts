/**
 * The console's own reads: its state, the search the palette runs, and the
 * counts the shell draws from them.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { askCount, attentionCount } from '@shared/attention-model.js';
import { isClosed } from '@/lib/closure';
import type { PrefSource } from '@shared/prefs-model.js';
import { api, type PlanSummary } from './api';
import { request } from './http';
import { keys } from './keys';
import { press, type Pressed } from './press';

export function useConsoleState() {
  return useQuery({ queryKey: keys.state(), queryFn: api.state });
}

/**
 * The boot question's answer — continue the runs a restart interrupted, or
 * leave them as the restart left them (`shell/resume-ask.tsx`). The state is
 * re-read either way: the server remembers the answer for this boot.
 */
export function useBootResume() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (decision: 'continue' | 'dismiss') => api.bootResume(decision),
    onSettled: () => client.invalidateQueries({ queryKey: keys.state() }),
  });
}

/**
 * Full-text search, debounced by the caller.
 *
 * Keyed by the query text so every distinct search is its own cache entry and
 * going back to a previous term is instant. `keepPreviousData` keeps the last
 * result on screen while a longer term is fetched — a list that blanks on every
 * keystroke is unreadable at typing speed.
 */
export function useSearch(query: string) {
  const text = query.trim();
  return useQuery({
    queryKey: keys.search(text),
    queryFn: () => api.search(text),
    enabled: text.length >= 2,
    placeholderData: keepPreviousData,
  });
}

/** The numbers on the rail and the tab bar. */
export interface ShellCounts {
  plans: number;
  phases: number;
  ready: number;
  approvals: number;
  unread: number;
  /**
   * How many things are waiting on a PERSON — Now's badge, and the only count
   * that wears the accent hue.
   *
   * The unified inbox's length, minus its `fyi` rows: a ruling worth reading
   * and a lock nobody is queued behind are real items and neither is a person
   * being waited on. The name was `needsYou` rather than `approvals` from the
   * first day precisely so widening what it counts did not mean renaming the
   * badge on every surface that reads it — and this is that widening.
   *
   * Falls back to the pending approvals when no inbox is passed (a server too
   * old for `/api/inbox`, or a test that hands neither), which is exactly what
   * this counted before.
   */
  needsYou: number;
  /**
   * Live ASKS — sessions stopped dead until a person answers: pending
   * permission cards plus non-autopilot sessions blocked at their own prompt
   * (`ASK_KINDS` over the open inbox). The header chip's count; a strict
   * subset of `needsYou`. Falls back to pending approvals on a server with no
   * inbox, for the same reason `needsYou` does.
   */
  asks: number;
  /** Every live session, of either kind — the Sessions destination's badge. */
  sessions: number;
  /** Live claude sessions. */
  agentSessions: number;
  /** Live shells. */
  terminalSessions: number;
  /**
   * Registered MCP servers that need a person: not signed in, not connecting,
   * or advertising different tools than they used to. Not a count of servers —
   * a healthy registry of nine shows nothing at all.
   */
  mcpAttention: number;
}

export function shellCounts(
  plans: PlanSummary[] | undefined,
  // Only the status is read, and saying so keeps this callable with a stub: the
  // full `Approval` is a nine-field server shape, and a counting function should
  // not demand one to be tested.
  approvals: readonly { status: string }[] | undefined,
  unread: number,
  // Both kinds arrive in one list from one registry; the nav shows each page
  // its own, because a single number on two entries reads as double-counting.
  // Ended records are excluded — a badge is "what is running", not history.
  sessions?: readonly { kind?: string; exited?: unknown }[],
  // Only what makes a badge light. A disabled server is excluded on purpose:
  // the operator already said no to it, and nagging about a thing they turned
  // off is how a badge becomes something people stop reading.
  mcp?: readonly { enabled: boolean; status: string; toolsChanged?: unknown }[],
  // The unified inbox, when the server has one. `undefined` — an older server,
  // or a still-loading first paint — falls back to the approvals count rather
  // than to zero: a badge that reads 0 while a session is parked on a
  // permission card is worse than one that under-counts.
  inbox?: readonly { severity: string; kind?: string }[],
): ShellCounts {
  const list = plans ?? [];
  const live = (sessions ?? []).filter((session) => !session.exited);
  return {
    // `plans` and `phases` are the CENSUS and count everything, closed included —
    // the same split the server makes, where `totals.phases`/`done`/`percent`
    // still see every plan. Closing a plan quiets it; it does not delete it, and
    // a rail that stopped counting them would disagree with the dashboard's own
    // subtitle. `ready` is the opposite kind of number: it is a call to action
    // with a badge on it, it links straight to the departures board, and it has
    // to say exactly what that board will show.
    plans: list.filter((p) => p.kind === 'plan').length,
    phases: list.reduce((n, p) => n + (p.phases ?? 0), 0),
    ready: list.reduce((n, p) => n + (isClosed(p) ? 0 : (p.ready?.length ?? 0)), 0),
    approvals: (approvals ?? []).filter((a) => a.status === 'pending').length,
    unread,
    needsYou: inbox ? attentionCount(inbox) : (approvals ?? []).filter((a) => a.status === 'pending').length,
    asks: inbox ? askCount(inbox) : (approvals ?? []).filter((a) => a.status === 'pending').length,
    sessions: live.length,
    agentSessions: live.filter((session) => session.kind === 'claude').length,
    terminalSessions: live.filter((session) => (session.kind ?? 'shell') === 'shell').length,
    mcpAttention: (mcp ?? []).filter(
      (server) =>
        server.enabled &&
        (server.status === 'needs-auth' || server.status === 'failed' || server.toolsChanged),
    ).length,
  };
}

/* ------------------------------------------------------------------ *
 * The settings schema (quiet-console phase 25) — Settings ▸ Everything draws it
 * ------------------------------------------------------------------ */

/** One key as the server describes it: the shared table's facts, its default, its value, where that came from. */
export interface PrefSchemaRow {
  /** `theme` · `notify.needs-you` · `retention.runRetainDays` · `profile.heapMb`. */
  key: string;
  group: string;
  type: string;
  words?: readonly string[];
  unit?: string;
  description: string;
  /** Absent for a key with no shipped default. */
  default?: unknown;
  /** A `secret` key's is said without the secret: a webhook's origin and masked tail, anything else as `[withheld]`. */
  value: unknown;
  /** The value is a credential or may carry one, so the server never serves it. */
  secret?: boolean;
  source: PrefSource;
  writable: boolean;
  /** The line that changes it from a terminal, where there is one. */
  cli: string | null;
}

export interface PrefsSchemaAnswer {
  files: { instance: string; config: string; profile: string };
  rows: PrefSchemaRow[];
}

/** Every preference and machine-profile field, described, with its value and its source. */
export const readPrefsSchema = (): Promise<PrefsSchemaAnswer> =>
  request<PrefsSchemaAnswer>('/api/prefs/schema');

/**
 * The schema, read once for every row of Settings that asks: each row draws its
 * value, its default and where the value came from out of the same answer, so
 * a save that moves one key moves the whole page to the same reading.
 */
export function usePrefsSchema(enabled = true) {
  return useQuery({
    queryKey: keys.prefsSchema(),
    queryFn: readPrefsSchema,
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * What a preference write sends for one key: the key itself, or — for a member
 * of a map — the map with that one member, which the server merges
 * (`notify.needs-you` → `{notify: {"needs-you": …}}`; a retention member is
 * held to the loader's floors there, quiet-console phase 23).
 */
export function prefPatch(key: string, value: unknown): Record<string, unknown> {
  for (const map of ['notify', 'retention'] as const) {
    if (key.startsWith(`${map}.`)) return { [map]: { [key.slice(map.length + 1)]: value } };
  }
  return { [key]: value };
}

/**
 * Write preferences — ONE patch, the keys it names, merged on the server — as
 * a press through the owner door (`press.ts`): a console with an owner key may
 * answer a save from this device as a request the owner confirms, and that is
 * not a save. The state and the schema are read again either way.
 */
export function usePrefsWrite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => press(() => api.savePrefs(patch)),
    onSettled: () => {
      for (const queryKey of keys.afterPrefs()) void client.invalidateQueries({ queryKey });
    },
  });
}

/**
 * Take one key back to its shipped default: `{key: null}` takes it out of the
 * file, so the schema reads it as the default however many saves follow; a
 * member of the announcement map goes back by its dotted name.
 */
export const resetPref = (key: string): Promise<Pressed<unknown>> =>
  press(() => api.savePrefs({ [key]: null }));

export function usePrefReset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: resetPref,
    onSettled: () => {
      for (const queryKey of keys.afterPrefs()) void client.invalidateQueries({ queryKey });
    },
  });
}
