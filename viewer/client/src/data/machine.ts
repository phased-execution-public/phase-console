/**
 * The machine under the console: restarting and shutting it down, the desktop
 * launcher, the tailnet, the directory picker, and the CLI's sign-in and
 * skills.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HeldCredentials, StartCeilingCounters, StrayConsoles } from '@shared/wire/system.js';
import { api, type RestartReadiness } from './api';
import { post, request } from './http';
import { keys } from './keys';

/** Where a one-click desktop launcher would land on the server's platform. */
export function useLauncherPlan(enabled = true) {
  return useQuery({ queryKey: keys.launcher(), queryFn: api.launcherPlan, enabled });
}

/**
 * The machine's console registry — every console beside this one, as this
 * console reads it (`GET /api/instances`); the shell's switcher lists it in
 * both editions. Read while the menu is open and kept a minute: a registry
 * moves when a console starts, not while a menu is looked at. Its key is a
 * local const, not a `keys` member: that object rides first paint.
 */
export function useInstances(enabled = true) {
  return useQuery({ queryKey: ['instances'] as const, queryFn: api.instances, enabled, staleTime: 60_000 });
}

/**
 * Point this console at another source. Everything on screen was about the
 * old repository, so every query is dropped once the server has moved; the
 * caller reads the answer's `check` and says so.
 */
export function useOpenRoot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.openRoot(path),
    onSuccess: async (result) => {
      if (result.check?.ok) await client.invalidateQueries();
    },
  });
}

/** What Shut down is about to stop. Read before the dialog opens, not after. */
export function useShutdownReadiness(enabled = true) {
  return useQuery({ queryKey: keys.shutdown(), queryFn: api.shutdownReadiness, enabled });
}

/**
 * This machine's tailnet, for the Settings card.
 *
 * Polled rather than pushed, and only while the card showing it is mounted: the
 * answer changes when a phone wakes up or someone runs `tailscale serve`,
 * neither of which this server has any way to hear about. The interval is
 * deliberately slower than the server's own 30-second memo, so a Settings tab
 * left open overnight costs about one process spawn a minute — most polls are
 * answered from that memo without touching the CLI at all.
 */
export function useTailscale(enabled = true) {
  return useQuery({
    queryKey: keys.tailscale(),
    queryFn: api.tailscale,
    enabled,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * Whether the CLI is signed in.
 *
 * A signed-out session does not look like a failure: it reports success, uses
 * one turn, costs nothing and changes nothing. `force` re-probes rather than
 * reading the server's cache — what the "Check again" button is for.
 */
export function useAuth(enabled: boolean) {
  return useQuery({ queryKey: keys.auth(), queryFn: () => api.auth(), enabled, retry: false });
}

/** Cached server-side, so switching tabs does not rescan a few hundred SKILL.md files. */
export function useSkills(enabled: boolean) {
  return useQuery({ queryKey: keys.skills(), queryFn: api.skills, enabled, retry: false });
}

/**
 * How often the Restart card re-asks while an update is in hand: while it runs,
 * while the process is on its way out, and — slowly — while it waits. The `restart` event says the same
 * thing sooner; the poll is the belt for a tab whose stream dropped mid-build.
 */
export function restartPollMs(readiness: RestartReadiness | undefined): number | false {
  const phase = readiness?.update?.run?.state;
  if (phase === 'running' || phase === 'restarting') return 1_500;
  // A wait lasts as long as the live phases do, and the event says when it ends.
  return phase === 'waiting' ? 15_000 : false;
}

/**
 * The machine profile (`fleet.json`) and what this console takes from it —
 * each field's source, and the fields this console overrides with its own.
 * `retry: false`: a console from before the route answers 404 and keeps doing so.
 */
export function useMachineProfile(enabled = true) {
  return useQuery({ queryKey: keys.machineProfile(), queryFn: api.fleetProfile, enabled, retry: false });
}

/** Whether this console can restart itself — asked before the button renders. */
export function useRestartReadiness(enabled = true) {
  return useQuery({
    queryKey: keys.restart(),
    queryFn: api.restartReadiness,
    enabled,
    retry: false,
    refetchInterval: (query) => restartPollMs(query.state.data),
  });
}

/**
 * One directory's sub-directories, for the picker.
 *
 * Never invalidated by an event: the file system is not what the console
 * watches, and a picker that refetched on every `changed` would fight the
 * person typing in it. `keepPreviousData` keeps the list stable while walking
 * into a folder.
 */
export function useDirListing(path: string) {
  return useQuery({
    queryKey: keys.browse(path),
    queryFn: () => api.browse(path),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Whether a path is a source directory — the Open button's whole basis. */
export function useRootCheck(path: string) {
  return useQuery({
    queryKey: keys.rootCheck(path),
    queryFn: () => api.checkRoot(path),
    enabled: path.trim().length > 0,
    retry: false,
  });
}

/* ------------------------------------------------------------------ *
 * The machine's thin reads (quiet-console phase 25) — Logs ▸ Health and
 * Settings ▸ Accounts draw them (phase 26)
 * ------------------------------------------------------------------ */

export type { CeilingWindow, StartCeilingCounters } from '@shared/wire/system.js';

export const readStartCeiling = (): Promise<StartCeilingCounters> =>
  request<StartCeilingCounters>('/api/ceiling');

/** The ceiling's counters move with every automatic start, which no event announces. */
const CEILING_POLL_MS = 30_000;

/**
 * The start ceiling's live counters — Logs ▸ Health. A read of the server's
 * memory, so it is cheap to ask while the section is open; polled for that
 * reason, and only then. A refused read stops the clock: a server without the
 * route answers the same every time, and Try again is the person's.
 */
export function useStartCeiling(enabled = true) {
  return useQuery({
    queryKey: ['ceiling'] as const,
    queryFn: readStartCeiling,
    enabled,
    staleTime: CEILING_POLL_MS,
    refetchInterval: (query) => (query.state.status === 'error' ? false : CEILING_POLL_MS),
    retry: false,
  });
}

export type { HeldCredential, HeldCredentials } from '@shared/wire/system.js';

export const readCredentials = (): Promise<HeldCredentials> => request<HeldCredentials>('/api/credentials');

/** Ask again now rather than read the minute-long cache — these ids, or every one when none. */
export const probeCredentials = (ids: readonly string[] = []): Promise<HeldCredentials> =>
  post<HeldCredentials>('/api/credentials/probe', { ids });

/** The held-credentials read; a probe's answer is the same view, so it is written straight over it. */
const CREDENTIALS = ['credentials'] as const;

/** The server reuses a probe's answer for this long (`cacheMs`), so a read inside it would ask nothing new. */
const CREDENTIALS_STALE_MS = 60_000;

/** What this machine holds — every credential id a plan names, and the CLI's own two — Settings ▸ Accounts. */
export function useCredentials(enabled = true) {
  return useQuery({
    queryKey: CREDENTIALS,
    queryFn: readCredentials,
    enabled,
    staleTime: CREDENTIALS_STALE_MS,
    retry: false,
  });
}

/**
 * Check again now, past the server's minute: `ids` names the credentials to
 * ask about, and none asks every one. The answer is the whole view, written
 * over the read, so every row shows what the probe found.
 */
export function useCredentialProbe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ids }: { ids?: readonly string[] } = {}) => probeCredentials(ids),
    onSuccess: (view) => client.setQueryData(CREDENTIALS, view),
  });
}

export type { StrayConsole, StrayConsoles } from '@shared/wire/system.js';

export const readStrayConsoles = (): Promise<StrayConsoles> => request<StrayConsoles>('/api/doctor/strays');

/**
 * The stray consoles — Logs ▸ Health. Each read is one `ps` of the whole
 * machine, so it is asked on arrival and when a person checks again, never on
 * a clock; a stray does not appear while nobody is looking.
 */
export function useStrayConsoles(enabled = true) {
  return useQuery({
    queryKey: ['strays'] as const,
    queryFn: readStrayConsoles,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
