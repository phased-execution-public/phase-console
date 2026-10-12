/**
 * Logs, the place, and its log explorer (quiet-console phase 20; Debug until
 * 7.0) — ported from 6.x's Debug page test, keeping what the place itself, its
 * lead and the explorer hold. The other sections have tests of their own, as
 * do the level card (`level.test.tsx`), the follow hook (`tail.test.ts`) and
 * the addresses (`routes.test.ts`).
 *
 * The thread through every case is 6.x's, unchanged: **a diagnostics page must
 * never reassure you about the thing that is broken.** A watcher nobody
 * reported on is not "watching". A source the server could not read says so
 * by name rather than contributing silence. A cut answer says it was cut. A
 * typo in the address selects nothing rather than narrowing the page to a word
 * nobody writes, and an unreadable phase or trace is dropped rather than sent.
 * Every filter the address carries is the filter the server is asked, and
 * every control writes the rest of the address back.
 *
 * Mounted as the router mounts it, with the server answering by path, and the
 * shell's panel beside it so a row's door can be followed.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`); every request is logged whole. */
const server = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  calls: [] as string[],
}));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    server.calls.push(path);
    const read = server.reads[path.split('?')[0]!];
    if (read instanceof Error) throw read;
    if (typeof read === 'function') return (read as (path: string) => unknown)(path);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { ConsoleState, DebugEntry, DebugIndex, DebugLevelState } from '@/data/api';
import { ApiError } from '@/data/http';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import { DriveableEventSource } from './driveable-event-source';
import { LogsFacts, watcherReading } from './facts';
import LogsPlace from './index';

/**
 * Below the shell breakpoint while `media.phone` is set. `lib/media` caches
 * each query's list for the whole module, so `matches` is read live.
 */
const media = { phone: false };
window.matchMedia = (query: string) =>
  ({
    media: query,
    get matches() {
      return media.phone && /max-width: 899px/.test(query);
    },
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

/*
 * The explorer's rows live in a `DataList`, which is virtualized. jsdom lays
 * nothing out, so without these the virtualizer measures a zero-height
 * scroller and renders NO rows — every assertion about a line would fail for a
 * reason that has nothing to do with the page. The harness
 * `ui/data-list.test.tsx` documents.
 */
const realRect = HTMLElement.prototype.getBoundingClientRect;
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const realOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      height: 34,
      width: 800,
      top: 0,
      left: 0,
      bottom: 34,
      right: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
});

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
  if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight);
  if (realOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', realOffsetWidth);
});

/* ---------------- the server's answers ---------------- */

/** One trace id: 32 lowercase hex, the only shape `?trace=` accepts. */
const TRACE = '0123456789abcdef0123456789abcdef';

/** `/api/state`, with the watcher in the shape `server/watch.ts` `status()` sends. */
const STATE = {
  root: { path: '/work/pe-hub', label: 'pe-hub', ok: true },
  platform: 'darwin',
  supervisor: { supervised: true, kind: 'launchd', detail: 'the launchd unit com.phase-console' },
  watcher: { healthy: true, watching: 3, expected: 3, failures: 0 },
} as unknown as ConsoleState;

const ROUTE_THREW: DebugEntry = {
  source: 'console',
  at: '2026-09-01T10:00:00.000Z',
  level: 'error',
  event: 'api.unhandled',
  text: 'the route threw',
  data: { path: '/api/x' },
};

const BOARDED: DebugEntry = {
  source: 'journal',
  at: '2026-09-01T09:59:00.000Z',
  level: 'info',
  event: 'phase.boarded',
  text: 'model=opus',
  slug: 'demo',
  runId: 'aaaa1111',
  phase: 2,
  traceId: TRACE,
};

const UNDATED: DebugEntry = {
  source: 'outcome',
  at: '',
  level: 'warn',
  event: 'outcome.unreadable',
  text: 'a file nobody will act on',
};

/** Every source read, but the supervisor's log, which this machine does not have. */
const INDEX: DebugIndex = {
  entries: [ROUTE_THREW, BOARDED],
  sources: [
    { source: 'console', available: true, count: 1, path: '~/.local/state/phase-console/console.log' },
    { source: 'supervisor', available: false, count: 0, note: 'No console.out.log on this machine.' },
    { source: 'journal', available: true, count: 1 },
    { source: 'outcome', available: true, count: 0 },
    { source: 'ruling', available: true, count: 0 },
    { source: 'delivery', available: true, count: 0 },
    { source: 'health', available: true, count: 0 },
  ],
  truncated: false,
  slugs: ['demo'],
};

/** Every source read. */
const ALL_READ = INDEX.sources.map((s) => ({ ...s, available: true }));

const LEVEL: DebugLevelState = {
  level: 'info',
  debug: '',
  source: 'env',
  levels: ['debug', 'info', 'warn', 'error'],
};

/** An address that names every filter the explorer reads. */
const FULL =
  '#/logs?q=boom&source=journal,console&level=error,warn' +
  '&since=2026-09-01T09:00:00.000Z&until=2026-09-01T11:00:00.000Z' +
  `&slug=demo&run=aaaa1111&phase=3&trace=${TRACE}&limit=2000`;

/* ---------------- the page ---------------- */

/**
 * The place at an address, the panel beside it. `go(next)` re-renders at
 * another address on the SAME query client — how a navigation the page made
 * is followed, since the place reads its route from its prop.
 */
function mount(hash: string) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const tree = (at: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={at}>
        <TooltipProvider>
          <LogsPlace route={parseHash(at) as Route} />
          <aside data-testid="panel">
            <InspectorHost />
          </aside>
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>
  );
  const view = render(tree(hash));
  return { ...view, go: (next: string) => view.rerender(tree(next)) };
}

const indexCalls = () => server.calls.filter((path) => path.startsWith('/api/debug/index'));
/** The last index read's query, as the server parses it. */
const lastRead = () => new URLSearchParams(indexCalls().at(-1)?.split('?')[1] ?? '');
/** The address the page last wrote, as the router reads it. */
const address = () => parseHash(window.location.hash).query;
const lines = () => screen.getAllByTestId('log-line');
/** Each line, as the row text it carries. */
const lineTexts = (texts: readonly string[]) =>
  lines().map((line) => texts.find((text) => line.textContent?.includes(text)) ?? line.textContent);
const lead = () => screen.getByTestId('logs-facts');
const toolbar = () => document.querySelector<HTMLElement>('[data-toolbar]')!;

/** Open the Filter slot's popover on a desk, by its button's spoken name. */
async function openFilter(name: string | RegExp = /^Filter/) {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.findByRole('dialog', { name: 'Filter' });
}

/** A source's box in the Filter panel — its label is the source and what it is. */
const sourceBox = (panel: HTMLElement, source: string) =>
  within(panel).getByRole('checkbox', { name: new RegExp(`^${source}`) });

/** Radix menus open on a primary pointer-down, never on a click. */
async function openMore() {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}

beforeEach(() => {
  media.phone = false;
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  __resetInspectorForTests();
  window.location.hash = '';
  server.calls = [];
  server.reads = {
    '/api/state': STATE,
    '/api/debug/index': INDEX,
    '/api/debug/level': LEVEL,
  };
});
afterEach(() => __resetInspectorForTests());

/* ------------------------------------------------------------------ *
 * The place
 * ------------------------------------------------------------------ */

describe('the place', () => {
  it('is Logs: what this console is under the title, then one section nav of real links', async () => {
    mount('#/logs');
    expect(screen.getByRole('heading', { level: 1, name: 'Logs' })).toBeInTheDocument();
    await waitFor(() =>
      expect(lead()).toHaveTextContent(
        'Watching pe-hub on darwin. Supervised by launchd, so a clean exit comes back.',
      ),
    );
    const nav = screen.getByRole('navigation', { name: 'Logs sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Logs', '#/logs'],
      ['Journal', '#/logs/journal'],
      ['Delivery', '#/logs/delivery'],
      ['Health', '#/logs/health'],
      ['Access', '#/logs/access'],
    ]);
    expect(within(nav).getByRole('link', { name: 'Logs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('logs-page')).toHaveAttribute('data-section', 'logs');
    expect(await screen.findByText('the route threw')).toBeInTheDocument();
  });

  it('marks the section the address names, and draws that section instead of the explorer', () => {
    mount('#/logs/access');
    const nav = screen.getByRole('navigation', { name: 'Logs sections' });
    expect(within(nav).getByRole('link', { name: 'Access' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Logs' })).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('logs-page')).toHaveAttribute('data-section', 'access');
    expect(screen.queryByTestId('logs-explorer')).toBeNull();
  });

  it('reads a segment nobody knows as the explorer, not a dead page', async () => {
    mount('#/logs/nonsense');
    expect(screen.getByTestId('logs-page')).toHaveAttribute('data-section', 'logs');
    expect(
      within(screen.getByRole('navigation', { name: 'Logs sections' })).getByRole('link', { name: 'Logs' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText('the route threw')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The lead
 * ------------------------------------------------------------------ */

describe('the lead never reassures you about the thing that is broken', () => {
  const facts = (state: Record<string, unknown> | undefined) =>
    render(<LogsFacts state={state as ConsoleState | undefined} />);

  it('says watching only when the server said so', () => {
    facts({ ...STATE });
    expect(lead()).toHaveAttribute('data-watcher', 'watching');
    expect(lead()).toHaveTextContent('Watching pe-hub on darwin.');
    // The wire type's older spelling says so too.
    expect(watcherReading({ watcher: { ok: true } })).toEqual({ word: 'watching' });
  });

  it('reads a watcher the server calls unhealthy as stopped, with how much of it still watches', () => {
    // `healthy: false` is what `status()` sends for a deaf or half-armed watch.
    facts({ ...STATE, watcher: { healthy: false, watching: 1, expected: 3, failures: 2 } });
    expect(lead()).toHaveAttribute('data-watcher', 'stopped');
    expect(lead()).toHaveTextContent(
      'The file watcher stopped (1 of 3 folders watched), so the board is not following pe-hub on darwin.',
    );
    expect(lead()).not.toHaveTextContent(/Watching/);
  });

  it('carries a stopped watcher’s own words through', () => {
    facts({ ...STATE, watcher: { ok: false, detail: 'ENOSPC' } });
    expect(lead()).toHaveAttribute('data-watcher', 'stopped');
    expect(lead()).toHaveTextContent('The file watcher stopped (ENOSPC)');
  });

  it('says it does not know when nothing said anything — never "watching"', () => {
    const view = facts({ ...STATE, watcher: undefined });
    expect(lead()).toHaveAttribute('data-watcher', 'unknown');
    expect(lead()).toHaveTextContent('Nothing said whether the file watcher runs for pe-hub on darwin.');
    view.unmount();
    // A status with neither word in it has said nothing either.
    facts({ ...STATE, watcher: {} });
    expect(lead()).toHaveAttribute('data-watcher', 'unknown');
    expect(watcherReading(undefined)).toEqual({ word: 'unknown' });
  });

  it('says what restarts the console, and only what the server said, its own words on hover', () => {
    const cases: [unknown, string][] = [
      [{ supervised: true, kind: 'launchd' }, 'Supervised by launchd, so a clean exit comes back.'],
      [
        { supervised: true, kind: 'systemd', assumed: true },
        'Supervised by systemd, as far as it can tell, so a clean exit comes back.',
      ],
      [
        { supervised: true, kind: 'declared' },
        'Supervised by the supervisor it was started under, so a clean exit comes back.',
      ],
      [{ supervised: false, kind: 'none' }, 'Nothing restarts it if it exits.'],
      [undefined, 'Nothing says what restarts it.'],
    ];
    for (const [supervisor, said] of cases) {
      const view = facts({ ...STATE, supervisor });
      expect(lead()).toHaveTextContent(said);
      view.unmount();
    }
    facts({ ...STATE });
    expect(screen.getByText('Supervised by launchd, so a clean exit comes back.')).toHaveAttribute(
      'title',
      'the launchd unit com.phase-console',
    );
  });

  it('a state that could not be read says so, Try again asks again, and the explorer works throughout', async () => {
    let asks = 0;
    server.reads['/api/state'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('state read failed', 500, '/api/state');
      return STATE;
    };
    mount('#/logs');
    await waitFor(() =>
      expect(lead()).toHaveTextContent('This console’s state could not be read: state read failed.'),
    );
    expect(lead()).toHaveAttribute('data-watcher', 'unknown');
    expect(lead()).not.toHaveTextContent(/Reading what this console is/);
    expect(await screen.findByText('the route threw')).toBeInTheDocument();

    fireEvent.click(within(lead()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(lead()).toHaveTextContent('Watching pe-hub on darwin.'));
    expect(asks).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * What the explorer read, and what it could not
 * ------------------------------------------------------------------ */

describe('the explorer says what it read, and what it could not', () => {
  it('draws one line per row, in the server’s order, in one log, and counts them by source', async () => {
    mount('#/logs');
    await screen.findByText('the route threw');
    const log = screen.getByRole('log', { name: 'Console logs' });
    const drawn = within(log).getAllByTestId('log-line');
    expect(drawn.map((line) => line.getAttribute('data-level'))).toEqual(['error', 'info']);
    // The level is the health vocabulary's word, never this page's own paint.
    expect(
      drawn.map((line) => line.querySelector('[data-vocab="health"]')?.getAttribute('data-status')),
    ).toEqual(['error', 'info']);
    expect(drawn[0]).toHaveTextContent('api.unhandled');
    expect(drawn[1]).toHaveTextContent('phase.boarded');
    expect(toolbar()).toHaveTextContent('2 rows: console 1, journal 1.');
  });

  it('marks an undated row as undated instead of borrowing a time', async () => {
    server.reads['/api/debug/index'] = { ...INDEX, entries: [UNDATED] };
    mount('#/logs');
    await screen.findByText('a file nobody will act on');
    expect(lines()[0]).toHaveTextContent('undated');
    expect(lines()[0]!.querySelector('[data-vocab="health"]')).toHaveAttribute('data-status', 'warning');
  });

  it('names a source it could not read, and why — and one that gave no reason is still named', async () => {
    server.reads['/api/debug/index'] = {
      ...INDEX,
      sources: [
        ...INDEX.sources.filter((s) => s.source !== 'ruling'),
        { source: 'ruling', available: false, count: 0 },
      ],
    };
    mount('#/logs');
    const strip = await screen.findByTestId('sources-unavailable');
    expect(strip).toHaveTextContent('Not readable here');
    // Each source a term, its reason the server's own sentence under it.
    expect(
      within(strip)
        .getAllByRole('term')
        .map((dt) => dt.textContent),
    ).toEqual(['supervisor', 'ruling']);
    expect(
      within(strip)
        .getAllByRole('definition')
        .map((dd) => dd.textContent),
    ).toEqual(['No console.out.log on this machine.', 'This console did not say why.']);
    // "Not readable here" is not "empty": the rows that were read are drawn.
    expect(screen.getByText('the route threw')).toBeInTheDocument();
  });

  it('an empty answer does not claim completeness while a source was unreadable', async () => {
    server.reads['/api/debug/index'] = { ...INDEX, entries: [] };
    mount('#/logs');
    expect(
      await screen.findByText('Nothing matched in the sources that could be read (6 of 7).'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Nothing matched.')).toBeNull();
  });

  it('an empty answer blames no filter nobody set, and offers the way out of one that is', async () => {
    server.reads['/api/debug/index'] = { ...INDEX, entries: [], sources: ALL_READ };
    const first = mount('#/logs');
    expect(await screen.findByText('Nothing matched.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear every filter' })).toBeNull();
    first.unmount();

    mount('#/logs?level=error&slug=demo');
    expect(await screen.findByText('Nothing matched.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear every filter' }));
    expect(window.location.hash).toBe('#/logs');
  });

  it('says a cut answer was cut, with the remedy as one press that keeps the rest', async () => {
    server.reads['/api/debug/index'] = { ...INDEX, truncated: true };
    const first = mount('#/logs?q=boom');
    expect(await screen.findByTestId('logs-truncated')).toHaveTextContent(
      'More rows matched than are shown.',
    );
    fireEvent.click(screen.getByRole('button', { name: `Read ${(2000).toLocaleString()} rows` }));
    expect(address()).toEqual({ q: 'boom', limit: '2000' });
    first.unmount();

    // At the server's ceiling it still says so, and offers no press that does nothing.
    mount('#/logs?limit=5000');
    expect(await screen.findByTestId('logs-truncated')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Read .* rows$/ })).toBeNull();
  });

  it('does not claim a cut when there was none', async () => {
    mount('#/logs');
    await screen.findByText('the route threw');
    expect(screen.queryByTestId('logs-truncated')).toBeNull();
  });

  it('a read that failed says so in its own words, the lead still says what the console is, and Try again asks again', async () => {
    let asks = 0;
    server.reads['/api/debug/index'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('index read failed', 500, '/api/debug/index');
      return INDEX;
    };
    mount('#/logs');
    expect(await screen.findByText('The logs could not be read: index read failed')).toBeInTheDocument();
    await waitFor(() => expect(lead()).toHaveTextContent('Watching pe-hub on darwin.'));

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('the route threw')).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The address is the state
 * ------------------------------------------------------------------ */

describe('the filters the address carries are the filters that are sent', () => {
  it('sends every filter the address names — q, source, level, since, until, slug, run, phase, trace, limit', async () => {
    mount(FULL);
    await screen.findByText('the route threw');
    const read = lastRead();
    expect(read.getAll('source')).toEqual(['journal', 'console']);
    expect(read.getAll('level')).toEqual(['error', 'warn']);
    expect(Object.fromEntries([...read].filter(([key]) => key !== 'source' && key !== 'level'))).toEqual({
      q: 'boom',
      since: '2026-09-01T09:00:00.000Z',
      until: '2026-09-01T11:00:00.000Z',
      slug: 'demo',
      run: 'aaaa1111',
      phase: '3',
      trace: TRACE,
      limit: '2000',
    });
    expect(screen.getByRole('searchbox', { name: 'Search logs' })).toHaveValue('boom');
    expect(screen.getByLabelText('How many rows to read')).toHaveValue('2000');
  });

  it('and each control writes the rest back: unticking a source keeps the window, the scope and the rows', async () => {
    const view = mount(FULL);
    await screen.findByText('the route threw');
    // Two sources, two levels and both ends of the window are in force.
    const panel = await openFilter('Filter, 4 in use');
    expect(sourceBox(panel, 'journal')).toHaveAttribute('aria-checked', 'true');
    expect(sourceBox(panel, 'console')).toHaveAttribute('aria-checked', 'true');
    expect(sourceBox(panel, 'supervisor')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(sourceBox(panel, 'journal'));
    expect(address()).toEqual({
      q: 'boom',
      source: 'console',
      level: 'error,warn',
      since: '2026-09-01T09:00:00.000Z',
      until: '2026-09-01T11:00:00.000Z',
      slug: 'demo',
      run: 'aaaa1111',
      phase: '3',
      trace: TRACE,
      limit: '2000',
    });

    // …and what it wrote is what the next read sends.
    view.go(window.location.hash);
    await waitFor(() => expect(lastRead().getAll('source')).toEqual(['console']));
    expect(lastRead().get('since')).toBe('2026-09-01T09:00:00.000Z');
    expect(lastRead().get('trace')).toBe(TRACE);
  });

  it('the search writes ?q= in place, carrying the rest, so typing leaves no Back step behind', async () => {
    mount('#/logs?source=journal');
    await screen.findByText('the route threw');
    const steps = window.history.length;
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search logs' }), { target: { value: 'boom' } });
    expect(address()).toEqual({ q: 'boom', source: 'journal' });
    expect(window.history.length).toBe(steps);
  });

  it('the window is a control as well as an address, and a time set there comes back as it was set', async () => {
    const view = mount('#/logs?q=boom');
    await screen.findByText('the route threw');
    await openFilter();
    fireEvent.change(screen.getByLabelText('Show rows at or after'), {
      target: { value: '2026-09-01T09:30' },
    });
    // A local time, written as the instant it is.
    expect(address()).toEqual({ q: 'boom', since: new Date(2026, 8, 1, 9, 30).toISOString() });

    view.go(window.location.hash);
    expect(screen.getByLabelText('Show rows at or after')).toHaveValue('2026-09-01T09:30');
    expect(screen.getByLabelText('Show rows at or before')).toHaveValue('');
    await waitFor(() => expect(lastRead().get('since')).toBe(new Date(2026, 8, 1, 9, 30).toISOString()));

    fireEvent.click(screen.getByRole('button', { name: 'Clear the window' }));
    expect(address()).toEqual({ q: 'boom' });
  });

  it('a typo’d filter selects nothing: no source or level is sent, and no box is ticked', async () => {
    mount('#/logs?source=journals&level=loud');
    await screen.findByText('the route threw');
    // Not `source=journals`, which would narrow the page to a word nobody
    // writes and read as an empty log.
    expect(indexCalls()).toEqual(['/api/debug/index']);
    const panel = await openFilter('Filter, Every source');
    for (const box of within(panel).getAllByRole('checkbox'))
      expect(box).toHaveAttribute('aria-checked', 'false');
  });

  it('drops an unreadable phase, trace or limit rather than sending it — and phase 0 is a phase', async () => {
    const first = mount('#/logs?phase=soon&trace=not-a-trace&limit=lots');
    await screen.findByText('the route threw');
    expect(indexCalls()).toEqual(['/api/debug/index']);
    // A trace that is no trace would narrow the page to nothing, which reads
    // as "this run left no evidence" — so no scope is claimed either.
    expect(screen.queryByTestId('scope-note')).toBeNull();
    first.unmount();

    server.calls = [];
    mount('#/logs?phase=0');
    await screen.findByText('the route threw');
    expect(indexCalls()).toEqual(['/api/debug/index?phase=0']);
    expect(screen.getByTestId('scope-note')).toHaveTextContent('Scoped to phase 0.');
  });

  it('names the scope it is under, with a way out that keeps the rest', async () => {
    mount(`#/logs?q=boom&slug=demo&run=aaaa1111&phase=4&trace=${TRACE}`);
    const note = await screen.findByTestId('scope-note');
    expect(note).toHaveTextContent('Scoped to plan demo, run aaaa1111, phase 4, trace 0123456789ab.');
    expect(within(note).getByRole('link', { name: 'Drop the scope' })).toHaveAttribute(
      'href',
      '#/logs?q=boom',
    );
  });

  it('the rows control reads ?limit= and writes it back, and the default writes nothing', async () => {
    const view = mount('#/logs?q=boom&limit=2000');
    await screen.findByText('the route threw');
    const rows = () => screen.getByLabelText('How many rows to read') as HTMLSelectElement;
    expect(rows()).toHaveValue('2000');
    fireEvent.change(rows(), { target: { value: '5000' } });
    expect(address()).toEqual({ q: 'boom', limit: '5000' });

    view.go(window.location.hash);
    fireEvent.change(rows(), { target: { value: '500' } });
    expect(address()).toEqual({ q: 'boom' });
  });

  it('offers a row count the address named that is not one of its steps, rather than showing another', async () => {
    mount('#/logs?limit=750');
    await screen.findByText('the route threw');
    const rows = screen.getByLabelText('How many rows to read') as HTMLSelectElement;
    expect(rows).toHaveValue('750');
    expect(rows.selectedOptions[0]).toHaveTextContent('750 rows');
    expect(lastRead().get('limit')).toBe('750');
  });

  it('Clear every filter is a verb, refused with its reason while nothing is set', async () => {
    const first = mount('#/logs');
    await screen.findByText('the route threw');
    const idle = within(await openMore()).getByRole('menuitem', { name: /Clear every filter/ });
    expect(idle).toHaveAttribute('data-disabled');
    expect(idle).toHaveTextContent('No filter is set.');
    first.unmount();

    mount('#/logs?q=boom&slug=demo');
    await screen.findByText('the route threw');
    fireEvent.click(within(await openMore()).getByRole('menuitem', { name: 'Clear every filter' }));
    expect(window.location.hash).toBe('#/logs');
  });

  it('copies the address of the view, which is the view', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      window.location.hash = '#/logs?q=boom&level=error';
      mount('#/logs?q=boom&level=error');
      await screen.findByText('the route threw');
      fireEvent.click(
        within(await openMore()).getByRole('menuitem', { name: 'Copy the address of this view' }),
      );
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.href));
      expect(writeText.mock.calls[0]).toEqual([expect.stringContaining('#/logs?q=boom&level=error')]);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Follow
 * ------------------------------------------------------------------ */

describe('Follow says only what it can measure', () => {
  const real = globalThis.EventSource;
  // Assignment, not `defineProperty`: `test-setup.ts`'s stand-in is writable
  // but not configurable.
  beforeEach(() => {
    DriveableEventSource.last = null;
    globalThis.EventSource = DriveableEventSource as unknown as typeof EventSource;
  });
  afterEach(() => {
    globalThis.EventSource = real;
    DriveableEventSource.last = null;
  });

  /** The page's own stream. */
  const stream = (): DriveableEventSource => {
    const last = DriveableEventSource.last;
    if (!last) throw new Error('the page opened no stream');
    return last;
  };

  const line = (at: string, text: string) => ({
    source: 'journal',
    at,
    level: 'info',
    event: 'phase.verified',
    text,
  });

  it('is a press that says whether it is on, and writes ?follow=1 in place', async () => {
    const view = mount('#/logs?source=journal');
    await screen.findByText('the route threw');
    const follow = screen.getByTestId('follow');
    expect(follow).toHaveAccessibleName('Follow');
    expect(follow).toHaveAttribute('aria-pressed', 'false');
    // Off costs nothing: no stream is open.
    expect(DriveableEventSource.last).toBeNull();

    const steps = window.history.length;
    fireEvent.click(follow);
    expect(address()).toEqual({ source: 'journal', follow: '1' });
    expect(window.history.length).toBe(steps);

    view.go(window.location.hash);
    expect(screen.getByTestId('follow')).toHaveAttribute('aria-pressed', 'true');
    expect(DriveableEventSource.last).not.toBeNull();
  });

  it('follows exactly what the page read: the tail opens on the same filters', async () => {
    mount('#/logs?follow=1&source=journal&q=boom');
    await screen.findByText('the route threw');
    expect(stream().url).toBe('/api/debug/tail?source=journal&q=boom');
    expect(indexCalls().at(-1)).toBe('/api/debug/index?source=journal&q=boom');
  });

  it('says it is connecting until the stream opens, and that it closed once the browser gives up', async () => {
    mount('#/logs?follow=1');
    await screen.findByText('the route threw');
    const connecting = screen.getByText('Connecting the follow stream. The rows below are the last read.');
    expect(connecting.closest('[data-severity]')).toHaveAttribute('data-severity', 'info');

    act(() => stream().open());
    expect(screen.queryByText(/follow stream/)).toBeNull();

    act(() => {
      stream().readyState = DriveableEventSource.CLOSED;
      stream().emit('error', {});
    });
    const closed = screen.getByText(
      'The follow stream closed. The rows below are the last read; turn Follow off and on to reconnect.',
    );
    expect(closed.closest('[data-severity]')).toHaveAttribute('data-severity', 'error');
  });

  it('puts the followed rows on top of the rows read, both newest first', async () => {
    mount('#/logs?follow=1');
    await screen.findByText('the route threw');
    act(() => {
      stream().open();
      // The wire is oldest first.
      stream().emit('entries', {
        entries: [
          line('2026-09-01T10:00:05.000Z', 'followed one'),
          line('2026-09-01T10:00:06.000Z', 'followed two'),
        ],
      });
    });
    expect(lineTexts(['followed two', 'followed one', 'the route threw', 'model=opus'])).toEqual([
      'followed two',
      'followed one',
      'the route threw',
      'model=opus',
    ]);
    expect(toolbar()).toHaveTextContent('4 rows');
  });

  it('draws no gap banner while nothing was dropped, and a sticky one once a frame arrives full', async () => {
    mount('#/logs?follow=1');
    await screen.findByText('the route threw');
    act(() => {
      stream().open();
      stream().emit('entries', { entries: [line('2026-09-01T10:00:05.000Z', 'a line')], capped: false });
    });
    expect(screen.queryByTestId('tail-gap')).toBeNull();

    act(() => {
      stream().emit('entries', { entries: [line('2026-09-01T10:00:06.000Z', 'a full frame')], capped: true });
    });
    expect(screen.getByTestId('tail-gap')).toHaveTextContent(
      'rows between it and the one before it were dropped',
    );

    // Sticky: the rows that frame lost never arrive, so a quiet frame after
    // it does not close the hole on screen.
    act(() => {
      stream().emit('entries', {
        entries: [line('2026-09-01T10:00:07.000Z', 'a quiet frame')],
        capped: false,
      });
    });
    expect(screen.getByTestId('tail-gap')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * A row's door
 * ------------------------------------------------------------------ */

describe('a row opens in the panel', () => {
  /** The panel's facts, label → value cell. */
  const factsOf = (panel: HTMLElement) =>
    Object.fromEntries(
      [...panel.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling as HTMLElement]),
    );
  /** Radix tabs move on a primary mouse-down, never on a click. */
  const openTab = (panel: HTMLElement, name: string) =>
    fireEvent.mouseDown(within(panel).getByRole('tab', { name }), { button: 0 });

  it('with its words, its facts and a link to each record it names, and the raw row to quote', async () => {
    mount('#/logs');
    fireEvent.click((await screen.findByText('model=opus')).closest('[data-testid="log-line"]')!);
    const panel = screen.getByTestId('panel');
    expect(within(panel).getByRole('heading', { name: 'phase.boarded' })).toBeInTheDocument();
    expect(within(panel).getByText('model=opus')).toBeInTheDocument();

    const facts = factsOf(panel);
    expect(Object.keys(facts)).toEqual(['Level', 'Source', 'When', 'Event', 'Plan', 'Run', 'Phase', 'Trace']);
    expect(facts.Level!.querySelector('[data-vocab="health"]')).toHaveAttribute('data-status', 'info');
    expect(facts.Source).toHaveTextContent('journal');
    expect(facts.Event).toHaveTextContent('phase.boarded');
    expect(within(facts.Plan!).getByRole('link', { name: 'demo' })).toHaveAttribute(
      'href',
      '#/plan/demo/phases',
    );
    // The run to its journal, at the phase the row is about.
    expect(within(facts.Run!).getByRole('link')).toHaveAttribute(
      'href',
      '#/logs/journal?slug=demo&run=aaaa1111&phase=2',
    );
    expect(facts.Phase).toHaveTextContent('Phase 2');
    // The trace to the explorer narrowed to that trace: the run's whole story.
    const trace = within(facts.Trace!).getByRole('link');
    expect(trace).toHaveAttribute('href', `#/logs?trace=${TRACE}`);
    expect(trace).toHaveTextContent(TRACE.slice(0, 12));
    expect(within(panel).getByText(/masked on the way out of the server/)).toBeInTheDocument();

    openTab(panel, 'Raw');
    expect(await within(panel).findByRole('button', { name: 'Copy the row' })).toBeInTheDocument();
    expect(panel.querySelector('pre')).toHaveTextContent('"event": "phase.boarded"');
    expect(panel.querySelector('pre')).toHaveTextContent(`"traceId": "${TRACE}"`);
  });

  it('names only what a row has: no plan, run or trace it lacks, and an undated row says so', async () => {
    server.reads['/api/debug/index'] = { ...INDEX, entries: [UNDATED] };
    mount('#/logs');
    fireEvent.click(
      (await screen.findByText('a file nobody will act on')).closest('[data-testid="log-line"]')!,
    );
    const panel = screen.getByTestId('panel');
    const facts = factsOf(panel);
    expect(Object.keys(facts)).toEqual(['Level', 'Source', 'When', 'Event']);
    expect(facts.Level!.querySelector('[data-vocab="health"]')).toHaveAttribute('data-status', 'warning');
    expect(facts.When).toHaveTextContent('undated — this source wrote no time');
    expect(within(panel).queryByRole('link')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Everything
 * ------------------------------------------------------------------ */

describe('Everything', () => {
  it('adds each line’s plan, phase, run and trace, and nothing to a line that has none', async () => {
    mount('#/logs');
    await screen.findByText('the route threw');
    const boarded = () => lines()[1]!;
    expect(boarded()).not.toHaveTextContent('demo, phase 2');

    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    await waitFor(() => expect(boarded()).toHaveTextContent('demo, phase 2'));
    expect(boarded()).toHaveTextContent('aaaa1111');
    expect(boarded()).toHaveTextContent(`trace ${TRACE.slice(0, 12)}`);
    expect(lines()[0]).not.toHaveTextContent(/trace|phase/);
  });
});

/* ------------------------------------------------------------------ *
 * On a phone
 * ------------------------------------------------------------------ */

describe('on a phone', () => {
  it('folds the filters, Follow and the rows into the one View sheet, the same controls', async () => {
    media.phone = true;
    mount('#/logs?source=journal');
    await screen.findByText('the route threw');
    expect(screen.queryByRole('button', { name: /^Filter/ })).toBeNull();
    expect(screen.queryByTestId('follow')).toBeNull();

    // The sheet's button counts the source in force.
    fireEvent.click(screen.getByRole('button', { name: 'View, 1 in use' }));
    const sheet = await screen.findByRole('dialog', { name: 'View' });
    const filter = within(sheet).getByRole('region', { name: 'Filter' });
    expect(sourceBox(filter, 'journal')).toHaveAttribute('aria-checked', 'true');
    const view = within(sheet).getByRole('region', { name: 'View' });
    expect(within(view).getByText('New rows arrive at the top.')).toBeInTheDocument();
    expect(within(view).getByLabelText('How many rows to read')).toHaveValue('500');

    fireEvent.click(within(view).getByTestId('follow'));
    expect(address()).toEqual({ source: 'journal', follow: '1' });
  });
});
