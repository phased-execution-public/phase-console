/**
 * The data plane: TanStack Query for *what is true*, the SSE stream for *when it
 * changed*.
 *
 * The old client cached responses in a Map and dropped entries when the server
 * said "changed". That worked, but the rule lived inside the fetch helper, so
 * "which events make which screen stale" was spread across every view that
 * happened to subscribe. Here it is one table — `EVENT_EFFECTS` — and the client
 * test asserts the table covers every event name the server can emit. An event
 * added on the server with no entry here is a test failure, not a screen that
 * quietly stops updating.
 *
 * Polling is off everywhere. The stream is the freshness signal; an interval on
 * top of it is a second, slower, wronger answer to the same question.
 *
 * Writing lives here too, at the foot of the file — `useApiMutation` and the
 * `keys.after*` bundles. The reason is the same one that put the effects table
 * here: "which keys does this write move" is a fact about the cache, and it was
 * being re-decided by every button that had one.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PreludeDraft } from '@/lib/api';
import {
  QueryClient,
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClientConfig,
  type QueryKey,
  type UseMutationResult,
} from '@tanstack/react-query';
import {
  api,
  type AccountsState,
  type ConsoleState,
  type InboxQuery,
  type NotificationScope,
  type PlanDetail,
  type PlanSummary,
  type TerminalState,
  type McpState,
  type SessionRegistryView,
  type ConvergeView,
  type ConvergeStatusView,
  type RepoGraphParams,
  type RepoDiffParams,
  type IssuesPayload,
  type DebugIndexParams,
} from './api';
import { isClosed } from './closure';
// The module, not the barrel: `components/ui/index.ts` pulls every primitive in,
// and the data plane is imported by every page.
import { toast } from '@/components/ui/toast';
import { askCount, attentionCount } from '@shared/attention-model.js';
import { PLAN_INCLUDES, includeParam } from '@shared/projection.js';
import { SSE_EVENTS, onSse, useSseStatus, type SseEvent } from './sse';

/* ---------------- keys ---------------- */

/**
 * Everything about one plan hangs off `['plan', slug]` on purpose.
 *
 * TanStack matches query keys by prefix, so the single `slugScoped: 'plan'`
 * invalidation in the table below reaches the plan detail, the open handoff, the
 * raw markdown and any boot prompt at once. The alternative — a flat key per
 * endpoint — means every new event has to remember every screen it affects, and
 * the one it forgets is the one that goes stale in front of you.
 */
export const keys = {
  state: () => ['state'] as const,
  plans: () => ['plans'] as const,
  /**
   * The BOARD projection, and the prefix every other plan key hangs off.
   *
   * A tab that needs more than the board asks for it by group
   * (`shared/projection.js`) and gets its own key under this prefix, so the
   * 47.8 KB board answer stays shared by the dashboard, the gate card, the
   * command palette and the Route tab instead of being re-fetched at 286 KB by
   * whichever of them rendered last. `includeParam` sorts the groups, so two
   * callers asking for the same set in a different order share one entry.
   */
  plan: (slug: string, include?: Iterable<string>) => {
    const param = include ? includeParam(include, PLAN_INCLUDES) : '';
    return (param ? ['plan', slug, 'include', param] : ['plan', slug]) as readonly unknown[];
  },
  planRaw: (slug: string) => ['plan', slug, 'raw'] as const,
  verifyPreflight: (slug: string) => ['plan', slug, 'verify-preflight'] as const,
  /** The run-start prelude for one draft — keyed by the draft's answers, so a changed account list re-probes. */
  prelude: (slug: string, draft: string) => ['plan', slug, 'prelude', draft] as const,
  isolationPreflight: (slug: string) => ['plan', slug, 'isolation-preflight'] as const,
  handoff: (slug: string, phase: number | string) => ['plan', slug, 'handoff', String(phase)] as const,
  prompt: (slug: string, phase: number | string) => ['plan', slug, 'prompt', String(phase)] as const,
  nextPrompt: (slug: string, phase: number | string) => ['plan', slug, 'next-prompt', String(phase)] as const,
  qaPrompt: (slug: string, phase: number | string) => ['plan', slug, 'qa-prompt', String(phase)] as const,
  /** One QA report — `round` absent means the latest the ledger records. */
  qaReport: (slug: string, phase: number, round?: number) =>
    ['plan', slug, 'qa-report', String(phase), round ?? 'latest'] as const,
  gate: (slug: string, phase: number | string) => ['plan', slug, 'gate', String(phase)] as const,
  review: (slug: string, phase: number | string) => ['plan', slug, 'review', String(phase)] as const,
  landing: (slug: string) => ['plan', slug, 'landing'] as const,
  stats: () => ['stats'] as const,
  /**
   * The Repo destination — one prefix, five surfaces under it.
   *
   * Every parameter that changes the ANSWER is part of the key, because two
   * requests that differ only in `?ref=` are two different graphs and sharing
   * one cache entry between them is how a page shows another branch's history
   * under this branch's heading. `['repo']` alone invalidates the destination.
   */
  repo: () => ['repo'] as const,
  repoTargets: () => ['repo', 'targets'] as const,
  repoGraph: (params: unknown) => ['repo', 'graph', params] as const,
  repoBranches: (repo: string | undefined) => ['repo', 'branches', repo ?? 'root'] as const,
  repoCheckouts: () => ['repo', 'checkouts'] as const,
  repoDiff: (params: unknown) => ['repo', 'diff', params] as const,
  repoSettles: (params: unknown) => ['repo', 'settles', params] as const,
  /**
   * The issue estate — ONE key, and deliberately not under `['repo', …]`.
   *
   * The board lives in the Repo destination, but the payload is estate-wide:
   * every repository in one answer, with no parameter that changes it. Filing
   * it under the repo prefix would mean a `?repo=`-scoped invalidation of one
   * git surface silently dropped the whole estate's cached issues.
   */
  issues: () => ['issues'] as const,
  /**
   * The Debug destination — one prefix over four surfaces.
   *
   * The index's key carries its whole parameter object for the same reason
   * Repo's does: two reads that differ only in `?source=` are two different
   * logs, and sharing one entry between them is how a page shows the journal
   * under a heading that says "console log".
   */
  debug: () => ['debug'] as const,
  debugIndex: (params: unknown) => ['debug', 'index', params] as const,
  debugRuns: (slug: string) => ['debug', 'runs', slug] as const,
  debugBundle: (params: unknown) => ['debug', 'bundle', params] as const,
  terminal: () => ['terminal'] as const,
  /** The session-presence registry — every Claude session the hook reported for this instance. */
  sessionRegistry: () => ['sessions', 'registry'] as const,
  converge: () => ['converge'] as const,
  /** Is the session-presence hook in `~/.claude/settings.json`? */
  hooksStatus: () => ['hooks-status'] as const,
  approvals: () => ['approvals'] as const,
  runs: () => ['runs'] as const,
  run: (slug: string) => ['run', slug] as const,
  /**
   * Admission, and it is deliberately NOT under `['run', slug]`.
   *
   * Both answer questions about *other* plans: what is holding the scope this
   * phase wants, and what would collide if it started now. `run:queue` — the one
   * event that moves them — is not slug-scoped precisely because a grant released
   * on plan A is what unblocks plan B, so these have to be reachable without
   * knowing whose release it was. `['scopes']` as a bare prefix invalidates every
   * plan's answer at once, which is what a release actually changes.
   */
  queue: () => ['queue'] as const,
  tailscale: () => ['tailscale'] as const,
  scopes: (slug: string) => ['scopes', slug] as const,
  /**
   * Deliberately NOT under `['run', slug]`.
   *
   * Everything else about a plan hangs off its prefix so one event refreshes the
   * lot — but these two must not. The transcript is a one-shot replay of up to
   * 4 MB that live events supersede the moment it lands, and a diagnosis costs a
   * `git status` and two script runs. Under the run prefix, every `run:phase`
   * would refetch both; the console would re-hydrate from the network several
   * times a minute to learn nothing it was not already being told.
   */
  transcript: (slug: string) => ['transcript', slug] as const,
  diagnosis: (slug: string, phase: number | string) => ['diagnosis', slug, String(phase)] as const,
  /**
   * The journal, and — like the transcript above — deliberately NOT under
   * `['run', slug]`.
   *
   * It is a one-shot read of the last N lines that the live `run:journal`
   * firehose supersedes line by line. Under the run prefix every `run:phase`
   * would re-read the whole tail from disk to learn what the stream had
   * already appended.
   */
  journal: (slug: string, id?: number | string) => ['journal', slug, String(id ?? 'latest')] as const,
  /**
   * The plan's ruling ledger. Its own key for a different reason: it is per
   * PLAN, not per run, and it outlives every run of that plan. Nothing but
   * `run:rulings` moves it.
   */
  rulings: (slug: string) => ['rulings', slug] as const,
  /**
   * The run's time axis, and one phase's boardings.
   *
   * Their own prefixes, for the journal's reason — both are derived reads of
   * the journal file, and under `['run', slug]` every `run:phase` would
   * re-project the whole file to learn what the run payload already said.
   * They ARE moved by a phase transition (a bar closes, an attempt lands), so
   * the effects table invalidates the bare prefixes: one run page is open at a
   * time, and a prefix invalidation costs one refetch rather than a slug-aware
   * effect entry that has to be kept in step with two key shapes.
   */
  timelineAll: () => ['timeline'] as const,
  timeline: (slug: string, id?: string) => ['timeline', slug, String(id ?? 'latest')] as const,
  attemptsAll: () => ['attempts'] as const,
  /** The run's ledger (phase 19) — moved by the same phase transitions as the timeline, so invalidated by prefix too. */
  ledgerAll: () => ['ledger'] as const,
  ledger: (slug: string, id?: string) => ['ledger', slug, String(id ?? 'latest')] as const,
  /** Every open plan's ledgers, per plan and per account — Insights. */
  ledgerSummary: () => ['ledger-summary'] as const,
  attempts: (slug: string, phase: number | string, id?: string) =>
    ['attempts', slug, String(phase), String(id ?? 'latest')] as const,
  /** Money, instance-wide: today against the day cap, per run, and the 7-day series. */
  spend: () => ['spend'] as const,
  /**
   * The unified attention inbox — everything that needs a person.
   *
   * A prefix with the `all` flag under it, so the Now section (open items) and
   * the bell drawer's "including acknowledged" view are two cache entries that
   * ONE `keys.inbox()` invalidation refreshes together. Answering a card on a
   * phone has to take the row off the laptop, and the two surfaces are usually
   * both mounted.
   *
   * Deliberately NOT `keys.notifications()`: that is the LOG of what the
   * console announced, and this is the list of what is still waiting. They
   * were one word apart and two different questions, which is how the badge
   * ended up counting the wrong one.
   */
  inbox: (all?: boolean) => (all == null ? (['inbox'] as const) : (['inbox', all] as const)),
  auth: () => ['auth'] as const,
  accounts: () => ['accounts'] as const,
  mcp: () => ['mcp'] as const,
  mcpCatalog: (query: string) => ['mcp', 'catalog', query] as const,
  launcher: () => ['launcher'] as const,
  skills: () => ['skills'] as const,
  notifications: () => ['notifications'] as const,
  search: (query: string) => ['search', query] as const,
  /** Both push keys sit under one prefix so subscribing refreshes the register. */
  push: () => ['push'] as const,
  webhooks: () => ['webhooks'] as const,
  policy: (slug: string) => ['policy', slug] as const,
  restart: () => ['restart'] as const,
  shutdown: () => ['shutdown'] as const,
  browse: (path: string) => ['browse', path] as const,
  rootCheck: (path: string) => ['root-check', path] as const,

  /* ---------------- after a write ----------------
   *
   * A mutation does not invalidate ONE key, it invalidates a set — and the set
   * is a claim about what the write actually moved. Those sets were written out
   * inline at every call site: `plans + stats + plan` appeared four times in
   * three files, `review + plan + plans` twice in one, and each copy was free to
   * forget a member. The copy that forgets is not a crash, it is a card that
   * stays on screen after it has been answered.
   *
   * Each name below is the MEANING of one write, and the list under it is what
   * that meaning implies. Feed one to `useApiMutation`'s `invalidates`. They are
   * bundles, not keys: never pass one to a `queryKey`, which wants a single key
   * and would silently take an array of them.
   */

  /**
   * A script rewrote the plan's files — a handoff landed, a plan was scaffolded
   * or reopened, a lock was released. The plan itself, the list it appears on,
   * and the portfolio totals it contributes to.
   */
  afterPlanWrite: (slug?: string): KeyBundle =>
    slug ? [keys.plans(), keys.stats(), keys.plan(slug)] : [keys.plans(), keys.stats()],

  /**
   * A gate was answered on a phase. Same reach as a plan write minus the
   * portfolio (a gate moves no totals) plus the run, because approving a gate
   * is also what lets a halted run carry on.
   */
  afterGate: (slug: string): KeyBundle => [keys.plan(slug), keys.plans(), keys.run(slug)],

  /** A review verdict or a review comment: this phase's review, then the board it moves. */
  afterReview: (slug: string, phase: number | string): KeyBundle => [
    keys.review(slug, phase),
    keys.plan(slug),
    keys.plans(),
  ],

  /**
   * A run verb landed — stop, freeze, thaw, decide, recover.
   *
   * Deliberately the UNION of what the two hand-rolled copies each reached for:
   * the run, the fleet that lists it, the plan whose board it moves, and the
   * asks its session was holding. Each copy was missing two of the four, which
   * is how a stopped lane went on being listed as live on the page next door.
   */
  afterRunAct: (slug: string): KeyBundle => [keys.run(slug), keys.runs(), keys.plan(slug), keys.approvals()],

  /** A run was started: the fleet, the board it will move, the totals, and the console's own state. */
  afterRunLaunch: (): KeyBundle => [keys.runs(), keys.plans(), keys.stats(), keys.state()],

  /**
   * An inbox item was answered. The widest bundle in the console, and honestly
   * so: an inbox verb can approve a permission, recover a run, unblock a phase
   * and clear a badge in one press.
   */
  afterInboxAct: (): KeyBundle => [keys.inbox(), keys.runs(), keys.plans(), keys.approvals(), keys.state()],

  /** A preference was saved. Prefs live on `/api/state` and nowhere else. */
  afterPrefs: (): KeyBundle => [keys.state()],
  /** An announcement changed (read/cleared): the log itself, and the bell's
   * unread count, which lives on `/api/state`. */
  afterAnnouncement: (): KeyBundle => [keys.notifications(), keys.state()],
};

/**
 * A set of query keys one write invalidates.
 *
 * Its own name because it is NOT a `QueryKey`: TanStack's key type is
 * `readonly unknown[]`, so a bundle passed where a key belongs typechecks and
 * then matches nothing at all.
 */
export type KeyBundle = readonly QueryKey[];

/**
 * How long an unobserved answer is kept before it is collected.
 *
 * `staleTime: Infinity` said "never refetch this on a timer" and `gcTime` was
 * left at TanStack's default of five minutes, which quietly said the opposite:
 * a plan you scrolled away from was thrown away after five minutes and the next
 * open was as cold as the first, engine invocation and all. The two settings
 * have to agree, and the one that matches how this console is used — a tab left
 * open all day, moving between a handful of plans — is a long retention with
 * explicit invalidation doing every eviction that matters.
 *
 * A day rather than `Infinity` so a tab open across a week of work cannot grow
 * without any bound at all; the persisted cache uses the same figure as its
 * `maxAge`, so what survives a reload and what survives a navigation are one
 * number rather than two that can drift.
 */
export const CACHE_GC_TIME = 24 * 60 * 60 * 1000;

export const queryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      // The stream invalidates; nothing needs a timer. `staleTime: Infinity`
      // plus explicit invalidation is the whole contract.
      staleTime: Infinity,
      gcTime: CACHE_GC_TIME,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: false,
      retry: 1,
    },
  },
};

export const createQueryClient = (): QueryClient => new QueryClient(queryClientConfig);

/* ---------------- event → effect ---------------- */

/** What one event does to the cache. */
type Effect = {
  /** Key prefixes to invalidate. `slugKeys` adds per-slug plan/run keys. */
  invalidate?: readonly (readonly unknown[])[];
  /** Invalidate `['plan', slug]` / `['run', slug]` for the slug(s) in the payload. */
  slugScoped?: 'plan' | 'run' | 'both';
  /** Everything is suspect (a warm/reindex). */
  all?: boolean;
  /**
   * Everything is suspect, but only when the payload says so.
   *
   * The narrower cousin of `all`, for an event that is USUALLY news about
   * nothing the client holds. Returning `false` invalidates nothing at all —
   * not even `invalidate` — because the point is to spend no requests.
   */
  allWhen?: (client: QueryClient, data: Record<string, unknown>) => boolean;
  /** Cheap in-place cache write instead of a refetch. */
  patch?: (client: QueryClient, data: Record<string, unknown>) => void;
  /** Deliberately invalidates nothing — see the note on each. */
  streamOnly?: true;
};

/** The unread badge travels on the event itself; refetching /api/state to learn
 *  a number the payload already carries is a round trip for nothing. */
const patchUnread: Effect['patch'] = (client, data) => {
  if (typeof data.unread !== 'number') return;
  client.setQueryData(keys.state(), (prev: ConsoleState | undefined) =>
    prev ? { ...prev, unread: data.unread as number } : prev,
  );
};

/** The account list travels on the event; writing it beats asking for it back. */
const patchAccounts: Effect['patch'] = (client, data) => {
  if (!Array.isArray(data.accounts)) return;
  client.setQueryData(keys.accounts(), (prev: AccountsState | undefined) => ({
    accounts: data.accounts as AccountsState['accounts'],
    allowAccounts: prev?.allowAccounts ?? false,
  }));
};

/**
 * The lint lands after the plan does, and travels on its own event.
 *
 * `/api/plans/<slug>` stopped awaiting `validate.sh` (11.27 s on the plan
 * somebody was actually working on) so the page can paint; the server computes
 * it behind the response and pushes it here. Written only onto a detail the
 * cache already holds — an event for a plan nobody has open is nothing to do,
 * not a reason to fetch one.
 */
const patchLint: Effect['patch'] = (client, data) => {
  if (typeof data.slug !== 'string' || !data.lint) return;
  // EVERY projection of this plan, not only the board one.
  //
  // `['plan', slug]` is a prefix, so this also matches the raw markdown, the
  // boot prompts, the gate and the landing packet — none of which is a
  // `PlanDetail`, and `{...aString, lint}` would quietly corrupt the cache. The
  // `summary` guard is what makes the prefix sweep safe: it patches the entries
  // that ARE plan details (`['plan', slug]` and each `…, 'include', <groups>`)
  // and leaves every sibling alone.
  client.setQueriesData({ queryKey: ['plan', data.slug] }, (prev: unknown) =>
    prev && typeof prev === 'object' && 'summary' in prev
      ? { ...(prev as PlanDetail), lint: data.lint as PlanDetail['lint'] }
      : prev,
  );
};

/** The server list travels on the event; writing it beats asking for it back. */
const patchMcp: Effect['patch'] = (client, data) => {
  if (!Array.isArray(data.servers)) return;
  client.setQueryData(keys.mcp(), (prev: McpState | undefined) => ({
    servers: data.servers as McpState['servers'],
    allowMcp: prev?.allowMcp ?? false,
  }));
};

/** The session list travels on the event; writing it beats asking for it back. */
const patchSessions: Effect['patch'] = (client, data) => {
  if (Array.isArray(data.sessions)) {
    client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) =>
      prev
        ? {
            ...prev,
            sessions: data.sessions as TerminalState['sessions'],
            ...(typeof data.live === 'number' ? { live: data.live as number } : {}),
          }
        : prev,
    );
  }
  // A recovery verdict moves the run record server-side (the write-back), and
  // a NOT-fixed verdict moves nothing that would emit `run:state` — so the run
  // and plan queries are re-read off the same event either way. This payload
  // had no consumer at all for a while: the run was fixed on disk and every
  // open tab kept the halt banner until a manual reload.
  if (data.type === 'recovery-outcome') {
    void client.invalidateQueries({ queryKey: keys.runs() });
    const slug = (data.recovery as { slug?: string } | undefined)?.slug;
    if (slug) {
      void client.invalidateQueries({ queryKey: keys.run(slug) });
      void client.invalidateQueries({ queryKey: keys.plan(slug) });
    }
  }
};

/** The `foreign` list the server appends to every `sessions` event — the registry, written straight into the cache. */
const patchPresence: Effect['patch'] = (client, data) => {
  if (Array.isArray(data.foreign)) {
    client.setQueryData<SessionRegistryView>(keys.sessionRegistry(), {
      sessions: data.foreign as SessionRegistryView['sessions'],
    });
  }
};
/** A finished convergence pass: merge its view into the cache by slug — the full report rides the event. */
const patchConverge: Effect['patch'] = (client, data) => {
  if (!data || typeof data.slug !== 'string' || !Array.isArray(data.actions)) return;
  const view = data as unknown as ConvergeView;
  client.setQueryData<ConvergeStatusView>(keys.converge(), (current) => {
    const rest = (current?.reports ?? []).filter((report) => report.slug !== view.slug);
    return {
      automatic: current?.automatic ?? true,
      everyMs: current?.everyMs ?? 0,
      pending: (current?.pending ?? []).filter((p) => p.slug !== view.slug),
      running: (current?.running ?? []).filter((slug) => slug !== view.slug),
      reports: [...rest, view],
    };
  });
};

/**
 * Did this `warm` come from opening a root we are NOT looking at?
 *
 * Three readings, and only one of them costs a request:
 *
 * - **No cached state at all** — this tab is still loading. There is nothing
 *   stale to throw away, and anything already in flight is being answered by
 *   the very server that just warmed. `false`.
 * - **Same root** — boot, or a re-open of the same directory. The boards were
 *   rebuilt from the same files; every answer we hold is still the answer.
 *   `false`, and this is the case that used to cost a whole cache.
 * - **A different root**, or a server too old to say which — everything we hold
 *   is about another project. `true`.
 *
 * Deliberately NOT keyed on `generation`: it advances on every `changed` too,
 * so a tab whose `/api/state` was a few file-saves behind would read every warm
 * as a root switch. The root path is the fact this question is actually about.
 */
function warmedAnotherRoot(client: QueryClient, data: Record<string, unknown>): boolean {
  const held = client.getQueryData<ConsoleState>(keys.state());
  if (!held) return false;
  const warmed = typeof data.root === 'string' ? data.root : null;
  return warmed === null || warmed !== held.root?.path;
}

export const EVENT_EFFECTS: Record<SseEvent, Effect> = {
  /* ---- the repo moved under us ---- */
  // Queue and runs ride along: lock files live under docs/handoffs, so a
  // foreign claim or release arrives as `changed` — and the queue page used
  // to sit stale (observed live: entries [] while a real manual lock held
  // the phase) because nothing here invalidated it.
  changed: {
    invalidate: [keys.plans(), keys.stats(), keys.state(), keys.queue(), keys.runs()],
    slugScoped: 'plan',
  },
  /*
   * The server finished pre-computing every board.
   *
   * This used to be `{ all: true }` — `invalidateQueries()` with no key, i.e.
   * throw away the entire cache. It fires from exactly ONE place, `open()`, so
   * in practice it arrived a moment after console boot and re-fetched the plan
   * a browser had just finished loading: the second of two identical 46 KB
   * requests, on the slowest part of the page's life.
   *
   * Nothing about a warm changes what an answer WOULD have been — the boards
   * are recomputed from the same files the previous answer was built from. The
   * one case where the client is genuinely holding the wrong thing is `open()`
   * against a DIFFERENT root, and the event now says which root it warmed, so
   * that case can be recognised instead of assumed. See `warmedAnotherRoot`.
   *
   * The safety `{ all: true }` accidentally provided — "a console restarted and
   * this tab may have missed events" — is not this event's job and never was:
   * a restart the browser slept through emits no warm the tab is listening to.
   * `useLiveData`'s reconnect guard covers it, deliberately and by name.
   */
  warm: { allWhen: warmedAnotherRoot },
  /* Watcher/server health is part of what `/api/state` reports (including
     `serverStale`, which the shell turns into a banner). */
  health: { invalidate: [keys.state()] },

  /* ---- approvals ---- */
  approval: { invalidate: [keys.approvals()] },
  // A card answered on a phone has to take the badge down on the laptop.
  'approval:resolved': { invalidate: [keys.approvals()] },

  /* ---- the inbox ---- */
  notification: { invalidate: [keys.notifications(), keys.state()] },
  'notification:delivery': { invalidate: [keys.notifications()] },
  'notification:read': { invalidate: [keys.notifications()], patch: patchUnread },
  'notification:cleared': { invalidate: [keys.notifications()], patch: patchUnread },

  /* ---- the unified work inbox ----
     `Service.emit()` debounces this one, so it arrives when something a person
     is waiting on actually changed. All three keys move together because a
     single fact reaches the operator through all three surfaces: the inbox
     rows, the approval cards the run page still draws, and the badge that
     `/api/state` feeds. */
  inbox: { invalidate: [keys.inbox(), keys.approvals(), keys.notifications()] },

  /* ---- sessions ----
     The list rides on the event, so this is a cache write rather than a
     refetch: a session appearing or ending must reach the dashboard card and
     the nav badges in the same tick, and there is nothing to ask for that the
     payload does not already carry. Invalidation stays as the belt to that
     braces — `/api/terminal` also answers `available` and the flags. */
  // The registry rides the same event: the server appends `foreign` — every
  // hook-reported session with its presence — to each `sessions` emission.
  sessions: {
    invalidate: [keys.terminal(), keys.sessionRegistry()],
    patch: (client, data) => {
      patchSessions(client, data);
      patchPresence(client, data);
    },
  },

  /* ---- autopilot ----
     A run starting, finishing, or having a phase land changes the board too:
     `plans` carries each plan's ready-set, and that is what a finished phase
     moves. */
  'run:run': {
    // A start writes `run.start` — the ledger's why-started — as well as moving the board.
    invalidate: [keys.runs(), keys.plans(), keys.spend(), keys.ledgerAll(), keys.ledgerSummary()],
    slugScoped: 'both',
  },
  'run:phase': {
    invalidate: [
      keys.runs(),
      keys.spend(),
      keys.timelineAll(),
      keys.attemptsAll(),
      keys.ledgerAll(),
      keys.ledgerSummary(),
    ],
    slugScoped: 'both',
  },
  'run:verify': { slugScoped: 'run' },
  'run:state': { invalidate: [keys.runs(), keys.plans(), keys.spend()], slugScoped: 'both' },
  /* A lane's liveness answer CHANGED — it went silent, started spinning, hit a
     stalemate, or came back. `runner.ts` emits only transitions, so this is
     news by construction and can afford to invalidate: the run payload carries
     `liveness[]`, and the fleet table badges a stalled run without being on
     its page. */
  'run:liveness': { invalidate: [keys.runs()], slugScoped: 'run' },
  /* The silent-session watchdog ACTED on a lane — nudged it, recycled it, or
     parked the phase after both. Its own event because none of the three is
     visible in any other one: a nudge changes no status at all, and a recycle
     kills a child whose settle arrives seconds later, which is a page showing
     a running session that is already gone. Invalidates the run for the same
     reason `run:liveness` does — the phase record carries `stallRemedy`. */
  'run:watchdog': { invalidate: [keys.runs()], slugScoped: 'run' },
  /* The run's git situation moved — commits, checkouts, or a radar verdict.
     `runs` for `run:liveness`'s reason: the run payload carries `git`, and the
     fleet table wants to badge a run whose branch is heading for a conflict
     without being on its page. Emitted only on a CHANGE, so it can afford to
     invalidate; a probe that fired every five minutes regardless would make
     this the most expensive entry in the table. */
  'run:git': { invalidate: [keys.runs()], slugScoped: 'run' },
  /* A ruling landed in the ledger. Both halves move: the plan-wide ledger the
     page reads, and `run.rulings` — the slice the run payload carries. */
  'run:rulings': {
    invalidate: [],
    slugScoped: 'run',
    patch: (client, data) => {
      const slug = typeof data.slug === 'string' ? data.slug : null;
      if (slug) void client.invalidateQueries({ queryKey: keys.rulings(slug) });
    },
  },
  /* Admission moved. `runs` because a phase crossing between queued and
     running is a change to a run; `state` because the header's "2 of 3
     running, 1 queued" is read from `/api/state`. Deliberately NOT
     slug-scoped: a grant released on one plan is precisely what unblocks
     another, and the plan that needs to hear about it is the other one —
     which is also why `['scopes']` is invalidated as a bare prefix rather
     than for the slug the event happens to name. */
  'run:queue': { invalidate: [keys.runs(), keys.state(), keys.queue(), ['scopes']] },
  /* A convergence pass landed: the view rides the event, so this is a cache
     write by slug; `runs` is invalidated too because a relaunch or a heal has
     just changed a run, and `/api/converge` is re-read as the belt to those
     braces (the pending/running lists move independently of any one pass). */
  'run:converge': { invalidate: [keys.converge(), keys.runs()], patch: patchConverge },

  /* ---- accounts ----
     The redacted list rides on the event (see `patchAccounts`), so this is a
     cache write first; the invalidation is the belt to those braces, because
     `/api/accounts` also carries `allowAccounts`. */
  accounts: { invalidate: [keys.accounts()], patch: patchAccounts },

  /* ---- MCP servers ----
     Same shape as accounts, and for the same reason: the redacted list rides on
     the event, and the invalidation is the belt to those braces because
     `/api/mcp` also carries `allowMcp`. A registry change also moves F15, which
     the lint panel reads through the plan — hence `plans` too. */
  mcp: { invalidate: [keys.mcp(), keys.plans()], patch: patchMcp },

  /* ---- the firehose ----
     These two arrive many times a second while a phase is talking. The run view
     subscribes to them directly and appends; routing them through the cache
     would refetch the whole run object per line. Invalidating nothing here is
     the point, not an omission. */
  'run:stream': { streamOnly: true },
  'run:journal': { streamOnly: true },

  /* ---- the lint, arriving after the page ----
     A cache WRITE and no invalidation: the plan detail the browser is holding
     is correct in every other respect, and refetching a 288 KB document to
     collect one field the event already carries is the round trip this whole
     change exists to remove. */
  'plan:lint': { patch: patchLint },
};

/** Slugs named by an event payload, in the two shapes the server uses. */
function slugsOf(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as { slug?: unknown; slugs?: unknown };
  if (Array.isArray(record.slugs)) return record.slugs.filter((s): s is string => typeof s === 'string');
  if (typeof record.slug === 'string') return [record.slug];
  return [];
}

/**
 * One event, applied to the cache.
 *
 * Exported for the tests: the table above is a set of claims about what an
 * arriving event costs, and the only way to check a claim like "a warm at boot
 * re-fetches nothing" is to apply the event to a real client and look. Nothing
 * in the app calls it except `useLiveData`.
 */
export function applyEffect(client: QueryClient, name: SseEvent, data: unknown): void {
  const effect = EVENT_EFFECTS[name];
  if (!effect || effect.streamOnly) return;

  if (effect.all) {
    void client.invalidateQueries();
    return;
  }

  // `allWhen` answers for the whole event, both ways: `true` is `all`, and
  // `false` means this arrival is news about nothing — not "fall through to
  // the narrower keys". An event that wants both shapes should be two effects.
  if (effect.allWhen) {
    if (effect.allWhen(client, (data ?? {}) as Record<string, unknown>)) void client.invalidateQueries();
    return;
  }

  for (const key of effect.invalidate ?? []) {
    void client.invalidateQueries({ queryKey: key });
  }

  if (effect.slugScoped) {
    for (const slug of slugsOf(data)) {
      if (effect.slugScoped !== 'run') void client.invalidateQueries({ queryKey: keys.plan(slug) });
      if (effect.slugScoped !== 'plan') void client.invalidateQueries({ queryKey: keys.run(slug) });
    }
  }

  if (effect.patch && data && typeof data === 'object') {
    effect.patch(client, data as Record<string, unknown>);
  }
}

/**
 * Mount once, in the shell. Wires every server event to its cache effect.
 *
 * Plus the one invalidation that is not an event: a stream that went away and
 * CAME BACK. Everything above assumes the tab saw every emission; a laptop that
 * slept, a console that restarted, a tunnel that dropped, all break that
 * assumption silently, and the events missed in the gap are unrecoverable by
 * construction. So the first return to `live` after a loss re-reads whatever is
 * on screen. It is the honest home for the safety `warm: { all: true }` used to
 * give by accident — accurate about a restart the old one could not see, and
 * quiet at boot, where the old one was loudest.
 */
export function useLiveData(): void {
  const client = useQueryClient();
  useEffect(() => {
    const offs = SSE_EVENTS.map((name) => onSse(name, (data) => applyEffect(client, name, data)));
    return () => {
      for (const off of offs) off();
    };
  }, [client]);

  const status = useSseStatus();
  // The FIRST `live` is a connection, not a reconnection — invalidating there
  // would re-fetch the page's own opening requests, which is the double-fetch
  // this phase exists to remove. Only a `live` that follows a loss counts, so
  // the ref holds three states rather than a boolean.
  const link = useRef<'cold' | 'live' | 'lost'>('cold');
  useEffect(() => {
    if (status !== 'live') {
      if (link.current === 'live') link.current = 'lost';
      return;
    }
    const reconnected = link.current === 'lost';
    link.current = 'live';
    if (reconnected) void client.invalidateQueries();
  }, [status, client]);
}

/* ---------------- the shell's own queries ---------------- */

export function useConsoleState() {
  return useQuery({ queryKey: keys.state(), queryFn: api.state });
}

export function usePlans(enabled = true) {
  return useQuery({ queryKey: keys.plans(), queryFn: api.plans, enabled });
}

/** The instance's Claude accounts with their meters — live via the `accounts` event. */
export function useAccounts(enabled = true) {
  return useQuery({ queryKey: keys.accounts(), queryFn: api.accounts, enabled });
}

/** This instance's MCP servers with their health — live via the `mcp` event. */
export function useMcp(enabled = true) {
  return useQuery({ queryKey: keys.mcp(), queryFn: api.mcp, enabled });
}

/**
 * The catalog for one search string.
 *
 * Its own key per query rather than one cache entry, because the registry half
 * of the answer is a network round trip and re-typing a search you already ran
 * should not repeat it. `staleTime: Infinity` (the app default) is right here:
 * the published catalog does not move while somebody is reading it.
 */
export function useMcpCatalog(query: string, enabled = true) {
  return useQuery({
    queryKey: keys.mcpCatalog(query),
    queryFn: () => api.mcpCatalog(query),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** Every Claude session the presence hook reported for this instance — a person's, an agent's, a lane's — with its presence. */
export function useSessionRegistry(enabled = true) {
  return useQuery({ queryKey: keys.sessionRegistry(), queryFn: api.sessionRegistry, enabled });
}

/** The session-presence hook's presence in `~/.claude/settings.json`. */

/** The convergence loop's standing and its last pass per plan (`GET /api/converge`). */
export function useConverge(enabled = true) {
  return useQuery({
    queryKey: keys.converge(),
    queryFn: api.converge,
    enabled,
    staleTime: 15_000,
  });
}
export function useHooksStatus(enabled = true) {
  return useQuery({ queryKey: keys.hooksStatus(), queryFn: api.hooksStatus, enabled });
}

/** Where a one-click desktop launcher would land on the server's platform. */
export function useLauncherPlan(enabled = true) {
  return useQuery({ queryKey: keys.launcher(), queryFn: api.launcherPlan, enabled });
}

/** How long a page has to stay open before opening it counts as reading. */
const AUTO_READ_DELAY_MS = 1_200;

/**
 * Opening the page that a notification is about counts as reading it.
 *
 * The 182-unread inbox was two failures compounding. P1 fixed the first — a
 * category that was off still recorded. This is the second: nothing ever became
 * read *by being looked at*, so the only way the count ever fell was a bulk
 * clear, which is indistinguishable from giving up on the inbox entirely.
 *
 * Three properties make it safe to do automatically:
 *
 *  - **Scoped, never global.** The server matches on the record's own `slug` /
 *    `runId` / `phase`, and an empty scope matches nothing — so a route whose
 *    slug has not parsed yet clears zero records rather than the inbox.
 *  - **Delayed.** Tabbing through plans should not silently mark six plans'
 *    notifications read; staying long enough to read one should.
 *  - **Only when there is something to clear.** Gated on the unread count the
 *    shell already holds, so the ordinary visit costs no request at all.
 *
 * The badge and any open inbox update from the `notification:read` event the
 * server emits, which is why nothing is invalidated here.
 */
export function useAutoReadNotifications(scope: NotificationScope, enabled = true): void {
  const { data: state } = useConsoleState();
  const unread = state?.unread ?? 0;
  // A stable identity for the scope object, so a caller may build it inline.
  const key = JSON.stringify(scope);

  useEffect(() => {
    if (!enabled || unread < 1) return undefined;
    const parsed = JSON.parse(key) as NotificationScope;
    if (!Object.values(parsed).some((value) => value !== undefined && value !== '')) return undefined;

    const timer = setTimeout(() => {
      // Fire-and-forget: a failed read marker must never surface as an error on
      // a page the operator opened to read something else.
      void api.markNotificationsReadFor(parsed).catch(() => {});
    }, AUTO_READ_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, key, unread]);
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
 * The same list, for the surfaces that want it regardless of which page they
 * are on. Enabled whenever the console can have a session of either kind — the
 * Agent page asks with `allowAgent`, the Terminal page with `allowTerminal`,
 * and the shell wants the union.
 */
export function useSessions(state: ConsoleState | undefined) {
  return useTerminals(state?.allowTerminal === true || state?.allowAgent === true);
}

/** What Shut down is about to stop. Read before the dialog opens, not after. */
export function useShutdownReadiness(enabled = true) {
  return useQuery({ queryKey: keys.shutdown(), queryFn: api.shutdownReadiness, enabled });
}

/**
 * A session parked on an approval is invisible until someone looks, so the badge
 * is kept current from wherever you happen to be in the app — but only on a
 * server that has a runner. Asking one that predates it just fills the browser
 * console with 404s.
 */
export function useApprovals(enabled: boolean) {
  return useQuery({ queryKey: keys.approvals(), queryFn: api.approvals, enabled });
}

/* ---------------- the plan surface ---------------- */

/**
 * One plan, and the fix for the defect that made the old plan view unusable
 * while anything else was happening.
 *
 * The old view held the detail in `useState`, and its `changed` subscriber set
 * it back to `null` before refetching — so *any* write anywhere in the repo
 * (another session finishing a phase, a file saved in an editor, the watcher
 * warming) blanked the page you were reading to a spinner and scrolled you back
 * to the top. `placeholderData: keepPreviousData` is the whole fix: the last
 * answer stays on screen while the next one is fetched, including across a slug
 * change, and `isFetching` is what says "a newer one is coming".
 */
/**
 * `include` names the projection groups this caller needs beyond the board —
 * `shared/projection.js`. Omit it and you get the board: what the Route tab,
 * the dashboard rows, the gate card and the command palette all read, and the
 * only variant `usePlanDetails` ever fetches.
 *
 * ⚠️ **Pass a STABLE array.** A fresh literal each render is a fresh query key
 * each render. Every caller here passes a module-level constant from
 * `tabs.ts`'s `TAB_INCLUDES`, via `includesForTab()`.
 */
export function usePlan(slug: string | undefined, include?: readonly string[]) {
  return useQuery({
    queryKey: keys.plan(slug ?? '', include),
    queryFn: () => api.plan(slug!, { include }),
    enabled: Boolean(slug),
    placeholderData: keepPreviousData,
  });
}

/**
 * Fetch a plan's board BEFORE anyone has asked for it — on hover, on focus.
 *
 * A pointer resting on a row, or a Tab landing on it, is the cheapest reliable
 * signal there is that the next click is that row: it buys the round trip that
 * would otherwise happen after the click, while the reader is still deciding.
 *
 * Three things keep it from being a way to spend requests:
 *
 * - `prefetchQuery` is a no-op when the key already holds fresh data, and with
 *   `staleTime: Infinity` everything already fetched IS fresh — so hovering the
 *   same row ten times costs one request, not ten.
 * - The include set has to be the one the DESTINATION will ask for, which is
 *   why it is a parameter and defaults to the board projection. A prefetch of
 *   a different set warms a key nothing reads and the page then pays twice —
 *   the failure mode is invisible, because both requests succeed.
 * - A failure is swallowed. A prefetch nobody asked for must never surface an
 *   error; the real query will ask again and report properly.
 */
export function usePrefetchPlan(): (slug: string | undefined, include?: readonly string[]) => void {
  const client = useQueryClient();
  return useCallback(
    (slug: string | undefined, include?: readonly string[]) => {
      if (!slug) return;
      void client
        .prefetchQuery({
          queryKey: keys.plan(slug, include),
          queryFn: () => api.plan(slug, { include }),
        })
        .catch(() => {
          /* see the note above */
        });
    },
    [client],
  );
}

/** The two DOM props that mean "this is probably next" — spread onto a row or a link. */
export function prefetchIntent(
  prefetch: (slug: string, include?: readonly string[]) => void,
  slug: string,
  include?: readonly string[],
) {
  return {
    onMouseEnter: () => prefetch(slug, include),
    onFocus: () => prefetch(slug, include),
  };
}

/**
 * Several plans at once, under the same `['plan', slug]` keys as `usePlan`.
 *
 * The ready queue and the dashboard both need facts `/api/plans` does not carry
 * — a phase's title, its size, whether it is gated, how much it unblocks — and
 * those live in the per-plan detail. Fetching them here rather than adding a
 * server endpoint keeps the frozen API frozen, and because the keys are shared,
 * the board warms the cache for exactly the plans you are most likely to open
 * next: clicking through to one is then instant.
 *
 * The cost is bounded by the caller passing a short list, and by the server's
 * own cache — a cold plan costs an engine invocation, a warm one costs nothing.
 * Callers render from the summary first and let each row upgrade as its detail
 * lands, so a slow plan delays a title, never the page.
 *
 * ⚠️ **The map is built in a `useMemo`, not in `useQueries`' `combine`.** A
 * `combine` that returns a `Map` returns a value TanStack's structural sharing
 * cannot compare, so every render produces a new snapshot for the
 * `useSyncExternalStore` behind `useQueries` — which re-renders, which combines
 * again. The symptom is not a slow page: React blows the update-depth limit and
 * throws during render, so the *whole app* goes blank and the console only says
 * "an error occurred in <ReadyView>". Keep the derived shape out of `combine`.
 */
export function usePlanDetails(slugs: readonly string[], enabled = true) {
  const results = useQueries({
    queries: slugs.map((slug) => ({
      queryKey: keys.plan(slug),
      queryFn: () => api.plan(slug),
      enabled,
      // A plan whose engine run fails should leave a row un-enriched, not retry
      // a shell-out at somebody several times over.
      retry: false,
    })),
  });

  const bySlug = useMemo(() => {
    const map = new Map<string, PlanDetail>();
    results.forEach((result, i) => {
      if (result.data) map.set(slugs[i], result.data);
    });
    return map;
    // `results` is a fresh array each render, so this recomputes each time. That
    // is a dozen map writes, and it is the price of not handing React a value it
    // has to diff. It cannot loop: nothing here feeds a store.
  }, [results, slugs]);

  return { bySlug, loading: results.some((r) => r.isPending) };
}

export function useHandoff(slug: string | undefined, phase: number | string | undefined) {
  return useQuery({
    queryKey: keys.handoff(slug ?? '', phase ?? ''),
    queryFn: () => api.handoff(slug!, phase!),
    enabled: Boolean(slug) && phase != null && phase !== '',
    placeholderData: keepPreviousData,
  });
}

export function usePlanRaw(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.planRaw(slug ?? ''),
    queryFn: () => api.planRaw(slug!),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * What boarding would find wrong with this plan's §Verification commands.
 *
 * Under the `['plan', slug]` prefix on purpose, unlike the journal and the
 * rulings: it is a reading OF the plan file and of this machine's PATH, so the
 * one thing that invalidates it — the plan changing on disk — is exactly what
 * that prefix already invalidates.
 *
 * Failure is not an error worth retrying at people: a console whose server
 * predates the endpoint 404s, and the health panel's honest answer to that is
 * to say nothing rather than to claim the plan is clean.
 */
/**
 * The run-start prelude (phase 11) for the launch form's draft: the manifest
 * with every row's state and the four probes' verdicts, recomputed when the
 * draft's answers change. Kept while a new draft loads, so the table never
 * blanks between keystrokes.
 */
export function usePrelude(slug: string | undefined, draft: PreludeDraft, enabled = true) {
  const key = JSON.stringify([
    draft.accounts ?? [],
    draft.relay ?? '',
    draft.resumeOnRestart ?? null,
    draft.acknowledgedWaivers ?? [],
    draft.model ?? '',
    draft.profile ?? '',
    draft.mcpPolicy ?? '',
  ]);
  return useQuery({
    queryKey: keys.prelude(slug ?? '', key),
    queryFn: () => api.runPrelude(slug!, draft),
    enabled: Boolean(slug) && enabled,
    retry: false,
    placeholderData: keepPreviousData,
    select: (data) => data.prelude,
  });
}

export function useVerifyPreflight(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.verifyPreflight(slug ?? ''),
    queryFn: () => api.verifyPreflight(slug!),
    enabled: Boolean(slug) && enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/**
 * A gate's machine-checkable status. Only asked for phases that declare one —
 * the engine shells out per call, so this is not something to ask idly.
 */
export function useGateStatus(slug: string | undefined, phase: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.gate(slug ?? '', phase ?? ''),
    queryFn: () => api.gate(slug!, phase!),
    enabled: Boolean(slug) && phase != null && enabled,
    // A gate that cannot be evaluated is not an error worth retrying at people.
    retry: false,
  });
}

/**
 * A phase's diff and the verdict on it.
 *
 * `enabled` is the caller's, because this is the most expensive read on the
 * plan surface — two `git log`s and a `git diff` — and it must not fire for a
 * phase nobody has opened the review for. `keepPreviousData` so switching
 * files inside an open review does not blank the panel.
 */
export function usePhaseReview(slug: string | undefined, phase: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.review(slug ?? '', phase ?? ''),
    queryFn: () => api.review(slug!, phase!),
    enabled: Boolean(slug) && phase != null && enabled,
    // A repository git cannot read is not an error worth retrying at people.
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/**
 * A plan's landing: the branch, the range, and the packet if one exists.
 *
 * `enabled` is the caller's for the same reason the review's is — this costs a
 * `git status` over the whole tree and a `git log` over the plan's whole range,
 * so it fires when somebody opens the card, not on every plan render.
 */
export function useLanding(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.landing(slug ?? ''),
    queryFn: () => api.landing(slug!),
    enabled: Boolean(slug) && enabled,
    // A source directory that is not a repository is an answer, not an outage.
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/* ---------------- the autopilot ---------------- */

/**
 * One plan's run, its history and its ETA.
 *
 * `keepPreviousData` for the same reason the plan detail has it: a run emits
 * `run:phase` every few seconds while it works, and each one invalidates this
 * key. Dropping to a skeleton on every phase event would make the tab unusable
 * precisely while there is something to watch.
 *
 * `enabled` is the stale-server guard. A console whose server predates the
 * autopilot has no run endpoints, and asking anyway just fills the browser
 * console with 404s — the view says so instead.
 */
export function useRun(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.run(slug ?? ''),
    queryFn: () => api.run(slug!),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * Every run of every plan, newest first.
 *
 * `keepPreviousData` for the same reason `useRun` has it, and it matters more
 * here: a live run emits `run:phase` every few seconds and `EVENT_EFFECTS`
 * invalidates this key on each one. Without a placeholder the fleet table — and
 * the dashboard's live strip — would drop to a skeleton every few seconds
 * precisely while there is something to watch.
 */
export function useRuns(enabled = true) {
  return useQuery({
    queryKey: keys.runs(),
    queryFn: api.runs,
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * What holds a scope, and what is waiting behind it.
 *
 * `keepPreviousData` because the answer is a live thing that moves while it is
 * being read: without it the queue card blanks on every admission, which is the
 * exact moment somebody is looking at it.
 */
export function useQueue(enabled = true) {
  return useQuery({
    queryKey: keys.queue(),
    queryFn: api.queue,
    enabled,
    placeholderData: keepPreviousData,
  });
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
 * This plan's phases, their declared scopes, and what each would collide with.
 *
 * Answered from the plan's Repos column plus every live lock across every plan,
 * so it is the one call that can say *why* a phase is not starting. Cheap enough
 * to hold open on the run page; refreshed by `run:queue` for every plan at once.
 */
export function useRunScopes(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.scopes(slug ?? ''),
    queryFn: () => api.runScopes(slug!),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * The recorded events of a run, replayed once into the console.
 *
 * Never invalidated (see `keys.transcript`): what happened after it was read
 * arrives on the live stream, and re-reading it would only re-deliver events the
 * console already folded. A missing replay is not an error worth showing.
 */
export function useTranscript(slug: string | undefined, id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...keys.transcript(slug ?? ''), id ?? 'latest'],
    queryFn: () => api.runTranscript(slug!, id),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

/** Fetched when a diagnosis panel is opened, because most rows are never opened. */
export function useDiagnosis(slug: string | undefined, phase: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.diagnosis(slug ?? '', phase ?? ''),
    queryFn: () => api.phaseDiagnosis(slug!, phase!),
    enabled: Boolean(slug) && phase != null && enabled,
    retry: false,
  });
}

/**
 * A run's journal — the audit trail, read once and then appended to live.
 *
 * `keepPreviousData` because the tail is re-read whenever the run id changes
 * and the reader is usually mid-scroll; dropping to a skeleton there loses
 * their place. A run with no journal file yet is not an error worth retrying.
 */
export function useJournal(slug: string | undefined, id?: number, limit = 500, enabled = true) {
  return useQuery({
    queryKey: keys.journal(slug ?? '', id),
    queryFn: () => api.runJournal(slug!, id, limit),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * The plan's whole ruling ledger, oldest first.
 *
 * Answers for a plan nobody has ever started a run on, which is every plan
 * somebody is driving by hand — so it is NOT gated on there being a run.
 */
/**
 * The run on a time axis.
 *
 * `keepPreviousData` for the journal's reason — the axis is re-projected
 * whenever a phase lands, and dropping the whole Gantt to a skeleton mid-read
 * loses the bar the reader was looking at.
 */
export function useTimeline(slug: string | undefined, id?: string, enabled = true) {
  return useQuery({
    queryKey: keys.timeline(slug ?? '', id),
    queryFn: () => api.runTimeline(slug!, id),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * The run's ledger (zero-touch phase 19): why each start happened, what every
 * session cost and ran, held to the run's spend. `keepPreviousData` for the
 * timeline's reason — it is re-projected whenever a phase lands.
 */
export function useLedger(slug: string | undefined, id?: string, enabled = true) {
  return useQuery({
    queryKey: keys.ledger(slug ?? '', id),
    queryFn: () => api.runLedger(slug!, id),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Every open plan's ledgers, per plan and per account — Insights. */
export function useLedgerSummary(enabled = true) {
  return useQuery({
    queryKey: keys.ledgerSummary(),
    queryFn: () => api.ledgerSummary(),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * One phase's boardings, with the consecutive pairs already diffed.
 *
 * Fetched only when a phase is actually being compared (`enabled`), because
 * the projection reads the whole journal and nothing on the page needs it
 * until someone opens the drawer.
 */
export function useAttempts(
  slug: string | undefined,
  phase: number | undefined,
  id?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: keys.attempts(slug ?? '', phase ?? '', id),
    queryFn: () => api.runAttempts(slug!, phase!, id),
    enabled: Boolean(slug) && phase !== undefined && enabled,
    retry: false,
  });
}

export function useRulings(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.rulings(slug ?? ''),
    queryFn: () => api.runRulings(slug!),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

/**
 * Money: today's settled spend against the day cap, each run against its
 * budget, and the 7-day series.
 *
 * Instance-wide and cheap to invalidate — TanStack only refetches a query
 * something is currently rendering, so the `run:phase` invalidation costs
 * nothing on the pages that do not show it.
 */
export function useSpend(enabled = true) {
  return useQuery({
    queryKey: keys.spend(),
    queryFn: api.spend,
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * Everything that needs a person, in one list.
 *
 * `all` includes what has been acknowledged — the drawer's "show everything"
 * view. Acknowledgement is an annotation and never a resolution, so an acked
 * row is still a row; it is only hidden by default.
 *
 * `placeholderData` because the SSE `inbox` event invalidates this whenever
 * anything moves, and a list that blanked to a skeleton every time a run
 * emitted a phase would be unreadable exactly while there is something to
 * read. `retry: false`: a console whose server predates the endpoint answers
 * 404 and will keep answering 404 — the section says so instead of asking
 * again at somebody.
 */
export function useAttentionInbox(all = false, enabled = true) {
  return useQuery({
    queryKey: keys.inbox(all),
    queryFn: () => api.inbox(all),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
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

/* ---------------- the remaining surfaces ---------------- */

/**
 * The whole portfolio — every plan read, every issue collected.
 *
 * It is invalidated by `changed` like the plans list, because it is the same
 * facts aggregated: a phase landing moves the velocity chart and the ready
 * total, and a stats page that disagrees with the board it sits beside is worse
 * than no stats page.
 */
export function useStats(enabled = true) {
  return useQuery({ queryKey: keys.stats(), queryFn: api.stats, enabled });
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

/**
 * One page of the inbox.
 *
 * The filters are part of the key: "unread only, approvals, 60 rows" is a
 * different answer from the server, not a client-side slice of one. `EVENT_
 * EFFECTS` invalidates the `notifications` prefix on all four inbox events, so
 * every variant a tab is holding refreshes together — which is what makes a
 * card answered on a phone take the badge down here.
 */
export function useInbox(query: InboxQuery) {
  return useQuery({
    queryKey: [...keys.notifications(), query.category ?? '', query.unread ?? false, query.limit ?? 60],
    queryFn: () => api.notifications(query),
    placeholderData: keepPreviousData,
  });
}

/** The push register: which devices are subscribed, and to what. */
export function usePush(enabled = true) {
  return useQuery({ queryKey: keys.push(), queryFn: api.push, enabled, retry: false });
}

/**
 * The outbound-webhook register.
 *
 * `retry: false` for the same reason as `usePush`: a console whose server
 * predates this endpoint answers 404 and will keep answering 404, and the card
 * hides itself rather than retrying into a wall.
 */
export function useWebhooks(enabled = true) {
  return useQuery({ queryKey: keys.webhooks(), queryFn: api.webhooks, enabled, retry: false });
}

/**
 * The permission rules, at one scope.
 *
 * `retry: false` because a console whose server predates the policy endpoint
 * answers 404 and will keep answering 404; the card hides rather than retrying
 * at somebody.
 */
export function usePolicy(slug: string | undefined) {
  return useQuery({
    queryKey: keys.policy(slug ?? ''),
    queryFn: () => api.policy(slug || undefined),
    retry: false,
  });
}

/** Whether this console can restart itself — asked before the button renders. */
export function useRestartReadiness(enabled = true) {
  return useQuery({
    queryKey: keys.restart(),
    queryFn: api.restartReadiness,
    enabled,
    retry: false,
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
 * Writes
 *
 * Reading is a table (`EVENT_EFFECTS`); writing was forty-four hand-rolled
 * copies of the same four lines. The error leg alone — "toast whatever the
 * server said, in red" — was written out in two dialects across 46 call sites,
 * and the two disagreed: one printed `String(error.message ?? error)`, the
 * other `(error as Error).message`, which renders `undefined` for anything
 * thrown that is not an Error.
 *
 * What is shared is the SHAPE of a write: call the API, say what happened, and
 * re-read what it moved. What is not shared is any of the words — every caller
 * still supplies its own verb, its own sentence and its own bundle.
 * ------------------------------------------------------------------ */

/**
 * The error leg, in one spelling.
 *
 * `unknown`, not `Error`: a rejected fetch, a thrown string and an `ApiError`
 * all arrive here, and the one dialect this replaces printed `undefined` for
 * two of the three. The message is the server's own words wherever there are
 * any — the console's job on a failure is to repeat what it was told, not to
 * summarise it.
 */
export function toastError(error: unknown): void {
  const said = message(error);
  // `String(undefined)` is `'undefined'`, which is TRUTHY — so a `?? fallback`
  // here would never fire and the console would print the word at a person.
  toast(said || 'The console could not say what went wrong. Look at the log.', 'error');
}

/** The words in the failure, or nothing at all. Never a stringified `undefined`. */
function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  const own = (error as { message?: unknown } | null | undefined)?.message;
  return typeof own === 'string' || typeof own === 'number' ? String(own) : '';
}

export interface ApiMutationOptions<TArgs, TResult> {
  /** The call itself. Anything that returns a promise; `api.*` in practice. */
  fn: (args: TArgs) => Promise<TResult>;
  /**
   * What this write moved — a bundle from `keys.after*`, or a function of the
   * result when only the answer says which plan was touched.
   *
   * Invalidated in `onSettled`, never in `onSuccess`. That is the whole reason
   * this exists: a card answered on a phone leaves another tab holding one that
   * no longer exists, pressing it 404s, and with the re-read inside the success
   * leg it was skipped — so the phantom stayed on screen and the next press
   * 404'd again. The failure is exactly the case where re-reading matters most.
   */
  invalidates?: KeyBundle | ((result: TResult | undefined, args: TArgs) => KeyBundle);
  /** The success line. A function returning `''`/`null` says nothing at all. */
  say?: string | ((result: TResult, args: TArgs) => string | null | undefined);
  /** Anything else to do once it lands — closing a dialog, clearing a note. */
  onDone?: (result: TResult, args: TArgs) => void;
  /** Replaces the toast on failure. Supply this only to say something better. */
  onFail?: (error: unknown, args: TArgs) => void;
}

/**
 * One write: call, say, re-read.
 *
 * `void`, never `await`, on the invalidation — `invalidateQueries` resolves
 * only once the refetch settles, and awaiting it holds `isPending` set for the
 * length of a network round trip after the action has already landed. Six of
 * the copies this replaces awaited it and left their buttons disabled for it.
 */
export function useApiMutation<TArgs = void, TResult = unknown>({
  fn,
  invalidates,
  say,
  onDone,
  onFail,
}: ApiMutationOptions<TArgs, TResult>): UseMutationResult<TResult, Error, TArgs> {
  const client = useQueryClient();
  return useMutation<TResult, Error, TArgs>({
    mutationFn: fn,
    onSuccess: (result, args) => {
      const line = typeof say === 'function' ? say(result, args) : say;
      if (line) toast(line, 'ok');
      onDone?.(result, args);
    },
    onError: (error, args) => {
      if (onFail) onFail(error, args);
      else toastError(error);
    },
    onSettled: (result, _error, args) => {
      const bundle = typeof invalidates === 'function' ? invalidates(result, args) : invalidates;
      for (const queryKey of bundle ?? []) void client.invalidateQueries({ queryKey });
    },
  });
}

/**
 * Save one preference key.
 *
 * ONE key at a time, merged server-side, because two tabs flipping different
 * knobs must not overwrite each other — which is why the argument is a patch
 * and never the whole `prefs` object. Six cards had this mutation written out
 * verbatim, and every one of them awaited its own invalidation.
 */
export function useSavePrefs(): UseMutationResult<unknown, Error, Record<string, unknown>> {
  return useApiMutation<Record<string, unknown>, unknown>({
    fn: (patch) => api.savePrefs(patch),
    invalidates: keys.afterPrefs(),
  });
}

/**
 * The launch dialog's one look at what isolation would DO for a plan — cached
 * a minute, asked only while a dialog that shows the control is open.
 */
export function useIsolationPreflight(slug: string | undefined) {
  return useQuery({
    queryKey: slug ? keys.isolationPreflight(slug) : ['plan', 'none', 'isolation-preflight'],
    queryFn: () => api.isolationPreflight(slug!),
    enabled: Boolean(slug),
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ *
 * Repo — the five git surfaces
 * ------------------------------------------------------------------ */

/**
 * A repository does not change because a run ticked, and it does change under a
 * console that is committing on your behalf. So these are polled on a slow
 * timer rather than tied to the socket: `staleTime` is the honest bound on how
 * old the answer on screen may be. A reader who knows something just landed
 * re-navigates or reloads; there is no Refresh control on this destination, and
 * a comment promising one is how a later phase comes looking for it.
 *
 * A commit graph read is the expensive one (a `git log` walk of up to 500
 * commits), so it is deliberately the slowest to go stale.
 */
const REPO_STALE = 30_000;

export function useRepoTargets(enabled = true) {
  return useQuery({ queryKey: keys.repoTargets(), queryFn: api.repoTargets, enabled, staleTime: REPO_STALE });
}

export function useRepoGraph(params: RepoGraphParams, enabled = true) {
  return useQuery({
    queryKey: keys.repoGraph(params),
    queryFn: () => api.repoGraph(params),
    enabled,
    staleTime: REPO_STALE,
  });
}

export function useRepoBranches(repo: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.repoBranches(repo),
    queryFn: () => api.repoBranches(repo),
    enabled,
    staleTime: REPO_STALE,
  });
}

export function useRepoCheckouts(enabled = true) {
  return useQuery({
    queryKey: keys.repoCheckouts(),
    queryFn: api.repoCheckouts,
    enabled,
    staleTime: REPO_STALE,
  });
}

/**
 * `placeholderData` holds the previous answer while the next one loads — **only
 * while the FILE LIST cannot have moved**, and the scoping is the whole of it.
 * (This lead said "only across a change of `path`" until QA round 4's F-3: true
 * when it was written, and contradicted fifteen lines below by the very commit
 * that widened it to `unified` and `bytes`.)
 *
 * The nicety it buys is real: picking a file adds `?path=`, which is a NEW key,
 * so without a placeholder the file list the reader just clicked in blanks to a
 * spinner and comes back, on every pick. The unscoped version cost far more
 * than that (QA round 2, M-1). `isPending` goes FALSE the moment a placeholder
 * exists, so the patch pane skipped its spinner and rendered the previous
 * response — whose `patch` is for another file — and `patchFile` degraded that
 * to a zero-hunk row, which `DiffHunks` correctly describes as *"no textual
 * change"*. A file that changed nine lines was told it had changed nothing:
 * exactly the sentence round 1's M2 was about, re-entered through the fix for
 * its L9.
 *
 * Carrying it across a change of RANGE or REPO was a second lie of the same
 * family — the header would say "N files between X and Y" off the old answer
 * while the URL named a different range. So the placeholder applies when, and
 * only when, the FILE LIST cannot have changed. `isPlaceholderData` then means
 * precisely "the list is the right list, the patch is not here yet", which is
 * what the panel needs to know.
 */
export function useRepoDiff(params: RepoDiffParams, enabled = true) {
  return useQuery({
    queryKey: keys.repoDiff(params),
    queryFn: () => api.repoDiff(params),
    enabled,
    staleTime: REPO_STALE,
    placeholderData: (prev, prevQuery) => {
      if (!prev) return undefined;
      const before = (prevQuery?.queryKey as [string, string, RepoDiffParams] | undefined)?.[2];
      if (!before) return undefined;
      return sameFileList(before, params) ? prev : undefined;
    },
  });
}

/**
 * Would these two requests produce the SAME file list?
 *
 * Three parameters decide it, and deliberately only three. `path`, `unified`
 * and `bytes` shape the PATCH and cannot touch the list — the server builds
 * `files` from `diffStat` before it so much as reads them
 * (`git-browse.ts` §`repoDiff`). Comparing `unified` here made toggling the
 * context-lines control blank the whole panel: the list, the header, the
 * truncation banner and the ToggleGroup that was just clicked, taking keyboard
 * focus with it. That is round 1's L9 again, re-entered through a different
 * control (QA round 3, F-3).
 *
 * Exported because a predicate this load-bearing is worth testing directly —
 * round 3's F-2 was that the test named for it asserted nothing about it.
 */
export function sameFileList(a: RepoDiffParams, b: RepoDiffParams): boolean {
  return a.repo === b.repo && a.base === b.base && a.tip === b.tip;
}

export function useRepoSettles(
  params: { limit?: number; slug?: string; runs?: number; entries?: number },
  enabled = true,
) {
  return useQuery({
    queryKey: keys.repoSettles(params),
    queryFn: () => api.repoSettles(params),
    enabled,
    staleTime: REPO_STALE,
  });
}

/* ------------------------------------------------------------------ *
 * Issues — the estate board
 * ------------------------------------------------------------------ */

/**
 * The GET never reaches the network, so it is cheap; what is expensive is the
 * REFRESH, and that is a button. Fifteen seconds is therefore about the cache
 * on disk moving under us — a sweep keeping a repository warm, or another
 * browser's Refresh — not about GitHub.
 */
const ISSUES_STALE = 15_000;

/**
 * How often to ask again WHILE a fetch is in flight somewhere else.
 *
 * `refreshing: true` means another browser's Refresh, or the idle sweep, is
 * asking GitHub right now — and every Refresh control on the board is disabled
 * while it is. Nothing else invalidates this key (no SSE event carries the issue
 * cache), so without a poll the board could sit disabled with no path back until
 * the reader reloaded the page. The poll runs ONLY in that state and stops the
 * moment the payload says the fetch is done. (QA round 1, M-2.)
 */
const ISSUES_SETTLE_POLL = 2_000;

/**
 * Whether to keep asking, and how often — exported because a predicate this
 * load-bearing is worth testing directly, the same reason `sameFileList` is.
 * `false` is TanStack's word for "do not poll".
 */
export const issuesPollInterval = (payload: IssuesPayload | undefined): number | false =>
  payload?.refreshing ? ISSUES_SETTLE_POLL : false;

export function useIssues(enabled = true) {
  return useQuery({
    queryKey: keys.issues(),
    queryFn: api.issues,
    enabled,
    staleTime: ISSUES_STALE,
    refetchInterval: (query) => issuesPollInterval(query.state.data),
  });
}

/**
 * Go and ask GitHub — for one repository, or for every askable one.
 *
 * The answer IS the next payload, so it is written straight into the cache
 * rather than merely invalidated: a refresh that came back with rows and then
 * showed a spinner while it re-asked the same server would be slower than the
 * button it replaced. The invalidation still follows, to settle any other
 * reader.
 */
export function useIssuesRefresh(): UseMutationResult<IssuesPayload, Error, string | undefined> {
  const client = useQueryClient();
  return useApiMutation<string | undefined, IssuesPayload>({
    fn: (repo) => api.issuesRefresh(repo),
    onDone: (payload) => client.setQueryData(keys.issues(), payload),
    invalidates: [keys.issues()],
  });
}

/* ---------------- the Debug destination ---------------- */

/**
 * How long a log read stays fresh.
 *
 * Shorter than Repo's, and for the opposite reason: a commit graph is
 * expensive and rarely moves, while a log is cheap to re-read and moves
 * constantly — a person on this page is asking what is happening NOW. It is
 * still not a timer: nothing here polls, and the surface that genuinely needs
 * live rows opens the follow tail (`useDebugTail`) instead, which is a stream
 * the reader turns on rather than a cost the page pays whether or not anyone
 * is watching.
 */
const DEBUG_STALE = 5_000;

export function useDebugIndex(params: DebugIndexParams, enabled = true) {
  return useQuery({
    queryKey: keys.debugIndex(params),
    queryFn: () => api.debugIndex(params),
    enabled,
    staleTime: DEBUG_STALE,
  });
}

export function useDebugRuns(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.debugRuns(slug ?? ''),
    queryFn: () => api.debugRuns(slug as string),
    // A run list for no plan is not a request. `enabled` rather than a guard
    // inside `queryFn`, so the hook reports `isPending` forever instead of
    // resolving to an empty list that reads as "this plan has no runs".
    enabled: enabled && Boolean(slug),
    staleTime: DEBUG_STALE,
  });
}

/**
 * The bundle.
 *
 * Deliberately NOT enabled by default: assembling one reads every source and
 * renders a metrics scrape, and the Health section must not pay that on every
 * visit for a payload most visits never copy. The section enables it when the
 * reader asks.
 */
export function useDebugBundle(params: { slug?: string } = {}, enabled = false) {
  return useQuery({
    queryKey: keys.debugBundle(params),
    queryFn: () => api.debugBundle(params),
    enabled,
    staleTime: DEBUG_STALE,
  });
}
