/**
 * The findings of the departure notice (quiet-console phase 13, exit criterion
 * 3): sorted blocking → warning → advice whatever order they were found in,
 * each with its own way forward, and a blocking decision holds Launch with the
 * reason in its title — the one rule (`launchHold`) the form, the footer and
 * this list read.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/data/keys';
import { FINDING_RANKS, Findings, launchHold } from './findings';
import { SetupFormProvider, type SetupForm } from './form-context';
import { shows } from './model/modes';
import { EMPTY, type RunSetupField } from './model/schema';
import { LaunchShell } from './shell';

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  verifyPreflight: vi.fn(),
  runPrelude: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const OK = { status: 'ok', ok: true, reason: 'fine' };

/** A prelude found out of order: the advice first, a warning, then what holds Launch. */
const PRELUDE = {
  slug: 'alpha',
  rows: [],
  blocking: [{ key: 'credentials', why: 'outstanding — owed by the operator' }],
  waived: [],
  acknowledged: [],
  manifestPresent: true,
  probes: {
    trees: {
      status: 'ok',
      ok: true,
      reason: 'another run holds `api` on `pe/other` (run r9 of other)',
      detail: { held: [{ repo: 'api', branch: 'pe/other', run: 'r9', slug: 'other' }], isolated: false },
    },
    accounts: { status: 'fail', ok: false, reason: '0 of 1 declared account usable' },
    mcp: OK,
    credentials: OK,
    delivery: OK,
  },
  accounts: [{ id: 'default', minHeadroomPct: 0 }],
  credentials: { policy: 'continue', ids: [], held: [], missing: [] },
  delivery: { ok: true, channels: ['1 subscribed device'], acknowledged: false },
  at: '2026-10-10T00:00:00.000Z',
};

const PHASES = [
  { phase: 1, title: 'one', state: 'done', size: 'S', weight: 1, gated: false },
  { phase: 2, title: 'two', state: 'ready', size: 'M', weight: 1, gated: false },
];

/** The form as the launch publishes it — only what the findings read is real. */
function form(over: Partial<SetupForm> = {}): SetupForm {
  const mode = over.mode ?? 'start';
  return {
    mode,
    context: { slug: 'alpha', run: null },
    values: EMPTY,
    seed: EMPTY,
    origins: {},
    errors: {},
    set: vi.fn(),
    on: (field: RunSetupField) => shows(mode, field),
    live: (field: RunSetupField) => shows(mode, field),
    src: () => undefined,
    fx: () => undefined,
    planPhases: PHASES,
    goCategory: vi.fn(),
    permissionName: (choice: string) => choice,
    accountName: (id: string) => id,
    ...over,
  } as unknown as SetupForm;
}

function mount(value: SetupForm, children = <Findings />) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <SetupFormProvider value={value}>{children}</SetupFormProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.plan.mockResolvedValue({ phases: PHASES, batches: { groups: [], raw: '', budget: '200K' } });
  mocks.verifyPreflight.mockResolvedValue({
    phases: [{ phase: 2, warnings: [{ kind: 'nothing-runnable', message: 'no runnable §Verification' }] }],
    computedAt: '2026-10-10T00:00:00Z',
  });
  mocks.runPrelude.mockResolvedValue({ prelude: PRELUDE });
});

describe('the findings', () => {
  it('are drawn blocking → warning → advice, whatever order they were found in', async () => {
    mount(form());
    await screen.findByText('Another run holds a tree this plan needs.');
    await screen.findByText('1 phase will park at boarding');
    const lines = within(screen.getByRole('list', { name: 'Before you launch' })).getAllByRole('listitem');
    expect(lines.map((line) => line.getAttribute('data-finding'))).toEqual([
      'decisions',
      'probe-accounts',
      'boarding-park',
      'trees',
    ]);
    const ranks = lines.map((line) => line.getAttribute('data-rank')!);
    expect(ranks).toEqual(['blocking', 'warning', 'warning', 'advice']);
    // Never out of rank order, by construction.
    const order = ranks.map((rank) => FINDING_RANKS.indexOf(rank as (typeof FINDING_RANKS)[number]));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // What holds Launch is the summons: the one amber, and a word for it.
    expect(lines[0]!.className).toContain('state-needs-you');
    expect(within(lines[0]!).getByRole('img', { name: 'Holds Launch' })).toBeTruthy();
    expect(lines[0]!.textContent).toContain('credentials: outstanding — owed by the operator');
  });

  it('each carries its own way forward, and the way forward opens the row that answers it', async () => {
    const value = form();
    mount(value);
    await screen.findByText('Another run holds a tree this plan needs.');
    await screen.findByText('1 phase will park at boarding');
    const action = (id: string) =>
      within(document.querySelector(`li[data-finding="${id}"]`) as HTMLElement).getByRole('button');
    expect(action('decisions')).toHaveAccessibleName('Answer');
    expect(action('probe-accounts')).toHaveAccessibleName('Open');
    expect(action('boarding-park')).toHaveAccessibleName('Narrow the scope');
    expect(action('trees')).toHaveAccessibleName('Give this run its own checkout');
    fireEvent.click(action('decisions'));
    expect(value.goCategory).toHaveBeenLastCalledWith('decisions');
    fireEvent.click(action('probe-accounts'));
    expect(value.goCategory).toHaveBeenLastCalledWith('accounts');
    fireEvent.click(action('boarding-park'));
    expect(value.goCategory).toHaveBeenLastCalledWith('scope');
    // The tree's way forward IS the answer: a work branch in a checkout of its own.
    fireEvent.click(action('trees'));
    expect(value.set).toHaveBeenCalledWith('gitMode', 'new-branch');
    expect(value.goCategory).toHaveBeenLastCalledWith('git');
  });

  it('say nothing at all when there is nothing to say', async () => {
    mocks.runPrelude.mockResolvedValue({
      prelude: { ...PRELUDE, blocking: [], probes: { accounts: OK, mcp: OK, credentials: OK, delivery: OK } },
    });
    mocks.verifyPreflight.mockResolvedValue({ phases: [], computedAt: '' });
    const view = mount(form());
    await vi.waitFor(() => expect(mocks.runPrelude).toHaveBeenCalled());
    expect(view.container.querySelector('[data-testid="launch-findings"]')).toBeNull();
  });
});

describe('what holds Launch', () => {
  const values = { manifestOverride: '', gitStrategyAck: '' as const };
  const asked = { asks: true, gitAsked: true, pending: false };
  const prelude = PRELUDE as unknown as Parameters<typeof launchHold>[1];

  it('is an open decision first, named with its reason', () => {
    expect(launchHold(values, prelude, asked)).toBe(
      'Decision outstanding: credentials — outstanding — owed by the operator',
    );
  });

  it('is nothing once a person signed the override, and nothing for a launch that asks no prelude', () => {
    expect(launchHold({ ...values, manifestOverride: 'me, on purpose' }, prelude, asked)).toBeUndefined();
    expect(launchHold(values, prelude, { ...asked, asks: false })).toBeUndefined();
  });

  it('is the plan’s git lines next, then the first read still in flight', () => {
    const lines = {
      ...PRELUDE,
      blocking: [],
      probes: {
        ...PRELUDE.probes,
        'git-strategy': { status: 'fail', ok: false, reason: 'x', detail: { lines: [{}] } },
      },
    } as unknown as Parameters<typeof launchHold>[1];
    expect(launchHold(values, lines, asked)).toBe(
      'Answer the plan’s git lines first — honour or override, in Git.',
    );
    expect(launchHold({ ...values, gitStrategyAck: 'override' as never }, lines, asked)).toBeUndefined();
    expect(launchHold(values, undefined, { ...asked, pending: true })).toBe('Reading this plan’s decisions…');
  });

  it('holds the one ink Launch with the reason in its title and in the footer', async () => {
    const reason = launchHold(values, prelude, asked)!;
    mount(
      form(),
      <LaunchShell
        open
        onOpenChange={() => {}}
        title="Start a run"
        mode="start"
        staged
        submit={{
          label: 'Start',
          busy: false,
          disabled: true,
          title: reason,
          onSubmit: () => {},
          note: reason,
        }}
      >
        <Findings />
      </LaunchShell>,
    );
    const launch = await screen.findByTestId('launch-submit');
    expect(launch).toBeDisabled();
    expect(launch.getAttribute('title')).toBe(reason);
    expect(screen.getByTestId('launch-note').textContent).toBe(reason);
    // The finding that holds it is on screen above, with its own way forward.
    const held = (await screen.findByText('Launch waits for a decision.')).closest('li[data-finding]')!;
    expect(held.getAttribute('data-rank')).toBe('blocking');
    expect(within(held as HTMLElement).getByRole('button', { name: 'Answer' })).toBeTruthy();
  });
});
