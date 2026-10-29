// Route metadata — the single source of truth for the client's route vocabulary.
//
// This module is deliberately plain, dependency-free ESM (+ JSDoc). It is imported
// two ways with NO build step:
//   • by the Vite/React client, to build the route→view registry and the plan tabs;
//   • by the Node test suite (`node --test`), which asserts that every notification
//     deep-link the server can emit (`server/push/catalogue.ts` routeFor) lands on a
//     head this client actually registers, and that a plan's `run` tab still exists.
//
// Before this file, the tests scraped `web/app.js` for `head === '…'` and
// `web/views/plan.js` for `const TABS = […]`. That coupled the tests to a specific
// hand-written dispatch shape. The rewrite replaces both scrapes with imports of the
// two arrays below, so the contract is asserted against data, not source text.
//
// The URL vocabulary the SERVER emits is frozen by `server/push/catalogue.ts`
// (`routeFor`, the only emitter): `#/plan/:slug/run`, `#/plan/:slug/phase/:n`,
// `#/plan/:slug/route`, `#/ready`, `#/runs`, `#/plans`, `#/agent[/:id]`,
// `#/terminal[/:id]`, `#/settings`. Renaming one of those heads means editing that
// server file too — the test will catch a divergence.
//
// (`#/notifications` and `#/guide` were listed here as server-emitted until 3.0 and
// never were: no `routeFor` branch has ever produced either. They are client-only
// heads, which is what let 3.0 turn both into overlays without touching the server.)
//
// 3.0 added `now`, `sessions` and `insights` and kept EVERY older head. Some of the
// old ones are now redirects rather than pages (`shell/redirects.ts` `REDIRECTS`), but a
// head that ever appeared in a bookmark, a push payload or a handoff stays in this
// list and stays resolvable — which is the whole contract this array exists for.
//
// 4.0 added `repo` and `debug` and, again, dropped nothing. Both are NEW heads
// rather than absorbed old ones — the git surfaces and the diagnostics were
// spread across three pages and a log file, never addressable — so no redirect
// arrives with them and `server/push/catalogue.ts` still mints only the heads it
// always did.
//
// 6.0 (control-tower phase 21) made `runs` the home and `now` a redirect onto
// it — the eighth head to become one — and again dropped nothing.
//
// 8.0 (one-pool phase 14, #366) made `turn` — Your turn — the eighth
// destination, in the work band after Runs, and every plan gained a `turn`
// view; nothing was dropped.
//
// 7.0 (quiet-console phase 3) renamed Debug to Logs: `logs` is the head and the
// destination, `debug` the ninth redirect (`#/debug/health?since=1` lands on
// `#/logs/health?since=1`, section and query carried). The Pro heads `chat`
// and `fleet` stay heads and leave DESTINATIONS: the Supervisor is the right
// panel's second mode (and `#/chat` on a phone), and Fleet opens from the
// instance switcher at the top of the rail. Nothing was dropped.

/**
 * Top-level route heads — `route.segments[0]`. The empty hash (`#/`) and any
 * unknown head resolve to `DEFAULT_HEAD` below.
 *
 * The first eight are the DESTINATIONS — what the rail and the phone tab
 * bar offer, the same eight in both editions (seven in 7.0; Your turn joined
 * them in 8.0). Everything after them is a head
 * that still resolves (a page a later phase has not rebuilt yet, or a redirect
 * onto its new home) but is not a place the navigation sends you.
 *
 * `source` renders outside the app shell (the pre-open directory picker).
 * `terminal` and `agent` became REDIRECTS into `sessions` in Phase 10, when the
 * two pages became one whose kind is read off the session record rather than
 * out of the URL. Both keep their optional session id through the redirect
 * (`#/terminal/<id>` → `#/sessions/<id>`), which is what a reload, a phone
 * locking its screen and an hour-old push notification all depend on; with no
 * id each carries `?new=shell` / `?new=agent`, because that half of the address
 * was the launch intent and dropping it would land a shell request on a list.
 *
 * `now` joined the redirects in 6.0 (control-tower phase 21): the Tower on
 * `#/runs` absorbed its bands, so the address lands there, each `?focus=` on
 * the bay that answers the same question. The server still MINTS `#/now` (the
 * digest) and `#/ready`, so both stay here for as long as a payload can carry
 * them — which is always.
 *
 * ⚠️ `server/push/catalogue.ts` still MINTS `/#/agent/<id>` and
 * `/#/terminal/<id>` (`routeFor`, case `session`) — deliberately: the redirect
 * carries the id, so a payload from any server, of any age, resolves. That is
 * the contract this array exists for, and it is why a head is never dropped.
 *
 * NOTE: the route-registry guard asserts every head here has a `ROUTE_TABLE`
 * entry AND that no entry exists without a head — adding one means adding both
 * sides.
 * @type {readonly string[]}
 */
export const ROUTE_HEADS = Object.freeze([
  // the eight destinations
  'runs',
  // Your turn (control-tower phase 137, #214; a destination since one-pool
  // phase 14, #366): every act only a person can do, each with its guide, its
  // check and its moves — `#/turn`, and `#/turn/<id>` for one item, which is
  // where every step push lands.
  'turn',
  'plans',
  'sessions',
  'repo',
  'insights',
  // Every log this console writes, on one time axis (7.0: Debug's new name;
  // `debug` below redirects onto it).
  'logs',
  'settings',
  // pages a destination has not absorbed yet, plus the deep-link heads
  'plan',
  // The whole queue of one console (control-tower phase 99, #135): every entry,
  // why it sits where it does, who holds what, and the verbs that move it. A
  // HEAD, not a destination — the Tower's queued bay links to it.
  'queue',
  'ready',
  'pulse',
  'notifications',
  'mcp',
  'source',
  'terminal',
  'agent',
  // redirects onto the above
  // Debug became Logs in 7.0 (quiet-console phase 3). The head stays: it is in
  // bookmarks, in handoff prose and in the e2e specs, and every `#/debug/<section>?…`
  // lands on `#/logs/<section>?…` in one hop with its query.
  'debug',
  // The phone answer page every push linked to until 6.2 — `#/approve` and
  // `#/approve?step=<id>` are in notifications already on phones, so the head
  // stays and lands on Your turn (`#/turn`, `#/turn/<id>`) in one hop.
  'approve',
  'now',
  'dashboard',
  'stats',
  'search',
  'guide',
]);

/**
 * The head an empty or unknown hash means.
 *
 * Shared rather than client-local because it is the answer to "where does a
 * notification whose deep link no longer resolves land?", and that question has
 * to have the same answer on both sides of the wire.
 *
 * `runs` since 6.0 (control-tower phase 21): the Tower is where "does anything
 * need me?" is answered, which is the question an address that says nothing is
 * asking. It was `now` from 3.0 until then.
 * @type {string}
 */
export const DEFAULT_HEAD = 'runs';

/**
 * The eight destinations, in nav order — the rail, the phone tab bar and the
 * palette's navigation group all read this.
 *
 * Read as three bands, which is what the rail draws a rule between and what the
 * order encodes: **the work** (`runs`, `turn`, `plans`, `sessions`) is what is
 * moving right now — and what is waiting on you; **the record** (`repo`, `insights`, `logs`) is what it did — the
 * tree it changed, the numbers it made, the trace it left; **`settings`** is
 * the console itself, and stays last because it always has been.
 *
 * `runs` leads since 6.0 (control-tower phase 21): it is the home, and `now` —
 * which led from 3.0 — is a redirect onto it. `repo` and `logs` (Debug until
 * 7.0) are 4.0's two additions; they sit in the middle band rather than at the
 * end because the band is the meaning: both answer *what happened*.
 *
 * `turn` joined in 8.0 (one-pool phase 14, #366): Your turn was a head that
 * lit Runs, reached through the situation line, the bell or a push — and a
 * person's own tasks deserve a place of their own, second in the work band,
 * with its open count.
 *
 * The SAME eight in both editions (seven since 7.0, quiet-console phase 3). Pro's two
 * places are reached from the shell rather than listed: the Supervisor is the
 * right panel's second mode (and the phone tab bar's fourth slot, `#/chat`),
 * and Fleet opens from the instance switcher at the top of the rail. A list
 * that differed by edition was a tab bar that differed by edition, and a guide
 * card that had to exist twice.
 * @type {readonly string[]}
 */
export const DESTINATIONS = Object.freeze([
  'runs',
  'turn',
  'plans',
  'sessions',
  'repo',
  'insights',
  'logs',
  'settings',
]);

/**
 * Plan-detail tab ids — the second segment of `#/plan/:slug/:tab`. `run` is
 * load-bearing (the whole autopilot lives there and the server routes every
 * in-flight-run notification to it); a test asserts it stays present. `phase` and
 * `handoff` are detail sub-routes (`#/plan/:slug/phase/:n`), not tabs, so they are
 * not listed here.
 *
 * Five in 3.0, down from seven. `analysis`, `overview` and `raw` were three
 * readings of the same file that a person had to try in turn: the numbers, the
 * prose, the bytes. The numbers are Insights' subject and the other two are one
 * tab with a switch — see `LEGACY_PLAN_TABS`.
 *
 * Three in 6.0 (control-tower phase 23, #26 #27). `route`, `phases`, `qa` and
 * `handoffs` were four lists of the SAME phases, each with a different third of
 * their facts, so every question about one phase was a tour of four tabs. They
 * are one table now, and the four readings are its views (`PLAN_PHASE_VIEWS`).
 * `phases` leads because it is what a plan opens on.
 *
 * Four in 8.0 (one-pool phase 14, #366): `turn`, the plan's Your turn —
 * the same page as `#/turn`, scoped to this plan (`#/plan/:slug/turn`, and
 * `#/plan/:slug/turn/<id>` for one item).
 * @type {readonly string[]}
 */
export const PLAN_TABS = Object.freeze(['phases', 'run', 'turn', 'source']);

/**
 * The views of the `phases` tab — the `?view=` of `#/plan/:slug/phases`.
 *
 * One table, its readings: `table` (every column the window fits, grouped by
 * need), `map` (the route drawn as a network — phase 30 decides its engine)
 * and `handoffs` — Handoffs & QA, the same rows in plan order with each
 * phase's record forward: its handoff and its QA side by side (2026-10-20,
 * Tower strips; before it `qa` and `handoffs` were two readings of one
 * record, and `?view=qa` still reads as this one). `table` is the default,
 * so it is the one view whose address carries no `?view=`. Since one-pool
 * phase 16 (#376) also `schedule` (the plan as a Gantt — what ran, from the
 * run record, and when what is left is expected to start and end) and
 * `burnup` (phases and weight done over time, against the forecast).
 *
 * Shared for the same reason `LEGACY_PLAN_TABS` is: three retired tabs redirect
 * INTO these views, and the server's `#/plan/:slug/route` lands on `map`.
 * @type {readonly string[]}
 */
export const PLAN_PHASE_VIEWS = Object.freeze([
  'table',
  'map',
  'handoffs',
  'schedule',
  'burnup',
]);

/**
 * The sections of Insights, each an address: `#/insights` (the questions) and
 * — Pro — `#/insights/accounts` (one-pool phase 10: what every account spent)
 * and `#/insights/tokens` (measured-console phase 31, F2: Tokens & cache —
 * cache hit per session and account, tokens per tool, skill and hook,
 * forecast against actual, retry overhead, the side spend, the model mix and
 * the boot prefix and first-edit context per lane). The first is the default,
 * so its address carries no segment.
 * @type {readonly string[]}
 */
export const INSIGHT_SECTIONS = Object.freeze([
  'questions',
]);

/**
 * Short addresses for two readings of the phases (one-pool phase 16, #376):
 * `#/plan/:slug/schedule` and `#/plan/:slug/burnup` land, in one hop, on
 * `#/plan/:slug/phases?view=schedule` and `?view=burnup` — the plan's
 * schedule (a Gantt of what ran and what is expected) and its burn-up. Not
 * retired tabs (`LEGACY_PLAN_TABS` is the list of tabs that LEFT); names for a
 * reading somebody types or a handoff prints.
 * @type {Readonly<Record<string, {tab: string, view: string}>>}
 */
export const PLAN_VIEW_ALIASES = Object.freeze({
  schedule: Object.freeze({ tab: 'phases', view: 'schedule' }),
  burnup: Object.freeze({ tab: 'phases', view: 'burnup' }),
});

/**
 * The views of the `run` tab — the `?view=` of `#/plan/:slug/run` (7.0,
 * quiet-console phase 10; drawn by phase 11): `live`, the plan's run as it is
 * now, and `history`, every run of the plan with a past run's activity and
 * report. `live` is the default, so it is the one whose address carries no
 * `?view=`.
 * @type {readonly string[]}
 */
export const PLAN_RUN_VIEWS = Object.freeze(['live', 'history']);

/**
 * A retired tab id -> where its address goes now.
 *
 * Shared rather than client-local for the same reason `PLAN_TABS` is: these ids
 * are in bookmarks, in handoff prose, and in push payloads minted by servers
 * older than this build. `insights` is a HEAD, not a tab — the analysis numbers
 * became the Insights destination, so that redirect leaves the plan page
 * entirely and carries `?plan=` to keep which plan it was about. The other two
 * are tabs of this page.
 *
 * A value naming a head is spelled with no leading `#/`; the caller builds the
 * URL (`shell/redirects.ts` `planTabRedirect`), because only it knows the slug and
 * how to encode it. `view` is the half of a tab an address meant — the same
 * device `?focus=` was for Now's bands (`?bay=` on the Tower since 6.0), and
 * the reason `#/plan/x/raw` does not quietly become "the prose reading of x".
 * @type {Readonly<Record<string, {tab?: string, head?: string, view?: string}>>}
 */
export const LEGACY_PLAN_TABS = Object.freeze({
  // The prose reading and the byte reading of one file: one tab, one switch.
  overview: Object.freeze({ tab: 'source' }),
  raw: Object.freeze({ tab: 'source', view: 'raw' }),
  // Velocity, completions, spend, ETA — the estate-wide questions, which is
  // where they answer better than on one plan.
  analysis: Object.freeze({ head: 'insights' }),
  // Three lists of the same phases, folded into the one table (6.0). The
  // server still MINTS `#/plan/:slug/route` (`server/push/catalogue.ts`), so
  // this entry is load-bearing for every plan push already on a phone.
  route: Object.freeze({ tab: 'phases', view: 'map' }),
  // QA and Handoffs are one reading since 2026-10-20 (Tower strips): a
  // phase's handoff and its QA verdict are halves of one record.
  qa: Object.freeze({ tab: 'phases', view: 'handoffs' }),
  handoffs: Object.freeze({ tab: 'phases', view: 'handoffs' }),
});

/**
 * A retired Settings section id -> the section that answers its question now.
 *
 * Shared for the same reason `LEGACY_PLAN_TABS` is, and one reason more: the
 * SERVER mints `#/settings/...` into push payloads and webhook bodies
 * (`server/webhooks.ts`), so a card sitting on a phone right now can carry an
 * id this build no longer has. A section id is an address, and an address that
 * stops resolving is a bug reported months later as "the notification does
 * nothing".
 *
 * The three moves, all from the Phase 7 regrouping (minimal → advanced):
 *
 * - `general` — its three answers (what directory is being read, the engine
 *   behind every status, the keys) are the first things anyone needs, so they
 *   lead Essentials rather than sitting in a section named after nothing.
 * - `alerts` — the section is about NOTIFICATIONS, which is the word every
 *   other surface uses (the bell, the drawer, `notifications.jsonl`, the push
 *   catalogue). "Alerts" was a fourth word for one thing.
 * - `process` — what it actually holds is this INSTANCE: which one is running,
 *   how it is reached, and the two buttons that end it. `process` named the
 *   implementation; `instance` names the thing an operator has.
 * @type {Readonly<Record<string, string>>}
 */
export const LEGACY_SETTINGS_SECTIONS = Object.freeze({
  general: 'essentials',
  alerts: 'notifications',
  process: 'instance',
});

/**
 * Guide section ids — the segment of `#/guide/:section`. The guide is rebuilt as
 * deep-linkable tabbed sections (replacing the single long scroll); `mobile` is the
 * dedicated phone-setup section. Deep links to these must survive a reload.
 *
 * `running` is how you START the console; `run` is what a run then DOES. They
 * were one 183-line section until the split, and the id stayed with the install
 * half because that is where the launcher prompt lives. `concepts` must remain
 * first — it is the section an unknown id falls back to.
 *
 * 6.0 (control-tower phase 32) adds a section per thing a person meets that no
 * section explained: `quick-start` (the one screen that starts a run),
 * `destinations` (every page on the rail and every overlay), `tower` (the Runs home), `halts` (a run that stopped itself, and the one press back),
 * and — Pro — `supervisor` and `license`; 8.0 (one-pool phase 32) adds — Pro — `accounts` (the
 * kinds, the keys, the pool and its policies, the caps, the picker and Insights ▸ Accounts); 9.0 (measured-console
 * phase 28) adds `settings` (Settings ▸ Skills & plugins and Settings ▸ Hooks), and phase 31 `insights` (Logs ▸ Health
 * over time and — Pro — Insights ▸ Tokens & cache and the trend). Every id has a Persian twin beside its
 * English file (`<id>.fa.md`); `test/guide-coverage.test.ts` holds both.
 * @type {readonly string[]}
 */
export const GUIDE_SECTIONS = Object.freeze([
  'concepts',
  'quick-start',
  'running',
  'destinations',
  'tower',
  'run',
  'autopilot',
  'halts',
  'sessions',
  'notifications',
  'your-turn',
  'permissions',
  'mcp',
  'settings',
  'insights',
  'mobile',
  'troubleshooting',
  'reference',
]);

/**
 * True when `head` is a registered top-level route head.
 * @param {string} head
 * @returns {boolean}
 */
export function isRouteHead(head) {
  return ROUTE_HEADS.includes(head);
}
