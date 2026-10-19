/**
 * The queue (quiet-console phase 21 — new: no 6.x page could change these).
 *
 * The console's scheduling word, each plan's own over it and the load guard's
 * factor are written through the queue's own door, `POST /api/queue/policy`,
 * never `POST /api/prefs`, and read from the queue's answer. Pinned on the
 * wire: the console's word posts `{policy}`, a plan's `{slug, policy}`, giving
 * a plan back `{slug, policy: null}`, the factor `{loadFactor}`. A console
 * without `--allow-run` offers none of it and says why; a press the owner door
 * holds is said in the server's words and never reads as a save; a policy is
 * its name in the choice and its explanation under it, never one dashed label.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import { SCHEDULING_POLICIES } from '@shared/orchestration-model.js';
import { ApiError } from '@/data/http';
import { renderWithClient, schemaAnswer, sent } from './test-kit';
import { QueueGroup, loadGuardWords, schedulingWords } from './queue';

interface Held {
  policy: { console: string; plans: Record<string, string>; default: string };
  load: { avg5: number; cores: number; factor: number | null; threshold: number | null; holding: boolean };
}

/** A console whose queue answers `held`, and whose door changes it as the server's would. */
function serve(state: Record<string, unknown> = { allowRun: true }) {
  const held: Held = {
    policy: { console: 'seniority', plans: { shop: 'critical-path' }, default: 'seniority' },
    load: { avg5: 8.1, cores: 14, factor: 1.5, threshold: 21, holding: false },
  };
  server.reads['/api/state'] = state;
  server.reads['/api/plans'] = [
    { slug: 'shop', phases: 3, ready: [] },
    { slug: 'trade', phases: 5, ready: [] },
    { slug: 'old', phases: 2, ready: [], status: 'complete', closed: true },
  ];
  server.reads['/api/prefs/schema'] = schemaAnswer({
    schedulingPolicy: { value: 'seniority', source: 'instance' },
  });
  server.reads['/api/queue'] = () => ({
    entries: [],
    lanes: [],
    hinted: [],
    withdrawn: [],
    audit: [],
    grants: [],
    policy: structuredClone(held.policy),
    load: { ...held.load },
  });
  server.reads['POST /api/queue/policy'] = (body: unknown) => {
    const change = body as { policy?: string | null; slug?: string; loadFactor?: number };
    if (change.slug) {
      if (change.policy === null) delete held.policy.plans[change.slug];
      else if (change.policy) held.policy.plans[change.slug] = change.policy;
    } else if (change.policy) held.policy.console = change.policy;
    if (change.loadFactor !== undefined) {
      const factor = change.loadFactor === 0 ? null : change.loadFactor;
      held.load = {
        ...held.load,
        factor,
        threshold: factor === null ? null : factor * held.load.cores,
      };
    }
    return { policy: structuredClone(held.policy), load: { ...held.load } };
  };
}

const posted = () => sent(server, 'POST', '/api/queue/policy');
const consoleWord = () => screen.getByLabelText('Scheduling policy') as HTMLSelectElement;

async function mount(state?: Record<string, unknown>) {
  serve(state);
  const view = renderWithClient(<QueueGroup />);
  await waitFor(() => expect(consoleWord().value).toBe('seniority'));
  return view;
}

beforeEach(() => {
  server.calls = [];
  server.reads = {};
  toast.mockClear();
});

describe('the words', () => {
  it('a policy is its name and its explanation, two things — never the dashed label', () => {
    for (const policy of SCHEDULING_POLICIES) {
      const { name, explanation } = schedulingWords(policy);
      expect(name).not.toMatch(/—/);
      expect(explanation).toMatch(/^[A-Z].*\.$/);
    }
    expect(schedulingWords('seniority')).toEqual({
      name: 'Seniority',
      explanation: 'First come, first served.',
    });
    expect(schedulingWords('unheard-of')).toEqual({ name: 'unheard-of', explanation: null });
  });

  it('the load guard reads as words: off, holding, or where it would hold', () => {
    expect(loadGuardWords({ avg5: 0.4, cores: 8, factor: null, threshold: null, holding: false })).toBe(
      'The guard is off: new work starts however loaded the machine is.',
    );
    expect(loadGuardWords({ avg5: 30.2, cores: 14, factor: 1.5, threshold: 21, holding: true })).toBe(
      'Holding new work now: the 5-minute load is 30.2, over 21 (1.5 times 14 cores). Live lanes carry on.',
    );
    expect(loadGuardWords({ avg5: 0.2, cores: 1, factor: 2, threshold: 2, holding: false })).toBe(
      'The 5-minute load is 0.2; new work waits at a load over 2 (2 times 1 core).',
    );
    // One-pool phase 26 (#243): the CPU beside the load, the average a ceiling.
    expect(
      loadGuardWords({
        avg5: 12,
        cores: 14,
        factor: 1.5,
        threshold: 42,
        busy: 0.93,
        busyLimit: 0.85,
        holding: true,
        cause: 'cpu',
      }),
    ).toBe(
      'Holding new work now: the CPU is 93 % busy over the last 30 s, at or over 85 %; the 5-minute load is 12. Live lanes carry on.',
    );
    expect(
      loadGuardWords({
        avg5: 36,
        cores: 14,
        factor: 1.5,
        threshold: 42,
        busy: 0.3,
        busyLimit: 0.85,
        holding: false,
        cause: null,
      }),
    ).toBe(
      'CPU 30 % over the last 30 s, 5-minute load 36; new work waits at 85 % CPU or a load over 42 (1.5 times 14 cores, times 2).',
    );
  });
});

describe('<QueueGroup>', () => {
  it('draws the console’s word, each plan’s own and the load guard, each key once', async () => {
    const { container } = await mount();
    // Names in the choice, the chosen one's explanation under it.
    expect([...consoleWord().options].map((option) => option.text)).toEqual([
      'Seniority',
      'Blocker first',
      'Critical path',
    ]);
    expect(screen.getByText('First come, first served.')).toBeTruthy();
    const shop = container.querySelector('[data-plan-policy="shop"]') as HTMLElement;
    expect((within(shop).getByLabelText('shop') as HTMLSelectElement).value).toBe('critical-path');
    expect(within(shop).getByText('The longest remaining chain first.')).toBeTruthy();
    // Only an OPEN plan without a word of its own can be given one.
    await waitFor(() =>
      expect(
        [...(screen.getByLabelText('Plan') as HTMLSelectElement).options].map((option) => option.value),
      ).toEqual(['trade']),
    );
    expect(screen.getByTestId('load-reading')).toHaveTextContent(
      'The 5-minute load is 8.1; new work waits at a load over 21 (1.5 times 14 cores).',
    );
    expect((screen.getByLabelText('Load guard') as HTMLInputElement).value).toBe('1.5');
    for (const key of ['schedulingPolicy', 'schedulingPolicies', 'loadGuardFactor']) {
      expect(container.querySelectorAll(`[data-pref="${key}"]`), key).toHaveLength(1);
    }
    expect(container.textContent).not.toMatch(/—/);
    expect(screen.queryByTestId('queue-run-off')).toBeNull();
  });

  it('the console’s word posts {policy} — to the queue’s door, never the preferences', async () => {
    await mount();
    fireEvent.change(consoleWord(), { target: { value: 'critical-path' } });
    await waitFor(() => expect(posted()).toEqual([{ policy: 'critical-path' }]));
    // The console row's own hint now explains the new word (the shop row says the same of its own).
    await waitFor(() =>
      expect(document.getElementById(consoleWord().getAttribute('aria-describedby')!)).toHaveTextContent(
        'The longest remaining chain first.',
      ),
    );
    expect(consoleWord().value).toBe('critical-path');
    expect(sent(server, 'POST', '/api/prefs')).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('a plan’s own word posts {slug, policy}; a plan is given one with the same body', async () => {
    const { container } = await mount();
    const shop = container.querySelector('[data-plan-policy="shop"]') as HTMLElement;
    fireEvent.change(within(shop).getByLabelText('shop'), { target: { value: 'blocker-first' } });
    await waitFor(() => expect(posted()).toEqual([{ slug: 'shop', policy: 'blocker-first' }]));

    await waitFor(() => expect((screen.getByLabelText('Plan') as HTMLSelectElement).value).toBe('trade'));
    fireEvent.change(screen.getByLabelText('Policy'), { target: { value: 'critical-path' } });
    fireEvent.click(screen.getByRole('button', { name: 'Give the plan its own policy' }));
    await waitFor(() => expect(posted().at(-1)).toEqual({ slug: 'trade', policy: 'critical-path' }));
    await waitFor(() => expect(container.querySelector('[data-plan-policy="trade"]')).not.toBeNull());
  });

  it('giving a plan back posts {slug, policy: null}, and the plan follows the console again', async () => {
    const { container } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Make shop follow the console’s policy' }));
    await waitFor(() => expect(posted()).toEqual([{ slug: 'shop', policy: null }]));
    await waitFor(() => expect(container.querySelector('[data-plan-policy="shop"]')).toBeNull());
    expect(screen.getByText('Every plan follows the console’s policy.')).toBeTruthy();
  });

  it('the factor posts {loadFactor} when it is left or on Enter; 0 switches the guard off; below 0 is refused here', async () => {
    await mount();
    const factor = screen.getByLabelText('Load guard') as HTMLInputElement;
    fireEvent.change(factor, { target: { value: '-1' } });
    fireEvent.blur(factor);
    expect(await screen.findByText('Type 0 or more; 0 switches the guard off.')).toBeTruthy();
    expect(posted()).toEqual([]);
    fireEvent.change(factor, { target: { value: '2' } });
    fireEvent.blur(factor);
    await waitFor(() => expect(posted()).toEqual([{ loadFactor: 2 }]));
    await waitFor(() =>
      expect(screen.getByTestId('load-reading')).toHaveTextContent(
        'new work waits at a load over 28 (2 times 14 cores)',
      ),
    );
    fireEvent.change(factor, { target: { value: '0' } });
    fireEvent.keyDown(factor, { key: 'Enter' });
    await waitFor(() => expect(posted().at(-1)).toEqual({ loadFactor: 0 }));
    await waitFor(() => expect(screen.getByTestId('load-reading')).toHaveTextContent('The guard is off'));
  });

  it('without --allow-run every control is off, says why, and nothing is sent', async () => {
    const { container } = await mount({ allowRun: false });
    expect(await screen.findByTestId('queue-run-off')).toHaveTextContent(
      'Start the console with --allow-run to change what starts.',
    );
    const controls = container.querySelectorAll('select, input, button');
    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) expect(control, control.outerHTML.slice(0, 80)).toBeDisabled();
    fireEvent.change(consoleWord(), { target: { value: 'critical-path' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make shop follow the console’s policy' }));
    expect(posted()).toEqual([]);
  });

  it('a press the owner door holds is said in the server’s words and never reads as a save', async () => {
    await mount();
    server.reads['POST /api/queue/policy'] = {
      requested: true,
      request: { id: 'r1', ask: 'asked by this device' },
      error: 'Asked of the owner: confirm it on Your turn.',
    };
    fireEvent.change(consoleWord(), { target: { value: 'critical-path' } });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Asked of the owner: confirm it on Your turn.', 'info', 6000),
    );
    expect(posted()).toEqual([{ policy: 'critical-path' }]);
    // Nothing changed on the server, so the word on screen is still its own.
    await waitFor(() => expect(consoleWord().value).toBe('seniority'));
    expect(screen.getByText('First come, first served.')).toBeTruthy();
  });

  it('a refusal is said in the server’s words, and the word goes back', async () => {
    await mount();
    server.reads['POST /api/queue/policy'] = new ApiError(
      'no scheduling policy fastest — one of seniority, blocker-first, critical-path',
      400,
      '/api/queue/policy',
      { error: 'no scheduling policy fastest — one of seniority, blocker-first, critical-path' },
    );
    fireEvent.change(consoleWord(), { target: { value: 'blocker-first' } });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'no scheduling policy fastest — one of seniority, blocker-first, critical-path',
        'error',
      ),
    );
    await waitFor(() => expect(consoleWord().value).toBe('seniority'));
  });
});
