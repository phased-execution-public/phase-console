/**
 * The write menu (7.0, quiet-console phase 9, exit criterion 4; ported from
 * `components/write-menu.test.tsx`).
 *
 * What is pinned: the eight acts are the eight 6.2 sent, each with 6.2's
 * payload byte for byte (`{action, ...base, ...values}`; `reopen-plan {slug}`;
 * `open-editor {path}`); the menu is gated on `allowWrites` — a header draws
 * nothing, the phase panel says what the flag would give; Close and Reopen are
 * never offered together; the lock offers Release or Claim by its lease; and
 * nothing runs before the exact command has been shown by a dry run.
 *
 * The close-plan preview (#247) waits for what a person waits for — the
 * command on screen carrying the reason that was typed — never for "a call"
 * and then the last one: under a full suite's load the last call can still be
 * the preview of the empty form.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOFF_STATUSES, QA_RESULTS } from '@shared/plan-vocab.js';
import type { PhaseView, PlanDetail, WriteRequest } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { ScaffoldPlanDialog, WRITE_ACTIONS, WriteMenu } from './write-menu';

vi.setConfig({ testTimeout: 20_000 });

const { write } = vi.hoisted(() => ({ write: vi.fn() }));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, write } };
});

/** The dry run's answer: the invocation, spelled from the body it was asked about. */
const commandFor = (body: WriteRequest): string =>
  `${String(body.action)}.sh ${Object.entries(body)
    .filter(([key]) => key !== 'action')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')}`;

beforeEach(() => {
  localStorage.clear();
  write
    .mockReset()
    .mockImplementation(async (body: WriteRequest, dry?: boolean) =>
      dry
        ? { dryRun: true, command: commandFor(body) }
        : { ok: true, code: 0, stdout: 'written', stderr: '' },
    );
});

function mount(node: React.ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const DETAIL = {
  summary: { slug: 'demo', title: 'demo plan', kind: 'plan', status: 'active', phases: 3, ready: [2] },
  plan: { path: '/repo/docs/plans/demo.md' },
  phases: [],
} as unknown as PlanDetail;

const CLOSED = {
  ...DETAIL,
  summary: { ...DETAIL.summary, status: 'abandoned', closed: true },
} as unknown as PlanDetail;

const PHASE = {
  phase: 2,
  title: 'the thing',
  state: 'ready',
  size: 'M',
  weight: 40_000,
  gated: false,
  bullets: [],
} as unknown as PhaseView;

/** The calls that RAN something — a dry run carries `true` as its second argument. */
const runs = () => write.mock.calls.filter((call) => call[1] !== true);

/** Wait for the command on screen — what a person waits for before pressing Run. */
const preview = (text: RegExp) =>
  waitFor(() => expect(screen.getByTestId('write-preview')).toHaveTextContent(text), { timeout: 10_000 });

describe('the eight acts (criterion 4)', () => {
  it('are the eight 6.2 sent, in the order a plan meets them', () => {
    expect([...WRITE_ACTIONS]).toEqual([
      'new-plan',
      'close-plan',
      'reopen-plan',
      'open-editor',
      'new-handoff',
      'qa-record',
      'lock-claim',
      'lock-release',
    ]);
  });

  /** The four phase acts with a form: the button, what is typed, and the body 6.2 sent. */
  const PHASE_FORMS: {
    button: string;
    phase?: Partial<PhaseView>;
    type: Record<string, string>;
    sent: WriteRequest;
  }[] = [
    {
      button: 'Scaffold handoff',
      type: { 'cart-api-endpoint': 'cart-api-endpoint' },
      sent: {
        action: 'new-handoff',
        slug: 'demo',
        phase: 2,
        title: 'cart-api-endpoint',
        status: HANDOFF_STATUSES[0],
        qa: false,
        force: false,
      },
    },
    {
      button: 'Record QA',
      type: { 'reports/phase-08-qa.md': 'reports/phase-02-qa.md' },
      sent: {
        action: 'qa-record',
        slug: 'demo',
        phase: 2,
        result: QA_RESULTS[0],
        report: 'reports/phase-02-qa.md',
      },
    },
    {
      button: 'Claim phase',
      type: { 'you@example.com/session-name': 'me@example.com/s1' },
      sent: { action: 'lock-claim', slug: 'demo', phase: 2, owner: 'me@example.com/s1', force: false },
    },
    {
      button: 'Release lock',
      phase: { lock: { owner: 'someone', expired: false } } as Partial<PhaseView>,
      type: { 'you@example.com/session-name': 'me@example.com/s1' },
      sent: { action: 'lock-release', slug: 'demo', phase: 2, owner: 'me@example.com/s1' },
    },
  ];

  it.each(PHASE_FORMS)('$sent.action sends the body 6.2 sent, after its dry run', async (form) => {
    mount(<WriteMenu detail={DETAIL} phase={{ ...PHASE, ...form.phase } as PhaseView} allowWrites inline />);
    fireEvent.click(screen.getByRole('button', { name: form.button }));
    for (const [placeholder, value] of Object.entries(form.type)) {
      fireEvent.change(await screen.findByPlaceholderText(placeholder), { target: { value } });
    }
    const last = Object.values(form.type).at(-1)!;
    await preview(new RegExp(last.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    expect(runs()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runs()).toEqual([[form.sent]]));
    expect(await screen.findByText('Completed')).toBeInTheDocument();
  });

  it('new-plan scaffolds by slug alone', async () => {
    mount(<ScaffoldPlanDialog onClose={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText('customer-tool-requests'), {
      target: { value: 'cart-api' },
    });
    await preview(/new-plan\.sh slug=cart-api/);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runs()).toEqual([[{ action: 'new-plan', slug: 'cart-api' }]]));
  });

  it('close-plan sends the terminal word and the reason', async () => {
    mount(<WriteMenu detail={DETAIL} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: 'Close plan' }));
    fireEvent.change(await screen.findByPlaceholderText(/superseded by/), {
      target: { value: 'folded into another plan' },
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'superseded' } });
    await preview(/status=superseded reason=folded into another plan/);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(runs()).toEqual([
        [{ action: 'close-plan', slug: 'demo', status: 'superseded', reason: 'folded into another plan' }],
      ]),
    );
  });

  it('reopen-plan sends the slug alone, once it is confirmed', async () => {
    // One small button on this side; on the other, the plan reappears on the
    // ready board, in the counts and in every announcement at once.
    mount(<WriteMenu detail={CLOSED} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen plan' }));
    expect(await screen.findByText('Reopen this plan?')).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(write.mock.calls).toEqual([[{ action: 'reopen-plan', slug: 'demo' }]]));
  });

  it('open-editor sends the plan file and asks nothing', async () => {
    mount(<WriteMenu detail={DETAIL} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));
    await waitFor(() =>
      expect(write.mock.calls).toEqual([[{ action: 'open-editor', path: '/repo/docs/plans/demo.md' }]]),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('remembers the owner a lock act succeeded with, for the next lock form', async () => {
    const first = mount(<WriteMenu detail={DETAIL} phase={PHASE} allowWrites inline />);
    fireEvent.click(screen.getByRole('button', { name: 'Claim phase' }));
    fireEvent.change(await screen.findByPlaceholderText('you@example.com/session-name'), {
      target: { value: 'me@example.com/s1' },
    });
    await preview(/owner=me@example\.com\/s1/);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runs()).toHaveLength(1));
    first.unmount();

    mount(
      <WriteMenu
        detail={DETAIL}
        phase={{ ...PHASE, lock: { owner: 'me@example.com/s1', expired: false } } as PhaseView}
        allowWrites
        inline
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Release lock' }));
    expect(await screen.findByPlaceholderText('you@example.com/session-name')).toHaveValue(
      'me@example.com/s1',
    );
  });
});

describe('the gate and the switches', () => {
  it('draws nothing in a header when writes are off', () => {
    const { container } = mount(<WriteMenu detail={DETAIL} allowWrites={false} />);
    expect(container.textContent).toBe('');
  });

  it('says what --allow-writes would give when it is inline and off', () => {
    mount(<WriteMenu detail={DETAIL} phase={PHASE} allowWrites={false} inline />);
    expect(screen.getByText(/--allow-writes/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers the phase verbs when writes are on', () => {
    mount(<WriteMenu detail={DETAIL} phase={PHASE} allowWrites inline />);
    const menu = screen.getByTestId('write-menu');
    expect(
      within(menu)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Scaffold handoff', 'Record QA', 'Claim phase']);
  });

  it('offers Release rather than Claim while a live lock is held', () => {
    mount(
      <WriteMenu
        detail={DETAIL}
        phase={{ ...PHASE, lock: { owner: 'someone', expired: false } } as PhaseView}
        allowWrites
        inline
      />,
    );
    expect(screen.getByRole('button', { name: 'Release lock' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claim phase' })).toBeNull();
  });

  it('treats an expired lock as claimable', () => {
    mount(
      <WriteMenu
        detail={DETAIL}
        phase={{ ...PHASE, lock: { owner: 'someone', expired: true } } as PhaseView}
        allowWrites
        inline
      />,
    );
    expect(screen.getByRole('button', { name: 'Claim phase' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release lock' })).toBeNull();
  });

  it('offers Close on an open plan and Reopen on a closed one, never both', () => {
    const open = mount(<WriteMenu detail={DETAIL} allowWrites />);
    expect(screen.getByRole('button', { name: 'Close plan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen plan' })).toBeNull();
    open.unmount();

    mount(<WriteMenu detail={CLOSED} allowWrites />);
    expect(screen.getByRole('button', { name: 'Reopen plan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close plan' })).toBeNull();
  });
});

describe('the dry run', () => {
  it('shows the exact command before anything can be pressed', async () => {
    mount(<WriteMenu detail={DETAIL} phase={PHASE} allowWrites inline />);
    fireEvent.click(screen.getByRole('button', { name: 'Scaffold handoff' }));

    // The second argument is the dry-run flag — the whole safety property of
    // this dialog: nothing runs to produce the preview.
    await waitFor(() => expect(write).toHaveBeenCalled());
    expect(write.mock.calls.every((call) => call[1] === true)).toBe(true);
    await preview(/new-handoff\.sh slug=demo phase=2/);
  });

  it('keeps Run disabled until a required field is filled', async () => {
    mount(<WriteMenu detail={DETAIL} phase={PHASE} allowWrites inline />);
    fireEvent.click(screen.getByRole('button', { name: 'Scaffold handoff' }));
    await preview(/new-handoff\.sh/);
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });

  it('asks for a terminal word and a reason before it will close anything', async () => {
    // The server refuses a reasonless close, and a status alone would leave a
    // closed plan that tells the next reader nothing.
    mount(<WriteMenu detail={DETAIL} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: 'Close plan' }));
    expect(await screen.findByRole('button', { name: 'Run' })).toBeDisabled();
    // `active` is not on the menu — reopening is its own verb, not a status.
    const options = [...screen.getByRole('combobox').querySelectorAll('option')].map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toEqual(['abandoned', 'superseded', 'complete']);
  });

  it('previews the real close-plan invocation, the reason in it, before anything runs (#247)', async () => {
    mount(<WriteMenu detail={DETAIL} allowWrites />);
    fireEvent.click(screen.getByRole('button', { name: 'Close plan' }));
    fireEvent.change(await screen.findByPlaceholderText(/superseded by/), {
      target: { value: 'the approach did not survive contact' },
    });

    // What a person waits for: the command on screen carrying the reason they
    // typed. An earlier preview (the empty form's) may land first, under load
    // late; this waits it out instead of reading whichever call came last.
    await preview(/close-plan\.sh slug=demo status=abandoned reason=the approach did not survive contact/);
    expect(write).toHaveBeenCalledWith(
      {
        action: 'close-plan',
        slug: 'demo',
        status: 'abandoned',
        reason: 'the approach did not survive contact',
      },
      true,
    );
    expect(runs()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  it('says a request the owner must confirm is asked, never done', async () => {
    write.mockImplementation(async (body: WriteRequest, dry?: boolean) =>
      dry
        ? { dryRun: true, command: commandFor(body) }
        : {
            requested: true,
            error: 'Sent to the owner to confirm',
            request: {
              id: 'q1',
              method: 'POST',
              path: '/api/write',
              body,
              label: 'a page',
              door: 'device',
              ask: 'Confirm',
            },
          },
    );
    mount(<ScaffoldPlanDialog onClose={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText('customer-tool-requests'), {
      target: { value: 'cart-api' },
    });
    await preview(/slug=cart-api/);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runs()).toHaveLength(1));
    expect(screen.queryByText('Completed')).toBeNull();
  });
});
