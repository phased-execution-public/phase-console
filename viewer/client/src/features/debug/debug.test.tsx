/**
 * The Debug destination.
 *
 * The four cases about the L0 card came from `features/stubs.test.tsx` when
 * Phase 10 grew this page from one card into four fetching sections. Each is a
 * Phase 4 QA finding and they are the same property the rest of this file
 * tests one rung further out: **a diagnostics page must never reassure you
 * about the thing that is broken.**
 *
 * That is the thread through every case below. A source the server could not
 * read must say so by name rather than contribute silence. A cut answer must
 * say it was cut. A 404 from the diagnosis endpoint is an ANSWER — no run has
 * a record of that phase — not an error. `sent` in the delivery ledger means
 * the push service accepted it, not that anybody saw it. And a filter typed
 * into the URL must either select something real or select nothing, never
 * silently widen to everything.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { ConsoleState, DebugIndex } from '@/lib/api';
import { debugHref, listOf, sectionFor, DEBUG_SECTIONS } from './routes';
import DebugPage from './index';
import { DriveableEventSource } from './driveable-event-source';

const { state, debugIndex, debugRuns, debugBundle, runTimeline, phaseDiagnosis } = vi.hoisted(() => ({
  state: vi.fn(),
  debugIndex: vi.fn(),
  debugRuns: vi.fn(),
  debugBundle: vi.fn(),
  runTimeline: vi.fn(),
  phaseDiagnosis: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, state, debugIndex, debugRuns, debugBundle, runTimeline, phaseDiagnosis },
  };
});

const STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  // Both set, so "unknown" in a `dd` can only ever be the watcher — the fact
  // the third L0 case is actually about.
  platform: 'darwin',
  supervisor: { detail: 'launchd' },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  unread: 0,
} as ConsoleState;

const INDEX: DebugIndex = {
  entries: [
    {
      source: 'console',
      at: '2026-09-01T10:00:00.000Z',
      level: 'error',
      event: 'api.unhandled',
      text: 'the route threw',
      data: { path: '/api/x' },
    },
    {
      source: 'journal',
      at: '2026-09-01T09:59:00.000Z',
      level: 'info',
      event: 'phase.boarded',
      text: 'model=opus',
      slug: 'demo',
      runId: 'aaaa1111',
      phase: 2,
    },
  ],
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

/*
 * The log explorer's rows live in a `DataList`, which is virtualized. jsdom
 * lays nothing out, so without these stubs the virtualizer measures a
 * zero-height scroller and renders ZERO rows — every assertion about a log
 * line would fail for a reason that has nothing to do with the page. Same
 * harness `components/ui/data-list.test.tsx` documents.
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

/** hash → Route, by hand. Same helper Repo's suite uses, same reasons. */
function routeOf(hash: string) {
  const [path, queryPart] = hash.replace(/^#\//, '').split('?');
  return {
    segments: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
    path,
  };
}

/**
 * `retry: false` is mandatory — the shared config's default is `retry: 1`, and
 * a rejected fetcher would otherwise be retried once before the assertion runs.
 * `go()` moves the `route` PROP rather than the provider's hash, which is a
 * lazy `useState` initializer fixed at mount.
 */
function mount(hash: string) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  // `MemoryRouterProvider` does not touch `window.location`, so a test that
  // read the hash back off the document saw `''` for every navigation. The
  // provider's own callback is where a click's destination is observable.
  const navigations: string[] = [];
  const tree = (at: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={at} onNavigate={(to) => navigations.push(to)}>
        <DebugPage route={routeOf(at)} />
      </MemoryRouterProvider>
    </QueryClientProvider>
  );
  const view = render(tree(hash));
  return {
    ...view,
    navigations,
    lastNavigation: () => navigations[navigations.length - 1] ?? '',
    go: (next: string) => view.rerender(tree(next)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(STATE);
  debugIndex.mockResolvedValue(INDEX);
  debugRuns.mockResolvedValue({ slug: 'demo', runs: [] });
  debugBundle.mockResolvedValue({
    schema: 'phase-console/debug-bundle',
    version: 1,
    generatedAt: '2026-09-01T10:00:00.000Z',
    console: {},
    root: '~/repo',
    plans: [],
    health: { environment: [], watches: null },
    metrics: [],
    delivery: { outcomes: {}, undelivered: 0, announcements: 0, devices: 0 },
    entries: [],
    sources: [],
    notes: [],
  });
  // Complete, not minimal: `Gantt` reads `criticalPath` unguarded, so a
  // partial timeline throws inside the component and the whole section
  // disappears — which reads as the assertion being wrong about the page.
  runTimeline.mockResolvedValue({
    lanes: [],
    marks: [],
    spanMs: 0,
    truncated: false,
    criticalPath: [],
    criticalMs: 0,
    startedAt: null,
    endedAt: null,
    horizonAt: null,
  });
  phaseDiagnosis.mockResolvedValue(null);
});

/* ------------------------------------------------------------------ *
 * The L0 card — moved from features/stubs.test.tsx, unchanged in meaning
 * ------------------------------------------------------------------ */

describe('Debug never reassures you about the thing that is broken', () => {
  it('says "watching" only when the server actually said so', async () => {
    state.mockResolvedValue({ ...STATE, watcher: { ok: true } });
    mount('#/debug');
    expect(await screen.findByText('watching')).toBeTruthy();
  });

  it('reports the watcher as unknown when the server reported nothing', async () => {
    state.mockResolvedValue({ ...STATE, watcher: undefined });
    mount('#/debug');
    expect(await screen.findByText('unknown', { selector: 'dd' })).toBeTruthy();
    expect(screen.queryByText('watching')).toBeNull();
  });

  it('carries the stopped detail through', async () => {
    state.mockResolvedValue({ ...STATE, watcher: { ok: false, detail: 'ENOSPC' } });
    mount('#/debug');
    expect(await screen.findByText('ENOSPC')).toBeTruthy();
    expect(screen.queryByText('watching')).toBeNull();
  });

  it('shows the error rather than a page of confident unknowns', async () => {
    state.mockRejectedValue(new Error('state read failed'));
    mount('#/debug');
    expect(await screen.findByText(/state read failed/i)).toBeTruthy();
    expect(screen.queryByText(/what this console is/i)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Sections and the URL
 * ------------------------------------------------------------------ */

describe('the URL is the state', () => {
  it('resolves an unknown segment to the log explorer instead of 404ing', () => {
    // A head that ever appeared in a bookmark must keep resolving.
    expect(sectionFor(undefined)).toBe('logs');
    expect(sectionFor('nonsense')).toBe('logs');
    expect(sectionFor('health')).toBe('health');
  });

  it('gives the default section no segment of its own', () => {
    expect(debugHref('logs')).toBe('#/debug');
    expect(debugHref('health')).toBe('#/debug/health');
  });

  it('never emits an empty parameter', () => {
    // On the server an empty parameter and an absent one are read the same way
    // by a coercion, so a link that sends `?slug=` says something the person
    // clicking it did not.
    expect(debugHref('logs', { slug: '', q: undefined, run: 'r1' })).toBe('#/debug?run=r1');
  });

  it('comma-joins a list rather than repeating the key', () => {
    // `Route.query` is flat and last-wins, so `?source=a&source=b` would read
    // back as ONE source and quietly narrow the page for anyone following
    // their own link.
    expect(debugHref('logs', { source: ['console', 'journal'] })).toBe('#/debug?source=console%2Cjournal');
  });

  it('drops an unknown word out of a list rather than selecting on it', () => {
    // `?source=journals` (a plural typo) must show EVERYTHING. Treating it as
    // a filter would show nothing and look like an empty log.
    expect(listOf('journal,console', ['journal', 'console'] as const)).toEqual(['journal', 'console']);
    expect(listOf('journals', ['journal', 'console'] as const)).toEqual([]);
    expect(listOf(undefined, ['journal'] as const)).toEqual([]);
  });

  it('renders every section in the nav, and marks the current one', async () => {
    mount('#/debug/health');
    const nav = await screen.findByRole('navigation', { name: /debug sections/i });
    for (const section of DEBUG_SECTIONS) {
      expect(within(nav).getByText(section.label)).toBeTruthy();
    }
    expect(within(nav).getByText('Health').getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByText('Logs').getAttribute('aria-current')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The log explorer
 * ------------------------------------------------------------------ */

describe('the log explorer says what it could not read', () => {
  it('names an unavailable source and its reason, rather than showing nothing', async () => {
    mount('#/debug');
    expect(await screen.findByTestId('sources-unavailable')).toBeTruthy();
    expect(screen.getByText(/No console\.out\.log on this machine\./)).toBeTruthy();
    // The distinction that matters: "not readable here" is not "empty".
    expect(screen.queryByText(/^Nothing matched$/)).toBeNull();
  });

  it('says a cut answer was cut', async () => {
    debugIndex.mockResolvedValue({ ...INDEX, truncated: true });
    mount('#/debug');
    expect(await screen.findByTestId('logs-truncated')).toBeTruthy();
  });

  it('does not claim truncation when there was none', async () => {
    mount('#/debug');
    await screen.findByText('the route threw');
    expect(screen.queryByTestId('logs-truncated')).toBeNull();
  });

  it('marks an undated row as undated instead of borrowing a time', async () => {
    debugIndex.mockResolvedValue({
      ...INDEX,
      entries: [
        {
          source: 'outcome',
          at: '',
          level: 'warn',
          event: 'outcome.unreadable',
          text: 'a file nobody will act on',
        },
      ],
    });
    mount('#/debug');
    expect(await screen.findByText('undated')).toBeTruthy();
  });

  it('passes the URL’s filters to the server', async () => {
    mount('#/debug?source=journal&level=error&q=boom&slug=demo');
    await screen.findByText('the route threw');
    expect(debugIndex).toHaveBeenCalledWith({
      source: ['journal'],
      level: ['error'],
      q: 'boom',
      slug: 'demo',
    });
  });

  it('asks for everything when the URL names a source that does not exist', async () => {
    mount('#/debug?source=journals');
    await screen.findByText('the route threw');
    // No `source` key at all — not `source: []`, which would be a filter that
    // matches nothing, and not `source: ['journals']`, which the server would
    // then drop for us with no way to tell the reader why.
    expect(debugIndex).toHaveBeenCalledWith({});
  });

  it('opens a row’s record, with the raw JSON behind the disclosure', async () => {
    mount('#/debug');
    fireEvent.click(await screen.findByText('the route threw'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('api.unhandled')).toBeTruthy();
    // L3 — and the sentence that explains why this record differs from the
    // file on disk, which is the one question a reader comparing them has.
    expect(within(dialog).getByText(/masked on the way out of the server/i)).toBeTruthy();
  });

  it('shows an empty state that does not blame the reader’s filters when there are none', async () => {
    debugIndex.mockResolvedValue({ ...INDEX, entries: [] });
    mount('#/debug');
    expect(await screen.findByText('Nothing matched')).toBeTruthy();
  });

  it('shows the server’s own words when the index read fails', async () => {
    debugIndex.mockRejectedValue(new Error('index read failed'));
    mount('#/debug');
    expect(await screen.findByText(/index read failed/i)).toBeTruthy();
    // And still says what the console IS: the L0 card is sourced from
    // /api/state, which succeeded.
    expect(screen.getByText(/what this console is/i)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * The journal
 * ------------------------------------------------------------------ */

describe('the journal section', () => {
  it('says no run has been recorded rather than drawing an empty axis', async () => {
    mount('#/debug/journal');
    expect(await screen.findByText(/No run has been recorded here/i)).toBeTruthy();
    expect(runTimeline).not.toHaveBeenCalled();
  });

  it('offers the plans that have actually run', async () => {
    state.mockResolvedValue({ ...STATE, runs: [{ slug: 'demo' }, { slug: 'other' }] });
    mount('#/debug/journal');
    expect(await screen.findByLabelText('Plan')).toBeTruthy();
    expect(runTimeline).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * The delivery ledger
 * ------------------------------------------------------------------ */

describe('the delivery ledger tells the truth about "sent"', () => {
  it('says sent means the service accepted it, not that anybody saw it', async () => {
    mount('#/debug/delivery');
    expect(await screen.findByText(/not “you saw it”/)).toBeTruthy();
  });

  it('counts quiet as held — neither delivered nor failed', async () => {
    mount('#/debug/delivery');
    // The word is load-bearing: folding `quiet` into either column would
    // misreport a device doing exactly what its operator configured.
    expect(await screen.findByText(/nothing attempted, on purpose/i)).toBeTruthy();
    expect(screen.getAllByText('held').length).toBeGreaterThan(0);
  });

  it('reads only the delivery source', async () => {
    mount('#/debug/delivery');
    await screen.findByText(/not “you saw it”/);
    expect(debugIndex).toHaveBeenCalledWith({ source: ['delivery'], limit: 500 });
  });
});

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

describe('the health section', () => {
  it('does not assemble a bundle until the reader asks', async () => {
    mount('#/debug/health');
    expect(await screen.findByText(/Read the console’s own health/i)).toBeTruthy();
    expect(debugBundle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Read health'));
    expect(await screen.findByText(/For an AI/i)).toBeTruthy();
    expect(debugBundle).toHaveBeenCalled();
  });

  it('says the metrics are a snapshot rather than implying a history', async () => {
    mount('#/debug/health');
    fireEvent.click(await screen.findByText('Read health'));
    expect(await screen.findByText(/keeps no history/i)).toBeTruthy();
  });

  it('carries an environment issue’s fix beside the finding', async () => {
    debugBundle.mockResolvedValue({
      schema: 'phase-console/debug-bundle',
      version: 1,
      generatedAt: '2026-09-01T10:00:00.000Z',
      console: {},
      root: '~/repo',
      plans: [],
      health: {
        environment: [{ kind: 'path-missing-dir', detail: 'PATH names ~/gone', fix: 'Reinstall the CLI.' }],
        watches: { passes: 4, asked: ['gh:o/r#run/1'], open: true },
      },
      metrics: [],
      delivery: { outcomes: {}, undelivered: 0, announcements: 0, devices: 0 },
      entries: [],
      sources: [],
      notes: [],
    });
    mount('#/debug/health');
    fireEvent.click(await screen.findByText('Read health'));
    // An issue with no errand beside it is a complaint, not a finding.
    expect(await screen.findByText('Reinstall the CLI.')).toBeTruthy();
    expect(screen.getByText('PATH names ~/gone')).toBeTruthy();
  });

  it('folds the watched refs away, and shows them on request', async () => {
    debugBundle.mockResolvedValue({
      schema: 'phase-console/debug-bundle',
      version: 1,
      generatedAt: '2026-09-01T10:00:00.000Z',
      console: {},
      root: '~/repo',
      plans: [],
      health: { environment: [], watches: { passes: 4, asked: ['gh:o/r#run/1'], open: true } },
      metrics: [],
      delivery: { outcomes: {}, undelivered: 0, announcements: 0, devices: 0 },
      entries: [],
      sources: [],
      notes: [],
    });
    mount('#/debug/health');
    fireEvent.click(await screen.findByText('Read health'));

    // The count is always on screen; the refs themselves are an L1 fold, and
    // `Disclosure` unmounts its content — so the ref is genuinely absent
    // rather than merely hidden.
    expect(await screen.findByText('Refs being watched')).toBeTruthy();
    expect(screen.queryByText('gh:o/r#run/1')).toBeNull();

    fireEvent.click(screen.getByText('Show the refs'));
    expect(await screen.findByText('gh:o/r#run/1')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * QA round 1 — one case per finding, each red against the pre-fix code
 * ------------------------------------------------------------------ */

describe('the filters the URL advertises are the filters that are sent', () => {
  it('H2 — reads the time window, the run and the phase, not only the five chips', async () => {
    // These were read from the URL and then not sent for one round, which is
    // worse than not offering them: the module header sells `?until=` as the
    // quotable permalink and the truncation banner tells the reader to add
    // `?since=`. A diagnostics page must not print a remedy that does nothing.
    mount('#/debug?since=2026-09-01T09:00:00.000Z&until=2026-09-01T11:00:00.000Z&run=aaaa1111&phase=3');
    await screen.findByText('the route threw');
    expect(debugIndex).toHaveBeenCalledWith({
      since: '2026-09-01T09:00:00.000Z',
      until: '2026-09-01T11:00:00.000Z',
      run: 'aaaa1111',
      phase: 3,
    });
  });

  it('H2 — drops an unparseable phase rather than sending NaN', async () => {
    mount('#/debug?phase=soon');
    await screen.findByText('the route threw');
    expect(debugIndex).toHaveBeenCalledWith({});
  });

  it('H2 — a chip click carries the window forward instead of deleting it', async () => {
    // `go()` rebuilt the href from five keys, so clicking any chip silently
    // dropped a `?since=` the reader had typed — which reads as the filter
    // having been ignored.
    const view = mount('#/debug?since=2026-09-01T09:00:00.000Z');
    await screen.findByText('the route threw');
    fireEvent.click(screen.getByRole('button', { name: 'journal' }));
    const href = view.lastNavigation();
    expect(href).toContain('since=2026-09-01T09%3A00%3A00.000Z');
    expect(href).toContain('source=journal');
  });

  it('H2 — offers the window as a control, not only as a URL', async () => {
    mount('#/debug');
    expect(await screen.findByLabelText('Show rows at or after')).toBeTruthy();
    expect(screen.getByLabelText('Show rows at or before')).toBeTruthy();
  });

  it('H2 — names the scope it is under, with a way out', async () => {
    mount('#/debug?slug=demo&phase=4');
    expect(await screen.findByTestId('scope-note')).toBeTruthy();
    expect(screen.getByText(/plan demo · phase 4/)).toBeTruthy();
    expect(screen.getByText('Drop the scope')).toBeTruthy();
  });
});

describe('a failed read is never rendered as a fact', () => {
  it('M5 — a non-404 diagnosis failure is an error, not "no record of that phase"', async () => {
    state.mockResolvedValue({ ...STATE, runs: [{ slug: 'demo' }] });
    debugRuns.mockResolvedValue({ slug: 'demo', runs: ['aaaa1111'] });
    runTimeline.mockResolvedValue({
      lanes: [
        { phase: 2, attempts: 1, workingMs: 1000, verifyingMs: 0, waitingMs: 0, frozenMs: 0, bars: [] },
      ],
      marks: [],
      spanMs: 1000,
      truncated: false,
      criticalPath: [],
      criticalMs: 0,
      startedAt: null,
      endedAt: null,
      horizonAt: null,
    });
    const boom = Object.assign(new Error('the console is not answering'), { status: 500 });
    phaseDiagnosis.mockRejectedValue(boom);

    mount('#/debug/journal?slug=demo&phase=2');

    expect(await screen.findByText(/the console is not answering/i)).toBeTruthy();
    expect(screen.queryByText(/has a record of phase/i)).toBeNull();
  });

  it('M5 — a watch clock that did not answer makes no claim about what is parked', async () => {
    // `null`'s only producer is a caught throw, so "Nothing is parked on a
    // ref." was a claim the page could not make, every time it appeared.
    mount('#/debug/health');
    fireEvent.click(await screen.findByText('Read health'));
    expect(await screen.findByText(/cannot say what is parked on a ref/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing is parked on a ref/i)).toBeNull();
  });

  it('M5 — a failed metrics scrape is an error, not "0 families right now"', async () => {
    debugBundle.mockResolvedValue({
      schema: 'phase-console/debug-bundle',
      version: 1,
      generatedAt: '2026-09-01T10:00:00.000Z',
      console: {},
      root: '~/repo',
      plans: [],
      health: { environment: [], watches: null },
      metrics: [],
      delivery: { outcomes: {}, undelivered: 0, announcements: 0, devices: 0 },
      entries: [],
      sources: [],
      notes: ['Metrics could not be rendered: the scrape threw'],
    });
    mount('#/debug/health');
    fireEvent.click(await screen.findByText('Read health'));
    expect(await screen.findByTestId('metrics-failed')).toBeTruthy();
    expect(screen.queryByText(/0 families, as/)).toBeNull();
  });
});

describe('what could not be read is never absorbed', () => {
  it('M7 — a source with no note is still named as unreadable', async () => {
    // The strip required BOTH `!available` and a note, and two of the seven
    // sources shipped without one — so their unavailability was invisible
    // under the words "every source this console can read was searched".
    debugIndex.mockResolvedValue({
      ...INDEX,
      entries: [],
      sources: [
        ...INDEX.sources.filter((s) => s.source !== 'ruling'),
        { source: 'ruling', available: false, count: 0 },
      ],
    });
    mount('#/debug');
    const strip = await screen.findByTestId('sources-unavailable');
    expect(within(strip).getByText('ruling')).toBeTruthy();
    expect(within(strip).getByText(/did not say why/i)).toBeTruthy();
  });

  it('M7 — the empty state does not claim completeness when a source was unreadable', async () => {
    debugIndex.mockResolvedValue({ ...INDEX, entries: [] });
    mount('#/debug');
    expect(await screen.findByText(/could not be read at all/i)).toBeTruthy();
    expect(screen.queryByText(/Every source this console can read was searched/)).toBeNull();
  });

  it('M8 — the delivery tiles say when their window was cut', async () => {
    debugIndex.mockResolvedValue({ ...INDEX, entries: [], truncated: true });
    mount('#/debug/delivery');
    expect(await screen.findByTestId('delivery-truncated')).toBeTruthy();
  });

  it('M8 — and say nothing when it was not', async () => {
    mount('#/debug/delivery');
    await screen.findByText(/not “you saw it”/);
    expect(screen.queryByTestId('delivery-truncated')).toBeNull();
  });

  it('L6 — a quiet row is not described as a service that stayed silent', async () => {
    debugIndex.mockResolvedValue({
      ...INDEX,
      entries: [
        {
          source: 'delivery',
          at: '2026-09-01T10:00:00.000Z',
          level: 'info',
          event: 'delivery.quiet',
          text: 'Phone: quiet · Phase 3 done',
          data: { outcome: 'quiet', label: 'Phone', notification: 'n1' },
        },
      ],
    });
    mount('#/debug/delivery');
    const rows = await screen.findAllByRole('button', { expanded: false });
    fireEvent.click(rows[0]);
    // The ROW's sentence, not the vocabulary card's: both say "quiet hours",
    // and matching on the shared phrase would pass with the row unopened.
    expect(await screen.findByText(/^Nothing was attempted: the device/)).toBeTruthy();
    expect(screen.queryByText(/The service gave no reason/)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * QA round 2
 * ------------------------------------------------------------------ */

describe('the tail says only what it can measure', () => {
  it('M-D — draws no gap banner when nothing was dropped', async () => {
    // The round-1 banner keyed on a handshake guess and said "they are not
    // below" about rows the next tick delivers. Nothing referenced its
    // testid, so neutering it left the suite green.
    mount('#/debug?follow=1');
    await screen.findByText('the route threw');
    expect(screen.queryByTestId('tail-gap')).toBeNull();
  });

  it('M-D (round 3) — draws the gap banner when a frame arrives full, and keeps it', async () => {
    // Round 2 pinned the hook's `behind`; nothing pinned the wiring from it to
    // the rendered `<Banner data-testid="tail-gap">`, so breaking that left the
    // suite green. This drives the page's own stream.
    const real = globalThis.EventSource;
    (globalThis as { EventSource: unknown }).EventSource = DriveableEventSource;
    DriveableEventSource.last = null;
    try {
      mount('#/debug?follow=1');
      await screen.findByText('the route threw');
      // Read through a cast: the reset above narrows the static to `null` for TS.
      const stream = DriveableEventSource.last as DriveableEventSource | null;
      expect(stream).not.toBeNull();
      const line = (at: string) => ({
        source: 'journal',
        at,
        level: 'info',
        event: 'phase.boarded',
        text: 'a line',
      });
      act(() => {
        stream!.open();
        stream!.emit('entries', { entries: [line('2026-09-01T10:00:05.000Z')], capped: true });
      });
      expect(await screen.findByTestId('tail-gap')).toBeTruthy();
      // Sticky by intent: the rows that frame lost never arrive, so a quiet
      // frame after it does not close the hole on screen.
      act(() => {
        stream!.emit('entries', { entries: [line('2026-09-01T10:00:06.000Z')], capped: false });
      });
      expect(screen.queryByTestId('tail-gap')).not.toBeNull();
    } finally {
      (globalThis as { EventSource: unknown }).EventSource = real;
      DriveableEventSource.last = null;
    }
  });
});

describe('the delivery ledger renders the server’s answer', () => {
  it('L-E — shows the undelivered count rather than re-deriving one', async () => {
    // `undelivered` is not the `failed` count: a fan-out where one device took
    // it is delivered, and one every device held as `quiet` was never
    // attempted. Two implementations of that rule would be two answers.
    debugIndex.mockResolvedValue({
      ...INDEX,
      entries: [],
      delivery: { outcomes: { sent: 4, failed: 1 }, undelivered: 2, announcements: 5, devices: 3 },
    });
    mount('#/debug/delivery');
    const tally = await screen.findByTestId('delivery-tally');
    expect(tally.textContent).toContain('5 announcements');
    expect(tally.textContent).toContain('3 devices');
    expect(tally.textContent).toContain('2 reached nobody');
  });

  it('L-E — prefers the server’s per-outcome counts over the page it fetched', async () => {
    debugIndex.mockResolvedValue({
      ...INDEX,
      entries: [],
      delivery: { outcomes: { sent: 41 }, undelivered: 0, announcements: 41, devices: 1 },
    });
    mount('#/debug/delivery');
    // The tiles count the whole retained ledger, not the rows on this page.
    expect(await screen.findByText('41')).toBeTruthy();
  });
});

describe('the journal section', () => {
  it('L-F — says when a linked phase is not in the run being read', async () => {
    state.mockResolvedValue({ ...STATE, runs: [{ slug: 'demo' }] });
    debugRuns.mockResolvedValue({ slug: 'demo', runs: ['aaaa1111'] });
    runTimeline.mockResolvedValue({
      lanes: [
        { phase: 2, attempts: 1, workingMs: 1000, verifyingMs: 0, waitingMs: 0, frozenMs: 0, bars: [] },
      ],
      marks: [],
      spanMs: 1000,
      truncated: false,
      criticalPath: [],
      criticalMs: 0,
      startedAt: null,
      endedAt: null,
      horizonAt: null,
    });
    mount('#/debug/journal?slug=demo&run=aaaa1111&phase=9');
    // "That phase does not exist" and "you are looking at the wrong run" are
    // different answers, and a link to a phase another run boarded is a real
    // URL somebody arrives with.
    const note = await screen.findByTestId('phase-not-in-run');
    expect(note.textContent).toContain('run aaaa1111');
    expect(phaseDiagnosis).not.toHaveBeenCalled();
  });
});
