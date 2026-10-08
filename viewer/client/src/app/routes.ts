/**
 * The route vocabulary, as data — no React, no lazy chunks, no DOM.
 *
 * `router.tsx` owns the *registry* (which head renders which lazily-loaded
 * page) because that half cannot exist without React. Everything a caller
 * needs in order to BUILD a URL or to ask what a URL means lives here, so the
 * shell, the palette, the nav and their tests can import it for a few hundred
 * bytes instead of pulling the whole view graph in behind a `lazy()`.
 *
 * Three ideas hold the 3.0 URL space together:
 *
 * 1. **Seven destinations, many heads.** `DESTINATIONS` is what the rail and
 *    the tab bar offer — six in 3.0, plus `repo` and `debug` in 4.0, less `now`
 *    in 6.0, when the Tower on `#/runs` became the home and Now a redirect.
 *    `ROUTE_HEADS` is every head that still resolves — which is a much longer
 *    list, because a head that ever appeared in a bookmark, a push payload or a
 *    handoff never stops working. `destinationFor()` is the mapping between
 *    them, and it is why `#/plan/x/run` lights up *Plans* and `#/terminal/abc`
 *    lights up *Sessions*.
 *
 *    The two new heads take no `DESTINATION_OF` entry and no redirect: nothing
 *    was absorbed to make them, so there is no older address to keep lit or to
 *    move. They are their own destination, which is the default.
 *
 * 2. **A redirect is a page whose new home already exists.** `#/ready` and
 *    `#/pulse` joined the list in Phase 8, when Now grew the sections that
 *    answered them — each becomes a redirect in the phase that builds its
 *    destination, never before, because a redirect onto a home that does not
 *    exist yet is a broken link with extra steps. `#/mcp` was still a page for
 *    exactly that reason until Phase 11 gave Settings its eight addressed
 *    sections; it is an alias now, and `#/settings/mcp` is the page.
 *
 * 3. **The three overlays are query parameters, not routes.** `?k=` (command
 *    palette), `?help=` (help sheet) and `?bell=` (announcements drawer) ride on
 *    top of whatever page you are on, so ⌘K from the Runs page does not throw
 *    the Runs page away. That also makes all three deep-linkable and reloadable
 *    for free, which is what lets `#/search?q=…`, `#/guide/:section` and
 *    `#/notifications` retire into them without losing a single old link.
 *
 * 4. **`?bay=` and `?panel=` say WHERE ON a page, not which page.** The Tower
 *    is six bays and the bell drawer is two panels, so an address that could
 *    only name the route lost the half of the old page's meaning that mattered:
 *    `#/ready` was never "the home page", it was "the part of it about what to
 *    start next". Both are plain query values on the destination — see
 *    `runsBayOf` and `PANEL_KEYS` — which keeps them deep-linkable, reloadable
 *    and, unlike a hash fragment, composable with the overlays above. Now's
 *    `?focus=` was the same device for its four bands; `FOCUS_KEYS` survives
 *    only to translate an old address into the bay that took its question.
 */

import {
  DEFAULT_HEAD,
  DESTINATIONS,
  LEGACY_PLAN_TABS,
  LEGACY_SETTINGS_SECTIONS,
  ROUTE_HEADS,
} from '@shared/route-meta.js';
import {
  handoffHref,
  laneHref,
  navigate,
  parseHash,
  phaseHref,
  phaseSessionHref,
  planHref,
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
  sessionsHref,
  toHash,
};

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
  // Your turn is a head under Runs (control-tower phase 137): the Runs badge
  // and the situation line are how a person gets there, so it is what stays
  // lit — and the old answer page's address keeps it lit while it redirects.
  turn: 'runs',
  approve: 'runs',
  // Everything Now answered is the Tower's since 6.0 (control-tower phase 21),
  // Now included: its head keeps Runs lit for the instant its redirect runs.
  now: 'runs',
  ready: 'runs',
  pulse: 'runs',
  notifications: 'runs',
  dashboard: 'runs',
  search: 'runs',
  guide: 'runs',
  stats: 'insights',
  mcp: 'settings',
  // Both retired INTO Sessions in Phase 10. They stay mapped rather than
  // dropped: `destinationFor` answers for a head, and a head that ever appeared
  // in a bookmark or a push payload never stops resolving — the redirect below
  // is what moves the address, this is what keeps the nav lit while it does.
  terminal: 'sessions',
  agent: 'sessions',
};

/** Which of the seven a head belongs to — `undefined` for the chromeless picker. */
export function destinationFor(head: string | undefined): string | undefined {
  if (!head) return DEFAULT_HEAD;
  if (head === 'source') return undefined;
  const mapped = DESTINATION_OF[head] ?? head;
  return (DESTINATIONS as readonly string[]).includes(mapped) ? mapped : DEFAULT_HEAD;
}

/* ---------------- redirects ---------------- */

const enc = encodeURIComponent;

/**
 * head → where it goes instead, given the whole route (the query and the deeper
 * segments are usually the point: a search term, a guide section, a plan).
 *
 * Every one of these is a head whose destination EXISTS today. See the header.
 */
export const REDIRECTS: Record<string, (route: Route) => string> = {
  // 6.2 (control-tower phase 137): the phone answer page is Your turn. A push
  // minted before it says `#/approve?step=<id>` — that is the item, so it lands
  // on `#/turn/<id>`, in one hop, with whatever else rode on the address.
  approve: (route) => {
    const query = { ...route.query };
    delete query.step;
    const search = new URLSearchParams(query).toString();
    return `${turnHref(route.query.step)}${search ? `?${search}` : ''}`;
  },
  // 6.0 (control-tower phase 21): the Tower on `#/runs` absorbed Now's bands in
  // phase 20, so Now's address is the Tower's — each `?focus=` becomes the bay
  // that holds the same things, and whatever else rode on the address (an
  // overlay, above all) rides on. See `nowRedirect`.
  now: (route) => nowRedirect(route),
  // `dashboard` is what Now was called before 3.0, so it goes where Now goes.
  dashboard: (route) => nowRedirect(route),
  // The search page is the palette now. `?q=` was its term; `?k=` is the
  // palette's, and it opens pre-filled with it.
  search: (route) => paletteHref(route.query.q ?? '', DEFAULT_HEAD),
  // The guide page is the help sheet. `#/guide/mobile?card=tailscale` keeps
  // both halves of its address.
  guide: (route) => helpHref(route.segments[1], route.query.card, DEFAULT_HEAD),
  // Statistics is Insights; `?plan=` is the one parameter it carried.
  stats: (route) => (route.query.plan ? `insights?plan=${enc(route.query.plan)}` : 'insights'),
  // The announcements are the bell drawer. The settings half of the old page is
  // still a page (`#/notifications/settings`), so only the BARE head redirects
  // — `redirectTarget` below is what enforces that. `panel` names the half of
  // the drawer this address always meant: the LOG of what was announced, not
  // the list of what is still waiting.
  notifications: () => bellHref(DEFAULT_HEAD, PANEL_KEYS.announcements),
  // The departures board was Now's Next up and the Pulse its Running now
  // (phase 8); both are bays of the Tower since 6.0. They take the same
  // translation Now's own address does, in one hop — the server still mints
  // `#/ready` into every "ready" push.
  ready: (route) => nowRedirect(route, FOCUS_KEYS.next),
  pulse: (route) => nowRedirect(route, FOCUS_KEYS.lanes),
  // Phase 10: two pages became one, and a session's KIND is read off the
  // record rather than out of the URL — so both deep links keep their id and
  // land on the same page. With no id each meant "start one of my kind", which
  // `?new=` preserves: dropping it would send someone who asked for a shell to
  // a list, and dropping the launcher would lose the four choices that have to
  // exist before an agent pty does. Same rule as `#/ready` → `?focus=next`.
  terminal: (route) => sessionsOrNew(route, 'shell'),
  agent: (route) => sessionsOrNew(route, 'agent'),
  // Phase 11: Settings became eight addressed sections, so the two pages it had
  // not absorbed move into it. The MCP page's second SEGMENT becomes a query
  // value — `#/settings/:section` is the address space now, and a section that
  // could also own a sub-path would let every section invent its own
  // vocabulary. `?tab=` keeps the half of the old address that meant something,
  // the `#/ready` → `?focus=next` rule.
  mcp: (route) => (route.segments[1] === 'catalog' ? 'settings/mcp?tab=catalog' : 'settings/mcp'),
};

/**
 * The two pages Settings absorbed in Phase 11, as a note for the next reader:
 * `#/mcp[/catalog]` → `#/settings/mcp[?tab=catalog]` above, and
 * `#/notifications/settings` → `#/settings/notifications` in `redirectTarget` (it is
 * the only redirect that depends on a head's DEPTH, so it cannot live in the
 * table, which is keyed on the head alone).
 */
const NOTIFICATION_SETTINGS_HOME = 'settings/notifications';

/**
 * A retired settings section's address today, or `null` if this is not one.
 *
 * The section-level twin of `planTabRedirect`, and it exists for a sharper
 * reason: the server itself mints `#/settings/<section>` into push payloads
 * and webhook bodies, so an id this build retired can arrive from a card
 * already sitting on somebody's phone. Redirecting rather than resolving
 * quietly is the `#/plan/x/raw` rule — the address bar must end up saying
 * where the page actually is, or the next reload has to resolve it again and
 * the URL can never be copied.
 *
 * The vocabulary is `LEGACY_SETTINGS_SECTIONS` in `shared/route-meta.js`,
 * shared because the server reads the same file.
 */
export function settingsSectionRedirect(route: Route): string | null {
  if (route.segments[0] !== 'settings') return null;
  const section = route.segments[1];
  if (!section) return null;
  const to = (LEGACY_SETTINGS_SECTIONS as Record<string, string | undefined>)[section];
  return to ? `settings/${to}` : null;
}

/** `#/terminal/abc` → `#/sessions/abc`; bare `#/terminal` → `#/sessions?new=shell`. */
function sessionsOrNew(route: Route, kind: 'agent' | 'shell'): string {
  const id = route.segments[1];
  return id ? `sessions/${enc(id)}` : `sessions?new=${kind}`;
}

/**
 * A retired plan tab's address today, or `null` if this is not one.
 *
 * Three of the seven 3.0 tabs retired, and their ids are in bookmarks, in
 * handoff prose and in push payloads minted by servers older than this build.
 * The vocabulary is `LEGACY_PLAN_TABS` in `shared/route-meta.js` (the server
 * reads the same file); the URL is built here, because only the client knows
 * the slug came out of a hash and has to go back into one encoded.
 *
 * `analysis` is the one that leaves the page: its numbers are the Insights
 * destination's whole subject, so it carries `?plan=` rather than dropping
 * which plan it was about — the same parameter `#/stats?plan=` has always used.
 */
interface LegacyPlanTab {
  tab?: string;
  head?: string;
  view?: string;
}

export function planTabRedirect(route: Route): string | null {
  if (route.segments[0] !== 'plan') return null;
  const [, slug, tab] = route.segments;
  if (!slug || !tab) return null;
  const to = (LEGACY_PLAN_TABS as Record<string, LegacyPlanTab | undefined>)[tab];
  if (!to) return null;
  if (to.head === 'insights') return insightsHref(slug);
  if (!to.tab) return null;
  // The rest of the address rides along (control-tower phase 23): `#/plan/x/qa?report=4`
  // is an open report sheet, and a redirect that kept the view and dropped the
  // sheet would land somewhere near what was asked for rather than on it.
  const query = [
    ...(to.view ? [`view=${enc(to.view)}`] : []),
    ...Object.entries(route.query ?? {})
      .filter(([key]) => key !== 'view')
      .map(([key, value]) => `${enc(key)}=${enc(value)}`),
  ];
  return planHref(slug, to.tab) + (query.length ? `?${query.join('&')}` : '');
}

/**
 * Where this route actually goes, or `null` if it is already there.
 *
 * `notifications` is the one head whose redirect depends on its depth:
 * `#/notifications` is the retired inbox and becomes the bell drawer, while
 * `#/notifications/settings` — a real page until Phase 11 — is now Settings ▸
 * Alerts. Two destinations for one head is why this cannot be a table entry.
 *
 * `plan` is a page, not an alias — so its redirect is asked about the SECOND
 * segment. A retired tab has to be caught here rather than inside the plan view,
 * or the address bar keeps saying `#/plan/x/raw` while the page shows Source,
 * and the next reload has to resolve it again.
 */
export function redirectTarget(route: Route): string | null {
  const head = route.segments[0];
  if (!head) return null;
  if (head === 'plan') return planTabRedirect(route);
  // Settings is a page too, so — like `plan` — its redirect is asked about the
  // SECOND segment. Phase 7 renamed three sections; the old ids are live in
  // bookmarks and in payloads the server minted before this build.
  if (head === 'settings') return settingsSectionRedirect(route);
  // `#/notifications` is the retired inbox and becomes the drawer; the deeper
  // `#/notifications/settings` was a real page until Phase 11 folded it into
  // Settings ▸ Notifications. Both now redirect, to different places.
  if (head === 'notifications' && route.segments.length > 1) return NOTIFICATION_SETTINGS_HOME;
  const to = REDIRECTS[head];
  return to ? to(route) : null;
}

/* ---------------- Now, retired into the Tower ---------------- */

/**
 * Now's four bands, as its `?focus=` spelled them — kept so an old address can
 * be translated, never to build a new one.
 *
 * The vocabulary is closed for the reason it always was: a value nobody
 * recognises is a silently ignored deep link, the defect class of
 * `#/plan/x/autopilot` (a tab registered as `run` that every approval
 * notification opened wrong for the life of that feature).
 */
export const FOCUS_KEYS = { inbox: 'inbox', lanes: 'lanes', next: 'next', plans: 'plans' } as const;

export type FocusKey = (typeof FOCUS_KEYS)[keyof typeof FOCUS_KEYS];

/** Which of Now's bands this route asks for, or `undefined`. An unknown value is ignored. */
export function focusOf(route: Route): FocusKey | undefined {
  const value = route.query.focus;
  return (Object.values(FOCUS_KEYS) as string[]).includes(value ?? '') ? (value as FocusKey) : undefined;
}

/**
 * Where each of Now's bands went (control-tower phases 20–21): its inbox is the
 * Needs-you bay, its lanes the Live bay, its Next up the Ready-to-start bay —
 * and its fourth, the plans in flight, is the Plans destination's whole list.
 */
const FOCUS_HOME: Record<FocusKey, { head: string; bay?: RunsBay }> = {
  inbox: { head: 'runs', bay: 'needs-you' },
  lanes: { head: 'runs', bay: 'live' },
  next: { head: 'runs', bay: 'ready' },
  plans: { head: 'plans' },
};

/**
 * `#/now[?focus=…]` in 6.0's address space — the Tower, on the bay that took
 * the band's question, with every other query value carried as it was.
 *
 * `focus` names the band when the address itself does not: `#/ready` and
 * `#/pulse` meant a band of Now, and take the same translation in one hop
 * rather than chaining through `#/now` (a redirect onto a redirect is a loop
 * waiting to be written — `router.test.tsx`). Carrying the rest is the
 * overlay rule: `?k=`, `?help=` and `?bell=` sit ON a page, and the page they
 * sat on moved.
 */
function nowRedirect(route: Route, focus: FocusKey | undefined = focusOf(route)): string {
  const home = focus ? FOCUS_HOME[focus] : { head: DEFAULT_HEAD };
  const query: Record<string, string> = home.bay ? { bay: home.bay } : {};
  for (const [key, value] of Object.entries(route.query ?? {})) if (key !== 'focus') query[key] = value;
  const search = new URLSearchParams(query).toString();
  return `#/${home.head}${search ? `?${search}` : ''}`;
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

/* ---------------- href builders ---------------- */

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
 * The third reader of the same shape as `focusOf`/`panelOf`, and here for the
 * same reason they are: a lane was component state, so the pane an operator
 * was pointed at could not be linked to. `#/plan/<slug>/run?lane=p7` now
 * addresses it, and the tab strip still owns the CHOICE — this only supplies
 * the opening one, so clicking another tab does not rewrite the URL.
 *
 * Returns the PHASE NUMBER, not the raw `p7`: the tab id is `features/runs`'
 * spelling (`laneId`) and it is that module's business, while a phase number
 * is the thing every caller actually has. An unparseable or absent value is
 * `undefined`, exactly as an unknown `focus` is — a URL is user input and a
 * bad one must not select something arbitrary.
 *
 * (There is an unrelated `laneOf` on the runner's own loop, `server/runner/
 * runner-loop.ts`. Different layer, never imported together; the plan named
 * this one and the route readers all live here.)
 */
export function laneOf(route: Route): number | undefined {
  const match = /^p(\d{1,4})$/.exec(route.query.lane ?? '');
  if (!match) return undefined;
  const phase = Number(match[1]);
  return Number.isInteger(phase) && phase >= 0 ? phase : undefined;
}

/**
 * Which shape `#/runs` opens in — `?view=board` or `?view=table`.
 *
 * The FOURTH reader of the `focusOf`/`panelOf`/`laneOf` shape, and here for
 * exactly their reason: the fleet section's shape is a persisted preference,
 * so without an address for it a link could not point at the board. The
 * palette's "Freeze all" is the caller that needs one — it navigates rather
 * than firing, and landing on the table would land beside no Freeze all at
 * all. An unknown value is `undefined` (the preference decides), never a guess.
 */
export const RUNS_VIEWS = { board: 'board', table: 'table' } as const;

export type RunsView = (typeof RUNS_VIEWS)[keyof typeof RUNS_VIEWS];

export function runsViewOf(route: Route): RunsView | undefined {
  const value = route.query.view;
  return (Object.values(RUNS_VIEWS) as string[]).includes(value ?? '') ? (value as RunsView) : undefined;
}

/**
 * Which bay of the Tower `#/runs` opens on — `?bay=needs-you`, `live`,
 * `waiting`, `queued`, `ready` or `settled` (control-tower phase 20).
 *
 * The FIFTH reader of the `focusOf` shape, and its vocabulary is closed the
 * same way — but it is not written here: the words ARE the Tower's bays
 * (`BAYS`, the leaf `shared/bays.js` — never `status-model.js`, which first
 * paint must not carry), so an address can name exactly the bays
 * the page draws and a bay added there is addressable the same day. The named
 * bay is scrolled to and, when it is folded (Settled), opened. It implies the
 * Tower: `?bay=` on a stored `table` preference draws the Tower for that visit,
 * exactly as `?view=board` does. An unknown value is ignored, never guessed at.
 * Now's `?focus=inbox`, `lanes` and `next` land here since phase 21
 * (`nowRedirect`).
 */
export type RunsBay = (typeof BAYS)[number];

export function runsBayOf(route: Route): RunsBay | undefined {
  const value = route.query.bay;
  return (BAYS as readonly string[]).includes(value ?? '') ? (value as RunsBay) : undefined;
}

export const runsBayHref = (bay: RunsBay): string => `#/runs?bay=${enc(bay)}`;

export const runsHref = (view?: RunsView): string => (view ? `#/runs?view=${enc(view)}` : '#/runs');
export const plansHref = (): string => '#/plans';
/** The whole queue of this console (control-tower phase 99, #135). */
export const queueHref = (): string => '#/queue';
/** Your turn (control-tower phase 137) — the page, or one item on it, expanded. */
export const turnHref = (item?: string | null): string => (item ? `#/turn/${enc(item)}` : '#/turn');
export const insightsHref = (plan?: string): string => (plan ? `#/insights?plan=${enc(plan)}` : '#/insights');
export const settingsHref = (section?: string): string =>
  section ? `#/settings/${enc(section)}` : '#/settings';
export const runHref = (slug: string): string => planHref(slug, 'run');

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
  const query = typeof base === 'string' ? {} : { ...base.query };
  // Never stack two overlays: opening one closes the others, which is also
  // what pressing its key while another is up should do.
  for (const k of Object.values(OVERLAY_KEYS)) delete query[k];
  query[key] = value;
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v == null || v === '') delete query[k];
    else query[k] = v;
  }
  const search = new URLSearchParams(query).toString();
  return `#/${path}${search ? `?${search}` : ''}`;
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
  const query = { ...route.query };
  for (const k of Object.values(OVERLAY_KEYS)) delete query[k];
  // `card` is the help sheet's second half and `panel` is the drawer's; neither
  // has any meaning without the overlay it belongs to, and a `?panel=` left on
  // the address after the drawer closes is a parameter that reopens nothing and
  // survives every later navigation.
  delete query.card;
  delete query.panel;
  // The bell drawer's announcement filters — same rule as `panel`: they have
  // no meaning without the overlay they filter.
  delete query.unread;
  delete query.category;
  const search = new URLSearchParams(query).toString();
  return `#/${route.path}${search ? `?${search}` : ''}`;
}

/** Which overlay this route asks for, if any. `''` is a value — an open, empty palette. */
export function openOverlay(route: Route): 'palette' | 'help' | 'bell' | null {
  if (route.query[OVERLAY_KEYS.palette] != null) return 'palette';
  if (route.query[OVERLAY_KEYS.help] != null) return 'help';
  if (route.query[OVERLAY_KEYS.bell] != null) return 'bell';
  return null;
}

