/**
 * The cache's shape: every query key, the bundles a write invalidates, and the
 * client's defaults.
 *
 * One file because "which keys does this write move" and "how long does an
 * answer live" are both facts about the cache, and the stream (`./live`) and
 * every domain's hooks read them from here. `lib/persist.ts` matches its
 * persisted allowlist against these exact shapes, so a key's spelling is a
 * contract: add one, never reshape one.
 */

import { QueryClient, type QueryClientConfig, type QueryKey } from '@tanstack/react-query';
import { PLAN_INCLUDES, includeParam } from '@shared/projection.js';

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
  /** Every preference described, with its value and where it came from (`GET /api/prefs/schema`). */
  prefsSchema: () => ['prefs-schema'] as const,
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
  notes: (slug: string, phase: number | string) => ['plan', slug, 'notes', String(phase)] as const,
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
   * The Logs destination (Debug until 7.0) — one prefix over four surfaces.
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
  debugRetention: () => ['debug', 'retention'] as const,
  /** `GET /api/doctor` — the same report `phase-console doctor` prints. */
  doctor: () => ['doctor'] as const,
  debugLevel: () => ['debug', 'level'] as const,
  /** The four runtime gauges Logs ▸ Health reads off the metrics scrape (`screens/logs/runtime.ts`). */
  debugRuntime: () => ['debug', 'runtime'] as const,
  planLint: (slug: string) => ['plan', slug, 'lint'] as const,
  planWork: (slug: string) => ['plan', slug, 'work'] as const,
  /** The board as the terminal prints it (`phase-graph.sh <slug>`) — the Source view's engine fold. */
  boardText: (slug: string) => ['plan', slug, 'board-text'] as const,
  /** The engine's machine block (`--memory-block`), the one board read the runner parses. */
  memoryBlock: (slug: string) => ['plan', slug, 'memory-block'] as const,
  /** `--session-plan [model]` — keyed by the model asked for, because another model is another answer. */
  sessionPlan: (slug: string, model?: string) => ['plan', slug, 'session-plan', model ?? 'plan'] as const,
  terminal: () => ['terminal'] as const,
  /** The session-presence registry — every Claude session the hook reported for this instance. */
  sessionRegistry: () => ['sessions', 'registry'] as const,
  /** One registry session's raw hook events, read while something shows them. */
  sessionEvents: (id: string) => ['sessions', id, 'events'] as const,
  locks: () => ['locks'] as const,
  /**
   * The claims as the server narrowed them (`?held`, `?lapsed`, `?scope`) —
   * under `['locks']`, so whatever moves a claim re-reads every narrowing.
   */
  lockRows: (filter: { held?: true; lapsed?: true; scope?: string }) =>
    ['locks', 'rows', filter.held ? 'held' : filter.lapsed ? 'lapsed' : 'any', filter.scope ?? ''] as const,
  converge: () => ['converge'] as const,
  /** Is the session-presence hook in `~/.claude/settings.json`? */
  hooksStatus: () => ['hooks-status'] as const,
  hooks: () => ['hooks'] as const,
  plugins: () => ['plugins'] as const,
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
   * 400 lines that live events supersede the moment it lands, and a diagnosis costs a
   * `git status` and two script runs. Under the run prefix, every `run:phase`
   * would refetch both; the console would re-hydrate from the network several
   * times a minute to learn nothing it was not already being told.
   */
  transcript: (slug: string) => ['transcript', slug] as const,
  /** A live phase's own view — its report and its session's activity (control-tower phase 95). */
  phaseNow: (slug: string) => ['phase-now', slug] as const,
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
  /**
   * Your turn (`GET /api/turn`, control-tower phase 137) — a PROJECTION of the
   * inbox, so its key sits under the inbox prefix: every write and every event
   * that re-reads the inbox re-reads the turn with it, and no bundle had to
   * learn a second name. `seen` (the person's last look, which the handled
   * count is taken from) is the third part; without it the prefix is every
   * look at once.
   */
  turn: (seen?: string | null) => (seen ? (['inbox', 'turn', seen] as const) : (['inbox', 'turn'] as const)),
  /**
   * One item's explain view (`GET /api/turn/:id`, quiet-console phase 8) —
   * under the inbox prefix too, so the events that move the turn re-read it.
   */
  turnItem: (id: string) => ['inbox', 'turn', 'item', id] as const,
  /** The human-step ledger (`GET /api/human-steps`) — every step with its moves. */
  humanSteps: () => ['human-steps'] as const,
  /** The owner door (`GET /api/owner`): its keys, this browser's session, the open requests. */
  owner: () => ['owner'] as const,
  auth: () => ['auth'] as const,
  accounts: () => ['accounts'] as const,
  /** What moving a run to another account would cut — asked while a choice is pending, never guessed. */
  switchPreview: (slug: string, accountId: string, when: string) =>
    ['accounts', 'switch-preview', slug, accountId, when] as const,
  mcp: () => ['mcp'] as const,
  mcpCatalog: (query: string) => ['mcp', 'catalog', query] as const,
  mcpLogin: (id: string) => ['mcp', 'login', id] as const,
  launcher: () => ['launcher'] as const,
  skills: () => ['skills'] as const,
  notifications: () => ['notifications'] as const,
  search: (query: string) => ['search', query] as const,
  /** Both push keys sit under one prefix so subscribing refreshes the register. */
  push: () => ['push'] as const,
  webhooks: () => ['webhooks'] as const,
  policy: (slug: string) => ['policy', slug] as const,
  restart: () => ['restart'] as const,
  /** `GET /api/fleet/profile` — the machine profile, and what this console takes from it. */
  machineProfile: () => ['machine-profile'] as const,
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
   * that meaning implies. After the write, invalidate each member on its own
   * (`invalidateQueries({ queryKey })`). They are bundles, not keys: never pass
   * one to a `queryKey`, which wants a single key and would silently take an
   * array of them.
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
  afterInboxAct: (): KeyBundle => [
    keys.inbox(),
    keys.runs(),
    keys.plans(),
    keys.approvals(),
    keys.state(),
    keys.humanSteps(),
  ],

  /**
   * A preference was saved: the console's state, which carries the values a
   * page runs with, and the settings schema, which says where each came from.
   */
  afterPrefs: (): KeyBundle => [keys.state(), keys.prefsSchema()],
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

/**
 * A failed read is asked once more — unless its answer says asking again
 * cannot help. (`_error`: the free tree reads only the count.)
 */
export function retryOnce(failures: number, _error: unknown): boolean {
  return failures < 1;
}


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
      retry: retryOnce,
    },
  },
};

export const createQueryClient = (): QueryClient => new QueryClient(queryClientConfig);
