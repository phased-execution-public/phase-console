/**
 * Logs ▸ Journal (7.0, quiet-console phase 20) — the journal cases of 6.2's
 * Debug page suite, ported to the kit's pickers and the run view's own Gantt.
 *
 * The section is a READER: a plan that has run, one of its runs (finished ones
 * included), the run's timeline, and the server's diagnosis of one phase. What
 * is pinned is what a reader would otherwise be misled by:
 *
 *  - **A 404 diagnosis is an ANSWER** — no run of this plan has a record of the
 *    phase — and any other failure is an error that says so, with a retry.
 *  - **A phase the run never boarded is said so and never asked about**: "that
 *    phase does not exist" and "you are reading another run" are different
 *    answers, and the request would come back with the wrong one.
 *  - **Only plans that ran are offered**, plus the one the address names.
 *  - **Choosing narrows honestly**: a new plan drops the run and the phase that
 *    named things in the old one, a new run drops the phase.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { PhaseDiagnosis, RunTimeline, TimelineLane } from '@/data/api';
import { ApiError } from '@/data/http';
import { queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import JournalSection from './journal-section';

// jsdom has no pointer capture, and Radix's Select asks for it before it opens.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.setPointerCapture ??= () => {};

const MIN = 60_000;

/* ---------------- the server's answers ---------------- */

function lane(over: Partial<TimelineLane> & { phase: number }): TimelineLane {
  return {
    bars: [{ kind: 'working', startMs: 0, endMs: 10 * MIN, attempt: 1, open: false }],
    startMs: 0,
    endMs: 10 * MIN,
    totalMs: 10 * MIN,
    workingMs: 10 * MIN,
    verifyingMs: 0,
    queuedMs: 0,
    waitingMs: 0,
    downMs: 0,
    frozenMs: 0,
    measuredMs: 10 * MIN,
    attempts: 1,
    partial: false,
    critical: false,
    ...over,
  };
}

function timeline(over: Partial<RunTimeline> = {}): RunTimeline {
  return {
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T11:00:00.000Z',
    horizonAt: '2026-09-01T11:00:00.000Z',
    spanMs: 60 * MIN,
    lanes: [lane({ phase: 2 }), lane({ phase: 3 })],
    marks: [],
    criticalPath: [],
    criticalMs: 0,
    truncated: false,
    unmapped: 0,
    ...over,
  };
}

function diagnosis(over: Partial<PhaseDiagnosis> = {}): PhaseDiagnosis {
  return {
    runId: 'aaaa1111',
    phase: 2,
    status: 'parked',
    blockedOn: 'verification',
    boardState: 'in-progress',
    said: 'The suite went red on the second run.',
    verification: null,
    verifiedIn: '.',
    lint: { ok: true, summary: 'LINT OK' },
    closeout: null,
    sessionId: 'sess-1',
    resumable: true,
    note: 'resumed once after a wall',
    workingTree: ['a.ts', 'b.ts'],
    lock: 'held by autopilot/aaaa1111',
    actions: [],
    situation: {
      id: 'verify-failed',
      key: 'verify-failed',
      label: 'Verification failed',
      blurb: 'a command in §Verification exited non-zero',
      actor: 'machine',
      why: [],
    },
    evidence: ['board reads in-progress', 'the handoff is missing'],
    ...over,
  };
}

/** The runs list every page holds — only the slug matters to the pickers. */
const ran = (...slugs: string[]) => slugs.map((slug, i) => ({ id: `run-${i}`, slug }));

/** Each plan's journal directory, newest first. */
let runsOf: Record<string, string[]> = {};

/* ---------------- the page ---------------- */

function mount(address = '#/logs/journal') {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <TooltipProvider>
          <JournalSection route={parseHash(address) as Route} />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

const callsTo = (prefix: string) => server.calls.filter((one) => one.startsWith(prefix));
const diagnosisCalls = () => server.calls.filter((one) => one.includes('/diagnosis/'));

/** A KeyValue's rows inside `root`, label → its value cell. */
function facts(root: HTMLElement): Record<string, HTMLElement> {
  return Object.fromEntries(
    [...root.querySelectorAll('dt')].map((dt) => [
      dt.textContent ?? '',
      dt.nextElementSibling as HTMLElement,
    ]),
  );
}

const openPointer = { button: 0, ctrlKey: false, pointerType: 'mouse' };
const picker = (name: 'Plan' | 'Run' | 'Phase') => screen.getByRole('combobox', { name });

/** Open a picker and read its options, in order. */
async function optionsOf(name: 'Plan' | 'Run' | 'Phase'): Promise<string[]> {
  fireEvent.pointerDown(picker(name), openPointer);
  const list = await screen.findByRole('listbox');
  const options = within(list)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
  fireEvent.keyDown(list, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  return options;
}

/** Choose an option the way the keyboard does — the deterministic path in jsdom. */
async function choose(name: 'Plan' | 'Run' | 'Phase', option: string) {
  fireEvent.pointerDown(picker(name), openPointer);
  const list = await screen.findByRole('listbox');
  fireEvent.keyDown(within(list).getByRole('option', { name: option }), { key: 'Enter' });
}

beforeEach(() => {
  window.location.hash = '';
  server.calls = [];
  runsOf = { demo: ['aaaa1111', 'bbbb2222'], other: ['cccc3333'] };
  server.reads = {
    '/api/runs': ran('demo', 'other', 'demo'),
    '/api/debug/runs': (path: string) => {
      const slug = new URLSearchParams(path.split('?')[1]).get('slug') ?? '';
      return { slug, runs: runsOf[slug] ?? [] };
    },
    // The plan's newest run, asked before its journal directory has answered.
    '/api/run/demo/timeline': timeline(),
    '/api/run/demo/timeline/aaaa1111': timeline(),
    '/api/run/demo/timeline/bbbb2222': timeline({ lanes: [lane({ phase: 1 })] }),
    '/api/run/demo/diagnosis/2': diagnosis(),
  };
});

/* ------------------------------------------------------------------ *
 * Which run
 * ------------------------------------------------------------------ */

describe('which run the journal reads', () => {
  it('says no run has been recorded rather than drawing an empty axis', async () => {
    server.reads['/api/runs'] = [];
    mount();
    expect(await screen.findByText(/^No run has been recorded here\./)).toBeInTheDocument();
    expect(screen.queryByTestId('journal')).toBeNull();
    expect(callsTo('/api/run/')).toEqual([]);
  });

  it('offers the plans that have actually run, once each and sorted, and reads the first one’s newest run', async () => {
    mount();
    expect(await screen.findByTestId('journal')).toBeInTheDocument();
    expect(await optionsOf('Plan')).toEqual(['demo', 'other']);
    await waitFor(() => expect(callsTo('/api/run/demo/timeline/aaaa1111')).toHaveLength(1));
    expect(callsTo('/api/debug/runs')).toEqual(['/api/debug/runs?slug=demo']);
    await waitFor(() => expect(picker('Run')).toBeEnabled());
    expect(await optionsOf('Run')).toEqual(['aaaa1111', 'bbbb2222']);
  });

  it('answers a plan the address names even when the run list has not heard of it', async () => {
    runsOf.ghost = ['dddd4444'];
    server.reads['/api/run/ghost/timeline/dddd4444'] = timeline();
    server.reads['/api/run/ghost/timeline'] = timeline();
    mount('#/logs/journal?slug=ghost');
    await screen.findByTestId('journal');
    expect(await optionsOf('Plan')).toEqual(['demo', 'ghost', 'other']);
    await waitFor(() => expect(callsTo('/api/run/ghost/timeline/dddd4444')).toHaveLength(1));
  });

  it('offers this run’s export as a real download of its redacted files', async () => {
    mount('#/logs/journal?slug=demo&run=aaaa1111');
    const link = await screen.findByRole('link', { name: 'Export this run' });
    expect(link).toHaveAttribute('href', '/api/debug/bundle?slug=demo&run=aaaa1111&download=1');
    expect(link).toHaveAttribute('download');
  });

  it('a new plan drops the run and the phase that named things in the old one', async () => {
    mount('#/logs/journal?slug=demo&run=aaaa1111&phase=2');
    await screen.findByTestId('journal');
    await choose('Plan', 'other');
    expect(window.location.hash).toBe('#/logs/journal?slug=other');
  });

  it('a new run drops the phase, and a phase keeps the plan and the run', async () => {
    mount('#/logs/journal?slug=demo&run=aaaa1111&phase=2');
    await screen.findByTestId('journal');
    await waitFor(() => expect(picker('Run')).toBeEnabled());
    await choose('Run', 'bbbb2222');
    expect(window.location.hash).toBe('#/logs/journal?slug=demo&run=bbbb2222');

    await waitFor(() => expect(picker('Phase')).toBeEnabled());
    expect(await optionsOf('Phase')).toEqual(['Phase 2', 'Phase 3']);
    await choose('Phase', 'Phase 3');
    expect(window.location.hash).toBe('#/logs/journal?slug=demo&run=aaaa1111&phase=3');
  });
});

/* ------------------------------------------------------------------ *
 * The run as it happened
 * ------------------------------------------------------------------ */

describe('the run, drawn as it happened', () => {
  it('draws the run view’s own Gantt over the server’s timeline, a row per phase', async () => {
    mount('#/logs/journal?slug=demo&run=aaaa1111');
    const gantt = await screen.findByTestId('run-gantt');
    expect(within(gantt).getByRole('img', { name: /^phase 2:/ })).toBeInTheDocument();
    expect(within(gantt).getByRole('img', { name: /^phase 3:/ })).toBeInTheDocument();
  });

  it('admits a journal longer than the projection read, rather than drawing a confident wrong picture', async () => {
    server.reads['/api/run/demo/timeline/aaaa1111'] = timeline({ truncated: true });
    mount('#/logs/journal?slug=demo&run=aaaa1111');
    const banner = await screen.findByText(/longer than the projection reads/);
    expect(banner.closest('[data-severity]')).toHaveAttribute('data-severity', 'warn');
  });

  it('opens a phase with two attempts from its lane, into the address', async () => {
    server.reads['/api/run/demo/timeline/aaaa1111'] = timeline({ lanes: [lane({ phase: 2, attempts: 2 })] });
    mount('#/logs/journal?slug=demo&run=aaaa1111');
    fireEvent.click(await screen.findByRole('button', { name: "Compare phase 2's 2 attempts" }));
    expect(window.location.hash).toBe('#/logs/journal?slug=demo&run=aaaa1111&phase=2');
  });

  it('says the timeline could not be read, in its own words, with a way to ask again', async () => {
    let asks = 0;
    server.reads['/api/run/demo/timeline/aaaa1111'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('the journal is locked', 503, '/api/run/demo/timeline/aaaa1111');
      return timeline();
    };
    mount('#/logs/journal?slug=demo&run=aaaa1111');
    const failed = await screen.findByText('The run’s timeline could not be read: the journal is locked');
    expect(failed.closest('[data-severity]')).toHaveAttribute('data-severity', 'error');
    expect(screen.queryByTestId('run-gantt')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('run-gantt')).toBeInTheDocument();
    expect(asks).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Why phase N is not done
 * ------------------------------------------------------------------ */

describe('why a phase is not done', () => {
  it('asks the reader to pick a phase, and asks the server nothing, when none is named', async () => {
    mount('#/logs/journal?slug=demo&run=aaaa1111');
    const why = await screen.findByTestId('diagnosis');
    expect(within(why).getByRole('heading', { name: 'Why a phase is not done' })).toBeInTheDocument();
    expect(why).toHaveTextContent('Pick a phase above');
    await screen.findByTestId('run-gantt');
    expect(diagnosisCalls()).toEqual([]);
  });

  it('says when a linked phase is not in the run being read, and never asks about it', async () => {
    mount('#/logs/journal?slug=demo&run=aaaa1111&phase=9');
    // "That phase does not exist" and "you are reading another run" are
    // different answers, and a link to a phase another run boarded is a real
    // address somebody arrives with.
    const note = await screen.findByTestId('phase-not-in-run');
    expect(note).toHaveTextContent('Phase 9 is not in run aaaa1111. Pick one of its phases above.');
    expect(within(screen.getByTestId('diagnosis')).getByRole('heading')).toHaveTextContent(
      'Why a phase is not done',
    );
    expect(diagnosisCalls()).toEqual([]);
    expect(screen.queryByText(/has a record of phase/)).toBeNull();
  });

  it('draws the server’s diagnosis of a phase the run boarded, every fact it sent', async () => {
    mount('#/logs/journal?slug=demo&run=aaaa1111&phase=2');
    const why = await screen.findByTestId('diagnosis');
    expect(await within(why).findByRole('heading', { name: 'Why phase 2 is not done' })).toBeInTheDocument();
    await waitFor(() => expect(facts(why).Status).toHaveTextContent('parked'));
    const rows = facts(why);
    expect(Object.keys(rows)).toEqual([
      'Status',
      'Blocked on',
      'Situation',
      'Last words',
      'Note',
      'Resumable',
      'Lint',
      'Lock',
      'Uncommitted',
      'Evidence',
    ]);
    expect(rows['Blocked on']).toHaveTextContent('verification');
    expect(rows.Situation).toHaveTextContent(
      'Verification failed — a command in §Verification exited non-zero',
    );
    expect(rows['Last words']).toHaveTextContent('The suite went red on the second run.');
    expect(rows.Note).toHaveTextContent('resumed once after a wall');
    expect(rows.Resumable).toHaveTextContent('yes');
    expect(rows.Lint).toHaveTextContent('LINT OK');
    expect(rows.Lock).toHaveTextContent('held by autopilot/aaaa1111');
    expect(rows.Uncommitted).toHaveTextContent('a.ts, b.ts');
    expect(rows.Evidence).toHaveTextContent('board reads in-progress; the handoff is missing');
    expect(diagnosisCalls()).toEqual(['/api/run/demo/diagnosis/2']);
  });

  it('leaves out what the diagnosis did not say, and says no for a phase that cannot resume', async () => {
    server.reads['/api/run/demo/diagnosis/2'] = diagnosis({
      status: '',
      blockedOn: null,
      situation: null,
      said: null,
      note: null,
      resumable: false,
      lint: null,
      lock: null,
      workingTree: [],
      evidence: [],
    });
    mount('#/logs/journal?slug=demo&run=aaaa1111&phase=2');
    const why = await screen.findByTestId('diagnosis');
    await waitFor(() => expect(facts(why).Status).toBeDefined());
    const rows = facts(why);
    expect(Object.keys(rows)).toEqual(['Status', 'Resumable']);
    expect(rows.Status).toHaveTextContent('unknown');
    expect(rows.Resumable).toHaveTextContent('no');
  });

  it('a 404 from the diagnosis is an answer — no run of the plan has a record of the phase', async () => {
    server.reads['/api/run/demo/diagnosis/2'] = new ApiError('no record', 404, '/api/run/demo/diagnosis/2');
    mount('#/logs/journal?slug=demo&run=aaaa1111&phase=2');
    expect(await screen.findByText('No run of demo has a record of phase 2.')).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a non-404 diagnosis failure is an error, not "no record of that phase" — and Try again asks again', async () => {
    let asks = 0;
    server.reads['/api/run/demo/diagnosis/2'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('the console is not answering', 500, '/api/run/demo/diagnosis/2');
      return diagnosis();
    };
    mount('#/logs/journal?slug=demo&phase=2');
    const failed = await screen.findByText('The diagnosis could not be read: the console is not answering');
    expect(failed.closest('[data-severity]')).toHaveAttribute('data-severity', 'error');
    expect(screen.queryByText(/has a record of phase/i)).toBeNull();

    fireEvent.click(within(screen.getByTestId('diagnosis')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(facts(screen.getByTestId('diagnosis')).Status).toHaveTextContent('parked'));
    expect(asks).toBe(2);
  });
});

