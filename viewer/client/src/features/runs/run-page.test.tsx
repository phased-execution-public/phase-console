/**
 * The rest of Phase 4's load-bearing behaviour.
 *
 * Three things here are easy to break by accident and invisible when broken:
 *
 * 1. **The defaults.** They are one exported object read by the controls and
 *    asserted here, so "the Autopilot tab opens on opus/max/keep-going/trusted"
 *    is a fact rather than a thing someone once saw.
 * 2. **The console model's identity contract.** `activity()` returns the state
 *    it was given when nothing changed, and the React wrapper depends on that to
 *    avoid re-rendering three panels per streamed token.
 * 3. **The board gates the actions, not the run record.** The defect the phase
 *    table was rebuilt for is offering to re-run a phase the board calls done.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_ACTIVITY, activity, fold, toLine } from './console-model';
import { DEFAULTS, EFFORTS, MODELS, effortAlias, isLive, modelAlias } from './defaults';
import { LiveConsole } from './console';
import { displayState } from './phase-table';
import { seedSkills } from './lane-setup';
import { RunHeader, RunTiles, phaseProgress } from './tiles';
import { RUN_SECTIONS, RunSection } from './run-sections';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { phaseActions } from '@shared/phase-model.js';
import { keys, queryClientConfig } from '@/lib/queries';
import type { PhaseReport, RunState } from '@/lib/api';

/** RunHeader reads the accounts cache for the paying-account chip. */
function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('DEFAULTS', () => {
  it('opens a fresh run on opus / max / keep-going / trusted', () => {
    expect(DEFAULTS).toEqual({
      model: 'opus',
      effort: 'max',
      autonomy: 'keep-going',
      permissionProfile: 'trusted',
    });
  });

  it('offers every default as a real choice in its own vocabulary', () => {
    // A default the select cannot show is a form that opens on a blank field.
    expect(MODELS).toContain(DEFAULTS.model);
    expect(EFFORTS).toContain(DEFAULTS.effort);
  });

  it('is frozen, so a view cannot edit the opening posture for everyone else', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
  });
});

describe('isLive', () => {
  it('counts frozen as live — there is a child holding a session', () => {
    // Treating it as idle would offer a Start button that refuses because a run
    // is already in progress.
    expect(isLive('frozen')).toBe(true);
    for (const s of ['running', 'waiting', 'pausing', 'stopping', 'halting']) expect(isLive(s)).toBe(true);
    for (const s of ['finished', 'halted', 'paused', 'interrupted']) expect(isLive(s)).toBe(false);
    expect(isLive(undefined)).toBe(false);
  });

  it('counts queued as live too, read from the other end', () => {
    // It holds no child and no lock — which is exactly why the SERVER keeps it
    // out of its own `IN_FLIGHT` — but a loop is behind it, sitting in
    // `admit()`. The client's question is "do the controls for a running run
    // apply", and for a queued one they do: Start would 409.
    expect(isLive('queued')).toBe(true);
  });
});

describe('plan-prose aliases', () => {
  it('reads a model or an effort out of a plan bullet, and only a known one', () => {
    expect(modelAlias('**Model:** Opus 5, because the reasoning is hard')).toBe('opus');
    expect(effortAlias('run this at MAX effort')).toBe('max');
    expect(modelAlias('whatever is cheapest')).toBeUndefined();
    expect(effortAlias(undefined)).toBeUndefined();
  });
});

describe('the console model, as React consumes it', () => {
  it('returns the SAME object when an event changes nothing', () => {
    // The contract the whole live console rests on: `setPanels(current =>
    // activity(current, …))` with an unchanged reference is a bail-out, not a
    // re-render. Roughly nine in ten stream events are this case.
    const before = NO_ACTIVITY;
    const after = activity(before, 'stream', { kind: 'partial', text: 'thinking…' });
    expect(after).toBe(before);
  });

  it('returns a NEW object when a tool call opens', () => {
    const after = activity(NO_ACTIVITY, 'stream', { kind: 'tool', id: 't1', name: 'Bash' });
    expect(after).not.toBe(NO_ACTIVITY);
    expect(after.tools).toHaveLength(1);
    // `null`, not absent: "still running" is a state the panel renders.
    expect(after.tools[0].ok).toBeNull();
    expect(after.tools[0].ms).toBeNull();
  });

  it('resets the task list when a new phase starts', () => {
    const withTodos = activity(NO_ACTIVITY, 'stream', {
      kind: 'todos',
      items: [{ content: 'do it', status: 'pending' }],
    });
    expect(withTodos.todos).toHaveLength(1);
    const next = activity(withTodos, 'phase', { phase: 2, status: 'running' });
    expect(next.todos).toEqual([]);
  });

  it('folds streamed fragments into one line rather than one line per token', () => {
    let lines = fold([], toLine('stream', { kind: 'partial', text: 'Hel' })!, 1);
    lines = fold(lines, toLine('stream', { kind: 'partial', text: 'lo' })!, 2);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Hello');
  });

  it('keeps two subagents apart by the call that started them', () => {
    // Without `parent` these interleaved into one line, legible as neither.
    let lines = fold([], toLine('stream', { kind: 'subagent', text: 'A1', parent: 'a' })!, 1);
    lines = fold(lines, toLine('stream', { kind: 'subagent', text: 'B1', parent: 'b' })!, 2);
    expect(lines).toHaveLength(2);
  });
});

describe('LiveConsole', () => {
  it('says what it will show rather than rendering an empty box', () => {
    render(<LiveConsole lines={[]} />);
    expect(screen.getByText(/Nothing to show yet/)).toBeInTheDocument();
    expect(screen.getByRole('log')).toHaveAttribute('aria-live', 'polite');
  });

  it('hides the quiet kinds until Detail is asked for, and counts them', () => {
    const lines = [
      { id: 1, kind: 'tool', text: 'Bash', at: 0 },
      { id: 2, kind: 'thinking', text: 'hmm', at: 0 },
      { id: 3, kind: 'hook', text: 'a hook', at: 0 },
    ];
    render(<LiveConsole lines={lines} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.queryByText('hmm')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Detail \(2\)/ })).toBeInTheDocument();
    expect(screen.getByText(/1 lines/)).toBeInTheDocument();
  });
});

describe('displayState — Boarding is not what a phase being worked on says', () => {
  // "Boarding" is the departures word for the engine's `ready`, which is read
  // from handoff files. Retry a phase and the board goes on saying it for as
  // long as it takes the session to write one — an hour is normal — while the
  // run has demonstrably started work. The row showed only the stale word.
  // The rule keys on the ROW's own record being live-running — not on
  // `run.activePhase`, which mirrors only the LOWEST live lane and sent every
  // other running lane straight back to "Boarding".
  it('shows a phase whose own record is live-running as in progress', () => {
    expect(displayState('ready', { running: true })).toBe('in-progress');
    expect(displayState('waiting', { running: true })).toBe('in-progress');
  });

  it('never overrules the board on done — that is the board reporting work finished', () => {
    expect(displayState('done', { running: true })).toBe('done');
  });

  it('leaves every other row exactly as the board reported it', () => {
    // Not running: the record is settled, or the console is not live — either
    // way there is no fresher fact to prefer and the board is all there is.
    expect(displayState('ready', { running: false })).toBe('ready');
    expect(displayState('blocked', { running: false })).toBe('blocked');
  });
});

describe('phaseActions — the board gates every action', () => {
  const ctx = { live: false, allowRun: true };

  it('never offers to run a phase the board calls done', () => {
    // Even when this run's own record says it failed. The record is what THAT
    // RUN did; the board is what is true now.
    const done = { phase: 1, state: 'done', record: { status: 'failed' } };
    expect(phaseActions(done, ctx)).toMatchObject({ runAlone: false, retry: false, skip: false });
  });

  it('offers Run only this for a ready phase, and not for a waiting one', () => {
    expect(phaseActions({ phase: 2, state: 'ready' }, ctx).runAlone).toBe(true);
    expect(phaseActions({ phase: 3, state: 'waiting' }, ctx).runAlone).toBe(false);
  });

  it('offers a diagnosis even on a console that cannot act', () => {
    // Reading the evidence changes nothing; refusing to show it is what sent
    // people to a terminal.
    const stalled = { phase: 2, state: 'ready', record: { status: 'failed' } };
    expect(phaseActions(stalled, { live: false, allowRun: false }).diagnose).toBe(true);
  });

  it('offers nothing that acts while a loop is driving, except Skip', () => {
    const failed = { phase: 2, state: 'ready', record: { status: 'failed' } };
    const live = phaseActions(failed, { live: true, allowRun: true });
    expect(live).toMatchObject({ runAlone: false, retry: false, skip: true });
  });
});

describe('seedSkills — which boxes the picker opens with ticked', () => {
  it('gives a run that does not exist yet the machine defaults', () => {
    expect(seedSkills(null, ['graph-tool'])).toEqual(['graph-tool']);
  });

  it('lets an existing run answer for itself, empty list included', () => {
    // THE case this exists for. `state.skills` is deleted when it is empty, so
    // an absent list on a REAL run means the operator turned them all off —
    // and `run.skills ?? defaults` would put the boxes straight back, making
    // them impossible to untick.
    const run = { id: 'r1' } as unknown as RunState;
    expect(seedSkills(run, ['graph-tool'])).toEqual([]);
  });

  it('shows an existing run its own list, not the machine one', () => {
    const run = { id: 'r1', skills: ['investigate'] } as unknown as RunState;
    expect(seedSkills(run, ['graph-tool'])).toEqual(['investigate']);
  });

  it('hands back a copy, so editing the picker cannot edit console state', () => {
    const defaults = ['graph-tool'];
    seedSkills(null, defaults).push('something-else');
    expect(defaults).toEqual(['graph-tool']);
  });
});

describe('phaseProgress — a running phase against its estimate', () => {
  it('shows the estimate while the phase is inside it, naming its clock', () => {
    expect(phaseProgress(10 * 60_000, 40 * 60_000)).toBe('~40 min of work');
  });

  it('says "over estimate" rather than counting down to zero', () => {
    // A clock that reaches 0:00 and stops reads as "it is stuck", which is the
    // one thing an over-running phase most reliably is not.
    expect(phaseProgress(90 * 60_000, 40 * 60_000)).toBe('over estimate');
  });

  it('renders nothing at all without an estimate', () => {
    expect(phaseProgress(60_000, undefined)).toBeNull();
    expect(phaseProgress(60_000, 0)).toBeNull();
  });
});

/**
 * The header's icons are decoration, and decoration that reaches the
 * accessibility tree stops being decoration: the phase clock would announce
 * itself as "timer 12m" and every text query for the time would start matching
 * an icon too. So the property worth holding is not which glyph was chosen —
 * it is that none of them adds a word.
 */
describe('the run header emphasis', () => {
  const RUN = {
    id: 'r1',
    slug: 'demo',
    status: 'running',
    model: 'opus',
    effort: 'max',
    autonomy: 'keep-going',
    spentUsd: 0,
    createdAt: '2026-08-04T10:00:00Z',
    updatedAt: '2026-08-04T10:20:00Z',
    activePhase: 2,
    child: { pid: 1, phase: 2, sessionId: 's', startedAt: '2026-08-04T10:10:00Z' },
  } as unknown as RunState;

  it('SW-7 (#100 ask 4): a run with no accountId names the machine login it is spending, never nothing', () => {
    const client = new QueryClient(queryClientConfig);
    client.setQueryData(keys.accounts(), {
      accounts: [
        { id: 'default', kind: 'default', builtIn: true, name: 'default', email: 'info@example.com' },
      ],
      allowAccounts: true,
    });
    render(
      <QueryClientProvider client={client}>
        <RunHeader run={{ ...RUN, accountId: undefined } as RunState} live={false} eta={null} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('machine login · info@example.com')).toBeTruthy();
  });

  it('names the run’s own clock in words, and gives the icons no voice (the attempt clock is the strip’s, #28)', () => {
    const { container } = mount(<RunHeader run={RUN} live={false} eta={null} />);
    // A labelled clock, never a bare figure: `ran 20m 00s`, the run's own.
    expect(screen.getByTestId('run-clock').textContent).toMatch(/^ran \d/);
    // The status word and the attempt clock are drawn once — by the strip above.
    expect(container.querySelector('[data-status]')).toBeNull();
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden');
    }
  });

  it('the model tile still reads as its model, icons and all', () => {
    const { container } = render(<RunTiles run={RUN} phases={[]} />);

    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('opus')).toBeInTheDocument();
    expect(screen.getByText(/max effort · keep-going/)).toBeInTheDocument();
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden');
    }
  });

  it('#91: the model tile says what the request resolved to, when it moved, and that the run is pinned', () => {
    const { unmount } = render(<RunTiles run={RUN} phases={[]} />);
    expect(screen.queryByTestId('resolved-model')).toBeNull();
    unmount();
    render(
      <RunTiles
        run={{
          ...RUN,
          modelPolicy: 'pinned',
          resolvedModels: {
            opus: { resolved: 'claude-opus-5-5', at: '2026-09-24T10:00:00Z', from: 'claude-opus-5' },
          },
        }}
        phases={[]}
      />,
    );
    const line = screen.getByTestId('resolved-model');
    expect(line).toHaveTextContent('resolves to claude-opus-5-5');
    expect(line).toHaveTextContent('moved from claude-opus-5');
    expect(line).toHaveTextContent('pinned');
    // Which model ran is the fix's evidence, not a hint: it reads in muted ink,
    // which holds AA at the hint's 12 px where faint ink does not (the e2e register).
    expect(screen.getByText('resolves to claude-opus-5-5')).toHaveClass('text-ink-muted');
  });
});

describe('the completion promise', () => {
  const LIVE = {
    id: 'r1',
    slug: 'demo',
    status: 'running',
    model: 'opus',
    autonomy: 'keep-going',
    spentUsd: 0,
    maxConsecutiveFailures: 2,
    consecutiveFailures: 0,
    createdAt: '2026-08-04T10:00:00Z',
    updatedAt: '2026-08-04T10:20:00Z',
    activePhase: 2,
    child: null,
    phases: {},
  } as unknown as RunState;

  it('a keep-going unscoped run says it drives to plan completion, with the budget when spent', () => {
    mount(<RunHeader run={{ ...LIVE, consecutiveFailures: 1 } as RunState} live eta={null} />);
    expect(screen.getByText('runs to plan completion')).toBeTruthy();
    expect(screen.getByText('failures 1/2')).toBeTruthy();
  });

  it('a scoped run makes no completion promise, and a clean streak shows no failure figure', () => {
    mount(<RunHeader run={{ ...LIVE, onlyPhases: [4] } as RunState} live eta={null} />);
    expect(screen.queryByText('runs to plan completion')).toBeNull();
    expect(screen.queryByText(/^failures /)).toBeNull();
  });

  it('#148: a run asleep on a clock nobody paused reads "waiting", and says on what and until when', () => {
    const until = '2099-09-26T08:57:36.000Z';
    const asleep = {
      ...LIVE,
      status: 'paused',
      stoppedBy: 'system',
      pause: null,
      waitUntil: until,
      waitReason: 'external',
      phases: {
        '10': { phase: 10, status: 'waiting', parkedUntil: until, watch: [], declared: { by: 'watchdog' } },
      },
    } as unknown as RunState;
    mount(<RunHeader run={asleep} live={false} eta={null} />);
    // The word itself is the strip's (control-tower phase 24); the facts line
    // says what it waits on and until when, and never calls it paused.
    expect(screen.queryByText('paused')).toBeNull();
    expect(screen.getByTestId('run-wait-note').textContent).toBe(
      'on phase 10 · its own job · resumes Sep 26 08:57Z',
    );
  });
});

describe("the Phases done tile counts the PLAN, not the run's records", () => {
  const WEDGED = {
    id: 'r1',
    slug: 'demo',
    status: 'parked',
    model: 'opus',
    effort: 'max',
    autonomy: 'keep-going',
    spentUsd: 0,
    createdAt: '2026-08-22T10:00:00Z',
    updatedAt: '2026-08-22T14:00:00Z',
  } as unknown as RunState;

  // A run holds a record only for phases it actually boarded. On a plan wedged
  // after two of eight phases, both records read `done` — so the tile above the
  // fold read "2 / 2", which is what a finished run looks like, while the board
  // said 2/8 and six phases were held. The denominator has to come from the
  // plan, which the page already has.
  it('uses the plan total when it is known', () => {
    const { container } = render(
      <RunTiles
        run={WEDGED}
        phases={
          [
            { phase: 1, status: 'done', attempts: 1 },
            { phase: 3, status: 'done', attempts: 1 },
          ] as never
        }
        total={8}
      />,
    );
    expect(container.textContent).toContain('/ 8');
    expect(container.textContent).not.toContain('/ 2');
  });

  it('falls back to the record count when the plan detail has not loaded', () => {
    const { container } = render(
      <RunTiles run={WEDGED} phases={[{ phase: 1, status: 'done', attempts: 1 }] as never} />,
    );
    expect(container.textContent).toContain('/ 1');
  });
});

describe('spend that was never reported is named, not shown as zero', () => {
  const LOST = {
    id: 'r2',
    slug: 'demo',
    status: 'parked',
    model: 'opus',
    effort: 'max',
    autonomy: 'keep-going',
    spentUsd: 0,
    createdAt: '2026-08-22T10:00:00Z',
    updatedAt: '2026-08-22T14:00:00Z',
  } as unknown as RunState;

  it('says the figure is a floor when a session ran and reported nothing', () => {
    const { container } = render(
      <RunTiles
        run={LOST}
        phases={[{ phase: 1, status: 'done', attempts: 1, costUsd: 0, costUnknown: true }] as never}
        total={3}
      />,
    );
    expect(container.textContent).toMatch(/at least/);
    expect(container.textContent).toMatch(/phase 1/);
  });

  // Run deadaff9 (autopilot-token-drain H7): the tile read $266.34 while
  // $111.87 was running in live sessions, because a session is booked only
  // when it ends. Both halves, side by side, and never summed into one figure
  // that would hide which half can still grow.
  it("shows the live sessions' running cost beside the booked spend", () => {
    const { container } = render(
      <RunTiles
        run={{ ...LOST, status: 'running', spentUsd: 266.34 } as RunState}
        phases={[{ phase: 1, status: 'done', attempts: 1, costUsd: 266.34 }] as never}
        total={3}
        liveness={[{ phase: 2, spentUsd: 80.68 }, { phase: 3, spentUsd: 31.19 }, { phase: 4 }] as never}
      />,
    );
    expect(container.textContent).toContain('$266.34');
    expect(container.textContent).toMatch(/\+\s*\$111\.87 live/);
    expect(container.textContent).not.toContain('$378.21');
  });

  it('claims nothing live when no session in flight has reported a cost', () => {
    const { container } = render(
      <RunTiles
        run={{ ...LOST, spentUsd: 12 } as RunState}
        phases={[{ phase: 1, status: 'done', attempts: 1, costUsd: 12 }] as never}
        total={3}
        liveness={[{ phase: 2 }] as never}
      />,
    );
    expect(container.textContent).not.toMatch(/live/);
  });

  it('is unchanged when every phase reported its spend', () => {
    const { container } = render(
      <RunTiles
        run={LOST}
        phases={[{ phase: 1, status: 'done', attempts: 1, costUsd: 12 }] as never}
        total={3}
      />,
    );
    expect(container.textContent).not.toMatch(/at least/);
  });
});

describe('the run page shows a Now panel per live lane (control-tower phase 95, #163)', () => {
  it("draws each live phase's report under the tiles, and the page mounts it for a live run", async () => {
    const { LiveNow } = await import('./now-panel');
    const REPORT: PhaseReport = {
      slug: 'demo',
      runId: 'r1',
      phase: 11,
      at: '2026-09-26T10:56:00Z',
      status: 'running',
      live: true,
      doing: {
        operation: {
          label: 'iOS sweep vendor',
          done: 45,
          of: 68,
          pct: 66,
          at: '2026-09-26T10:50:00Z',
          source: [],
        },
      },
      done: { count: 0, total: 0, items: [] },
      left: { count: 0, items: [] },
      waitingOn: [],
      whySlow: [],
      eta: {
        minutes: null,
        confidence: 'none',
        basis: 'no task has finished and no operation reports progress',
        source: [],
      },
      timeline: [],
      summary: 'Phase 11 is running.',
    };
    const client = new QueryClient({
      ...queryClientConfig,
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData([...keys.phaseNow('demo'), '11', 'report'], REPORT);
    client.setQueryData([...keys.phaseNow('demo'), '12', 'report'], { ...REPORT, phase: 12, live: false });
    render(
      <QueryClientProvider client={client}>
        <LiveNow slug="demo" phases={[11, 12]} />
      </QueryClientProvider>,
    );
    const panels = screen.getAllByTestId('now-panel');
    expect(panels).toHaveLength(1);
    expect(panels[0]).toHaveTextContent('Now — phase 11');
    expect(panels[0]).toHaveTextContent('iOS sweep vendor: 45/68');
    const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'run-page.tsx'), 'utf8');
    expect(page).toMatch(/\{run && live && \(\s*<LiveNow\s+slug=\{slug\}/);
  });
});

describe('the run page’s folds: named, counted while folded, remembered (control-tower phase 24)', () => {
  beforeEach(() => setPrefs({ runSectionsOpen: [] }));

  it('names what it holds and draws its count while folded — and only while folded', () => {
    render(
      <RunSection id="journal" name="Journal" count={42}>
        <p>the lines</p>
      </RunSection>,
    );
    const toggle = screen.getByRole('button', { name: /Journal/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('run-section-count').textContent).toBe('(42)');
    expect(screen.queryByText('the lines')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('the lines')).toBeTruthy();
    // Open, the count has done its job: the fold's own content says how much.
    expect(screen.queryByTestId('run-section-count')).toBeNull();
  });

  it('remembers each fold per person — open stays open on the next visit, and one fold never opens another', () => {
    const page = () => (
      <>
        <RunSection id="journal" name="Journal" count={2}>
          <p>the lines</p>
        </RunSection>
        <RunSection id="notes" name="Notes" count={1}>
          <p>the note</p>
        </RunSection>
      </>
    );
    const first = render(page());
    fireEvent.click(screen.getByRole('button', { name: /Journal/ }));
    expect(getPrefs().runSectionsOpen).toEqual(['journal']);
    first.unmount();

    render(page());
    expect(screen.getByRole('button', { name: /Journal/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Notes/ })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: /Journal/ }));
    expect(getPrefs().runSectionsOpen).toEqual([]);
  });

  it('keeps the console’s fold mounted while folded — hidden, never unmounted — so no stream line is lost', () => {
    render(
      <RunSection id="sessions" name="Sessions and their consoles" count={1} keepMounted>
        <p>a live line</p>
      </RunSection>,
    );
    const line = screen.getByText('a live line', { selector: 'p' });
    expect(line.closest('[hidden]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Sessions and their consoles/ }));
    expect(screen.getByText('a live line').closest('[hidden]')).toBeNull();
  });

  it('opens for a link into it, whatever the preference says', () => {
    render(
      <RunSection id="journal" name="Journal" count={2} forceOpen>
        <p>the linked line</p>
      </RunSection>,
    );
    expect(screen.getByText('the linked line')).toBeTruthy();
    expect(getPrefs().runSectionsOpen).toEqual([]);
  });

  it('every fold the page draws is a declared section, drawn once', () => {
    const source = (name: string) =>
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), 'utf8');
    const files = ['run-page.tsx'];
    const ids = [
      ...files
        .map(source)
        .join('\n')
        .matchAll(/<RunSection\s+id="([a-z-]+)"/g),
    ].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(8);
    for (const id of ids) expect(RUN_SECTIONS).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
