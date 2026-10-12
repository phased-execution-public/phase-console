/**
 * The route-registry guard, and the address space it serves.
 *
 * `ROUTE_HEADS` is shared with the server: `server/push/catalogue.ts` builds
 * every notification deep link from the same vocabulary, and the Node suite
 * asserts each `routeFor` destination is a member of it. This test closes the
 * other half — that each member actually resolves here. Without both, a head can
 * be renamed on one side and a push notification opens a blank page, which is
 * exactly the failure that stays invisible until someone taps one.
 *
 * A head is either a page or a redirect, so the assertions walk the whole table
 * and then follow every redirect to the page it lands on — because a redirect
 * onto a head that does not exist is the same broken link as a missing view,
 * and a redirect onto another redirect is a loop waiting to be written.
 *
 * Nothing here spells an expected address by hand: every one is a builder's
 * answer from `./routes` (the one file that spells `#/`), and the builders are
 * pinned against the shared normaliser and `parseHash` in the last blocks. The
 * INPUTS are spelled out, because they are what arrives from outside — a
 * bookmark, a push payload, a handoff's prose.
 *
 * The pages' chunks are stubbed (`@/screens/settings` stands in for every page,
 * and each entry's preload is watched): what is asserted is which chunk a head
 * is wired to, not what the page draws.
 */

import { Suspense } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BAYS } from '@shared/bays.js';
import { LEGACY_PLAN_TABS, LEGACY_SETTINGS_SECTIONS, PLAN_TABS, ROUTE_HEADS } from '@shared/route-meta.js';
import { LOGS_SECTIONS, logsSectionHref, logsSectionOf } from '@/screens/logs/routes';
import { REDIRECTS } from './redirects';
import {
  CHROMELESS_HEADS,
  DEFAULT_HEAD,
  DESTINATIONS,
  FULL_HEIGHT_HEADS,
  MemoryRouterProvider,
  ROUTE_TABLE,
  destinationFor,
  preloadView,
  redirectTarget,
  resolveEntry,
  resolveHead,
  resolveView,
  useNavigate,
  useRoute,
} from './router';
import {
  OVERLAY_KEYS,
  bellHref,
  closeOverlaysHref,
  helpHref,
  hrefOf,
  insightsHref,
  laneOf,
  locksViewOf,
  logsHref,
  openOverlay,
  ownsHeight,
  paletteHref,
  panelOf,
  parseHash,
  phaseSessionHref,
  planHref,
  planViewHref,
  plansHref,
  queueHref,
  repoHref,
  runHref,
  runsBayHref,
  runsBayOf,
  runsHref,
  runsViewOf,
  searchOf,
  sessionsHref,
  sessionsLocksHref,
  sessionsNewHref,
  settingsHref,
  sourceHref,
  toHash,
  turnHref,
  withQuery,
  type Route,
} from './routes';

// The Settings screen stands in for every page: a one-line page that says what
// it was handed, so this file never imports a real screen's chunk to render.
vi.mock('@/screens/settings', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ route }: { route: { path: string } }) =>
      createElement('p', null, `the settings page at ${route.path || '(root)'}`),
  };
});
// The directory picker's chunk fails to load, as a chunk does when the build
// it came from has been replaced: what a failed preload must survive.
vi.mock('@/screens/settings/source', () => {
  throw new Error('offline');
});

const at = (hash: string): Route => parseHash(hash) as Route;
const headOf = (address: string): string | undefined => at(address).segments[0];
/** Every page entry's preload, watched and stubbed: which chunk a head would fetch, never the fetch. */
function watchPreloads() {
  return Object.fromEntries(
    Object.entries(ROUTE_TABLE).flatMap(([head, entry]) =>
      entry.kind === 'page' ? [[head, vi.spyOn(entry, 'preload').mockImplementation(() => {})] as const] : [],
    ),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the route table', () => {
  it('has an entry for every shared route head', () => {
    const missing = (ROUTE_HEADS as readonly string[]).filter((head) => !(head in ROUTE_TABLE));
    expect(missing, `heads with no entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('holds nothing the shared vocabulary does not declare', () => {
    const extra = Object.keys(ROUTE_TABLE).filter(
      (head) => !(ROUTE_HEADS as readonly string[]).includes(head),
    );
    expect(extra, `entries with no head: ${extra.join(', ')}`).toEqual([]);
  });

  it('makes every page a lazy component', () => {
    for (const [head, entry] of Object.entries(ROUTE_TABLE)) {
      if (entry.kind !== 'page') continue;
      // React marks lazy components with this tag; a plain object would render
      // as nothing and only fail once someone navigated there.
      expect((entry.lazy as unknown as { $$typeof: symbol }).$$typeof, head).toBe(Symbol.for('react.lazy'));
    }
  });

  it('makes every destination, and the chromeless picker, a page', () => {
    for (const head of [...DESTINATIONS, ...CHROMELESS_HEADS]) {
      expect(ROUTE_TABLE[head]?.kind, head).toBe('page');
    }
  });

  it('loads every page from a screen of its own — no old page is left (quiet-console phase 21)', () => {
    // Each page entry preloads exactly its own chunk, never a neighbour's.
    const preloads = watchPreloads();
    for (const head of Object.keys(preloads)) {
      preloadView(head);
      expect(preloads[head], head).toHaveBeenCalledTimes(1);
    }
    for (const spy of Object.values(preloads)) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('renders the page a head names, handed the route, through its lazy chunk', async () => {
    const View = resolveView('settings')!;
    render(
      <Suspense fallback={null}>
        <View route={at(hrefOf('settings/deeper'))} />
      </Suspense>,
    );
    expect(await screen.findByText('the settings page at settings/deeper')).toBeTruthy();
  });

  it('sends the empty hash and any unknown head to Runs, the home since 6.0', () => {
    // Control-tower phase 21: the Tower answers "does anything need me?", so
    // it is where an address that says nothing — or nothing this build knows —
    // lands. Now is a redirect onto it.
    expect(DEFAULT_HEAD).toBe('runs');
    expect(resolveHead(undefined)).toBe('runs');
    expect(resolveHead('')).toBe('runs');
    expect(resolveHead('nope')).toBe('runs');
    expect(resolveHead('logs')).toBe('logs');
    expect(resolveEntry('nope')).toBe(ROUTE_TABLE.runs);
    expect(resolveView('')).toBe(resolveView('runs'));
    expect(resolveView('nope')).toBe(resolveView('runs'));
    expect(ROUTE_TABLE.runs!.kind).toBe('page');
    expect(ROUTE_TABLE.now!.kind).toBe('redirect');
  });

  it('answers null — never a guess — for the view of a redirect head', () => {
    // A caller that gets null should have followed `redirectTarget` first; the
    // shell does, and a blank frame with a stack trace beats a silently wrong
    // page.
    for (const head of Object.keys(REDIRECTS)) expect(resolveView(head), head).toBeNull();
    expect(resolveView('logs')).toBeTruthy();
    expect(resolveView('sessions')).toBeTruthy();
  });

  it('preloads nothing for a redirect head, and the home for an unknown one', () => {
    const preloads = watchPreloads();
    for (const head of Object.keys(REDIRECTS)) preloadView(head);
    for (const spy of Object.values(preloads)) expect(spy).not.toHaveBeenCalled();
    // An unknown head is the home's address, so it is the home's chunk that goes out.
    preloadView('nope');
    expect(preloads[DEFAULT_HEAD]).toHaveBeenCalledTimes(1);
    const others = Object.entries(preloads).filter(([head]) => head !== DEFAULT_HEAD);
    for (const [head, spy] of others) expect(spy, head).not.toHaveBeenCalled();
  });

  it('swallows a preload that fails — the render asks again and reports it there', async () => {
    // A preload is a head start, never a claim: a failed chunk must not become
    // an unhandled rejection on every navigation. (Vitest fails the run on one.)
    expect(ROUTE_TABLE.source!.kind).toBe('page');
    expect(() => preloadView('source')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('takes its redirects from shell/redirects.ts, every one of them', () => {
    const redirects = Object.entries(ROUTE_TABLE).filter(([, entry]) => entry.kind === 'redirect');
    expect(redirects.map(([head]) => head).sort()).toEqual(Object.keys(REDIRECTS).sort());
    for (const [head, entry] of redirects) {
      expect(entry.kind === 'redirect' && entry.to, head).toBe(REDIRECTS[head]);
    }
  });
});

describe('the redirects — one hop, with what the old address said', () => {
  it('lands every redirect on a page that is not itself a redirect, in every shape', () => {
    // Bare, deeper and with a query: each must land on a page in ONE hop. A
    // redirect onto a redirect is a loop waiting to be written.
    for (const head of Object.keys(REDIRECTS)) {
      for (const address of [
        hrefOf(head),
        hrefOf(`${head}/abc`),
        hrefOf(head, { q: 'cart', focus: 'inbox', step: 's1', card: 'c', plan: 'demo', since: '1' }),
      ]) {
        const target = redirectTarget(at(address));
        expect(target, address).toBeTruthy();
        expect(ROUTE_TABLE[resolveHead(headOf(target!))]?.kind, `${address} → ${target}`).toBe('page');
        expect(redirectTarget(at(target!)), `${address} → ${target} → ?`).toBeNull();
      }
    }
  });

  it('moves Debug to Logs, carrying the section and every filter (7.0)', () => {
    expect(redirectTarget(at('#/debug'))).toBe(logsHref());
    expect(redirectTarget(at('#/debug/health?since=1'))).toBe(logsHref('health', { since: '1' }));
    expect(redirectTarget(at('#/debug?source=console'))).toBe(logsHref(undefined, { source: 'console' }));
    // The explorer IS the Logs page — it has no segment of its own.
    expect(redirectTarget(at('#/debug/logs?level=error'))).toBe(logsHref(undefined, { level: 'error' }));
    expect(ROUTE_TABLE.debug!.kind).toBe('redirect');
    expect(ROUTE_TABLE.logs!.kind).toBe('page');
    expect(redirectTarget(at('#/logs/health?since=1'))).toBeNull();
  });

  it('makes every Logs section an address, and lands each #/debug/<section>?q on it in one hop', () => {
    for (const { id } of LOGS_SECTIONS) {
      const address = logsSectionHref(id, { slug: 'demo', q: 'merge' });
      // The section is the address's own: read back from the path, never a tab held in state.
      expect(logsSectionOf(at(address).segments[1]), address).toBe(id);
      expect(redirectTarget(at(address)), address).toBeNull();
      const old = id === 'logs' ? '#/debug?slug=demo&q=merge' : `#/debug/${id}?slug=demo&q=merge`;
      expect(redirectTarget(at(old)), old).toBe(address);
    }
    // A segment Logs does not know is the explorer, never a dead link.
    expect(logsSectionOf('nonsense')).toBe('logs');
  });

  it('lands Now on the Runs home, each band on the group that answers its question (6.0; `?group=` since 7.0)', () => {
    // Push payloads minted by older servers carry `#/now` (the digest) and
    // `#/ready`; both still land where they meant.
    expect(redirectTarget(at('#/now'))).toBe(runsHref());
    expect(redirectTarget(at('#/now?focus=inbox'))).toBe(runsBayHref('needs-you'));
    expect(redirectTarget(at('#/now?focus=lanes'))).toBe(runsBayHref('live'));
    expect(redirectTarget(at('#/now?focus=next'))).toBe(runsBayHref('ready'));
    // The fourth band was the plans in flight — Plans answers that one.
    expect(redirectTarget(at('#/now?focus=plans'))).toBe(plansHref());
    // A focus this build never had is ignored, never guessed at.
    expect(redirectTarget(at('#/now?focus=portfolio'))).toBe(runsHref());
    // An overlay rides along: `?k=`, `?help=` and `?bell=` sit ON a page, and
    // the page they sat on moved.
    expect(redirectTarget(at('#/now?k=cart'))).toBe(paletteHref('cart'));
    expect(redirectTarget(at('#/now?focus=inbox&bell=1&panel=inbox'))).toBe(
      hrefOf('runs', { group: 'needs-you', bell: '1', panel: 'inbox' }),
    );
    expect(redirectTarget(at('#/now?focus=plans&help=run'))).toBe(helpHref('run', undefined, 'plans'));
    // The grid's address is untouched — `?view=all` opens it, and so does the
    // 6.x `?view=table`, read as an alias — and a view that rode on Now rides
    // on exactly as it was spelled.
    expect(redirectTarget(at('#/runs?view=all'))).toBeNull();
    expect(redirectTarget(at('#/runs?view=table'))).toBeNull();
    expect(redirectTarget(at('#/now?view=all'))).toBe(runsHref('all'));
    expect(redirectTarget(at('#/now?view=table'))).toBe(hrefOf('runs', { view: 'table' }));
    // `dashboard` is what Now was called before 3.0, so it goes where Now goes.
    expect(redirectTarget(at('#/dashboard'))).toBe(runsHref());
    expect(redirectTarget(at('#/'))).toBeNull(); // the empty hash is the default head, not a redirect
  });

  it('sends the departures board and the Pulse to their groups', () => {
    expect(redirectTarget(at('#/ready'))).toBe(runsBayHref('ready'));
    expect(redirectTarget(at('#/pulse'))).toBe(runsBayHref('live'));
  });

  it('lands the queue page on the Queued group of the home, carrying its query (7.0)', () => {
    // Control-tower phase 99's `#/queue` is the home's Queued group since 7.0
    // (quiet-console phase 7). The head stays in the vocabulary — the server
    // and the palette still spell it — and lands in one hop.
    expect(ROUTE_TABLE.queue!.kind).toBe('redirect');
    expect(redirectTarget(at('#/queue'))).toBe(queueHref());
    expect(redirectTarget(at('#/queue'))).toBe(runsBayHref('queued'));
    expect(redirectTarget(at('#/queue?k=cart'))).toBe(hrefOf('runs', { group: 'queued', k: 'cart' }));
    expect(redirectTarget(at(queueHref()))).toBeNull();
  });

  it('lands #/approve and a push’s #/approve?step=<id> on Your turn (6.2)', () => {
    expect(redirectTarget(at('#/approve'))).toBe(turnHref());
    expect(redirectTarget(at('#/approve?step=abc'))).toBe(turnHref('abc'));
    expect(redirectTarget(at('#/approve?step=a%2Fb'))).toBe(turnHref('a/b'));
    // An overlay that rode on the old address rides on.
    expect(redirectTarget(at('#/approve?step=s1&k=cart'))).toBe(hrefOf(turnHref('s1'), { k: 'cart' }));
  });

  it('opens the announcements as one panel of the bell drawer, and the old settings half as a section', () => {
    // The one head whose redirect depends on its DEPTH. The bare address was
    // the announcement log; the deeper one was the device register and
    // preferences, and is a Settings section now.
    expect(redirectTarget(at('#/notifications'))).toBe(bellHref(DEFAULT_HEAD, 'announcements'));
    expect(redirectTarget(at('#/notifications'))).toBe(hrefOf('runs', { bell: '1', panel: 'announcements' }));
    expect(redirectTarget(at('#/notifications/settings'))).toBe(settingsHref('notifications'));
  });

  it('folds the MCP page into Settings, keeping which half of it you asked for', () => {
    expect(redirectTarget(at('#/mcp'))).toBe(settingsHref('mcp'));
    expect(redirectTarget(at('#/mcp/catalog'))).toBe(hrefOf(settingsHref('mcp'), { tab: 'catalog' }));
  });

  it('retires both terminal heads into Sessions, keeping the session id — or the intent', () => {
    // `#/agent/<id>` is in bookmarks, in handoff prose and in push payloads
    // minted by older servers, and the id is the whole address.
    expect(redirectTarget(at('#/terminal/x'))).toBe(sessionsHref('x'));
    expect(redirectTarget(at('#/agent/abc123'))).toBe(sessionsHref('abc123'));
    // With no id each meant "start one of MY kind".
    expect(redirectTarget(at('#/terminal'))).toBe(sessionsNewHref('shell'));
    expect(redirectTarget(at('#/agent'))).toBe(sessionsNewHref('agent'));
    expect(resolveEntry('terminal').kind).toBe('redirect');
    expect(resolveEntry('agent').kind).toBe('redirect');
  });

  it('turns the search page into the palette and the guide into the help sheet', () => {
    expect(redirectTarget(at('#/search?q=foo'))).toBe(paletteHref('foo'));
    expect(redirectTarget(at('#/search?q=cart%20api'))).toBe(hrefOf('runs', { k: 'cart api' }));
    expect(redirectTarget(at('#/search'))).toBe(paletteHref());
    // Both halves of a guide address survive.
    expect(redirectTarget(at('#/guide/mobile?card=tailscale'))).toBe(helpHref('mobile', 'tailscale'));
    expect(redirectTarget(at('#/guide/mobile?card=tailscale'))).toBe(
      hrefOf('runs', { help: 'mobile', card: 'tailscale' }),
    );
  });

  it('sends Statistics to Insights with the one parameter it carried', () => {
    expect(redirectTarget(at('#/stats?plan=x'))).toBe(insightsHref('x'));
    expect(redirectTarget(at('#/stats'))).toBe(insightsHref());
  });

  it('sends a retired Settings section to the one that answers its question', () => {
    // The server mints `#/settings/<section>` into push payloads and webhook
    // bodies, so a retired id can arrive from a card already on a phone.
    expect(redirectTarget(at('#/settings/general'))).toBe(settingsHref('essentials'));
    for (const [old, now] of Object.entries(LEGACY_SETTINGS_SECTIONS)) {
      const target = redirectTarget(at(settingsHref(old)));
      expect(target, old).toBe(settingsHref(now));
      expect(redirectTarget(at(target!)), `${old} → ${now} → ?`).toBeNull();
    }
    expect(redirectTarget(at('#/settings'))).toBeNull();
    expect(redirectTarget(at('#/settings/essentials'))).toBeNull();
  });

  it('sends a retired plan TAB where it went, keeping what the address meant', () => {
    // `plan` is a page, not a redirect, so its redirect is about the SECOND
    // segment — caught here so the address bar never goes on saying `/raw`.
    expect(redirectTarget(at('#/plan/demo/overview'))).toBe(planHref('demo', 'source'));
    expect(redirectTarget(at('#/plan/demo/raw'))).toBe(hrefOf(planHref('demo', 'source'), { view: 'raw' }));
    // Analysis left the plan page entirely; `?plan=` is which plan it was about.
    expect(redirectTarget(at('#/plan/demo/analysis'))).toBe(insightsHref('demo'));
    // A slug that needs encoding survives the round trip as ONE segment.
    const encoded = redirectTarget(at('#/plan/a%2Fb/raw'))!;
    expect(encoded).toBe(hrefOf(planHref('a/b', 'source'), { view: 'raw' }));
    expect(at(encoded).segments).toEqual(['plan', 'a/b', 'source']);
  });

  it('folds the three phase lists into views of the one table, carrying the rest of the address', () => {
    // The server still mints `#/plan/:slug/route`, so that one is load-bearing.
    expect(redirectTarget(at('#/plan/demo/route'))).toBe(planViewHref('demo', 'map'));
    expect(redirectTarget(at('#/plan/demo/handoffs'))).toBe(planViewHref('demo', 'handoffs'));
    // An open report sheet survives the move — `?report=` rides along.
    expect(redirectTarget(at('#/plan/demo/qa?report=3%3A2'))).toBe(
      hrefOf(planHref('demo', 'phases'), { view: 'qa', report: '3:2' }),
    );
  });

  it('answers every retired tab of the shared table, in one hop', () => {
    for (const [tab, to] of Object.entries(LEGACY_PLAN_TABS)) {
      const target = redirectTarget(at(planHref('demo', tab)));
      expect(target, tab).toBeTruthy();
      const landed = at(target!);
      if (to.head) {
        expect(landed.segments, tab).toEqual([to.head]);
        expect(landed.query.plan, tab).toBe('demo');
      } else {
        expect(landed.segments, tab).toEqual(['plan', 'demo', to.tab]);
        expect(landed.query.view, tab).toBe(to.view);
      }
      expect(redirectTarget(landed), `${tab} → ${target} → ?`).toBeNull();
    }
  });

  it('leaves a LIVE plan tab, and the phase/handoff detail routes, exactly where they are', () => {
    for (const tail of [...PLAN_TABS, 'phase/3', 'handoff/2']) {
      expect(redirectTarget(at(hrefOf(`plan/demo/${tail}`))), tail).toBeNull();
    }
    expect(redirectTarget(at('#/plan/demo'))).toBeNull();
  });
});

describe('every old deep link still resolves', () => {
  // The plan's exit list, the shapes `routeFor` builds with an id, and the
  // addresses 6.2 and 7.0 retired.
  const OLD = [
    '#/',
    '#/now',
    '#/now?focus=inbox',
    '#/now?focus=lanes',
    '#/now?focus=next',
    '#/now?focus=plans',
    '#/dashboard',
    '#/ready',
    '#/pulse',
    '#/notifications',
    '#/notifications/settings',
    '#/agent',
    '#/agent/abc123',
    '#/terminal',
    '#/terminal/abc123',
    '#/mcp',
    '#/mcp/catalog',
    '#/stats',
    '#/stats?plan=alpha',
    '#/search?q=cart',
    '#/guide/mobile?card=tailscale',
    '#/approve',
    '#/approve?step=human-step-1',
    '#/debug',
    '#/debug/health?since=1',
    '#/settings/general',
    '#/source',
    '#/plans',
    '#/plan/alpha/run',
    '#/plan/alpha/phase/8',
    '#/plan/alpha/route',
    '#/runs',
    // The 6.x spellings of where on the home: read as aliases, never a redirect.
    '#/runs?bay=live',
    '#/runs?view=table',
    '#/turn/human-step-1',
    '#/queue',
    '#/logs',
    '#/settings',
  ];

  it('ends on a page in at most one hop, never on the fallback by accident', () => {
    for (const hash of OLD) {
      const parsed = at(hash);
      const target = redirectTarget(parsed);
      const head = target ? headOf(target) : parsed.segments[0];
      // Registered outright — the fallback to Runs is for heads nobody knows.
      if (head) expect(ROUTE_TABLE, hash).toHaveProperty([head]);
      expect(ROUTE_TABLE[resolveHead(head)]?.kind, hash).toBe('page');
      if (target) expect(redirectTarget(at(target)), `${hash} → ${target} → ?`).toBeNull();
    }
  });
});

describe('what the navigation lights up', () => {
  it('keeps a plan under Plans and a session page under Sessions', () => {
    expect(destinationFor('plan')).toBe('plans');
    // The one the old registry could not express: a terminal deep link used to
    // light up nothing at all, because `terminal` was not a nav entry.
    expect(destinationFor('terminal')).toBe('sessions');
    expect(destinationFor('agent')).toBe('sessions');
  });

  it('lights Runs for every address Now answered, Your turn and the queue, and for the empty hash', () => {
    for (const head of [
      'now',
      'ready',
      'pulse',
      'dashboard',
      'notifications',
      'search',
      'guide',
      'turn',
      'approve',
      'queue',
    ]) {
      expect(destinationFor(head), head).toBe('runs');
    }
    expect(destinationFor(undefined)).toBe('runs');
    expect(destinationFor('')).toBe('runs');
    expect(DESTINATIONS as readonly string[]).not.toContain('now');
  });

  it('lights the place each retired head moved into', () => {
    expect(destinationFor('debug')).toBe('logs');
    expect(destinationFor('stats')).toBe('insights');
    expect(destinationFor('mcp')).toBe('settings');
  });

  it('lights nothing for the chromeless picker, and the home for a head nobody knows', () => {
    expect(destinationFor('source')).toBeUndefined();
    expect(destinationFor('nope')).toBe(DEFAULT_HEAD);
  });

  it('lights every destination for itself', () => {
    for (const head of DESTINATIONS) expect(destinationFor(head), head).toBe(head);
  });

  it('names one of the seven for every head but the picker', () => {
    for (const head of ROUTE_HEADS as readonly string[]) {
      const destination = destinationFor(head);
      if (head === 'source') {
        expect(destination).toBeUndefined();
        continue;
      }
      expect(DESTINATIONS as readonly string[], head).toContain(destination);
    }
  });

  it('keeps Your turn a lazy head that lights Runs — never an eighth destination (6.2)', () => {
    expect(resolveEntry('turn').kind).toBe('page');
    expect(resolveView('turn')).toBeTruthy();
    expect(DESTINATIONS as readonly string[]).not.toContain('turn');
    // The item's address is the head and the id — no redirect, it is the page.
    expect(redirectTarget(at(turnHref()))).toBeNull();
    expect(redirectTarget(at(turnHref('human-step-1')))).toBeNull();
    expect(at(turnHref('human-step-1')).segments).toEqual(['turn', 'human-step-1']);
  });

  it('gives Sessions the full height, and every other place the one scroller', () => {
    expect(FULL_HEIGHT_HEADS.has('sessions')).toBe(true);
    for (const head of DESTINATIONS.filter((id) => id !== 'sessions')) {
      expect(FULL_HEIGHT_HEADS.has(head), head).toBe(false);
      expect(ownsHeight(at(hrefOf(head))), head).toBe(false);
    }
    expect(CHROMELESS_HEADS.has('source')).toBe(true);
  });

  it('gives Sessions its height only while a session is open (quiet-console phase 15)', () => {
    // The terminal scrolls itself; the list, the locks and the launch door are
    // pages on the one scroller, where the grid's virtualizer can work.
    expect(ownsHeight(at(sessionsHref('pty-1')))).toBe(true);
    expect(ownsHeight(at(sessionsHref()))).toBe(false);
    expect(ownsHeight(at(sessionsLocksHref()))).toBe(false);
    expect(ownsHeight(at(sessionsLocksHref('history')))).toBe(false);
    expect(ownsHeight(at(sessionsNewHref('agent')))).toBe(false);
  });
});

describe('the memory router', () => {
  function Probe() {
    const here = useRoute();
    const go = useNavigate();
    return (
      <button type="button" onClick={() => go('plans')}>
        {here.path || '(root)'}
      </button>
    );
  }

  it('renders at a route and moves without touching the address bar', () => {
    const before = window.location.hash;
    const onNavigate = vi.fn();
    render(
      <MemoryRouterProvider initial={planHref('alpha', 'run')} onNavigate={onNavigate}>
        <Probe />
      </MemoryRouterProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('plan/alpha/run');

    fireEvent.click(screen.getByRole('button'));
    expect(onNavigate).toHaveBeenCalledWith(plansHref());
    expect(screen.getByRole('button')).toHaveTextContent('plans');
    expect(window.location.hash).toBe(before);
  });

  it('starts at the home when it is told nothing', () => {
    render(
      <MemoryRouterProvider>
        <Probe />
      </MemoryRouterProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('runs');
  });
});

describe('the readers — where ON a page, never which page', () => {
  it('reads the phase number a lane tab is spelled with', () => {
    expect(laneOf(at('#/plan/demo/run?lane=p7'))).toBe(7);
    expect(laneOf(at('#/plan/demo/run?lane=p0'))).toBe(0);
    expect(laneOf(at('#/plan/demo/run?lane=p123'))).toBe(123);
  });

  it('ignores a lane it cannot read, exactly as an unknown focus is ignored', () => {
    // A URL is user input. A bad one must not select an arbitrary lane.
    for (const hash of [
      '#/plan/demo/run',
      '#/plan/demo/run?lane=',
      '#/plan/demo/run?lane=7', // the `p` is the spelling, not decoration
      '#/plan/demo/run?lane=phase-7',
      '#/plan/demo/run?lane=p-1',
      '#/plan/demo/run?lane=p99999', // wider than any plan; not a lane id
      '#/plan/demo/run?lane=p7x',
    ]) {
      expect(laneOf(at(hash)), hash).toBeUndefined();
    }
  });

  it('round-trips what `phaseSessionHref` builds', () => {
    const href = phaseSessionHref({ slug: 'demo', phase: 9, live: { via: 'run' } })!;
    expect(laneOf(at(href))).toBe(9);
  });

  it('reads the Runs view, group and drawer panel from their closed vocabularies only', () => {
    expect(runsViewOf(at(runsHref('all')))).toBe('all');
    expect(runsViewOf(at(runsHref('groups')))).toBe('groups');
    // The 6.x words are read as aliases — a bookmark or a stored preference
    // that spells them still lands — and never written again (7.0).
    expect(runsViewOf(at(hrefOf('runs', { view: 'table' })))).toBe('all');
    expect(runsViewOf(at(hrefOf('runs', { view: 'board' })))).toBe('groups');
    expect(runsViewOf(at(hrefOf('runs', { view: 'grid' })))).toBeUndefined();
    for (const bay of BAYS) expect(runsBayOf(at(runsBayHref(bay))), bay).toBe(bay);
    // `?bay=` is the 6.x spelling, which the server still mints into pushes.
    expect(runsBayOf(at(hrefOf('runs', { bay: 'live' })))).toBe('live');
    expect(runsBayOf(at(hrefOf('runs', { group: 'inbox' })))).toBeUndefined();
    expect(runsBayOf(at(hrefOf('runs', { bay: 'inbox' })))).toBeUndefined();
    expect(panelOf(at(bellHref(DEFAULT_HEAD, 'inbox')))).toBe('inbox');
    expect(panelOf(at(bellHref(DEFAULT_HEAD, 'announcements')))).toBe('announcements');
    expect(panelOf(at(hrefOf('runs', { bell: '1', panel: 'other' })))).toBeUndefined();
  });
});

describe('one spelling — hrefOf and the builders', () => {
  it('writes the query in the wire’s encoding: an absent value dropped, an EMPTY one kept', () => {
    expect(searchOf({ a: '1', b: null, c: undefined, d: '' })).toBe('a=1&d=');
    expect(searchOf({ q: 'cart api', n: 3 })).toBe('q=cart+api&n=3');
    expect(searchOf({})).toBe('');
  });

  it('agrees with the shared normaliser the server and `navigate` use', () => {
    expect(hrefOf('logs/health')).toBe(toHash('logs/health'));
    expect(hrefOf('runs', { k: '' })).toBe(toHash('runs?k='));
    expect(hrefOf('runs', { group: 'live', k: 'x y' })).toBe(toHash('runs?group=live&k=x+y'));
  });

  it('never doubles the prefix, and adds no `?` for an empty query', () => {
    expect(hrefOf(hrefOf('plans'))).toBe(hrefOf('plans'));
    expect(hrefOf('/plans')).toBe(hrefOf('plans'));
    expect(hrefOf('runs', {})).toBe(hrefOf('runs'));
    expect(hrefOf('runs', { a: null, b: undefined })).toBe(hrefOf('runs'));
  });

  it('round-trips through parseHash', () => {
    expect(parseHash(hrefOf('logs/health', { since: '1', q: 'a b' }))).toEqual({
      segments: ['logs', 'health'],
      query: { since: '1', q: 'a b' },
      path: 'logs/health',
    });
  });

  it('replaces a route’s query with `withQuery`, keeping its path', () => {
    expect(withQuery(at('#/runs?group=live'), { view: 'all' })).toBe(hrefOf('runs', { view: 'all' }));
    expect(withQuery(at('#/plan/demo/run?lane=p4'), {})).toBe(hrefOf('plan/demo/run'));
  });

  it('builds every place’s address from the one spelling', () => {
    expect(logsHref()).toBe(hrefOf('logs'));
    expect(logsHref('logs')).toBe(hrefOf('logs'));
    expect(logsHref('health', { since: '1' })).toBe(hrefOf('logs/health', { since: '1' }));
    expect(repoHref()).toBe(hrefOf('repo'));
    expect(repoHref('issues', { repo: 'a/b' })).toBe(hrefOf('repo/issues', { repo: 'a/b' }));
    expect(sessionsNewHref('shell')).toBe(hrefOf('sessions', { new: 'shell' }));
    expect(sessionsNewHref('agent')).toBe(hrefOf('sessions', { new: 'agent' }));
    expect(sessionsLocksHref()).toBe(hrefOf('sessions/locks'));
    // The ledger is the section's second view, an address — never a tab in component state.
    expect(sessionsLocksHref('history')).toBe(hrefOf('sessions/locks', { view: 'history' }));
    expect(locksViewOf(at(sessionsLocksHref('history')))).toBe('history');
    expect(locksViewOf(at(hrefOf('sessions/locks', { view: 'board' })))).toBe('held');
    expect(turnHref()).toBe(hrefOf('turn'));
    expect(at(turnHref('a/b')).segments).toEqual(['turn', 'a/b']);
    expect(runsBayHref('needs-you')).toBe(hrefOf('runs', { group: 'needs-you' }));
    expect(runsHref()).toBe(hrefOf('runs'));
    expect(runsHref('all')).toBe(hrefOf('runs', { view: 'all' }));
    expect(runsHref('groups')).toBe(hrefOf('runs', { view: 'groups' }));
    expect(plansHref()).toBe(hrefOf('plans'));
    // The whole queue is the home's Queued group since 7.0.
    expect(queueHref()).toBe(hrefOf('runs', { group: 'queued' }));
    expect(insightsHref()).toBe(hrefOf('insights'));
    expect(insightsHref('x')).toBe(hrefOf('insights', { plan: 'x' }));
    expect(settingsHref()).toBe(hrefOf('settings'));
    expect(settingsHref('mcp')).toBe(hrefOf('settings/mcp'));
    expect(sourceHref()).toBe(hrefOf('source'));
    expect(runHref('x')).toBe(planHref('x', 'run'));
  });
});

describe('the three overlays — query parameters, never routes', () => {
  it('are the palette, the help sheet and the bell', () => {
    expect(OVERLAY_KEYS).toEqual({ palette: 'k', help: 'help', bell: 'bell' });
  });

  it('open ON the page you are on, after its own query', () => {
    // `#/runs?group=live` opens its palette as `…?group=live&k=` — the address
    // stays readable as the page it is on.
    expect(paletteHref('', at(runsBayHref('live')))).toBe(hrefOf('runs', { group: 'live', k: '' }));
    expect(helpHref('mobile', 'tailscale', at(plansHref()))).toBe(
      hrefOf('plans', { help: 'mobile', card: 'tailscale' }),
    );
    expect(bellHref(at(plansHref()), 'inbox')).toBe(hrefOf('plans', { bell: '1', panel: 'inbox' }));
    // Without a page, they sit on the home.
    expect(paletteHref('x')).toBe(hrefOf('runs', { k: 'x' }));
    expect(helpHref()).toBe(hrefOf('runs', { help: '' }));
    expect(bellHref()).toBe(hrefOf('runs', { bell: '1' }));
  });

  it('never stack two: opening one closes the others', () => {
    const cases = [
      ['palette', paletteHref('x', at('#/plans?help=run&bell=1'))],
      ['help', helpHref('mobile', undefined, at('#/plans?k=x&bell=1'))],
      ['bell', bellHref(at('#/plans?k=x&help=run'))],
    ] as const;
    for (const [overlay, href] of cases) {
      const route = at(href);
      expect(openOverlay(route), href).toBe(overlay);
      const open = Object.values(OVERLAY_KEYS).filter((key) => key in route.query);
      expect(open, href).toHaveLength(1);
      expect(route.path, href).toBe('plans');
    }
  });

  it('drop an empty help card rather than spell `card=`', () => {
    expect(helpHref('mobile', '', at(plansHref()))).toBe(hrefOf('plans', { help: 'mobile' }));
  });

  it('close together, taking their halves with them and leaving the page’s own query', () => {
    expect(
      closeOverlaysHref(
        at('#/runs?group=live&k=x&help=a&card=b&bell=1&panel=inbox&unread=1&category=c&view=all'),
      ),
    ).toBe(hrefOf('runs', { group: 'live', view: 'all' }));
    expect(closeOverlaysHref(at(plansHref()))).toBe(plansHref());
  });

  it('say which is open — and an empty value is a value: `?k=` is an open, empty palette', () => {
    expect(openOverlay(at('#/runs?k='))).toBe('palette');
    expect(openOverlay(at('#/runs?help='))).toBe('help');
    expect(openOverlay(at('#/runs?bell=1'))).toBe('bell');
    expect(openOverlay(at('#/runs?group=live'))).toBeNull();
  });
});

