/**
 * The surface registry (quiet-console phase 2, §Architecture 5): one row for
 * every HTTP route (by method), every SSE event, every settings key and every
 * operator verb the server exposes — and where a person meets it.
 *
 * Each row answers exactly one of three ways:
 *
 *   - `door` — the place a person meets it TODAY, as data (`head` + `section`,
 *     never an address: `shell/routes.ts` is the one place that spells one),
 *     with `data`, the export under `data/` a page reaches it through
 *     (`<file>#<export>[.<member>]`). A settings key's door is the section that
 *     sets it, so `data` is optional there; a route a page fetches itself,
 *     outside `data/`, names that file as `caller` instead.
 *   - `exempt` — why no page should ever draw it (a hook a session posts, a
 *     route a script reads, the same fact another route already carries), and
 *     the `caller` that reaches it instead: a repository file that exists and
 *     names it, so the reason is a fact and not a hope.
 *
 * Phase 26 completed it: nothing is left for a later phase. `unassigned` stays
 * in the type only so `surface-parity` can say, by name, why a row that uses
 * it fails — and `surface-ratchet.json` holds zero.
 *
 * A row is `pro` exactly when the thing it names exists only in the Pro tree,
 * and every such row sits in a `!pro:` region, so the free tree's registry is
 * its own server's. A free row's door is a door in the FREE tree: a route only
 * a Pro page presses is a free hole, `unassigned` until a phase opens it there.
 *
 * `viewer/test/surface-parity.test.ts` holds all of it to the server — the
 * dispatcher, the router's own answers, the events it emits, the settings it
 * stores, the verb and authority tables — and fails on any gap either way.
 *
 * Data only, and off first paint: only lazy chunks import it (the palette, the
 * panel's Actions, the help sheet), and it imports nothing at run time.
 */

/** What a row names. */
export type SurfaceKind = 'route' | 'sse' | 'setting' | 'verb';

/** The 7.0 map's places (§Architecture 3): seven destinations, Your turn, the two Pro places, and the shell around them. */
export const SURFACE_PLACES = [
  'Runs',
  'Plans',
  'Sessions',
  'Repo',
  'Insights',
  'Logs',
  'Settings',
  'Your turn',
  'Fleet',
  'Supervisor',
  'Shell',
] as const;

export type SurfacePlace = (typeof SURFACE_PLACES)[number];

/** Where a person meets a row: a place, the route head it is drawn under today, and the section within it. */
export interface SurfaceDoor {
  place: SurfacePlace;
  /** A `ROUTE_HEADS` member — the head the page is under today. */
  head: string;
  /** A Settings, Repo or Logs section, a plan tab, or the shell part. */
  section?: string;
}

/** The phase that gives a row its door. */
export type SurfacePhase = `phase ${number}`;

export type SurfaceMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface SurfaceRow {
  kind: SurfaceKind;
  /** Unique: `GET /api/state` · `supervisor GET /api/fleet/turn` · `sse run:phase` · `verb pause` · `setting convergeEveryMs`. */
  id: string;
  method?: SurfaceMethod;
  /** Placeholders spelled `:slug` `:phase` `:id` `:n`, as the verb and door tables spell them. */
  path?: string;
  event?: string;
  verb?: string;
  /** The key, namespaced by its store: `retention.`, `run.`, `browser.`, `profile.`, `flag `. */
  key?: string;
  /** The capability flag it needs — a `CAPABILITY_WORDS` flag. */
  flag?: string;
  /** The `AUTHORITY_ROUTES` authority, exactly where the door table gives one. */
  authority?: string;
  edition: 'free' | 'pro';
  /** The export a page reaches it through: `<file under data/ without .ts>#<export>[.<member>]`. */
  data?: string;
  /**
   * Who reaches it without a `data/` export. On a door: the page that calls
   * the route itself, a path under `client/src`. On an exempt row: the file
   * that reaches it INSTEAD of a page — the hook script, the CLI, the server
   * writing a session's hook, the supervisor, the push worker, the doc a
   * script's author reads — repository-relative, and it must name the thing.
   */
  caller?: string;
  /** A stream or a long answer the parity probe never opens. */
  stream?: true;
  /**
   * The body or query fields of a route that a person must be able to send —
   * its options beyond the bare press (`debug` and `ttlMs` on
   * `POST /api/debug/level`). Each is spelled in the door's `data` export and
   * on a page that reaches it, which `surface-parity` holds: a route a page
   * presses with half its options is a partial door.
   */
  options?: readonly string[];
  door?: SurfaceDoor;
  exempt?: string;
  /** Never in this registry since phase 26 — `surface-parity` refuses it by name. */
  unassigned?: SurfacePhase;
  /**
   * A route the fleet supervisor answers itself (`viewer/fleet/index.ts`),
   * never this console's dispatcher: a console's page reaches it through this
   * console's relay, and the supervisor's own page directly. `surface-parity`
   * holds these rows to the supervisor's dispatcher and never asks this
   * console's router about them.
   */
  server?: 'supervisor';
}

/* ------------------------------------------------------------------ *
 * The builders
 * ------------------------------------------------------------------ */

type Answer = Pick<SurfaceRow, 'door' | 'data' | 'caller' | 'exempt' | 'unassigned'>;
type Extra = Partial<Pick<SurfaceRow, 'flag' | 'authority' | 'edition' | 'stream' | 'options'>>;

const door = (place: SurfacePlace, head: string, section?: string): SurfaceDoor =>
  section === undefined ? { place, head } : { place, head, section };

/** A door, and the export under `data/` a page meets it through. */
const at = (where: SurfaceDoor, data?: string): Answer =>
  data === undefined ? { door: where } : { door: where, data };
/** No page draws it, and `caller` (repository-relative) is the file that reaches it instead. */
const why = (exempt: string, caller: string): Answer => ({ exempt, caller });

const route = (method: SurfaceMethod, path: string, answer: Answer, extra: Extra = {}): SurfaceRow => ({
  kind: 'route',
  id: `${method} ${path}`,
  method,
  path,
  edition: 'free',
  ...answer,
  ...extra,
});
const sse = (event: string, answer: Answer, extra: Extra = {}): SurfaceRow => ({
  kind: 'sse',
  id: `sse ${event}`,
  event,
  edition: 'free',
  ...answer,
  ...extra,
});
const verb = (name: string, answer: Answer, extra: Extra = {}): SurfaceRow => ({
  kind: 'verb',
  id: `verb ${name}`,
  verb: name,
  edition: 'free',
  ...answer,
  ...extra,
});
const setting = (key: string, answer: Answer, extra: Extra = {}): SurfaceRow => ({
  kind: 'setting',
  id: `setting ${key}`,
  key,
  edition: 'free',
  ...answer,
  ...extra,
});

/* The doors of today's pages, by the head each is drawn under. */
const runsHome = door('Runs', 'runs');
const queuePage = door('Runs', 'queue');
const plansLibrary = door('Plans', 'plans');
const phasesTab = door('Plans', 'plan', 'phases');
const runView = door('Plans', 'plan', 'run');
const sourceTab = door('Plans', 'plan', 'source');
const sessionsPage = door('Sessions', 'sessions');
const locksPage = door('Sessions', 'sessions', 'locks');
const insightsPage = door('Insights', 'insights');
const turnPage = door('Your turn', 'turn');
const sourcePicker = door('Settings', 'source');
const repo = (section?: string): SurfaceDoor => door('Repo', 'repo', section);
const logs = (section: string): SurfaceDoor => door('Logs', 'logs', section);
const settings = (section: string): SurfaceDoor => door('Settings', 'settings', section);
/** The shell around every page: the header, the switcher, the bell, the palette. */
const shell = (part: string): SurfaceDoor => door('Shell', 'runs', part);

/* The flags the router's guards ask for. */
const runFlag = { flag: '--allow-run' } as const;
const writesFlag = { flag: '--allow-writes' } as const;
const terminalFlag = { flag: '--allow-terminal' } as const;
const accountsFlag = { flag: '--allow-accounts' } as const;
const mcpFlag = { flag: '--allow-mcp' } as const;
const webhooksFlag = { flag: '--allow-webhooks' } as const;

/* The reasons and the exports several rows share. */
const SESSION_HOOK = 'a hook a session posts on this machine, with its own credential — never a page';
/** Writes the hooks a supervised session posts back (its `--settings`). */
const HOOK_WRITER = 'viewer/server/runner/approvals.ts';
/** The control surface's own reference, where a script's author reads a route no page needs. */
const CONTROLS_DOC = 'docs/controls.md';
const BY_INBOX = 'api/inbox#inboxApi.inboxAct';
/** The one write every Settings row goes through (`POST /api/prefs`, through the owner door). */
const SAVE_PREFS = 'console#usePrefsWrite';
/** The queue's scheduling policy and load guard (`POST /api/queue/policy`). */
const QUEUE_POLICY = 'queue#useQueuePolicyWrite';
const RUN_START = 'api/runs#runsApi.runStart';
/** A phase's queue moves — hold, release, defer, withdraw, requeue — from its Actions in the panel. */
const QUEUE_ACT = 'queue#useQueueAct';
/** A verb pressed by its name (`shared/verb-model.js`), as the Actions tab and the palette press it. */
const PRESS_VERB = 'verbs#pressVerb';
/** The browser's own prefs, which still hold a retired view's key. */
const BROWSER_PREFS = 'viewer/client/src/lib/prefs.ts';
const RETIRED_VIEW =
  "a retired view's state, kept so `setPrefs()` still writes a whole object — no page reads it any more";


/* ------------------------------------------------------------------ *
 * Routes — in the dispatcher's order (`server/api/routes.ts`)
 * ------------------------------------------------------------------ */

const ROUTES: readonly SurfaceRow[] = [
  /* The hooks a session posts, and the one stream. */
  route('POST', '/hooks/pre-tool-use', why(`the approval hook: ${SESSION_HOOK}`, HOOK_WRITER)),
  route('POST', '/hooks/permission-request', why(`the relay's transport: ${SESSION_HOOK}`, HOOK_WRITER)),
  route('POST', '/hooks/stop', why(`the closeout hook: ${SESSION_HOOK}`, HOOK_WRITER)),
  route(
    'POST',
    '/hooks/declaration',
    why(`\`phase-outcome.sh\` asks for a probe now: ${SESSION_HOOK}`, 'scripts/phase-outcome.sh'),
  ),
  route(
    'POST',
    '/hooks/session',
    why(`the presence hook (\`scripts/session-hook.sh\`): ${SESSION_HOOK}`, 'scripts/session-hook.sh'),
  ),
  route('GET', '/events', at(shell('header'), 'live#useLiveData'), { stream: true }),


  route('POST', '/api/events/subscribe', at(runView, 'live-share#useRunStream')),

  /* The owner key. */
  route('GET', '/api/owner', at(settings('permissions'), 'owner#ownerApi.owner')),
  route('POST', '/api/owner/enroll/link', at(settings('permissions'), 'owner#ownerApi.ownerEnrolLink'), {
    authority: 'owner-key',
  }),
  route('POST', '/api/owner/enroll/begin', at(settings('permissions'), 'owner#enrolOwnerKey'), {
    authority: 'owner-key',
  }),
  route('POST', '/api/owner/enroll/finish', at(settings('permissions'), 'owner#enrolOwnerKey'), {
    authority: 'owner-key',
  }),
  route('POST', '/api/owner/assert/begin', at(settings('permissions'), 'owner#signInAsOwner'), {
    authority: 'owner-key',
  }),
  route('POST', '/api/owner/assert/finish', at(settings('permissions'), 'owner#signInAsOwner'), {
    authority: 'owner-key',
  }),
  route('POST', '/api/owner/lock', at(settings('permissions'), 'owner#ownerApi.ownerLock'), {
    authority: 'owner-key',
  }),
  route('DELETE', '/api/owner/keys/:id', at(settings('permissions'), 'owner#ownerApi.ownerKeyRemove'), {
    authority: 'owner-key',
  }),
  route('POST', '/api/owner/requests/:id/confirm', at(turnPage, 'owner#ownerApi.ownerConfirm'), {
    authority: 'answer',
  }),
  route('POST', '/api/owner/requests/:id/refuse', at(turnPage, 'owner#ownerApi.ownerRefuse'), {
    authority: 'answer',
  }),

  route('GET', '/api/state', at(shell('header'), 'console#useConsoleState')),
  route('GET', '/api/engine', at(phasesTab, 'plans#useEngineQueue')),

  /* Sessions this machine's hook reported. */
  route('GET', '/api/sessions/registry', at(sessionsPage, 'sessions#useSessionRegistry')),
  route('GET', '/api/sessions/:id/events', at(sessionsPage, 'sessions#useSessionEvents')),
  route('POST', '/api/sessions/:id/release', at(runsHome, 'api/state#stateApi.releaseSessionHold'), runFlag),
  route('GET', '/api/converge', at(runsHome, 'runs#useConverge')),
  route('GET', '/api/hooks-install', at(settings('automation'), 'sessions#useHooksStatus')),
  route('POST', '/api/hooks-install', at(settings('automation'), 'sessions#useHooksWrite'), writesFlag),
  route('GET', '/api/fs', at(sourcePicker, 'machine#useDirListing')),

  /* The repository. */
  route('GET', '/api/repo/targets', at(repo(), 'repo#useRepoTargets')),
  route('GET', '/api/repo/graph', at(repo('history'), 'repo#useRepoGraph')),
  route('GET', '/api/repo/branches', at(repo('branches'), 'repo#useRepoBranches')),
  route('GET', '/api/repo/checkouts', at(repo('trees'), 'repo#useRepoCheckouts')),
  route('GET', '/api/repo/diff', at(repo('changes'), 'repo#useRepoDiff')),
  route('GET', '/api/repo/settles', at(repo('settles'), 'repo#useRepoSettles')),
  route('GET', '/api/issues', at(repo('issues'), 'repo#useIssues')),
  route('POST', '/api/issues/refresh', at(repo('issues'), 'repo#useIssuesRefresh')),
  route('GET', '/api/root', at(sourcePicker, 'machine#useRootCheck')),
  route('POST', '/api/root', at(shell('switcher'), 'machine#useOpenRoot')),
  // The settings schema (quiet-console phase 25): Settings ▸ Everything draws it.
  route('GET', '/api/prefs/schema', at(settings('everything'), 'console#usePrefsSchema')),
  route('POST', '/api/prefs', at(settings('automation'), SAVE_PREFS), { authority: 'policy-widen' }),
  route('POST', '/api/boot-resume', at(shell('header'), 'console#useBootResume'), runFlag),

  /* A person's turn. */
  route('GET', '/api/turn', at(turnPage, 'turn#turnApi.read')),
  // An item's explain view (quiet-console phase 8): the item's inspector Overview reads it.
  route('GET', '/api/turn/:id', at(turnPage, 'turn#useTurnItem')),
  route('GET', '/api/human-steps', at(turnPage, 'human-steps#humanStepsApi.humanSteps')),
  route('POST', '/api/human-steps/suspected', at(shell('bell'), BY_INBOX)),
  route('POST', '/api/human-steps/:id/open', at(turnPage, 'human-steps#humanStepsApi.humanStepOpen')),
  route('POST', '/api/human-steps/:id/check', at(turnPage, 'human-steps#humanStepsApi.humanStepCheck'), {
    authority: 'attest',
  }),
  route('POST', '/api/human-steps/:id/snooze', at(turnPage, 'human-steps#humanStepsApi.humanStepSnooze')),
  route('POST', '/api/human-steps/:id/cannot', at(turnPage, 'human-steps#humanStepsApi.humanStepCannot')),
  // *Withdraw* among an item's moves (quiet-console phase 8): the owner takes an open item off the page.
  route('POST', '/api/human-steps/:id/dismiss', at(turnPage, 'turn#withdrawItem'), { authority: 'decline' }),
  route('POST', '/api/human-steps/:id/answer', at(turnPage, 'human-steps#humanStepsApi.humanStepAnswer'), {
    authority: 'answer',
  }),
  route('POST', '/api/human-steps/:id/decline', at(turnPage, 'human-steps#humanStepsApi.humanStepDecline'), {
    authority: 'decline',
  }),
  route('POST', '/api/human-steps/:id/ask', at(turnPage, 'human-steps#humanStepsApi.humanStepAsk')),
  route('POST', '/api/human-steps/:id/evidence', at(turnPage, 'human-steps#humanStepsApi.humanStepAttach')),
  route(
    'POST',
    '/api/human-steps/:id/override',
    at(turnPage, 'human-steps#humanStepsApi.humanStepOverride'),
    {
      authority: 'override',
    },
  ),
  route('POST', '/api/human-steps/:id/rewrite', at(turnPage, 'human-steps#humanStepsApi.humanStepRewrite'), {
    authority: 'decline',
  }),
  route('POST', '/api/human-steps/:id/deny', at(turnPage, BY_INBOX), { authority: 'decline' }),
  route('POST', '/api/human-steps/:id/convert', at(turnPage, BY_INBOX), { authority: 'decline' }),
  route('POST', '/api/human-steps/:id/grant', at(turnPage, 'permissions#permissionsApi.grant'), {
    authority: 'grant',
  }),

  /* The scoped grants. */
  route('GET', '/api/permissions/grants', at(settings('permissions'), 'permissions#useGrants')),
  route('POST', '/api/permissions/grants/:id/revoke', at(settings('permissions'), 'turn#revokeGrant'), {
    authority: 'decline',
    options: ['reason'],
  }),
  route('POST', '/api/permissions/grants/revoke-all', at(settings('permissions'), 'turn#revokeAll'), {
    authority: 'decline',
    options: ['reason'],
  }),

  /* Push, webhooks and the notification inbox. */
  route('GET', '/api/push', at(settings('notifications'), 'inbox#usePush')),
  route(
    'POST',
    '/api/push/subscribe',
    at(settings('notifications'), 'api/notifications#notificationsApi.pushSubscribe'),
  ),
  route(
    'POST',
    '/api/push/unsubscribe',
    at(settings('notifications'), 'api/notifications#notificationsApi.pushUnsubscribe'),
  ),
  route(
    'POST',
    '/api/push/categories',
    at(settings('notifications'), 'api/notifications#notificationsApi.pushCategories'),
  ),
  route(
    'POST',
    '/api/push/quiet',
    at(settings('notifications'), 'api/notifications#notificationsApi.pushQuiet'),
  ),
  route(
    'POST',
    '/api/push/test',
    at(settings('notifications'), 'api/notifications#notificationsApi.pushTest'),
  ),
  route('POST', '/api/push/action', at(shell('bell'), 'api/notifications#notificationsApi.pushAction'), {
    authority: 'answer',
  }),
  route('GET', '/api/webhooks', at(settings('notifications'), 'webhooks#useWebhooks')),
  route(
    'POST',
    '/api/webhooks/add',
    at(settings('notifications'), 'api/webhooks#webhooksApi.webhookAdd'),
    webhooksFlag,
  ),
  route(
    'POST',
    '/api/webhooks/remove',
    at(settings('notifications'), 'api/webhooks#webhooksApi.webhookRemove'),
    webhooksFlag,
  ),
  route(
    'POST',
    '/api/webhooks/categories',
    at(settings('notifications'), 'api/webhooks#webhooksApi.webhookCategories'),
    webhooksFlag,
  ),
  route(
    'POST',
    '/api/webhooks/test',
    at(settings('notifications'), 'api/webhooks#webhooksApi.webhookTest'),
    webhooksFlag,
  ),
  route('GET', '/api/notifications', at(shell('bell'), 'inbox#useInbox')),
  route(
    'POST',
    '/api/notifications/read',
    at(shell('bell'), 'api/notifications#notificationsApi.markNotificationsRead'),
  ),
  route(
    'DELETE',
    '/api/notifications',
    at(shell('bell'), 'api/notifications#notificationsApi.clearNotifications'),
  ),

  /* The console's own process. */
  route('GET', '/api/restart', at(settings('instance'), 'machine#useRestartReadiness')),
  // The plain press and its three forms (phase 23): without updating, when the live sessions finish, anyway.
  route('POST', '/api/restart', at(settings('instance'), 'api/system#systemApi.restart'), {
    ...runFlag,
    options: ['update', 'whenIdle', 'force'],
  }),
  route('GET', '/api/shutdown', at(settings('instance'), 'machine#useShutdownReadiness')),
  route('POST', '/api/shutdown', at(settings('instance'), 'api/system#systemApi.shutdown')),

  /* The terminal. */
  route('GET', '/api/terminal', at(sessionsPage, 'sessions#useTerminals')),
  route('POST', '/api/terminal', at(sessionsPage, 'sessions#useSessionStart'), terminalFlag),
  route('DELETE', '/api/terminal', at(sessionsPage, 'sessions#useSessionActs'), terminalFlag),
  route('POST', '/api/terminal/:id/freeze', at(sessionsPage, 'sessions#useSessionActs'), terminalFlag),
  route('POST', '/api/terminal/:id/thaw', at(sessionsPage, 'sessions#useSessionActs'), terminalFlag),
  route('POST', '/api/terminal/:id/stop', at(sessionsPage, 'sessions#useSessionActs'), terminalFlag),

  route('GET', '/api/tailscale', at(settings('instance'), 'machine#useTailscale')),
  /* The census and the machine profile: the Fleet page draws both in Pro; a free console has neither yet. */
  route('GET', '/api/instances', at(shell('switcher'), 'machine#useInstances')),
  // What this console takes from the machine profile (phase 23): This instance's profile group.
  route('GET', '/api/fleet/profile', at(settings('instance'), 'machine#useMachineProfile')),

  /* MCP servers. */
  route('GET', '/api/mcp', at(settings('mcp'), 'mcp#useMcp')),
  route('GET', '/api/mcp/catalog', at(settings('mcp'), 'mcp#useMcpCatalog')),
  route('POST', '/api/mcp/refresh', at(settings('mcp'), 'api/mcp#mcpApi.mcpRefresh')),
  route('POST', '/api/mcp', at(settings('mcp'), 'api/mcp#mcpApi.mcpAdd'), mcpFlag),
  route('DELETE', '/api/mcp/:id', at(settings('mcp'), 'api/mcp#mcpApi.mcpDelete'), mcpFlag),
  // A rename is the patch's `label`; a sign-in for a profile account names it (phase 23).
  route('PATCH', '/api/mcp/:id', at(settings('mcp'), 'api/mcp#mcpApi.mcpPatch'), {
    ...mcpFlag,
    options: ['label'],
  }),
  route('POST', '/api/mcp/:id/login', at(settings('mcp'), 'api/mcp#mcpApi.mcpLogin'), {
    ...mcpFlag,
    options: ['accountId'],
  }),
  route('POST', '/api/mcp/:id/acknowledge', at(settings('mcp'), 'api/mcp#mcpApi.mcpAcknowledge')),

  /* Claude accounts. The breaker's two verbs and the credits switch are Settings ▸ Accounts' in both editions (phase 22). */
  route('GET', '/api/accounts', at(settings('accounts'), 'accounts#useAccounts')),
  route(
    'POST',
    '/api/accounts/login',
    at(settings('accounts'), 'api/accounts#accountsApi.accountLogin'),
    accountsFlag,
  ),
  route(
    'PUT',
    '/api/accounts/:id/credential',
    at(settings('accounts'), 'api/accounts#accountsApi.accountReplaceToken'),
    accountsFlag,
  ),
  route('POST', '/api/accounts/refresh', at(settings('accounts'), 'api/accounts#accountsApi.accountRefresh')),
  route(
    'POST',
    '/api/accounts/:id/clear-retired',
    at(settings('accounts'), 'accounts#clearRetired'),
    accountsFlag,
  ),
  route(
    'POST',
    '/api/accounts/:id/probe-entitlement',
    at(settings('accounts'), 'accounts#probeEntitlement'),
    accountsFlag,
  ),
  route(
    'POST',
    '/api/accounts',
    at(settings('accounts'), 'api/accounts#accountsApi.accountAdd'),
    accountsFlag,
  ),
  route(
    'DELETE',
    '/api/accounts/:id',
    at(settings('accounts'), 'api/accounts#accountsApi.accountDelete'),
    accountsFlag,
  ),
  route(
    'DELETE',
    '/api/accounts',
    why(
      'the same removal with its id in the query (`?id=`) — a page names the account in the path',
      'viewer/client/src/data/api/accounts.ts',
    ),
    accountsFlag,
  ),
  route('POST', '/api/accounts/:id/overage', at(settings('accounts'), 'accounts#overage'), {
    ...accountsFlag,
    options: ['capUsd'],
  }),
  route(
    'PATCH',
    '/api/accounts/:id',
    at(settings('accounts'), 'api/accounts#accountsApi.accountRename'),
    accountsFlag,
  ),

  /* The desktop launcher, the permission policy, the ledgers and the doctor. */
  route('GET', '/api/launcher', at(settings('essentials'), 'machine#useLauncherPlan')),
  route(
    'POST',
    '/api/launcher',
    at(settings('essentials'), 'api/system#systemApi.createLauncher'),
    writesFlag,
  ),
  route('GET', '/api/policy', at(settings('permissions'), 'policy#usePolicy')),
  route(
    'POST',
    '/api/policy/advisory/acknowledge',
    at(settings('permissions'), 'api/policy#policyApi.acknowledgePolicyAdvisory'),
    { authority: 'policy-widen' },
  ),
  route('POST', '/api/policy', at(settings('permissions'), 'api/policy#policyApi.editPolicy'), {
    ...writesFlag,
    authority: 'policy-widen',
  }),
  route('GET', '/api/spend', at(insightsPage, 'runs#useSpend')),
  route('GET', '/api/ledger', at(insightsPage, 'runs#useLedgerSummary')),
  route('GET', '/api/metrics', at(logs('health'), 'logs#readMetricsScrape')),
  /* The console's and the machine's thin reads (quiet-console phase 25): Logs ▸ Health
     draws the ceiling and the strays, Settings ▸ Accounts what this machine holds. */
  route('GET', '/api/ceiling', at(logs('health'), 'machine#useStartCeiling')),
  route('GET', '/api/credentials', at(settings('accounts'), 'machine#useCredentials')),
  route('POST', '/api/credentials/probe', at(settings('accounts'), 'machine#useCredentialProbe'), {
    options: ['ids'],
  }),
  route('GET', '/api/doctor/strays', at(logs('health'), 'machine#useStrayConsoles')),
  route('GET', '/api/doctor', at(logs('health'), 'logs#useDoctor')),

  /* The logs. */
  route('GET', '/api/debug/retention', at(settings('instance'), 'logs#useRetention')),
  /* The level card rides the explorer since 7.0: the floor, the debug channels, the change's life. */
  route('GET', '/api/debug/level', at(logs('logs'), 'logs#useDebugLevel')),
  route('DELETE', '/api/debug/level', at(logs('logs'), 'logs#useLogLevelWrite.revertLevel')),
  route('POST', '/api/debug/level', at(logs('logs'), 'logs#useLogLevelWrite.setLevel'), {
    options: ['level', 'debug', 'ttlMs'],
  }),
  route('GET', '/api/debug/index', at(logs('logs'), 'logs#useDebugIndex')),
  route('GET', '/api/debug/runs', at(logs('journal'), 'logs#useDebugRuns')),
  route('GET', '/api/debug/bundle', at(logs('health'), 'logs#useDebugBundle')),
  route('GET', '/api/debug/tail', at(logs('logs'), 'api/debug#debugTailPath'), { stream: true }),

  /* The attention inbox. */
  route('GET', '/api/inbox', at(shell('bell'), 'inbox#useAttentionInbox')),
  route('POST', '/api/inbox/ack', at(shell('bell'), 'api/inbox#inboxApi.inboxAck')),
  route('DELETE', '/api/inbox/ack', at(shell('bell'), 'api/inbox#inboxApi.inboxUnack')),

  /* The plans — behind the "no source directory" wall from here on. */
  /* What the open directory's runs measured (quiet-console phase 25): Insights draws both. */
  route('GET', '/api/sizing', at(insightsPage, 'runs#useSessionSizing')),
  route('GET', '/api/report', at(insightsPage, 'runs#useWeekReport'), { options: ['until', 'replay'] }),
  route('GET', '/api/plans', at(plansLibrary, 'plans#usePlans')),
  route('GET', '/api/stats', at(insightsPage, 'plans#useStats')),
  route('GET', '/api/search', at(shell('palette'), 'console#useSearch')),
  route('GET', '/api/skills', at(runView, 'machine#useSkills')),
  route('GET', '/api/plans/:slug', at(phasesTab, 'plans#usePlan')),
  route('GET', '/api/plans/:slug/raw', at(sourceTab, 'plans#usePlanRaw')),
  route('GET', '/api/plans/:slug/handoff/:phase', at(phasesTab, 'plans#useHandoff')),
  route('GET', '/api/plans/:slug/qa-report/:phase', at(phasesTab, 'plans#useQaReport')),
  route('GET', '/api/plans/:slug/prompt/:phase', at(phasesTab, 'api/plans#plansApi.prompt')),
  route('GET', '/api/plans/:slug/next-prompt/:phase', at(phasesTab, 'plans#useNextPrompt')),
  route('GET', '/api/plans/:slug/qa-prompt/:phase', at(phasesTab, 'plans#useQaPrompt')),
  route('GET', '/api/plans/:slug/memory-block', at(sourceTab, 'plans#useMemoryBlock')),
  route('GET', '/api/plans/:slug/notes/:phase', at(phasesTab, 'plans#usePhaseNotes')),
  route('GET', '/api/plans/:slug/verify-preflight', at(phasesTab, 'plans#useVerifyPreflight')),
  route('GET', '/api/plans/:slug/isolation-preflight', at(runView, 'plans#useIsolationPreflight')),
  route('GET', '/api/plans/:slug/board', at(sourceTab, 'plans#useBoardText')),
  route('GET', '/api/plans/:slug/review/:phase', at(phasesTab, 'plans#usePhaseReview')),
  route('POST', '/api/plans/:slug/review/:phase', at(phasesTab, 'api/plans#plansApi.setReview'), writesFlag),
  route(
    'POST',
    '/api/plans/:slug/review-comment/:phase',
    at(phasesTab, 'api/plans#plansApi.commentOnReview'),
    writesFlag,
  ),
  route(
    'POST',
    '/api/plans/:slug/review-send-back/:phase',
    at(phasesTab, 'api/plans#plansApi.sendBackReview'),
    runFlag,
  ),
  route('GET', '/api/plans/:slug/landing', at(phasesTab, 'plans#useLanding')),
  route('POST', '/api/plans/:slug/landing', at(phasesTab, 'api/plans#plansApi.composeLanding'), writesFlag),
  route('GET', '/api/plans/:slug/landing/:file', at(phasesTab, 'api/plans#plansApi.landingFileHref')),
  route('GET', '/api/plans/:slug/gate/:phase', at(phasesTab, 'plans#useGateStatus')),
  route('POST', '/api/plans/:slug/gate/:phase', at(phasesTab, 'api/plans#plansApi.approveGate'), {
    ...writesFlag,
    authority: 'gate-approve',
  }),
  route('GET', '/api/plans/:slug/session-plan', at(sourceTab, 'plans#useSessionPlan')),
  route('GET', '/api/plans/:slug/lint', at(phasesTab, 'plans#usePlanLint')),
  route('GET', '/api/plans/:slug/work', at(phasesTab, 'plans#usePlanWork')),
  route('POST', '/api/plans/:slug/qa-mode', at(phasesTab, 'api/plans#plansApi.qaModeSet'), writesFlag),
  route('POST', '/api/plans/:slug/qa-waive', at(phasesTab, 'api/plans#plansApi.qaWaive'), writesFlag),

  /* The admission queue. */
  route('GET', '/api/queue', at(queuePage, 'queue#useQueue')),


  /* An operator's word on a phase's place, and on a lane: the phase's Actions in
     the panel (its queue moves through `useQueueAct`, its lane verbs pressed by
     name), the Queued group's order on Runs, the policy in Settings ▸ Automation. */
  route('POST', '/api/queue/bump', at(runsHome, 'api/state#stateApi.queueBump'), runFlag),
  route('POST', '/api/queue/hold', at(phasesTab, QUEUE_ACT), runFlag),
  route('POST', '/api/queue/release', at(phasesTab, QUEUE_ACT), runFlag),
  route('POST', '/api/queue/defer', at(phasesTab, QUEUE_ACT), runFlag),
  route('POST', '/api/queue/withdraw', at(phasesTab, QUEUE_ACT), runFlag),
  route('POST', '/api/queue/requeue', at(phasesTab, QUEUE_ACT), runFlag),
  route('POST', '/api/queue/reorder', at(runsHome, 'api/state#stateApi.queueReorder'), runFlag),
  route('POST', '/api/queue/policy', at(settings('automation'), QUEUE_POLICY), runFlag),
  route('POST', '/api/lane/pin', at(phasesTab, PRESS_VERB), runFlag),
  route('POST', '/api/lane/unpin', at(phasesTab, PRESS_VERB), runFlag),
  route('POST', '/api/lane/reserve', at(phasesTab, PRESS_VERB), runFlag),
  route('POST', '/api/lane/unreserve', at(phasesTab, PRESS_VERB), runFlag),
  route('POST', '/api/lane/yield', at(phasesTab, PRESS_VERB), runFlag),
  route(
    'POST',
    '/api/lane/isolate',
    why(
      "the lane table's spelling of POST /api/run/:slug/isolate — one service method; a page presses the run's (the Run view's Actions)",
      'viewer/client/src/data/api/state.ts',
    ),
    runFlag,
  ),
  route(
    'POST',
    '/api/lane/isolate-phase',
    why(
      "the lane table's spelling of POST /api/run/:slug/isolate-phase — one service method; a page presses the run's",
      'viewer/client/src/data/api/state.ts',
    ),
    runFlag,
  ),

  /* The boot hold and the panic button. */
  route(
    'GET',
    '/api/automation/hold',
    why(
      'the boot hold rides `/api/state` (`bootHold`), which the page draws; a script reads this',
      CONTROLS_DOC,
    ),
  ),
  route(
    'POST',
    '/api/automation/hold/release',
    at(settings('instance'), 'api/state#stateApi.releaseBootHold'),
    runFlag,
  ),
  route(
    'GET',
    '/api/fleet',
    why('the freeze rides `/api/state` (`fleet`), which the page draws; a script reads this', CONTROLS_DOC),
  ),
  route('POST', '/api/fleet/freeze', at(runsHome, 'lifecycle#pressFleet'), runFlag),
  route('POST', '/api/fleet/thaw', at(runsHome, 'lifecycle#pressFleet'), runFlag),

  /* The claims. */
  route('GET', '/api/locks', at(locksPage, 'plans#useLocks')),
  route('POST', '/api/locks/release', at(locksPage, 'plans#useLockRelease'), writesFlag),

  /* Runs, signing in, approvals. */
  route('GET', '/api/runs', at(runsHome, 'runs#useRunList')),
  route('GET', '/api/auth', at(runsHome, 'machine#useAuth')),
  route('POST', '/api/auth/login', at(runView, 'api/system#systemApi.authLogin'), runFlag),
  route('GET', '/api/approvals', at(runsHome, 'runs#useApprovals')),
  route('POST', '/api/approvals/:id/extend', at(runView, 'api/runs#runsApi.extend'), {
    ...runFlag,
    authority: 'answer',
  }),
  route('POST', '/api/approvals/:id', at(turnPage, 'api/runs#runsApi.decide'), {
    ...runFlag,
    authority: 'answer',
  }),

  /* One run's reads. */
  route('GET', '/api/run/:slug', at(runView, 'runs#useRun')),
  route('GET', '/api/run/:slug/journal', at(runView, 'runs#useJournal')),
  route('GET', '/api/run/:slug/timeline', at(runView, 'runs#useTimeline')),
  route('GET', '/api/run/:slug/attempts/:phase', at(runView, 'runs#useAttempts')),
  route('GET', '/api/run/:slug/ledger', at(runView, 'runs#useLedger')),
  route('GET', '/api/run/:slug/phase/:phase/activity', at(runView, 'runs#usePhaseActivity')),
  route('GET', '/api/run/:slug/phase/:phase/report', at(runView, 'runs#usePhaseReport')),
  route('GET', '/api/run/:slug/transcript', at(runView, 'runs#useTranscript')),
  route('GET', '/api/run/:slug/diagnosis/:phase', at(runView, 'runs#useDiagnosis')),
  route('GET', '/api/run/:slug/scopes', at(runView, 'queue#useRunScopes')),
  route('GET', '/api/run/:slug/prelude', at(runView, 'runs#usePrelude')),
  route('GET', '/api/run/:slug/rulings', at(runView, 'runs#useRulings')),
  route(
    'GET',
    '/api/run/:slug/wait',
    why(
      'a long poll for a script (`phase-console run wait`) — a page has the live event stream; the palette copies its line',
      'viewer/shared/verb-model.js',
    ),
  ),
  route('GET', '/api/run/:slug/plan-text', at(runView, 'runs#usePlanText')),
  route('GET', '/api/run/:slug/triggers', at(runView, 'runs#useTriggers')),
  // What the plan's sessions proved and every run of its §Verification lines
  // (quiet-console phase 25): the run view's Verification section draws both.
  route('GET', '/api/run/:slug/proofs', at(runView, 'verification#useRunProofs'), { options: ['phase'] }),
  route('GET', '/api/run/:slug/verifications', at(runView, 'verification#useRunVerifications'), {
    options: ['phase', 'limit'],
  }),
  route('POST', '/api/run/:slug/rulings/:id/remember', at(phasesTab, 'api/runs#runsApi.rememberRuling'), {
    authority: 'policy-widen',
  }),

  /* One run's verbs — the run-verb switch, `OPERATOR_VERBS`' order of it. */
  route(
    'POST',
    '/api/run/:slug/phase/:n/errand-answered',
    at(runView, 'api/runs#runsApi.runErrandAnswered'),
    runFlag,
  ),
  route('POST', '/api/run/:slug/start', at(runView, RUN_START), runFlag),
  route('POST', '/api/run/:slug/ask', at(runView, 'api/runs#runsApi.runAsk'), runFlag),
  route('POST', '/api/run/:slug/steer', at(runView, 'api/runs#runsApi.runSteer'), runFlag),
  route('POST', '/api/run/:slug/answer', at(turnPage, BY_INBOX), { ...runFlag, authority: 'answer' }),
  route('POST', '/api/run/:slug/pause', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  route('POST', '/api/run/:slug/resume', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  route('POST', '/api/run/:slug/identity', at(runView, 'api/runs#runsApi.runIdentity'), runFlag),
  route('POST', '/api/run/:slug/hold', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  route('POST', '/api/run/:slug/release', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  route('POST', '/api/run/:slug/switch-account', at(runView, 'accounts#useSwitchAccount'), runFlag),
  route('POST', '/api/run/:slug/freeze', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  route('POST', '/api/run/:slug/thaw', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  route('POST', '/api/run/:slug/stop', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  /* A stopped run's Dismiss on its inbox row; the Runs page's own resolve buttons are Pro's fleet rows. */
  route('POST', '/api/run/:slug/resolve', at(shell('bell'), BY_INBOX), runFlag),
  route('POST', '/api/run/:slug/unresolve', at(runsHome, 'api/runs#runsApi.runUnresolve'), runFlag),
  route('POST', '/api/run/:slug/notes', at(runView, 'api/runs#runsApi.runNote'), runFlag),
  route('POST', '/api/run/:slug/skip', at(runView, 'api/runs#runsApi.runSkip'), runFlag),
  route('POST', '/api/run/:slug/raise-budget', at(runView, 'api/runs#runsApi.runRaiseBudget'), runFlag),
  route('POST', '/api/run/:slug/clear-streak', at(runView, 'api/runs#runsApi.runClearStreak'), runFlag),
  route('POST', '/api/run/:slug/retry', at(runView, 'api/runs#runsApi.runRetry'), runFlag),
  route('POST', '/api/run/:slug/recover', at(runView, 'api/runs#runsApi.runRecover'), runFlag),
  route('POST', '/api/run/:slug/verify-command', at(runView, 'api/runs#runsApi.runVerifyCommand'), runFlag),
  route('POST', '/api/run/:slug/mcp-continue', at(runView, 'api/runs#runsApi.runMcpContinue'), runFlag),
  route('POST', '/api/run/:slug/qa-recover', at(runView, 'api/runs#runsApi.qaRecover'), runFlag),
  route('POST', '/api/run/:slug/qa-rerun', at(phasesTab, 'api/runs#runsApi.qaRerun'), runFlag),
  route('POST', '/api/run/:slug/ultrareview', at(runView, 'api/runs#runsApi.runUltraReview'), runFlag),
  route('POST', '/api/run/:slug/recheck', at(runView, 'api/runs#runsApi.runRecheck'), runFlag),
  route(
    'POST',
    '/api/run/:slug/board-at-boundary',
    at(runView, 'api/runs#runsApi.runBoardAtBoundary'),
    runFlag,
  ),
  route('POST', '/api/run/:slug/triggers', at(runView, 'api/runs#runsApi.armTrigger'), runFlag),
  route('POST', '/api/run/:slug/triggers/:id/cancel', at(runView, 'api/runs#runsApi.cancelTrigger'), runFlag),
  route('POST', '/api/run/:slug/closeout', at(runView, 'api/runs#runsApi.runCloseout'), runFlag),
  route('POST', '/api/run/:slug/resume-phase', at(runView, 'api/runs#runsApi.runResumePhase'), runFlag),
  route('POST', '/api/run/:slug/repair-checkout', at(runView, 'api/runs#runsApi.runRepairCheckout'), runFlag),
  route('POST', '/api/run/:slug/isolate', at(runView, 'api/runs#runsApi.runIsolate'), runFlag),
  route('POST', '/api/run/:slug/isolate-phase', at(runView, 'api/runs#runsApi.runIsolatePhase'), runFlag),
  route('POST', '/api/run/:slug/errand-tree', at(runView, 'api/runs#runsApi.runErrandTree'), runFlag),
  route('POST', '/api/run/:slug/delegate', at(runView, 'api/runs#runsApi.runDelegate'), {
    ...runFlag,
    authority: 'trust',
  }),
  route('POST', '/api/run/:slug/plan-approval', at(runView, 'api/runs#runsApi.runPlanDecision'), {
    ...runFlag,
    authority: 'plan-approve',
  }),
  route('POST', '/api/run/:slug/settings', at(runView, 'api/runs#runsApi.runSettings'), {
    ...runFlag,
    authority: 'profile-raise',
  }),

  /* The console's own door for a write. */
  route('POST', '/api/write', at(plansLibrary, 'api/plans#plansApi.write'), {
    ...writesFlag,
    authority: 'gate-approve',
  }),
];


/* ------------------------------------------------------------------ *
 * Events — `SSE_EVENTS` (`data/live.ts`), applied by the shell's one stream
 * ------------------------------------------------------------------ */

const LIVE = 'live#useLiveData';

const EVENTS: readonly SurfaceRow[] = [
  sse('changed', at(plansLibrary, LIVE)),
  sse('warm', at(shell('header'), LIVE)),
  sse('health', at(shell('header'), LIVE)),
  sse('approval', at(turnPage, LIVE)),
  sse('approval:resolved', at(turnPage, LIVE)),
  sse('notification', at(shell('bell'), LIVE)),
  sse('notification:delivery', at(shell('bell'), LIVE)),
  sse('notification:read', at(shell('bell'), LIVE)),
  sse('notification:cleared', at(shell('bell'), LIVE)),
  sse('sessions', at(sessionsPage, LIVE)),
  sse('run:run', at(runsHome, LIVE)),
  sse('run:phase', at(runView, LIVE)),
  sse('run:stream', at(runView, 'live-share#useRunStream')),
  sse('run:journal', at(runView, LIVE)),
  sse('run:verify', at(runView, LIVE)),
  sse('run:state', at(runsHome, LIVE)),
  sse('run:queue', at(queuePage, LIVE)),
  sse('run:converge', at(runsHome, LIVE)),
  sse('accounts', at(settings('accounts'), LIVE)),
  sse('mcp', at(settings('mcp'), LIVE)),
  sse('inbox', at(shell('bell'), LIVE)),
  sse('run:liveness', at(runView, LIVE)),
  sse('run:watchdog', at(runView, LIVE)),
  sse('run:git', at(runView, LIVE)),
  sse('run:rulings', at(runView, LIVE)),
  sse('repo:radar', at(repo('trees'), LIVE)),
  sse('human-step', at(turnPage, LIVE)),
  sse('turn', at(turnPage, LIVE)),
  sse('plan:lint', at(phasesTab, LIVE)),
  sse('run:progress', at(runsHome, LIVE)),
  sse('restart', at(settings('instance'), LIVE)),
  sse('review', at(phasesTab, LIVE)),
  sse('landing', at(phasesTab, LIVE)),
  /* Its effect re-reads `['triggers', slug]` — the Run view's Triggers fold. */
  sse('run:triggers', at(runView, LIVE)),
  sse('run:budget', at(runView, LIVE)),
];

/* ------------------------------------------------------------------ *
 * Settings — every key the server stores (`server/config.ts` `Prefs`, its
 * retention policy, a run's own fields), the browser's own (`lib/prefs.ts`),
 * the machine profile and the capability flags
 * ------------------------------------------------------------------ */

const automation = settings('automation');
/**
 * A key Settings ▸ Automation writes: its own cards, or — for the run defaults
 * (`gitMode`, `isolation`, `settle`, …) — the launch form in its `defaults` mode.
 */
const automationKey = (key: string): SurfaceRow => setting(key, at(automation, SAVE_PREFS));
/** A key no section draws a control of its own for: Settings ▸ Everything writes every key a page may. */
const everything = (key: string): SurfaceRow => setting(key, at(settings('everything'), SAVE_PREFS));
/** A key the queue's own door writes (`POST /api/queue/policy`): Settings ▸ Automation ▸ The queue. */
const queueKey = (key: string): SurfaceRow => setting(key, at(automation, QUEUE_POLICY));

const PREFS: readonly SurfaceRow[] = [
  setting('recentRoots', at(shell('switcher'), 'machine#useOpenRoot')),
  setting('issueRepos', at(repo('issues'), 'repo#useIssueRepos')),
  setting(
    'lastRoot',
    why(
      'which root the console reopens at boot — written by opening one, and the open root is on every page',
      'viewer/server/config.ts',
    ),
  ),
  // The four person-wide keys (`config.json`): the browser keeps its own theme and density
  // (`browser.*`), so Everything is the server's pair's one door; Appearance writes the model
  // a session plan is sized for and the library's order, which the library writes too.
  everything('theme'),
  everything('density'),
  setting('model', at(settings('appearance'), SAVE_PREFS)),
  setting('sort', at(settings('appearance'), SAVE_PREFS)),
  automationKey('attachDefaultSkills'),
  automationKey('qaByDefault'),
  automationKey('gitMode'),
  automationKey('openPrOnComplete'),
  automationKey('reviewEachPhaseByDefault'),
  automationKey('reviewerPolicy'),
  automationKey('repoGuard'),
  automationKey('isolation'),
  automationKey('settle'),
  automationKey('worktreeMaxConcurrent'),
  automationKey('worktreeSetup'),
  automationKey('worktreeCopyEnv'),
  automationKey('worktreeRoot'),
  automationKey('maxConcurrentPerRepo'),
  automationKey('worktreeRetention'),
  automationKey('baseBranch'),
  automationKey('radarSerialize'),
  automationKey('landing'),
  automationKey('conflictPolicy'),
  automationKey('messaging'),
  automationKey('issuesMode'),
  automationKey('isolationReclaim'),
  automationKey('deleteMergedRunBranches'),
  automationKey('autoRecoverByDefault'),
  automationKey('autoContinueRecovery'),
  automationKey('watchCmdRefs'),
  automationKey('watchMintedCmdRefs'),
  automationKey('mcpPolicy'),
  automationKey('ladderPerPhaseRungs'),
  automationKey('ladderPerPhaseUsd'),
  automationKey('ladderPerRunRungs'),
  automationKey('ladderPerRunUsd'),
  automationKey('ladderPerDayUsd'),
  automationKey('ceilingStartsPerHour'),
  automationKey('ceilingUsdPerHour'),
  // The console's scheduling word, a plan's own, the load guard's factor: Settings ▸ Automation ▸ The queue.
  queueKey('schedulingPolicy'),
  queueKey('schedulingPolicies'),
  queueKey('loadGuardFactor'),
  automationKey('usageForecastLeadHours'),
  automationKey('usageForecastHold'),
  automationKey('unblockAttempts'),
  automationKey('staleClaimTakeover'),
  automationKey('delegateHumanGates'),
  automationKey('policy'),
  automationKey('allowUnverifiedPhases'),
  automationKey('ladderExtendOnProgress'),
  automationKey('resumeAtBoot'),
  automationKey('autoAccountSwitch'),
  automationKey('convergeEveryMs'),
  automationKey('budgetAutoRaisePct'),
  automationKey('mcpRequireTimeoutMs'),
  automationKey('boardingSchedule'),
  automationKey('relayRules'),
  automationKey('stallSilentMs'),
  automationKey('stallSpinTurns'),
  automationKey('stallStalemateAttempts'),
  automationKey('stallRetryBurst'),
  automationKey('stallExternalWaitMs'),
  automationKey('stallLocalJobMs'),
  automationKey('stallLoopRun'),
  automationKey('checkJudgement'),
  automationKey('checkModel'),
  automationKey('checkEffort'),
  automationKey('turnEscalateAfter'),
  automationKey('stallAutomaticPark'),
  automationKey('stallEscalateMs'),
  setting('notify', at(settings('notifications'), SAVE_PREFS)),
  setting('retention', at(settings('instance'), SAVE_PREFS)),
];

/** A retention member: Settings ▸ This instance writes every one (phase 23), held to the loader's floors. */
const retained = (key: string): SurfaceRow =>
  setting(`retention.${key}`, at(settings('instance'), SAVE_PREFS));

const RETENTION: readonly SurfaceRow[] = [
  retained('consoleLogMaxBytes'),
  retained('supervisorLogMaxBytes'),
  retained('supervisorLogKeepBytes'),
  retained('runRetainDays'),
  retained('runRetainMin'),
  retained('runsMaxBytes'),
  retained('taskInboxDays'),
  retained('rulingsOversizedBytes'),
  retained('outcomeInboxDays'),
  retained('outcomeInboxMax'),
  retained('sessionEventsMaxBytes'),
  retained('gitTraceLeftoverHours'),
  retained('gitTraceDirMaxBytes'),
  retained('messagesRotateBytes'),
  retained('messagesRetainDays'),
  retained('crashRetainDays'),
  retained('locksRotateBytes'),
  retained('humanStepsRotateBytes'),
  retained('grantsRotateBytes'),
  retained('handledRotateBytes'),
  retained('turnEvidenceRetainDays'),
  retained('turnEvidenceMaxBytes'),
  retained('runWorktreeRetainDays'),
  retained('runWorktreesMaxBytes'),
];

/** A run's own field: the launch form gives each a control (`run-setup/reachability.test.tsx`). */
const runField = (field: string): SurfaceRow => setting(`run.${field}`, at(runView, RUN_START));

const RUN_FIELDS: readonly SurfaceRow[] = [
  ...[
    'model',
    'effort',
    'maxParallel',
    'maxConsecutiveFailures',
    'autonomy',
    'phaseBudgetUsd',
    'runBudgetUsd',
    'onlyPhases',
    'phaseOptions',
    'skills',
    'mcpServers',
    'mcpPolicy',
    'permissionProfile',
    'permissionMode',
    'gitStrategyAck',
    'gitMode',
    'openPr',
    'isolation',
    'settle',
    'priority',
    'startAfter',
    'reviewEachPhase',
    'reviewerPolicy',
    'ultracode',
    'ultraReview',
    'attachDefaultSkills',
    'qa',
    'qaMaxRounds',
    'qaModel',
    'qaEffort',
    'approvalTimeoutMinutes',
    'qaFixStrategy',
    'qaRoundBudgetUsd',
    'ladderPerRunRungs',
    'ladderPerPhaseRungs',
    'onLimit',
    'modelPolicy',
    'baseBranch',
    'maxConcurrentPerRepo',
    'worktreeRetention',
    'landing',
    'conflictPolicy',
    'messaging',
    'issuesMode',
    'autoRecover',
    'resumeOnRestart',
    'relay',
    'accounts',
    'accountId',
    'acknowledgedWaivers',
    'manifestOverride',
    'verifyAnswers',
  ].map(runField),
  setting(
    'run.resumeRunId',
    why(
      "the launch form's context — the run a Continue resumes — never a value a person types",
      'viewer/client/src/screens/launch/model/schema.ts',
    ),
  ),
  setting(
    'run.autoOpen',
    why(
      "the launch form's context — the links it showed in full — never a value a person types",
      'viewer/client/src/screens/launch/model/schema.ts',
    ),
  ),
];

const BROWSER: readonly SurfaceRow[] = [
  setting('browser.theme', at(settings('appearance'))),
  setting('browser.density', at(settings('appearance'))),
  // The right panel's width, mode and whether it stands (7.0): set by the panel
  // itself — its edge, its segmented control, its close — never from a page.
  setting('browser.panel', at(shell('panel'))),
  // Everything, per page (quiet-console phase 6): the last slot of every list page's toolbar (`ui/toolbar.tsx`).
  setting('browser.everything', at(shell('toolbar'))),
  setting('browser.sort', at(plansLibrary)),
  setting('browser.showDocuments', at(settings('appearance'))),
  setting('browser.showClosed', at(plansLibrary)),
  setting('browser.plansHiddenBannerOff', at(plansLibrary)),
  setting('browser.model', at(settings('appearance'))),
  setting('browser.plansLayout', at(plansLibrary)),
  setting('browser.plansGroup', at(plansLibrary)),
  setting('browser.readyRank', at(runsHome)),
  setting('browser.readyGroup', why(RETIRED_VIEW, BROWSER_PREFS)),
  setting('browser.nowShowAcked', why(RETIRED_VIEW, BROWSER_PREFS)),
  // The runs table's order and its closed-plan switch are the Pro fleet table's; All runs draws them in phase 7.
  setting('browser.runsSort', at(runsHome)),
  setting('browser.runsShowClosed', at(runsHome)),
  setting('browser.runsView', at(runsHome)),
  setting('browser.runPhasesCollapsed', why(RETIRED_VIEW, BROWSER_PREFS)),
  setting('browser.stripsOpen', at(runsHome)),
  setting('browser.runSectionsOpen', at(runView)),
  setting('browser.towerCategory', at(runsHome)),
  setting('browser.towerQuery', at(runsHome)),
  setting('browser.towerSettledOpen', at(runsHome)),
  setting('browser.planPhasesCollapsed', why(RETIRED_VIEW, BROWSER_PREFS)),
  setting('browser.runsConsole', at(runsHome)),
  setting('browser.sessionsSort', at(sessionsPage)),
  setting('browser.sessionsKind', at(sessionsPage)),
  setting('browser.sessionsGroup', at(sessionsPage)),
  setting('browser.mapPanZoom', at(phasesTab)),
  setting('browser.terminalFontStep', at(sessionsPage)),
  // Read by the terminal: Appearance, beside its WebGL switch.
  setting('browser.terminalScreenReader', at(settings('appearance'))),
  setting('browser.terminalWebgl', at(settings('appearance'))),
  setting('browser.tables', at(plansLibrary)),
];

/** The machine profile (`~/.config/phase-console/fleet.json`): Settings ▸ This instance shows it read-only, with the CLI line. */
const profileKey = (key: string): SurfaceRow => setting(`profile.${key}`, at(settings('instance')));

const PROFILE: readonly SurfaceRow[] = [
  profileKey('remoteHost'),
  profileKey('remoteUsers'),
  profileKey('notifyCommand'),
  profileKey('webhooks'),
  profileKey('categories'),
  profileKey('quietHours'),
  profileKey('maxSessions'),
  profileKey('hookScript'),
  profileKey('heapMb'),
  profileKey('heapSnapshotOnNearLimit'),
  profileKey('autostart'),
];

/** A capability flag: the start command in Settings ▸ Essentials composes each one into the line that turns it on. */
const capability = (flag: string): SurfaceRow =>
  setting(`flag ${flag}`, at(settings('essentials')), { flag });

const FLAGS: readonly SurfaceRow[] = [
  capability('--allow-run'),
  capability('--allow-terminal'),
  capability('--allow-agent'),
  // The one flag the start command never composes — it pushes the work. This instance lists it with the others.
  setting('flag --allow-publish', at(settings('instance')), { flag: '--allow-publish' }),
  capability('--allow-accounts'),
  capability('--allow-mcp'),
  capability('--allow-webhooks'),
  capability('--allow-writes'),
];

/* ------------------------------------------------------------------ *
 * Operator verbs — `OPERATOR_VERBS` (`shared/verb-model.js`), in its order
 * ------------------------------------------------------------------ */

const VERBS: readonly SurfaceRow[] = [
  verb('runs', at(runsHome, 'runs#useRunList')),
  verb('status', at(runsHome, 'runs#useRunList')),
  verb('queue', at(queuePage, 'queue#useQueue')),
  verb('accounts', at(settings('accounts'), 'accounts#useAccounts')),
  verb('approvals', at(runsHome, 'runs#useApprovals')),
  verb('journal', at(runView, 'runs#useJournal')),
  verb('tail', at(runView, 'runs#usePhaseActivity')),
  verb('explain', at(runView, 'runs#usePhaseReport')),
  verb('plan-text', at(runView, 'runs#usePlanText')),
  verb('triggers', at(runView, 'runs#useTriggers')),
  // The one read no page presses: a script waits on it (Pro's palette copies its line).
  verb(
    'wait',
    why(
      'a long poll for a script (`phase-console run wait`) — a page has the live event stream',
      'viewer/shared/verb-model.js',
    ),
  ),
  verb('pause', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  verb('start', at(runView, RUN_START), runFlag),
  verb('resume', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  verb('resume-phase', at(runView, 'api/runs#runsApi.runResumePhase'), runFlag),
  verb('retry', at(runView, 'api/runs#runsApi.runRetry'), runFlag),
  verb('steer', at(runView, 'api/runs#runsApi.runSteer'), runFlag),
  verb('bump', at(runsHome, 'api/state#stateApi.queueBump'), runFlag),
  verb('pin', at(phasesTab, PRESS_VERB), runFlag),
  verb('unpin', at(phasesTab, PRESS_VERB), runFlag),
  verb('reserve', at(phasesTab, PRESS_VERB), runFlag),
  verb('unreserve', at(phasesTab, PRESS_VERB), runFlag),
  verb('yield', at(phasesTab, PRESS_VERB), runFlag),
  verb('queue-policy', at(settings('automation'), QUEUE_POLICY), runFlag),
  verb('raise-budget', at(runView, 'api/runs#runsApi.runRaiseBudget'), runFlag),
  verb('clear-streak', at(runView, 'api/runs#runsApi.runClearStreak'), runFlag),
  verb('board-at-boundary', at(runView, 'api/runs#runsApi.runBoardAtBoundary'), runFlag),
  verb('hold', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  verb('release', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  verb('switch-account', at(runView, 'accounts#useSwitchAccount'), runFlag),
  verb('note', at(runView, 'api/runs#runsApi.runNote'), runFlag),
  verb('trigger', at(runView, 'api/runs#runsApi.armTrigger'), runFlag),
  verb('cancel-trigger', at(runView, 'api/runs#runsApi.cancelTrigger'), runFlag),
  verb('approve', at(turnPage, 'api/runs#runsApi.decide'), { ...runFlag, authority: 'answer' }),
  verb('deny', at(turnPage, 'api/runs#runsApi.decide'), { ...runFlag, authority: 'answer' }),
  verb('ask', at(runView, 'api/runs#runsApi.runAsk'), runFlag),
  verb('answer', at(turnPage, BY_INBOX), { ...runFlag, authority: 'answer' }),
  verb('identity', at(runView, 'api/runs#runsApi.runIdentity'), runFlag),
  verb('freeze', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  verb('thaw', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  verb('stop', at(runsHome, 'lifecycle#useLifecycle'), runFlag),
  verb('resolve', at(shell('bell'), BY_INBOX), runFlag),
  verb('unresolve', at(runsHome, 'api/runs#runsApi.runUnresolve'), runFlag),
  verb('skip', at(runView, 'api/runs#runsApi.runSkip'), runFlag),
  verb('recover', at(runView, 'api/runs#runsApi.runRecover'), runFlag),
  verb('verify-command', at(runView, 'api/runs#runsApi.runVerifyCommand'), runFlag),
  verb('mcp-continue', at(runView, 'api/runs#runsApi.runMcpContinue'), runFlag),
  verb('qa-recover', at(runView, 'api/runs#runsApi.qaRecover'), runFlag),
  verb('qa-rerun', at(phasesTab, 'api/runs#runsApi.qaRerun'), runFlag),
  verb('ultrareview', at(runView, 'api/runs#runsApi.runUltraReview'), runFlag),
  verb('recheck', at(runView, 'api/runs#runsApi.runRecheck'), runFlag),
  verb('closeout', at(runView, 'api/runs#runsApi.runCloseout'), runFlag),
  verb('repair-checkout', at(runView, 'api/runs#runsApi.runRepairCheckout'), runFlag),
  verb('isolate', at(runView, 'api/runs#runsApi.runIsolate'), runFlag),
  verb('isolate-phase', at(runView, 'api/runs#runsApi.runIsolatePhase'), runFlag),
  verb('errand-tree', at(runView, 'api/runs#runsApi.runErrandTree'), runFlag),
  verb('delegate', at(runView, 'api/runs#runsApi.runDelegate'), { ...runFlag, authority: 'trust' }),
  verb('errand-answered', at(runView, 'api/runs#runsApi.runErrandAnswered'), runFlag),
  verb('plan-approval', at(runView, 'api/runs#runsApi.runPlanDecision'), {
    ...runFlag,
    authority: 'plan-approve',
  }),
  verb('settings', at(runView, 'api/runs#runsApi.runSettings'), { ...runFlag, authority: 'profile-raise' }),
];

/** Every row. */
export const SURFACE: readonly SurfaceRow[] = [
  ...ROUTES,
  ...EVENTS,
  ...PREFS,
  ...RETENTION,
  ...RUN_FIELDS,
  ...BROWSER,
  ...PROFILE,
  ...FLAGS,
  ...VERBS,
];
