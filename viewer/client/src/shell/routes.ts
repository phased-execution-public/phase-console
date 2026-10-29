/**
 * The route vocabulary, as data — no React, no lazy chunks, no DOM.
 *
 * `app/routes.ts` until 7.0 (quiet-console phase 3); `router.tsx` owns the
 * *registry* (which head renders which lazily loaded page) because that half
 * cannot exist without React. Everything a caller needs in order to BUILD an
 * address or to ask what one means lives here, and **this is the one file
 * that spells `#/`** — the boundary lint refuses the literal anywhere else in
 * `client/src` but the tests, so a renamed head is renamed in one place
 * (`hrefOf`).
 *
 * The ideas that hold the URL space together, unchanged since 3.0:
 *
 * 1. **Eight destinations, many heads.** `DESTINATIONS` is what the rail and
 *    the tab bar offer — the same eight in both editions since 8.0 (`runs turn
 *    plans sessions repo insights logs settings`; 7.0 had seven, and Your turn
 *    became the eighth in one-pool phase 14, #366). `ROUTE_HEADS` is every head that
 *    still resolves, which is a much longer list, because a head that ever
 *    appeared in a bookmark, a push payload or a handoff never stops working.
 *    `destinationFor()` is the mapping between them, and it is why `#/plan/x/run`
 *    lights *Plans*, `#/debug/health` lights *Logs* for the instant its redirect
 *    runs, and `#/fleet` lights *Settings* (the machine, one step wider than
 *    this console).
 *
 * 2. **A redirect is a page whose new home already exists.** `shell/redirects.ts`
 *    holds the table; each entry carries the query and the deeper segments in
 *    one hop, never a chain.
 *
 * 3. **The three overlays are query parameters, not routes.** `?k=` (the
 *    palette), `?help=` (the help sheet) and `?bell=` (the announcements
 *    drawer) ride on top of whatever page you are on, so ⌘K from the Runs page
 *    keeps the Runs page underneath — and all three are deep-linkable and
 *    reloadable for free.
 *
 * 4. **`?bay=`, `?view=`, `?lane=` and `?panel=` say WHERE ON a page, not which
 *    page.** Each has a closed vocabulary and a reader below; an unknown value
 *    is ignored, never guessed at.
 */

import { DEFAULT_HEAD, DESTINATIONS, ROUTE_HEADS } from '@shared/route-meta.js';
import {
  handoffHref,
  laneHref,
  navigate,
  parseHash,
  phaseHref,
  phaseSessionHref,
  planHref,
  planViewHref,
  sessionsHref,
  toHash,
} from '@shared/routes.js';
import { BAYS } from '@shared/bays.js';

/** A parsed hash. The shape every page receives and every helper here reads. */
export interface Route {
  segments: string[];
  query: Record<string, string>;
  path: string;
}

export { DEFAULT_HEAD, DESTINATIONS, ROUTE_HEADS };
/** The pure routing rules, re-exported so a caller needs one import, not two. */
export {
  handoffHref,
  laneHref,
  navigate,
  parseHash,
  phaseHref,
  phaseSessionHref,
  planHref,
  planViewHref,
  sessionsHref,
  toHash,
};

/* ---------------- the one spelling ---------------- */

type Query = Readonly<Record<string, string | number | null | undefined>>;

/**
 * `?a=b&c=d` from a record, in the record's own order — the wire's encoding, so
 * a space is `+` both ways. An absent value (`null`, `undefined`) is dropped; an
 * EMPTY one is kept, because `?k=` is an open, empty palette and a query carried
 * through a redirect must arrive as it was.
 */
export function searchOf(query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/**
 * An address: `#/<path>[?query]`. The one place the hash prefix is written.
 *
 * `path` is the route's own path (`plan/x/run`), with or without a leading
 * `#/` — a builder that is handed another builder's answer must not double it.
 */
export function hrefOf(path: string, query?: Query): string {
  const search = query ? searchOf(query) : '';
  return `#/${path.replace(/^#?\/+/, '')}${search ? `?${search}` : ''}`;
}

/** The same route with its query replaced — what every overlay and redirect builds on. */
export function withQuery(route: Route, query: Query): string {
  return hrefOf(route.path, query);
}

/* ---------------- destinations ---------------- */

/**
 * head → the destination that stays lit while you are on it.
 *
 * A nav that goes dark whenever you go deeper reads as though you have left the
 * app, so every head that is not itself a destination names the one it belongs
 * under. Heads absent from this map are their own destination.
 */
const DESTINATION_OF: Record<string, string> = {
  plan: 'plans',
  // Your turn is a place of its own since one-pool phase 14 (#366); the old
  // answer page's address keeps it lit while it redirects.
  approve: 'turn',
  // The Queue lights Runs in both editions: a head under Runs in Pro (one-pool
  // phase 40), the Runs home's Queued group in Free.
  queue: 'runs',
  // Everything Now answered is the Runs home's since 6.0 (control-tower phase
  // 21), Now included: its head keeps Runs lit for the instant its redirect runs.
  now: 'runs',
  ready: 'runs',
  pulse: 'runs',
  notifications: 'runs',
  dashboard: 'runs',
  search: 'runs',
  guide: 'runs',
  stats: 'insights',
  mcp: 'settings',
  // Debug became Logs in 7.0; the old head lights the new place while it moves.
  debug: 'logs',
  // Both retired INTO Sessions in Phase 10. They stay mapped rather than
  // dropped: `destinationFor` answers for a head, and a head that ever appeared
  // in a bookmark or a push payload never stops resolving — the redirect is
  // what moves the address, this is what keeps the nav lit while it does.
  terminal: 'sessions',
  agent: 'sessions',
};

/** Which of the eight a head belongs to — `undefined` for the chromeless picker. */
export function destinationFor(head: string | undefined): string | undefined {
  if (!head) return DEFAULT_HEAD;
  if (head === 'source') return undefined;
  const mapped = DESTINATION_OF[head] ?? head;
  return (DESTINATIONS as readonly string[]).includes(mapped) ? mapped : DEFAULT_HEAD;
}

/* ---------------- how a page is framed ---------------- */

/**
 * `source` is the pre-open directory picker: it renders INSTEAD of the shell,
 * not inside it, because there is nothing to navigate to until a root is open.
 */
export const CHROMELESS_HEADS: ReadonlySet<string> = new Set(['source']);

/**
 * Views that own their height: the shell gives them a non-scrolling flex column
 * (banner + view sum to the viewport) instead of the one page scroller. A
 * banner used to push a 100%-tall terminal frame down and put the key bar below
 * the fold on every SSE reconnect. Any view rendered under these heads must be
 * flex-aware (`h-full min-h-0`).
 */
export const FULL_HEIGHT_HEADS: ReadonlySet<string> = new Set([
  'sessions',
]);

/**
 * Whether THIS address owns its height. Sessions does only while one session
 * is open on it (`#/sessions/<id>`, quiet-console phase 15): the terminal
 * scrolls itself, and a page that scrolled too would give a phone two
 * scrollers and no way to the prompt. Its list, its locks and its launcher are
 * pages like any other, on the one scroller.
 */
export function ownsHeight(route: Pick<Route, 'segments'>): boolean {
  const [head, id] = route.segments;
  if (!FULL_HEIGHT_HEADS.has(head ?? '')) return false;
  return head !== 'sessions' || (Boolean(id) && id !== 'locks');
}

/* ---------------- the readers ---------------- */

const enc = encodeURIComponent;

/**
 * Which half of the bell drawer.
 *
 * `inbox` is what still needs a person; `announcements` is the log of what the
 * console has said. They were one page in 2.x and they answer completely
 * different questions — which is exactly why `#/notifications` redirects with
 * `announcements` named rather than letting the drawer's default decide.
 */
export const PANEL_KEYS = { inbox: 'inbox', announcements: 'announcements' } as const;

export type PanelKey = (typeof PANEL_KEYS)[keyof typeof PANEL_KEYS];

export function panelOf(route: Route): PanelKey | undefined {
  const value = route.query.panel;
  return (Object.values(PANEL_KEYS) as string[]).includes(value ?? '') ? (value as PanelKey) : undefined;
}

/**
 * Which autopilot lane a run page should open on — `?lane=p7`.
 *
 * Returns the PHASE NUMBER, not the raw `p7`: a phase number is the thing every
 * caller actually has. An unparseable or absent value is `undefined` — a URL is
 * user input and a bad one must not select something arbitrary.
 */
export function laneOf(route: Route): number | undefined {
  const match = /^p(\d{1,4})$/.exec(route.query.lane ?? '');
  if (!match) return undefined;
  const phase = Number(match[1]);
  return Number.isInteger(phase) && phase >= 0 ? phase : undefined;
}

/**
 * Which shape `#/runs` opens in — `?view=groups` (the home) or `?view=all` (the
 * grid of every run). 7.0's words (quiet-console phase 7); the 6.x pair,
 * `board` and `table`, are read as aliases — an address or a stored preference
 * that spells them still lands — and never written again. An unknown value is
 * `undefined` (the preference decides), never a guess.
 */
export const RUNS_VIEWS = { groups: 'groups', all: 'all' } as const;

export type RunsView = (typeof RUNS_VIEWS)[keyof typeof RUNS_VIEWS];

/** The 6.x words, each to the 7.0 word that replaced it. */
const RUNS_VIEW_ALIASES: Readonly<Record<string, RunsView>> = { board: 'groups', table: 'all' };

/** A view word — 7.0's or a 6.x alias — as the 7.0 word, or `undefined` for anything else. */
export function runsViewWord(value: string | undefined): RunsView | undefined {
  if (!value) return undefined;
  if ((Object.values(RUNS_VIEWS) as string[]).includes(value)) return value as RunsView;
  return RUNS_VIEW_ALIASES[value];
}

export function runsViewOf(route: Route): RunsView | undefined {
  return runsViewWord(route.query.view);
}

/**
 * Which group of the Runs home `#/runs` opens on — `?group=needs-you`, `live`,
 * `waiting`, `queued`, `ready` or `settled`. The words ARE the groups (`BAYS`,
 * the leaf `shared/bays.js` — never `status-model.js`, which first paint must
 * not carry). `?bay=` is the 6.x spelling, still read: the server mints it
 * into pushes (`push/catalogue.ts`). An unknown value is ignored, never
 * guessed at.
 */
export type RunsBay = (typeof BAYS)[number];

export function runsBayOf(route: Route): RunsBay | undefined {
  const value = route.query.group ?? route.query.bay;
  return (BAYS as readonly string[]).includes(value ?? '') ? (value as RunsBay) : undefined;
}

/* ---------------- href builders ---------------- */

export const runsBayHref = (bay: RunsBay): string => `#/runs?group=${enc(bay)}`;
export const runsHref = (view?: RunsView): string => (view ? `#/runs?view=${enc(view)}` : '#/runs');
export const plansHref = (): string => '#/plans';
/**
 * Whether `#/queue` is a page (Pro, one-pool phase 40) or the Runs home's Queued
 * group (Free, as since 7.0). One switch, so every caller builds the same address.
 */
const QUEUE = { page: false };
/**
 * The whole queue of this console (control-tower phase 99, #135): in Pro the
 * Queue page, with its view, group, sort and filters (`screens/queue/model.ts`
 * names them; `at` points at one row); in Free the Queued group of the home,
 * where the query has nothing to say.
 */
export const queueHref = (query?: Query): string =>
  QUEUE.page ? hrefOf('queue', query) : runsBayHref('queued');
/** Your turn (control-tower phase 137) — the page, or one item on it, expanded. */
export const turnHref = (item?: string | null): string => (item ? `#/turn/${enc(item)}` : '#/turn');
export const insightsHref = (plan?: string): string => (plan ? `#/insights?plan=${enc(plan)}` : '#/insights');
/** Settings, a section of it, or either with the search (`?q=`) the place answers. */
export const settingsHref = (section?: string, query?: Query): string =>
  hrefOf(section ? `settings/${enc(section)}` : 'settings', query);
export const runHref = (slug: string): string => planHref(slug, 'run');
/**
 * A reading of the plan's Run view (quiet-console phase 11): the live run
 * (no `?view=`), or `history` — every run of the plan, `run` naming the one
 * opened.
 */
export const runViewHref = (slug: string, view: 'live' | 'history' = 'live', run?: string | null): string =>
  hrefOf(planHref(slug, 'run'), { view: view === 'history' ? 'history' : null, run: run ?? null });

/** A pane of the Run view's sessions: the run's own console, one lane's, or the phases still waiting. */
export type RunPane = 'run' | 'waiting' | `p${number}`;

/**
 * One pane of the Run view's sessions (quiet-console phase 12) — `?lane=run`,
 * `?lane=p7` or `?lane=waiting`. The address chooses the pane, so a pick
 * survives a reload and can be linked to; a pane whose lane has gone falls
 * back to the run's own reading where it is read.
 */
export const runPaneHref = (slug: string, pane: RunPane): string =>
  hrefOf(planHref(slug, 'run'), { lane: pane });

/** The pane `?lane=` names, or `undefined` for an absent or unknown value. */
export function runPaneOf(route: Route): RunPane | undefined {
  const lane = route.query.lane ?? '';
  if (lane === 'run' || lane === 'waiting') return lane;
  const phase = laneOf(route);
  return phase !== undefined ? `p${phase}` : undefined;
}
/** The Repo destination, on one of its sections. */
export const repoHref = (section?: string, query?: Query): string =>
  hrefOf(section ? `repo/${enc(section)}` : 'repo', query);
/**
 * Logs (7.0): `#/logs` is the log explorer — the section a person means when
 * they say "the logs" — so `logs` has no segment of its own; every other
 * section is `#/logs/<section>`, with only the query that was asked for.
 */
export const logsHref = (section?: string, query?: Query): string =>
  hrefOf(section && section !== 'logs' ? `logs/${enc(section)}` : 'logs', query);
/** The chromeless directory picker. */
export const sourceHref = (): string => '#/source';
/** Sessions, asked to start one of a kind — the half of `#/terminal`'s address that was intent. */
export const sessionsNewHref = (kind: 'shell' | 'agent'): string => `#/sessions?new=${kind}`;
/**
 * The Locks section's two views (quiet-console phase 15): the claims held now,
 * and the ledger of every claim since (Pro) — `?view=history`, an address and
 * never a tab held in component state. Anything else reads as the claims.
 */
export type LocksView = 'held' | 'map' | 'history';
export const sessionsLocksHref = (view?: LocksView): string =>
  hrefOf('sessions/locks', view === 'history' || view === 'map' ? { view } : undefined);
export const locksViewOf = (route: Pick<Route, 'query'>): LocksView =>
  route.query.view === 'history' ? 'history' : route.query.view === 'map' ? 'map' : 'held';

/* ---------------- the three overlays ---------------- */

/**
 * The query keys the shell watches. Exported because "is an overlay open?" is
 * asked in four places and spelling it out four times is how one of them ends
 * up spelling it differently.
 */
export const OVERLAY_KEYS = { palette: 'k', help: 'help', bell: 'bell' } as const;

/**
 * An overlay's address, ON the page you are already on.
 *
 * `base` is only for the redirects, which arrive from a head that has no page
 * of its own to sit on and therefore have to name one.
 */
function overlayHref(
  key: string,
  value: string,
  base: string | Route,
  extra?: Record<string, string | undefined>,
): string {
  const path = typeof base === 'string' ? base.replace(/^#\/?/, '') : base.path;
  const query: Record<string, string | undefined> = typeof base === 'string' ? {} : { ...base.query };
  // Never stack two overlays: opening one closes the others, which is also
  // what pressing its key while another is up should do.
  for (const k of Object.values(OVERLAY_KEYS)) delete query[k];
  // Appended AFTER the page's own query, so `#/runs?bay=live` opens its palette
  // as `#/runs?bay=live&k=` — the address stays readable as the page it is on.
  query[key] = value;
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v == null || v === '') delete query[k];
    else query[k] = v;
  }
  return hrefOf(path, query);
}

/** `?k=` — the command palette, pre-filled with `term`. */
export const paletteHref = (term = '', base: string | Route = DEFAULT_HEAD): string =>
  overlayHref(OVERLAY_KEYS.palette, term, base);

/** `?help=<section>&card=<card>` — the help sheet. */
export const helpHref = (section?: string, card?: string, base: string | Route = DEFAULT_HEAD): string =>
  overlayHref(OVERLAY_KEYS.help, section ?? '', base, { card });

/** `?bell=1[&panel=…]` — the drawer, optionally on one of its two panels. */
export const bellHref = (base: string | Route = DEFAULT_HEAD, panel?: PanelKey): string =>
  overlayHref(OVERLAY_KEYS.bell, '1', base, panel ? { panel } : undefined);

/** The same route with every overlay closed — what Escape and a backdrop mean. */
export function closeOverlaysHref(route: Route): string {
  const query: Record<string, string | undefined> = { ...route.query };
  for (const k of Object.values(OVERLAY_KEYS)) delete query[k];
  // `card` is the help sheet's second half and `panel` is the drawer's; neither
  // has any meaning without the overlay it belongs to, and a `?panel=` left on
  // the address after the drawer closes is a parameter that reopens nothing and
  // survives every later navigation.
  delete query.card;
  delete query.panel;
  // The bell drawer's announcement filters — same rule as `panel`.
  delete query.unread;
  delete query.category;
  return withQuery(route, query);
}

/** Which overlay this route asks for, if any. `''` is a value — an open, empty palette. */
export function openOverlay(route: Route): 'palette' | 'help' | 'bell' | null {
  if (route.query[OVERLAY_KEYS.palette] != null) return 'palette';
  if (route.query[OVERLAY_KEYS.help] != null) return 'help';
  if (route.query[OVERLAY_KEYS.bell] != null) return 'bell';
  return null;
}

