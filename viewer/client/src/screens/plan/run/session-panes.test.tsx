/**
 * The sessions of a run and their panes (7.0, quiet-console phase 12) — every
 * case of the 6.x session panes' suite, and the fold's section list.
 *
 *  1. **Two sessions, two windows.** When the narrowing is wrong nothing
 *     throws and the page renders perfectly: it just splices two sessions'
 *     sentences into one paragraph. So every case drives BOTH lanes and asserts
 *     on what the other pane did NOT get — through the real `EventSource` seam
 *     (named frame → `JSON.parse` → fan-out → predicate → fold).
 *  2. **A queued lane says why.** Every holder named, with the tokens that
 *     collided, the terminal's release, and the evidence a hold rests on.
 *  3. **The section list is the address.** `?lane=` picks the pane; every pane
 *     stays mounted with the others hidden; a pick whose lane has gone falls back.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseRecord, PhaseStatus, PlanDetail, QueueEntry, RunState, TranscriptEntry } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { __resetStreamForTests } from '@/data/live';
import { __resetShareForTests } from '@/data/live-share';
import {
  holderEvidenceText,
  holderLabel,
  queueEntryFor,
  sessionHolderText,
  waitingLabel,
} from '@/data/queue-words';
import { MemoryRouterProvider } from '@/shell/router';
import { runPaneHref } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import {
  ReleaseHold,
  ReplayNote,
  RunQueuedPane,
  RunSessionPanes,
  RunSessions,
  paneIdOf,
  pickPane,
  sessionLanesOf,
  type SessionLane,
} from './session-panes';

/* ------------------------------------------------------------------ *
 * A stream something can be pushed down
 * ------------------------------------------------------------------ */

/** The suite's own fake drops listeners; these cases need to BE the server. */
class DrivableEventSource {
  static latest: DrivableEventSource | null = null;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    DrivableEventSource.latest = this;
  }

  addEventListener(name: string, fn: (event: MessageEvent) => void): void {
    const set = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, set);
    set.add(fn);
  }

  removeEventListener(name: string, fn: (event: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(fn);
  }

  close(): void {
    this.readyState = 2;
  }

  /** Deliver one named frame exactly as the browser would. */
  send(name: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }
}

const emit = (name: string, data: unknown) =>
  act(() => {
    DrivableEventSource.latest?.send(name, data);
  });

// Assignment, not `defineProperty`: the setup's fake is writable and not configurable.
const slot = globalThis as unknown as { EventSource: unknown };
const original = slot.EventSource;

/** Every request this file's panes make, answered by path. */
const calls: { url: string; body: unknown }[] = [];
let answer: (url: string, init?: RequestInit) => Response = () => json({});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  __resetStreamForTests();
  DrivableEventSource.latest = null;
  slot.EventSource = DrivableEventSource;
  calls.length = 0;
  answer = (url) =>
    url.includes('/transcript') ? json([]) : url.includes('/messages') ? json({ messages: [] }) : json({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return answer(url, init);
    }),
  );
});

afterEach(() => {
  __resetStreamForTests();
  __resetShareForTests();
  slot.EventSource = original;
  vi.unstubAllGlobals();
});

/**
 * Mount with the replays already answered — `demo#r1` is the run's merged
 * replay, `demo#r1#6` phase 6's own — so the cases are about the live stream.
 */
function mount(
  node: ReactElement,
  {
    transcripts = {},
    detail,
    address = '#/plan/demo/run',
  }: {
    transcripts?: Record<string, TranscriptEntry[]>;
    detail?: { run: unknown; history: unknown[] };
    address?: string;
  } = {},
) {
  const client = new QueryClient(queryClientConfig);
  for (const [key, entries] of Object.entries(transcripts)) {
    const [slug, runId, phase] = key.split('#');
    const base = [...keys.transcript(slug!), runId ?? 'latest'];
    client.setQueryData(phase == null ? base : [...base, Number(phase)], entries);
  }
  client.setQueryData(keys.run('demo'), { eta: null, ...(detail ?? { run: null, history: [] }) });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouterProvider initial={address}>{node}</MemoryRouterProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function twoLanes(runId = 'r1') {
  return mount(
    <>
      <div data-testid="pane-6">
        <RunSessionPanes slug="demo" runId={runId} phase={6} live allowRun={false} />
      </div>
      <div data-testid="pane-7">
        <RunSessionPanes slug="demo" runId={runId} phase={7} live allowRun={false} />
      </div>
    </>,
    { transcripts: { [`demo#${runId}#6`]: [], [`demo#${runId}#7`]: [] } },
  );
}

const pane = (id: string | number) => within(screen.getByTestId(`pane-${id}`));

/* ------------------------------------------------------------------ *
 * 1 · Two sessions, two windows
 * ------------------------------------------------------------------ */

describe('two lanes of one run', () => {
  it('keeps each pane to its own phase, with both driven at once', () => {
    twoLanes();
    // Interleaved: a filter that merely ordered, or latched onto the first
    // phase it saw, passes a sequential fixture.
    emit('run:stream', { runId: 'r1', slug: 'demo', phase: 6, kind: 'text', text: 'six speaks' });
    emit('run:stream', { runId: 'r1', slug: 'demo', phase: 7, kind: 'text', text: 'seven speaks' });
    emit('run:stream', { runId: 'r1', slug: 'demo', phase: 6, kind: 'text', text: 'six again' });

    expect(pane(6).getByText('six speaks')).toBeInTheDocument();
    expect(pane(6).getByText('six again')).toBeInTheDocument();
    expect(pane(6).queryByText('seven speaks')).toBeNull();
    expect(pane(7).getByText('seven speaks')).toBeInTheDocument();
    expect(pane(7).queryByText('six speaks')).toBeNull();
  });

  it('ignores another RUN entirely, even on the same phase number', () => {
    twoLanes();
    emit('run:stream', { runId: 'other', slug: 'elsewhere', phase: 6, kind: 'text', text: 'not ours' });
    expect(pane(6).queryByText('not ours')).toBeNull();
    expect(pane(7).queryByText('not ours')).toBeNull();
  });

  it('resets the task list only for the phase whose session restarted', () => {
    twoLanes();
    emit('run:stream', {
      runId: 'r1',
      phase: 6,
      kind: 'todos',
      items: [{ content: 'six is working', status: 'pending' }],
    });
    emit('run:stream', {
      runId: 'r1',
      phase: 7,
      kind: 'todos',
      items: [{ content: 'seven is working', status: 'pending' }],
    });
    expect(pane(6).getByText('six is working')).toBeInTheDocument();
    expect(pane(7).getByText('seven is working')).toBeInTheDocument();

    // A phase starting is a new session with a new list — for that phase alone.
    emit('run:phase', { runId: 'r1', phase: 7, status: 'running', model: 'opus' });
    expect(pane(6).getByText('six is working')).toBeInTheDocument();
    expect(pane(7).queryByText('seven is working')).toBeNull();
  });

  it('routes the runner’s narration of a phase to that phase alone', () => {
    twoLanes();
    emit('run:verify', { runId: 'r1', phase: 7, command: 'npm test', index: 0, total: 2 });
    expect(pane(7).getByText('[1/2] npm test')).toBeInTheDocument();
    expect(pane(6).queryByText('[1/2] npm test')).toBeNull();
  });
});

describe('a pane that reads the whole run', () => {
  it('takes every lane of its own run, and nothing from any other', () => {
    mount(
      <div data-testid="pane-0">
        <RunSessionPanes slug="demo" runId="r1" live allowRun={false} />
      </div>,
      { transcripts: { 'demo#r1': [] } },
    );
    emit('run:stream', { runId: 'r1', phase: 6, kind: 'text', text: 'six speaks' });
    emit('run:stream', { runId: 'r1', phase: 7, kind: 'text', text: 'seven speaks' });
    emit('run:stream', { runId: 'other', phase: 6, kind: 'text', text: 'not ours' });

    expect(pane(0).getByText('six speaks')).toBeInTheDocument();
    expect(pane(0).getByText('seven speaks')).toBeInTheDocument();
    expect(pane(0).queryByText('not ours')).toBeNull();
  });
});

describe('the run’s own pane: narration, never a lane’s text or its task list', () => {
  const runPane = () =>
    mount(
      <div data-testid="pane-run">
        <RunSessionPanes slug="demo" runId="r1" live allowRun={false} runLevel />
      </div>,
      { transcripts: { 'demo#r1': [] } },
    );

  it('keeps the runner’s narration and drops the session text', () => {
    runPane();
    emit('run:stream', { runId: 'r1', slug: 'demo', phase: 6, kind: 'text', text: 'six speaks' });
    emit('run:phase', { runId: 'r1', phase: 6, status: 'running', model: 'opus' });
    expect(pane('run').queryByText('six speaks')).toBeNull();
    expect(pane('run').getByText(/phase 6 started on opus/)).toBeInTheDocument();
  });

  it('draws no task panels — the lanes own them, so no lane starting can wipe another', () => {
    runPane();
    emit('run:stream', {
      runId: 'r1',
      phase: 6,
      kind: 'todos',
      items: [{ content: 'six is working', status: 'pending' }],
    });
    emit('run:phase', { runId: 'r1', phase: 7, status: 'running', model: 'opus' });
    expect(pane('run').queryByText('six is working')).toBeNull();
    expect(pane('run').getByText(/text, task list and tool calls are in its pane/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * 2 · Which lanes exist, and which pane shows
 * ------------------------------------------------------------------ */

const run = (over: Partial<RunState> = {}): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    status: 'running',
    model: 'opus',
    phases: {},
    child: null,
    activePhase: null,
    ...over,
  }) as unknown as RunState;

/** Phase records arrive keyed by the phase number AS A STRING. */
const phases = (...records: ({ phase: number; status: PhaseStatus } & Partial<PhaseRecord>)[]) =>
  Object.fromEntries(records.map((r) => [String(r.phase), { attempts: 1, costUsd: 0, ...r }])) as Record<
    string,
    PhaseRecord
  >;

describe('sessionLanesOf', () => {
  it('is every phase with a pane worth showing, lowest first', () => {
    const lanes = sessionLanesOf(
      run({
        phases: phases(
          { phase: 7, status: 'running' },
          { phase: 2, status: 'done' },
          { phase: 4, status: 'queued' },
          { phase: 5, status: 'verifying' },
          { phase: 9, status: 'pending' },
          { phase: 3, status: 'awaiting-verification' },
        ),
      }),
    );
    expect(lanes.map((l) => l.phase)).toEqual([3, 4, 5, 7]);
    expect(lanes.map((l) => l.queued)).toEqual([false, true, false, false]);
    expect(lanes.map(paneIdOf)).toEqual(['p3', 'p4', 'p5', 'p7']);
  });

  it('gives a done phase a pane while a QA round is in flight on it, and names the round', () => {
    // `done` is the only status a review runs under, and the reviewer is a
    // session the run is paying for.
    const lanes = sessionLanesOf(
      run({
        phases: phases(
          { phase: 2, status: 'done' },
          {
            phase: 3,
            status: 'done',
            qaSession: {
              round: 2,
              report: 'reports/phase-03-qa-round2.md',
              startedAt: '2026-09-07T04:00:00.000Z',
            },
          },
        ),
      }),
    );
    expect(lanes.map((l) => l.phase)).toEqual([3]);
    expect(lanes[0]!.qa).toEqual({ round: 2 });
    expect(lanes[0]!.queued).toBe(false);
  });

  it('includes a queued phase, which has no session by definition', () => {
    const lanes = sessionLanesOf(run({ children: {}, phases: phases({ phase: 4, status: 'queued' }) }));
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.queued).toBe(true);
  });

  it('is empty for no run at all', () => {
    expect(sessionLanesOf(null)).toEqual([]);
    expect(sessionLanesOf(undefined)).toEqual([]);
  });
});

describe('pickPane', () => {
  const lane = (phase: number): SessionLane => ({
    slug: 'demo',
    runId: 'r1',
    phase,
    status: 'running',
    queued: false,
  });

  it('defaults to the sole lane — the session a person came to watch', () => {
    expect(pickPane(undefined, [lane(6)])).toBe('p6');
  });

  it('defaults to the run’s own pane with two lanes, or none', () => {
    expect(pickPane(undefined, [lane(6), lane(7)])).toBe('run');
    expect(pickPane(undefined, [])).toBe('run');
  });

  it('keeps a pick while its lane exists, and falls back when it has gone', () => {
    expect(pickPane('p7', [lane(6), lane(7)])).toBe('p7');
    expect(pickPane('p7', [lane(6)])).toBe('p6');
    expect(pickPane('run', [lane(6)])).toBe('run');
  });

  it('shows the waiting pane only while phases wait', () => {
    expect(pickPane('waiting', [lane(6), lane(7)], true)).toBe('waiting');
    expect(pickPane('waiting', [lane(6), lane(7)], false)).toBe('run');
    expect(pickPane('waiting', [lane(6)], false)).toBe('p6');
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The fold's body: the section list is the address
 * ------------------------------------------------------------------ */

/** Stamped when it is mounted: phase 6 boarded two minutes and five seconds before. */
const RUN = () =>
  run({
    activePhase: 6,
    phases: phases(
      { phase: 5, status: 'done' },
      {
        phase: 6,
        status: 'running',
        startedAt: new Date(Date.now() - 125_000).toISOString(),
        model: 'sonnet',
      },
      { phase: 7, status: 'queued', attempts: 0 },
      {
        phase: 8,
        status: 'done',
        qaSession: {
          round: 2,
          report: 'reports/phase-08-qa-round2.md',
          startedAt: '2026-09-07T04:00:00.000Z',
        },
      },
    ),
  });

const DETAIL = {
  summary: { slug: 'demo' },
  eta: null,
  phases: [
    { phase: 5, state: 'done', title: 'Five', gated: false },
    { phase: 6, state: 'in-progress', title: 'Six', gated: false },
    { phase: 7, state: 'ready', title: 'Seven', gated: false },
    { phase: 8, state: 'done', title: 'Eight', gated: false },
    { phase: 9, state: 'waiting', title: 'Nine', gated: false, analysis: { dependsOn: [6] } },
  ],
} as unknown as PlanDetail;

function mountSessions(address: string, over: { run?: RunState; live?: boolean } = {}) {
  const shown = over.run ?? RUN();
  return mount(
    <RunSessions
      slug="demo"
      run={shown}
      detail={DETAIL}
      live={over.live ?? true}
      allowRun
      enabled
      phaseEta={[{ phase: 6, weight: 1, estMs: 40 * 60_000, basis: 'plan', clock: 'working', label: '' }]}
    />,
    {
      address,
      detail: { run: shown, history: [] },
      transcripts: { 'demo#r1': [], 'demo#r1#6': [], 'demo#r1#8': [] },
    },
  );
}

const nav = () => within(screen.getByRole('navigation', { name: 'Sessions of this run' }));
const paneOf = (id: string) => document.querySelector(`[data-pane="${id}"]`) as HTMLElement | null;

describe('RunSessions — the section list', () => {
  it('links the run’s pane, each lane’s and the waiting phases, each to its own address', () => {
    mountSessions('#/plan/demo/run');
    const links = nav().getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Run3',
      'Phase 6',
      'Phase 7, queued',
      'Phase 8, QA round 2',
      'Waiting1',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      runPaneHref('demo', 'run'),
      runPaneHref('demo', 'p6'),
      runPaneHref('demo', 'p7'),
      runPaneHref('demo', 'p8'),
      runPaneHref('demo', 'waiting'),
    ]);
    expect(links[1]!.getAttribute('href')).toBe('#/plan/demo/run?lane=p6');
  });

  it('counts the lanes beside Run only when there is more than one', () => {
    mountSessions('#/plan/demo/run', {
      run: run({ phases: phases({ phase: 6, status: 'running' }) }),
    });
    expect(nav().getByRole('link', { name: 'Run' })).toBeInTheDocument();
  });

  it('?lane= picks the pane that shows; every other pane stays mounted, hidden', () => {
    mountSessions('#/plan/demo/run?lane=p6');
    expect(nav().getByRole('link', { name: 'Phase 6' })).toHaveAttribute('aria-current', 'page');
    expect(paneOf('p6')).not.toHaveAttribute('hidden');
    for (const id of ['run', 'p7', 'p8']) {
      expect(paneOf(id), id).toBeInTheDocument();
      expect(paneOf(id), id).toHaveAttribute('hidden');
    }
    // A lane pane, with its own console, and the queued one saying why.
    expect(within(paneOf('p6')!).getByRole('log', { name: 'Phase 6 console' })).toBeInTheDocument();
    expect(within(paneOf('p7')!).getByText('Phase 7 is queued')).toBeInTheDocument();
    // The waiting pane holds no stream, so it is not drawn until asked for.
    expect(paneOf('waiting')).toBeNull();
  });

  it('opens on the run’s own pane with several lanes and nothing asked', () => {
    mountSessions('#/plan/demo/run');
    expect(nav().getByRole('link', { name: /^Run/ })).toHaveAttribute('aria-current', 'page');
    expect(paneOf('run')).not.toHaveAttribute('hidden');
    expect(within(paneOf('run')!).getByRole('log', { name: 'Run console' })).toBeInTheDocument();
  });

  it('a pick whose lane has gone falls back', () => {
    mountSessions('#/plan/demo/run?lane=p12');
    expect(nav().getByRole('link', { name: /^Run/ })).toHaveAttribute('aria-current', 'page');
    expect(paneOf('run')).not.toHaveAttribute('hidden');
  });

  it('draws the waiting phases when asked, and only while the run is live', () => {
    mountSessions('#/plan/demo/run?lane=waiting');
    expect(paneOf('waiting')).toBeInTheDocument();
    expect(within(paneOf('waiting')!).getByTestId('waiting-phase')).toHaveAttribute('data-phase', '9');
  });

  it('a finished run has no Waiting', () => {
    mountSessions('#/plan/demo/run?lane=waiting', { live: false });
    expect(nav().queryByRole('link', { name: /Waiting/ })).toBeNull();
    expect(paneOf('waiting')).toBeNull();
  });

  it('heads a lane pane with its status, its vitals in words, and its controls', () => {
    mountSessions('#/plan/demo/run?lane=p6');
    const lane = within(paneOf('p6')!);
    expect(lane.getByText('Running')).toBeInTheDocument();
    expect(
      lane.getByText(/^sonnet, (worked|running) 2m \d\ds, expected ~40 min of work$/),
    ).toBeInTheDocument();
    expect(lane.getByRole('group', { name: 'Phase 6 session controls' })).toBeInTheDocument();
    // A QA round is a session at work on a phase the board reads done.
    expect(within(paneOf('p8')!).getByText('Running')).toBeInTheDocument();
  });

  it('aims the run pane’s ask box at the active phase', () => {
    mountSessions('#/plan/demo/run?lane=run');
    expect(within(paneOf('run')!).getByText('phase 6 on opus')).toBeInTheDocument();
    expect(within(paneOf('run')!).getByPlaceholderText('/btw ask the session running phase 6')).toBeEnabled();
  });
});

/* ------------------------------------------------------------------ *
 * 4 · A queued lane, and why
 * ------------------------------------------------------------------ */

const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
  id: 'q1',
  slug: 'demo',
  phase: 4,
  runId: 'r1',
  scope: ['packages/cart-api'],
  since: Date.now() - 90_000,
  waitingOn: [],
  bypassed: 0,
  reserving: false,
  ...over,
});

const holder = (over: Partial<QueueEntry['waitingOn'][number]> = {}): QueueEntry['waitingOn'][number] => ({
  kind: 'grant',
  slug: 'other-plan',
  phase: 2,
  owner: 'claude-a/session',
  scope: ['packages/cart-api'],
  overlaps: ['packages/cart-api'],
  ...over,
});

describe('the queue in words', () => {
  it('names the holder rather than repeating the state', () => {
    expect(waitingLabel(entry({ waitingOn: [holder()] }))).toBe('queued — waiting on other-plan P2');
  });

  it('counts the rest instead of running off the end of a cell', () => {
    expect(waitingLabel(entry({ waitingOn: [holder(), holder({ slug: 'third' })] }))).toBe(
      'queued — waiting on other-plan P2 +1',
    );
  });

  it('falls back to the bare word when the scheduler has named nobody', () => {
    expect(waitingLabel(entry())).toBe('queued');
    expect(waitingLabel(undefined)).toBe('queued');
  });

  it('reports the two non-scope blocks as themselves, not as a plan', () => {
    expect(holderLabel('reserved', 'session cap', null)).toBe('session cap');
    expect(holderLabel('lock', 'other-plan', 3)).toBe('other-plan P3 (lock)');
    expect(holderLabel('grant', 'other-plan', null)).toBe('other-plan');
  });

  it('matches an entry on plan AND phase, never on either alone', () => {
    const entries = [entry(), entry({ id: 'q2', slug: 'other', phase: 4 })];
    expect(queueEntryFor(entries, 'demo', 4)?.id).toBe('q1');
    expect(queueEntryFor(entries, 'other', 4)?.id).toBe('q2');
    expect(queueEntryFor(entries, 'demo', 5)).toBeUndefined();
    expect(queueEntryFor(undefined, 'demo', 4)).toBeUndefined();
  });
});

describe('a terminal session holding the queue', () => {
  const terminal = (over: Record<string, unknown> = {}) =>
    holder({
      kind: 'session',
      slug: 'demo',
      phase: null,
      owner: 'session f118dfd4 (pid 78963)',
      scope: ['app'],
      session: 'f118dfd4-aaaa',
      pid: 78963,
      cwd: '/w/hub',
      scopeBasis: 'touched',
      ...over,
    } as never);

  it('names the terminal, its pid, the scope it holds and how that scope was read', () => {
    expect(sessionHolderText(terminal())).toBe(
      'your terminal session f118dfd4, pid 78963 — scope app (from what it edited)',
    );
    expect(sessionHolderText(terminal({ scopeBasis: 'unknown', scope: ['all'] }))).toBe(
      'your terminal session f118dfd4, pid 78963 — scope all (nothing touched yet, so treated as that until its lease ends)',
    );
  });

  it('is what a cell says, never a bare "queued"', () => {
    expect(waitingLabel(entry({ waitingOn: [terminal()] }))).toBe(
      'queued — waiting on your terminal session f118dfd4, pid 78963 — scope app (from what it edited)',
    );
  });

  it('names what a touched hold rests on; a declared or unknown hold has no second line', () => {
    const touched = terminal({ evidence: ['edited app/src/b.ts at 08:47Z', 'named alpha P2'] });
    expect(holderEvidenceText(touched)).toBe('held because it edited app/src/b.ts at 08:47Z; named alpha P2');
    expect(holderEvidenceText(terminal({ evidence: [] }))).toBeNull();
    expect(
      holderEvidenceText(
        terminal({ scopeBasis: 'unknown', evidence: ['opened in the root, nothing touched yet'] }),
      ),
    ).toBeNull();
    expect(
      holderEvidenceText(terminal({ scopeBasis: 'declared', evidence: ['declared PE_SCOPE app'] })),
    ).toBeNull();
  });

  it('the queued pane prints the evidence under the terminal it names, with its release', () => {
    mount(
      <RunQueuedPane
        phase={4}
        entry={entry({ waitingOn: [terminal({ evidence: ['edited app/src/b.ts at 08:47Z'] })] })}
      />,
    );
    expect(screen.getByTestId('holder-session').textContent).toContain('your terminal session f118dfd4');
    expect(screen.getByTestId('holder-session').textContent).toContain('/w/hub');
    expect(screen.getByTestId('holder-evidence').textContent).toBe(
      'held because it edited app/src/b.ts at 08:47Z',
    );
    expect(screen.getByRole('button', { name: 'Release for 2 h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not working here' })).toBeInTheDocument();
  });
});

describe('RunQueuedPane', () => {
  it('says what it wants, what holds it, and how long it has waited', () => {
    mount(<RunQueuedPane phase={4} entry={entry({ waitingOn: [holder()] })} />);
    expect(screen.getByRole('heading', { name: 'Phase 4 is queued' })).toHaveAttribute(
      'title',
      expect.stringMatching(/Nothing has been spawned and no lock is held/),
    );
    // Twice, deliberately: the scope it wants, and the token that collided.
    expect(screen.getAllByText('packages/cart-api')).toHaveLength(2);
    expect(screen.getByText('other-plan P2')).toBeInTheDocument();
    expect(screen.getByText(/overlaps/)).toBeInTheDocument();
    expect(screen.getByTestId('queued-clock')).toHaveTextContent('queued 1m 30s');
  });

  it('still shows the declared scope before the scheduler has answered', () => {
    mount(<RunQueuedPane phase={4} scope={['docs-site']} />);
    expect(screen.getByText('docs-site')).toBeInTheDocument();
    expect(screen.getByText(/has not answered yet/)).toBeInTheDocument();
  });

  it('says an admitted phase with no holder is next', () => {
    mount(<RunQueuedPane phase={4} entry={entry()} />);
    expect(screen.getByText(/it is next/)).toBeInTheDocument();
  });

  it('names the branch a holder is on, when it declared one', () => {
    // Branch-disjoint claims are carved out of admission, so a holder that
    // names a branch is one whose branch was NOT disjoint from this phase's.
    mount(<RunQueuedPane phase={4} entry={entry({ waitingOn: [holder({ branch: 'pe/other-plan' })] })} />);
    expect(screen.getByTestId('holder-branch').textContent).toContain('pe/other-plan');
  });

  it('says nothing about a branch for a holder that declared none — absent is not a gap', () => {
    mount(<RunQueuedPane phase={4} entry={entry({ waitingOn: [holder()] })} />);
    expect(screen.queryByTestId('holder-branch')).toBeNull();
  });

  it('says when a phase has been passed over enough to reserve its scope', () => {
    mount(<RunQueuedPane phase={4} entry={entry({ bypassed: 3, reserving: true })} />);
    expect(screen.getByText(/Passed over 3 times/)).toBeInTheDocument();
    expect(screen.getByText(/Now reserving its scope/)).toBeInTheDocument();
  });

  it('puts the lane’s own control at the end of its head', () => {
    mount(<RunQueuedPane phase={4} entry={entry()} control={<span data-testid="stop">Stop</span>} />);
    expect(screen.getByTestId('stop')).toBeInTheDocument();
  });
});

describe('ReleaseHold', () => {
  it('releases for two hours, then says the queue no longer waits', async () => {
    answer = () => json({ ok: true, sessionId: 'f118dfd4-aaaa' });
    mount(<ReleaseHold sessionId="f118dfd4-aaaa" />);
    fireEvent.click(screen.getByRole('button', { name: 'Release for 2 h' }));
    expect(await screen.findByText('Released: the queue no longer waits on it.')).toBeInTheDocument();
    expect(calls).toEqual([{ url: '/api/sessions/f118dfd4-aaaa/release', body: { hours: 2 } }]);
  });

  it('releases for as long as the session lives, and says the server’s words when it refuses', async () => {
    answer = () => json({ error: 'releasing a hold needs --allow-run' }, 403);
    mount(<ReleaseHold sessionId="f118dfd4-aaaa" />);
    fireEvent.click(screen.getByRole('button', { name: 'Not working here' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not released: releasing a hold needs --allow-run',
    );
    expect(calls[0]).toEqual({ url: '/api/sessions/f118dfd4-aaaa/release', body: {} });
  });
});

/* ------------------------------------------------------------------ *
 * 5 · The replay, kept per phase
 * ------------------------------------------------------------------ */

describe('a lane’s replay', () => {
  const at = '2026-09-26T07:00:00.000Z';
  const line = (seq: number, data: Record<string, unknown>): TranscriptEntry => ({
    seq,
    at,
    event: 'stream',
    data,
  });

  it('hydrates from its own phase’s replay', () => {
    mount(
      <div data-testid="pane-6">
        <RunSessionPanes slug="demo" runId="r1" phase={6} live={false} allowRun={false} />
      </div>,
      {
        transcripts: {
          'demo#r1#6': [line(41, { phase: 6, kind: 'text', text: 'six, replayed after a reload' })],
        },
      },
    );
    expect(pane(6).getByText('six, replayed after a reload')).toBeInTheDocument();
    expect(pane(6).getByText('six, replayed after a reload').closest('.live-line')).toHaveClass(
      'is-replayed',
    );
  });

  it('shows the journal the server fell back to, and the line saying so', () => {
    mount(
      <div data-testid="pane-6">
        <RunSessionPanes slug="demo" runId="r1" phase={6} live={false} allowRun={false} />
      </div>,
      {
        transcripts: {
          'demo#r1#6': [
            line(0, {
              phase: 6,
              kind: 'notice',
              source: 'journal',
              text: 'Nothing was replayed for phase 6 — these are its journal lines instead',
            }),
            line(12, {
              phase: 6,
              kind: 'notice',
              source: 'journal',
              text: 'phase.parked — usage window spent',
            }),
          ],
        },
      },
    );
    expect(pane(6).getByText(/Nothing was replayed for phase 6/)).toBeInTheDocument();
    expect(pane(6).getByText('phase.parked — usage window spent')).toBeInTheDocument();
  });

  it('says when the replay nears its cap, from the phase record', () => {
    const replay = { state: 'near-full' as const, bytes: 13.5 * 1024 * 1024, cap: 16 * 1024 * 1024, at };
    mount(
      <div data-testid="pane-6">
        <RunSessionPanes slug="demo" runId="r1" phase={6} live allowRun={false} />
      </div>,
      {
        transcripts: { 'demo#r1#6': [] },
        detail: { run: { id: 'r1', phases: phases({ phase: 6, status: 'running', replay }) }, history: [] },
      },
    );
    expect(pane(6).getByRole('status')).toHaveTextContent('Phase 6’s replay is 84 % full (13.5 MB of 16 MB)');
  });

  it('says when the replay is full, and what a reload will show', () => {
    render(
      <ReplayNote
        phase={9}
        replay={{ state: 'full', bytes: 16 * 1024 * 1024 + 300, cap: 16 * 1024 * 1024, at }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Phase 9’s replay is full at 16 MB, so a reload shows it only up to that point.',
    );
  });
});

/* ------------------------------------------------------------------ *
 * 6 · The task list is seeded from the record
 * ------------------------------------------------------------------ */

describe('seeding the panel from the run record', () => {
  const TASKS = [
    { id: 'p8.task1', content: 'p8.task1 — write the writer', status: 'completed' },
    {
      id: 'p8.task2',
      content: 'p8.task2 — wire the runner',
      activeForm: 'Wiring the runner',
      status: 'in_progress',
    },
    { id: 'p8.task3', content: 'p8.task3 — ship it', status: 'pending' },
  ];
  const runWith = (tasks: typeof TASKS | undefined, id = 'r1') =>
    run({ id, phases: phases({ phase: 8, status: 'running', ...(tasks ? { tasks } : {}) }) });
  const lanePane = (runId = 'r1') => (
    <RunSessionPanes slug="demo" runId={runId} phase={8} live allowRun={false} />
  );

  it('shows the list a run ended on, with an empty replay', async () => {
    mount(lanePane(), { transcripts: { 'demo#r1#8': [] }, detail: { run: runWith(TASKS), history: [] } });
    expect(await screen.findByRole('heading', { name: 'Task list' })).toBeInTheDocument();
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument();
    // `activeForm` is what an in-progress row reads as: a state, not an order.
    expect(screen.getByText('Wiring the runner')).toBeInTheDocument();
  });

  it('shows nothing when the record has no list — no invented panel', () => {
    mount(lanePane(), { transcripts: { 'demo#r1#8': [] }, detail: { run: runWith(undefined), history: [] } });
    expect(screen.queryByRole('heading', { name: 'Task list' })).toBeNull();
  });

  it('does not seed a replay of a DIFFERENT run with the live one’s list', () => {
    mount(lanePane('r0'), {
      transcripts: { 'demo#r0#8': [] },
      detail: { run: runWith(TASKS, 'r1'), history: [] },
    });
    expect(screen.queryByRole('heading', { name: 'Task list' })).toBeNull();
  });

  it('finds the run in history too, so an old run replays its own list', async () => {
    mount(lanePane('r0'), {
      transcripts: { 'demo#r0#8': [] },
      detail: { run: runWith(undefined, 'r1'), history: [runWith(TASKS, 'r0')] },
    });
    await waitFor(() => expect(screen.getByText('1 of 3 done')).toBeInTheDocument());
  });
});
