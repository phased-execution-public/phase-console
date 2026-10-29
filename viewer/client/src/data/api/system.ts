/**
 * The console itself — the tailnet, the portfolio, search, skills, the
 * directory picker, the desktop launcher, sign-in, restart and shutdown.
 * The shapes are the wire's (`shared/wire/system.js`).
 */

import { request, post, q } from '../http';
import type { ShutdownMode } from '@shared/ops-vocab.js';
import type {
  AuthStatus,
  DirListing,
  FleetProfileView,
  InstancesView,
  LauncherCreated,
  LauncherPlanView,
  OpenRootResult,
  Portfolio,
  RestartOutcome,
  RestartReadiness,
  RootCheck,
  SearchResult,
  ShutdownOutcome,
  ShutdownReadiness,
  SkillInfoList,
  TailscaleStatus,
} from '@shared/wire/system.js';

export type {
  AuthStatus,
  DirListing,
  FleetProfileView,
  InstancesView,
  InventoryClock,
  LauncherCreated,
  LauncherPlanView,
  OpenRootResult,
  Portfolio,
  PortfolioTotals,
  RestartOutcome,
  RestartReadiness,
  RestartUpdateView,
  RootCheck,
  SearchHit,
  SearchResult,
  SelfUpdateResultView,
  ServeCommand,
  ServeHandler,
  ServeOccupant,
  ShutdownInventory,
  ShutdownOutcome,
  ShutdownReadiness,
  SkillInfo,
  SkillInfoList,
  StopPlanView,
  TailscaleDevice,
  TailscaleServe,
  TailscaleStatus,
} from '@shared/wire/system.js';

/** The console's own fetchers — merged into `api` by `./index`. */
export const systemApi = {
  instances: () => request<InstancesView>('/api/instances'),
  fleetProfile: () => request<FleetProfileView>('/api/fleet/profile'),
  /** This machine's tailnet — devices, and whether `serve` points here. */
  tailscale: () => request<TailscaleStatus>('/api/tailscale'),
  stats: () => request<Portfolio>('/api/stats'),

  /* ---- the directory picker ---- */
  browse: (path?: string) => request<DirListing>(`/api/fs?path=${q(path ?? '')}`),
  checkRoot: (path: string) => request<RootCheck>(`/api/root?path=${q(path)}`),
  openRoot: (path: string) => post<OpenRootResult>('/api/root', { path }),

  search: (query: string) => request<SearchResult>(`/api/search?q=${q(query)}`),
  skills: () => request<SkillInfoList>('/api/skills'),

  /* ---- the desktop launcher ---- */
  launcherPlan: () => request<LauncherPlanView>('/api/launcher'),
  createLauncher: () => post<LauncherCreated>('/api/launcher'),

  /* ---- signing in, and restarting the console itself ---- */
  auth: (force?: boolean) => request<AuthStatus>(`/api/auth${force ? '?force=1' : ''}`),
  authLogin: () => post<{ opened?: boolean; detail?: string }>('/api/auth/login'),
  restartReadiness: () => request<RestartReadiness>('/api/restart'),
  /* No `by`: the server DERIVES the actor from the request — a browser is
   * `operator`, a script is `script`, a tailnet caller its login (SHD-3).
   * A bare press updates first where the console can; `update: false` is the
   * plain restart, `whenIdle` waits for the live sessions instead of being
   * refused mid-run, `force` restarts past a refusal that is not a run in
   * flight — no supervisor to bring it back, a launch unit that drifted — and
   * `cancel` calls a waiting restart off. */
  restart: (options: { update?: boolean; whenIdle?: boolean; force?: boolean; cancel?: boolean } = {}) =>
    post<RestartOutcome>(
      '/api/restart',
      options.cancel
        ? { cancel: true }
        : {
            ...(options.update === false ? { update: false } : {}),
            ...(options.whenIdle ? { whenIdle: true } : {}),
            ...(options.force ? { force: true } : {}),
          },
    ),

  /* The off switch. `confirm` is required by the server so a replayed or stray
   * POST cannot end a console; the dialog is what supplies it — and, having
   * SHOWN the inventory, the acknowledgement a non-empty one needs (SHD-1).
   * `mode: 'unload'` is the separate "stay off" choice (SHD-2). */
  shutdownReadiness: () => request<ShutdownReadiness>('/api/shutdown'),
  shutdown: (opts: { mode?: ShutdownMode; acknowledge?: boolean } = {}) =>
    post<ShutdownOutcome>('/api/shutdown', { confirm: true, ...opts }),
};
