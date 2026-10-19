/**
 * Every address this console ever had, and where it lands today — in ONE hop,
 * with its query and its deeper segments carried.
 *
 * A redirect is a page whose new home already exists: `#/ready` and `#/pulse`
 * joined when Now grew the sections that answered them, `#/mcp` when Settings
 * got its addressed sections, `#/now` when the Runs home took Now's bands,
 * `#/approve` when Your turn took the phone answer page, and `#/debug` in 7.0,
 * when Debug became Logs. Each entry is a function of the WHOLE route, because
 * the query and the deeper segments are usually the point: a search term, a
 * guide section, a plan, a log filter. A redirect onto a redirect is a loop
 * waiting to be written, so every entry names a page (`router.test.tsx`).
 *
 * Nothing here spells `#/`: every address comes from a builder in `./routes`.
 */

import {
  DEFAULT_HEAD,
  LEGACY_PLAN_TABS,
  LEGACY_SETTINGS_SECTIONS,
  PLAN_VIEW_ALIASES,
} from '@shared/route-meta.js';
import {
  PANEL_KEYS,
  bellHref,
  helpHref,
  hrefOf,
  insightsHref,
  logsHref,
  paletteHref,
  planHref,
  sessionsHref,
  sessionsNewHref,
  settingsHref,
  turnHref,
  type Route,
  type RunsBay,
} from './routes';

/* ---------------- Now, retired into the Runs home ---------------- */

/**
 * Now's four bands, as its `?focus=` spelled them — kept so an old address can
 * be translated, never to build a new one. The vocabulary is closed: a value
 * nobody recognises is a silently ignored deep link.
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
 * Needs-you group, its lanes the Live group, its Next up the Ready-to-start
 * group — and its fourth, the plans in flight, is the Plans destination.
 */
const FOCUS_HOME: Record<FocusKey, { head: string; group?: RunsBay }> = {
  inbox: { head: 'runs', group: 'needs-you' },
  lanes: { head: 'runs', group: 'live' },
  next: { head: 'runs', group: 'ready' },
  plans: { head: 'plans' },
};

/**
 * `#/now[?focus=…]` in today's address space — the Runs home, on the group that
 * took the band's question (`?group=`, 7.0's word), with every other query
 * value carried as it was. `#/ready` and `#/pulse` name their band and take
 * the same translation.
 */
function nowRedirect(route: Route, focus: FocusKey | undefined = focusOf(route)): string {
  const home = focus ? FOCUS_HOME[focus] : { head: DEFAULT_HEAD };
  const query: Record<string, string> = home.group ? { group: home.group } : {};
  for (const [key, value] of Object.entries(route.query ?? {})) if (key !== 'focus') query[key] = value;
  return hrefOf(home.head, query);
}

/**
 * `#/queue` (control-tower phase 99) is the Queued group of the Runs home since
 * 7.0 (quiet-console phase 7): every run waiting for a scope or a slot, with
 * the queue's own facts on each row. The head stays in the vocabulary — the
 * server and the palette still spell it — and lands here in one hop. That is
 * the FREE answer: in Pro the Queue is a page again (one-pool phase 40), so the
 * table below loses the row and the router draws the page.
 */
export function queueRedirect(route: Route): string {
  return hrefOf(DEFAULT_HEAD, { group: 'queued', ...route.query });
}

/** `#/terminal/abc` → `#/sessions/abc`; bare `#/terminal` → `#/sessions?new=shell`. */
function sessionsOrNew(route: Route, kind: 'agent' | 'shell'): string {
  const id = route.segments[1];
  return id ? sessionsHref(id) : sessionsNewHref(kind);
}

/* ---------------- the table ---------------- */

/**
 * head → where it goes instead, given the whole route. Every one of these is a
 * head whose destination EXISTS today.
 */
export const REDIRECTS: Record<string, (route: Route) => string> = {
  // 6.2 (control-tower phase 137): the phone answer page is Your turn. A push
  // minted before it says `#/approve?step=<id>` — that is the item, so it lands
  // on `#/turn/<id>`, in one hop, with whatever else rode on the address.
  approve: (route) => {
    const query = { ...route.query };
    delete query.step;
    return hrefOf(turnHref(route.query.step), query);
  },
  // 6.0 (control-tower phase 21): the Runs home absorbed Now's bands, so Now's
  // address is its — each `?focus=` becomes the group that holds the same
  // things, and whatever else rode on the address rides on.
  now: (route) => nowRedirect(route),
  // 7.0 (quiet-console phase 7): the queue page is the Queued group of the home.
  queue: queueRedirect,
  // `dashboard` is what Now was called before 3.0, so it goes where Now goes.
  dashboard: (route) => nowRedirect(route),
  // The search page is the palette now. `?q=` was its term; `?k=` is the
  // palette's, and it opens pre-filled with it.
  search: (route) => paletteHref(route.query.q ?? '', DEFAULT_HEAD),
  // The guide page is the help sheet. `#/guide/mobile?card=tailscale` keeps
  // both halves of its address.
  guide: (route) => helpHref(route.segments[1], route.query.card, DEFAULT_HEAD),
  // Statistics is Insights; `?plan=` is the one parameter it carried.
  stats: (route) => insightsHref(route.query.plan),
  // The announcements are the bell drawer. The settings half of the old page is
  // still a page (`#/notifications/settings`), so only the BARE head redirects
  // — `redirectTarget` below is what enforces that. `panel` names the half of
  // the drawer this address always meant: the LOG of what was announced.
  notifications: () => bellHref(DEFAULT_HEAD, PANEL_KEYS.announcements),
  // The departures board was Now's Next up and the Pulse its Running now; both
  // are groups of the Runs home. One hop — the server still mints `#/ready`.
  ready: (route) => nowRedirect(route, FOCUS_KEYS.next),
  pulse: (route) => nowRedirect(route, FOCUS_KEYS.lanes),
  // Phase 10: two pages became one, and a session's KIND is read off the
  // record rather than out of the URL — so both deep links keep their id. With
  // no id each meant "start one of my kind", which `?new=` preserves.
  terminal: (route) => sessionsOrNew(route, 'shell'),
  agent: (route) => sessionsOrNew(route, 'agent'),
  // Phase 11: the MCP page's second SEGMENT becomes a query value —
  // `#/settings/:section` is the address space, and `?tab=` keeps the half of
  // the old address that meant something.
  // Its query rides along (one-pool phase 19, #363: `#/mcp?tab=catalog` used
  // to land on Registered).
  mcp: (route) =>
    hrefOf(settingsHref('mcp'), {
      ...route.query,
      ...(route.segments[1] === 'catalog' ? { tab: 'catalog' } : {}),
    }),
  // 7.0 (quiet-console phase 3): Debug became Logs. The section and every
  // filter ride along — `#/debug/health?since=1` is `#/logs/health?since=1`,
  // and bare `#/debug?source=console` is `#/logs?source=console`.
  debug: (route) => logsHref(route.segments[1], route.query),
};


/**
 * A retired settings section's address today, or `null` if this is not one.
 *
 * The server itself mints `#/settings/<section>` into push payloads and
 * webhook bodies, so an id this build retired can arrive from a card already
 * sitting on somebody's phone. The vocabulary is `LEGACY_SETTINGS_SECTIONS` in
 * `shared/route-meta.js`, shared because the server reads the same file.
 */
export function settingsSectionRedirect(route: Route): string | null {
  if (route.segments[0] !== 'settings') return null;
  const section = route.segments[1];
  if (!section) return null;
  const to = (LEGACY_SETTINGS_SECTIONS as Record<string, string | undefined>)[section];
  return to ? settingsHref(to) : null;
}

interface LegacyPlanTab {
  tab?: string;
  head?: string;
  view?: string;
}

/**
 * A retired plan tab's address today, or `null` if this is not one.
 *
 * The vocabulary is `LEGACY_PLAN_TABS` in `shared/route-meta.js`; the address
 * is built here, because only the client knows the slug came out of a hash and
 * has to go back into one encoded. `analysis` is the one that leaves the page:
 * its numbers are the Insights destination's whole subject, so it carries
 * `?plan=` rather than dropping which plan it was about. The rest of the
 * address rides along: `#/plan/x/qa?report=4` is an open report sheet.
 */
export function planTabRedirect(route: Route): string | null {
  if (route.segments[0] !== 'plan') return null;
  const [, slug, tab] = route.segments;
  if (!slug || !tab) return null;
  const to =
    (LEGACY_PLAN_TABS as Record<string, LegacyPlanTab | undefined>)[tab] ??
    (PLAN_VIEW_ALIASES as Record<string, LegacyPlanTab | undefined>)[tab];
  if (!to) return null;
  if (to.head === 'insights') return insightsHref(slug);
  if (!to.tab) return null;
  const query: Record<string, string> = {};
  if (to.view) query.view = to.view;
  for (const [key, value] of Object.entries(route.query ?? {})) if (key !== 'view') query[key] = value;
  return hrefOf(planHref(slug, to.tab), query);
}

/** `#/notifications/settings` — a real page until Phase 11, now Settings ▸ Notifications. */
const NOTIFICATION_SETTINGS = 'notifications';

/**
 * Where this route actually goes, or `null` if it is already there.
 *
 * `plan` and `settings` are pages, not aliases — so their redirects are asked
 * about the SECOND segment. `notifications` is the one head whose redirect
 * depends on its depth: bare, it is the retired inbox and becomes the bell
 * drawer; deeper, it is Settings ▸ Notifications. Two destinations for one head
 * is why that one cannot be a table entry.
 */
export function redirectTarget(route: Route): string | null {
  const head = route.segments[0];
  if (!head) return null;
  if (head === 'plan') return planTabRedirect(route);
  if (head === 'settings') return settingsSectionRedirect(route);
  if (head === 'notifications' && route.segments.length > 1) return settingsHref(NOTIFICATION_SETTINGS);
  const to = REDIRECTS[head];
  return to ? to(route) : null;
}
