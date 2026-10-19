/**
 * The inspector's Actions tab (quiet-console phase 26, exit criterion 2): every
 * record kind's tab lists exactly the verbs that name that kind of record.
 *
 * The kinds are the table's own: each operator verb names one record — the
 * console, a plan, a run, a phase, a trigger or a permission card — derived
 * from its route and its CLI shape, so a verb is in exactly one tab. In it, an
 * act the record's identity is enough for is pressed, after a confirm, with
 * that identity where the CLI would send it (a phase rides the body of `pin`);
 * one that takes more is a link to where it is drawn, never a blind press; a
 * verb whose flag the console lacks says which. A phase's tab adds its place in
 * the queue — hold, release, defer, withdraw, requeue — through `useQueueAct`.
 */

import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_VERBS, VERB_NAMES } from '@shared/verb-model.js';
import { queryClientConfig } from '@/data/keys';
import { SURFACE } from '@/data/surface';
import type { VerbArgs } from '@/data/verbs';
import { ActionsTab } from './actions-tab';
import { RECORD_KINDS, verbIdentity, verbsOf, type Capabilities, type RecordKind } from './verbs';

const { pressVerb, queueAct, state } = vi.hoisted(() => ({
  pressVerb: vi.fn(),
  queueAct: vi.fn(),
  state: vi.fn(),
}));

// The press itself is `data/verbs.ts`'s and is tested there; what is the tab's
// is WHICH verb it hands over, and with what.
vi.mock('@/data/verbs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/verbs')>()),
  pressVerb,
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, queueAct, state } };
});

/** Each kind's record, named whole. */
const FULL: Readonly<Record<RecordKind, VerbArgs>> = {
  console: {},
  plan: { slug: 'demo' },
  run: { slug: 'demo', runId: 'r1' },
  phase: { slug: 'demo', phase: 3 },
  trigger: { slug: 'demo', id: 't1' },
  approval: { id: 'c1' },
};

const RUN: Capabilities = { allowRun: true };

/** `wait` is a script's long poll, handed over as its line where this tree's CLI runs it. */
const LINES_ONLY_SHOWN: readonly string[] = [
];

const REGISTERED = new Set(SURFACE.filter((row) => row.kind === 'verb').map((row) => row.verb));
const kindOf = (name: string) =>
  (OPERATOR_VERBS as readonly { name: string; kind: string }[]).find((verb) => verb.name === name)!.kind;

function mount(kind: RecordKind | readonly RecordKind[], args: VerbArgs, capabilities?: Capabilities) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const ui: ReactElement = <ActionsTab kind={kind} args={args} capabilities={capabilities} />;
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** A group's rows, by the name each is drawn under, in order. */
const namesIn = (group: string) =>
  within(screen.getByRole('group', { name: group }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('span span')?.textContent);

/** Press, then confirm — the way every act here is taken. */
function pressTwice(name: string, scope: HTMLElement = document.body) {
  fireEvent.click(within(scope).getByRole('button', { name: `Press ${name}` }));
  fireEvent.click(within(scope).getByRole('button', { name: `Confirm ${name}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue({});
  pressVerb.mockResolvedValue({ state: 'done', result: {} });
  queueAct.mockResolvedValue({ change: { verb: 'hold', slug: 'demo', phase: 3, changed: true } });
});

describe('the record kinds', () => {
  it('gives every verb of the table exactly one', () => {
    const lists = RECORD_KINDS.map((kind) => verbsOf(kind));
    const all = lists.flat();
    expect([...all].sort()).toEqual([...VERB_NAMES].sort());
    expect(new Set(all).size).toBe(all.length);
    for (const name of VERB_NAMES) expect(RECORD_KINDS).toContain(verbIdentity(name).record);
  });

  it('reads it from the route and the CLI, and overrides only where that spelling under-tells', () => {
    expect(verbsOf('plan')).toEqual(['start']);
    expect(verbsOf('trigger')).toEqual(['cancel-trigger']);
    expect(verbsOf('approval')).toEqual(['approve', 'deny']);
    expect(verbsOf('console')).toEqual([
      'runs',
      'status',
      'queue',
      'accounts',
      'approvals',
      'queue-policy',
    ]);
    // A positional `phase`, a `:n` in the route, and the switch's rows that read `body.phase`.
    expect(verbsOf('phase')).toEqual(
      expect.arrayContaining([
        'tail',
        'retry',
        'bump',
        'pin',
        'yield',
        'errand-answered',
        'skip',
        'plan-approval',
      ]),
    );
    expect(verbsOf('run')).toEqual(expect.arrayContaining(['pause', 'journal', 'stop', 'freeze', 'resolve']));
    expect(verbIdentity('resolve').fields).toEqual(['slug', 'runId']);
    expect(verbIdentity('errand-answered').fields).toEqual(['slug', 'phase']);
    expect(verbIdentity('switch-account').fields).toEqual(['slug']);
  });
});

describe('the tab', () => {
  it.each(RECORD_KINDS)('lists exactly the verbs of a %s — its acts, then its reads', (kind) => {
    mount(kind, FULL[kind], RUN);
    const mine = verbsOf(kind).filter(
      (name) => REGISTERED.has(name) && (name !== 'wait' || LINES_ONLY_SHOWN.includes(name)),
    );
    const acts = mine.filter((name) => kindOf(name) === 'act');
    const reads = mine.filter((name) => kindOf(name) === 'read');
    if (acts.length) expect(namesIn('Acts')).toEqual(acts);
    else expect(screen.queryByRole('group', { name: 'Acts' })).toBeNull();
    if (reads.length) expect(namesIn('Reads')).toEqual(reads);
    else expect(screen.queryByRole('group', { name: 'Reads' })).toBeNull();
    // Only a phase has a place in the queue.
    expect(screen.queryByRole('group', { name: 'Queue' }) !== null).toBe(kind === 'phase');
  });

  it('lists a plan’s verbs and its run’s together, once the plan has a run', () => {
    mount(['plan', 'run'], { slug: 'demo', runId: 'r1' }, RUN);
    const acts = namesIn('Acts');
    expect(acts).toContain('start');
    expect(acts).toContain('pause');
  });

  it('disables an act the console has no flag for, and names the flag', () => {
    mount('run', FULL.run, {});
    const pause = screen.getByRole('button', { name: 'Press pause' });
    expect(pause).toBeDisabled();
    expect(within(pause.closest('li')!).getByText('Needs --allow-run on this console.')).toBeInTheDocument();
    // One that takes more says so too, and opens nothing.
    expect(screen.getByRole('button', { name: 'Open note' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Open note' })).toBeNull();
    // A read needs no flag.
    expect(screen.getByRole('link', { name: 'Open journal' })).toHaveAttribute('href', '#/plan/demo/run');
  });

  it('reads the console’s flags itself when it is not handed them', async () => {
    state.mockResolvedValue({ allowRun: true });
    mount('run', FULL.run);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Press pause' })).toBeEnabled());
  });

  it('offers an act that takes more than a press as a link to where it is drawn — never a blind press', () => {
    mount('phase', FULL.phase, RUN);
    const steer = screen.getByRole('link', { name: 'Open steer' });
    expect(steer).toHaveAttribute('href', '#/plan/demo/run');
    expect(
      within(steer.closest('li')!).getByText('Takes the words to send: open it where it is drawn.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Press steer' })).toBeNull();
  });

  it('presses a phase’s verb with its slug and phase where the CLI sends them — and only once confirmed', async () => {
    mount('phase', FULL.phase, RUN);
    fireEvent.click(screen.getByRole('button', { name: 'Press pin' }));
    expect(pressVerb).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pin' }));
    await waitFor(() => expect(pressVerb).toHaveBeenCalledWith('pin', {}, { slug: 'demo', phase: 3 }));
    pressTwice('retry');
    await waitFor(() => expect(pressVerb).toHaveBeenCalledWith('retry', { slug: 'demo' }, { phase: 3 }));
    pressTwice('errand-answered');
    await waitFor(() =>
      expect(pressVerb).toHaveBeenCalledWith('errand-answered', { slug: 'demo', n: 3 }, {}),
    );
  });

  it('presses a run’s card dismissal at the run it names', async () => {
    mount('run', FULL.run, RUN);
    pressTwice('resolve');
    await waitFor(() => expect(pressVerb).toHaveBeenCalledWith('resolve', { slug: 'demo' }, { runId: 'r1' }));
  });

  it('presses a card’s verb at the card, with the decision its route reads from the body', async () => {
    mount('approval', FULL.approval, RUN);
    pressTwice('deny');
    await waitFor(() => expect(pressVerb).toHaveBeenCalledWith('deny', { id: 'c1' }, { decision: 'deny' }));
  });

});

describe('a phase’s place in the queue', () => {
  const queue = () => screen.getByRole('group', { name: 'Queue' });

  it('holds, defers to the time chosen and requeues at the front — through useQueueAct', async () => {
    mount('phase', FULL.phase, RUN);
    expect(namesIn('Queue')).toEqual([
      'Hold in the queue',
      'Release',
      'Defer until…',
      'Withdraw',
      'Requeue at the front',
    ]);

    pressTwice('Hold in the queue', queue());
    await waitFor(() => expect(queueAct).toHaveBeenCalledWith('hold', { slug: 'demo', phase: 3 }));

    fireEvent.change(within(queue()).getByRole('combobox', { name: 'Defer until' }), {
      target: { value: '240' },
    });
    const before = Date.now();
    pressTwice('Defer until', queue());
    await waitFor(() =>
      expect(queueAct).toHaveBeenCalledWith('defer', expect.objectContaining({ slug: 'demo', phase: 3 })),
    );
    const [, body] = queueAct.mock.calls.find(([verb]) => verb === 'defer') as [string, { until: string }];
    const ahead = Date.parse(body.until) - before;
    expect(ahead).toBeGreaterThanOrEqual(240 * 60_000 - 1_000);
    expect(ahead).toBeLessThan(241 * 60_000);

    pressTwice('Requeue at the front', queue());
    await waitFor(() =>
      expect(queueAct).toHaveBeenCalledWith('requeue', { slug: 'demo', phase: 3, position: 'front' }),
    );
  });

  it('disables every move without --allow-run, naming the flag', () => {
    mount('phase', FULL.phase, {});
    for (const button of within(queue()).getAllByRole('button')) expect(button).toBeDisabled();
    expect(within(queue()).getAllByText('Needs --allow-run on this console.')).toHaveLength(5);
  });
});
