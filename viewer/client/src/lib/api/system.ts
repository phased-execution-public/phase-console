/**
 * The console itself — the tailnet, the portfolio, search, skills, the
 * directory picker, the desktop launcher, sign-in, restart and shutdown.
 */

import { request, post, q } from './client';
import type { BootHold, ConsoleState, SupervisorInfo } from './state';
import type { ShutdownClockSource, ShutdownDurability, ShutdownMode } from '@shared/ops-vocab.js';
import type { Liveness } from '@shared/fleet-model.js';
import type { SessionInventory } from './sessions';
import type { HealthIssue } from './plans';
import type { EtaBasis } from './runs';

/** How one strength of Shut down is carried out, and what it achieves (SHD-2, SHD-5). */
export interface StopPlanView {
  /** `exit` ends the process; `launchctl`/`systemctl` unload AND disable the unit. */
  via: 'launchctl' | 'systemctl' | 'exit';
  mode: ShutdownMode;
  durability: ShutdownDurability;
  label?: string;
  /** The command that undoes a "stay off". */
  resurrect?: string;
  detail: string;
}

/** One in-process clock the exit discards (SHD-1). */
export interface InventoryClock {
  at: string;
  source: ShutdownClockSource;
  slug?: string;
  runId?: string;
  phase?: number;
}

/** What Shut down would stop, computed from work rather than guessed (SHD-1). */
export interface ShutdownInventory {
  lanes: { slug: string; runId: string; phase: number; pid: number | null; sessionId: string | null }[];
  clocks: InventoryClock[];
  runs: {
    slug: string;
    id: string;
    status: string;
    waitUntil: string | null;
    live: boolean;
    clock: InventoryClock | null;
  }[];
  liveSessions: {
    sessionId: string;
    kind: string;
    pid: number | null;
    cwd: string;
    plan: { slug: string; phase: number } | null;
  }[];
  pendingApprovals: { id: string; slug: string; phase: number | null; kind: string; expiresAt: string }[];
  inboxDepth: { sessions: number; outcomes: number };
}

export interface ShutdownReadiness {
  supervisor: SupervisorInfo;
  /** The strength a plain press uses. */
  mode?: ShutdownMode;
  /** How that strength stops it. */
  stop: StopPlanView;
  /** Both strengths — `unload` is null where there is no unit to unload. Absent from a server before 5.0.0. */
  modes?: { exit: StopPlanView; unload: StopPlanView | null };
  inventory?: ShutdownInventory;
  /** Nothing in flight, armed, owed, live, pending or unread. */
  empty?: boolean;
  soonestClock?: InventoryClock | null;
  busy: boolean;
  run: { slug: string; status: string } | null;
  sessions: SessionInventory;
  /** How to get it back after `exit` — the last thing this console will tell you. */
  restartHint: string;
  /** How to undo a "stay off". */
  unloadHint?: string | null;
  bootHold?: BootHold | null;
}

/** A refused press answers with what it was about. */
export interface ShutdownOutcome {
  ok: boolean;
  reason?: string;
  needs?: 'mode' | 'unload' | 'acknowledge';
  mode?: ShutdownMode;
  stop?: StopPlanView;
  inventory?: ShutdownInventory;
}

/** One machine on the tailnet, reduced to what the Settings card renders. */
export interface TailscaleDevice {
  hostName: string;
  dnsName: string;
  ips: string[];
  os?: string;
  online: boolean;
  /** Only present, and only useful, for a device that is offline now. */
  lastSeen?: string;
}

/**
 * The console a Serve handler forwards to, as this machine's registry names it
 * (`server/tailscale.ts`). `id`, `name` and `liveness` are absent when no
 * registered console claims the port.
 */
export interface ServeOccupant {
  port: number;
  id?: string;
  name?: string;
  liveness?: Liveness;
}

/** One handler of the machine's one Serve table; `targetPort` is null for anything not on loopback. */
export interface ServeHandler {
  host: string;
  httpsPort: number;
  path: string;
  targetPort: number | null;
  ours: boolean;
  occupant?: ServeOccupant;
}

/**
 * The serve command decided against the whole table. `displaces` names the
 * live console that holds the natural https port — the reason `httpsPort` is
 * another one.
 */
export interface ServeCommand {
  httpsPort: number;
  text: string;
  displaces: { httpsPort: number; occupant: ServeOccupant } | null;
}

/**
 * `active` and `forOurPort` stay separate on the wire because they have
 * different fixes: nothing is served, versus something else is — and
 * `targetPort`/`occupant` say which something. Everything past `url` is absent
 * from a server before 5.0.0, which is why it is optional here.
 */
export interface TailscaleServe {
  active: boolean;
  forOurPort: boolean;
  url?: string;
  targetPort?: number;
  occupant?: ServeOccupant;
  handlers?: ServeHandler[];
  /** `null` once a handler serves this console. */
  command?: ServeCommand | null;
}

/** The tailnet as this machine sees it. */
export type TailscaleStatus =
  | { state: 'not-installed' }
  | { state: 'installed-not-running'; detail?: string }
  | {
      state: 'running';
      tailnet?: string;
      magicDns: boolean;
      magicDnsSuffix?: string;
      self: TailscaleDevice;
      peers: TailscaleDevice[];
      serve: TailscaleServe;
    };

/** Where a one-click desktop launcher would land, and whether this platform can. */
export interface LauncherPlanView {
  platform: string;
  supported: boolean;
  path?: string;
  kind?: 'command' | 'desktop-entry';
  note: string;
  rootOpen: boolean;
  fullFlags: readonly string[];
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  method?: string;
  organisation?: string;
  subscription?: string;
  checkedAt: string;
  /** Present when the probe could not answer — different from answering "no". */
  detail?: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: 'personal' | 'project' | 'plugin';
  plugin?: string;
  path: string;
}

/* ---------------- search ----------------
 * Mirrors `server/search.ts`. `kind` stays open for the same reason a phase
 * `state` does: the index decides what it indexes. */

export interface SearchHit {
  slug: string;
  kind: string;
  section: string;
  phase?: number;
  title: string;
  score: number;
  snippet: string;
}

export interface SearchResult {
  query: string;
  total: number;
  groups: { slug: string; title: string; hits: SearchHit[] }[];
}

/* ---------------- the portfolio ----------------
 * Mirrors `server/analysis/stats.ts` (`Portfolio`). */

export interface PortfolioTotals {
  plans: number;
  documents: number;
  orphans: number;
  /**
   * Plans an operator has closed. ⚠️ The census fields (`phases`, `done`,
   * `percent`, `waiting`, `inProgress`, `stuck`) still count them; the
   * forward-looking ones (`ready`, `remainingWeight`, `remainingSessions`) do
   * not. Closing a plan quiets it — it never deletes its history.
   */
  closed: number;
  phases: number;
  done: number;
  ready: number;
  waiting: number;
  inProgress: number;
  stuck: number;
  percent: number;
  remainingWeight: number;
  remainingSessions: number;
}

export interface Portfolio {
  generatedAt: number;
  totals: PortfolioTotals;
  /** `closed`: this status word is terminal. Carried by the server so a consumer
   * groups the terminal statuses without re-deriving the predicate. */
  byStatus: { status: string; count: number; closed?: boolean }[];
  /** `closed`: the lock's plan is terminal, so the lock is debris — `phase-lock.sh
   * conflicts` skips it and it blocks nobody. Optional for an older server. */
  activeLocks: {
    slug: string;
    phase: number;
    owner: string;
    expired: boolean;
    leaseUntil?: number;
    closed?: boolean;
    /** The claiming session's id, when the lock names one (newer servers). */
    session?: string;
  }[];
  issues: HealthIssue[];
  velocity: { week: string; count: number }[];
  calendar: { date: string; count: number }[];
  medianCycleDays?: number;
  sizeMix: { size: string; count: number }[];
  repos: { repo: string; count: number }[];
  skills: { skill: string; count: number }[];
  models: { model: string; count: number }[];
  stalled: { slug: string; days: number; ready: number[] }[];
  busiest: { slug: string; completions: number }[];
  /** How fast a phase has actually been going lately, pooled across every plan. */
  rate?: { ratePerWeight: number; basis: EtaBasis; samples: number; spread: number };
}

/* ---------------- the directory picker ---------------- */

export interface DirListing {
  path: string;
  parent?: string;
  entries: { name: string; path: string; hasDocs: boolean }[];
}

/** `server/config.ts` `RootCheck` — `ok` is the only field always meaningful. */
export interface RootCheck {
  path: string;
  ok: boolean;
  label: string;
  planCount: number;
  handoffCount: number;
  docsDir?: string;
  plansDir?: string;
  reason?: string;
}

export interface OpenRootResult {
  check: RootCheck;
  state: ConsoleState;
}

/* ---------------- restarting the console ---------------- */

export interface RestartReadiness {
  ok: boolean;
  reason?: string;
  /** Nothing supervises this console, so it restarts by re-executing itself with its own argv. */
  selfRestart?: boolean;
  supervisor: SupervisorInfo;
  busy: boolean;
  run: { slug: string; status: string; phase?: number } | null;
  /** A restart has always killed every pty. Now it says so before it does. */
  sessions?: SessionInventory;
}

/** The console's own fetchers — merged into `api` by `./index`. */
export const systemApi = {
  /** This machine's tailnet — devices, and whether `serve` points here. */
  tailscale: () => request<TailscaleStatus>('/api/tailscale'),
  stats: () => request<Portfolio>('/api/stats'),

  /* ---- the directory picker ---- */
  browse: (path?: string) => request<DirListing>(`/api/fs?path=${q(path ?? '')}`),
  checkRoot: (path: string) => request<RootCheck>(`/api/root?path=${q(path)}`),
  openRoot: (path: string) => post<OpenRootResult>('/api/root', { path }),

  search: (query: string) => request<SearchResult>(`/api/search?q=${q(query)}`),
  skills: () => request<SkillInfo[]>('/api/skills'),

  /* ---- the desktop launcher ---- */
  launcherPlan: () => request<LauncherPlanView>('/api/launcher'),
  createLauncher: () => post<{ ok: true; path: string; note: string }>('/api/launcher'),

  /* ---- signing in, and restarting the console itself ---- */
  auth: (force?: boolean) => request<AuthStatus>(`/api/auth${force ? '?force=1' : ''}`),
  authLogin: () => post<{ opened?: boolean; detail?: string }>('/api/auth/login'),
  restartReadiness: () => request<RestartReadiness>('/api/restart'),
  /* No `by`: the server DERIVES the actor from the request — a browser is
   * `operator`, a script is `script`, a tailnet caller its login (SHD-3). */
  restart: () => post<unknown>('/api/restart', {}),

  /* The off switch. `confirm` is required by the server so a replayed or stray
   * POST cannot end a console; the dialog is what supplies it — and, having
   * SHOWN the inventory, the acknowledgement a non-empty one needs (SHD-1).
   * `mode: 'unload'` is the separate "stay off" choice (SHD-2). */
  shutdownReadiness: () => request<ShutdownReadiness>('/api/shutdown'),
  shutdown: (opts: { mode?: ShutdownMode; acknowledge?: boolean } = {}) =>
    post<ShutdownOutcome>('/api/shutdown', { confirm: true, ...opts }),
};
