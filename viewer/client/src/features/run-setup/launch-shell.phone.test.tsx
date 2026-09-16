/**
 * The launch flow on a phone: a full-screen sheet, the stage bar and the
 * buttons fixed, Launch on the review only, Next between the stages.
 *
 * Its own file because `lib/media.ts` caches each media query the first time
 * it is asked, per module — so the phone answer has to be installed before
 * the first render in this module, and no other test in the file may want
 * the desk.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runStart: vi.fn(),
  plan: vi.fn(),
  verifyPreflight: vi.fn(),
  runPrelude: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

// A phone: the shell query matches, nothing else does.
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: /max-width: 899px/.test(query),
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

/** A prelude with nothing open: every row answered, every probe ok. */
const EMPTY_PRELUDE = {
  slug: 'alpha',
  rows: [],
  blocking: [],
  waived: [],
  acknowledged: [],
  manifestPresent: false,
  probes: {
    accounts: { status: 'ok', ok: true, reason: 'the machine login' },
    mcp: { status: 'skip', ok: true, reason: 'no MCP server named' },
    credentials: { status: 'skip', ok: true, reason: 'no credential named' },
    delivery: { status: 'ok', ok: true, reason: '1 subscribed device' },
  },
  accounts: [{ id: 'default', minHeadroomPct: 0 }],
  credentials: { policy: 'continue', ids: [], held: [], missing: [] },
  delivery: { ok: true, channels: ['1 subscribed device'], acknowledged: false },
  at: '2026-09-14T00:00:00.000Z',
};

async function mount() {
  mocks.state.mockResolvedValue({ prefs: {}, defaultSkills: [], allowRun: true });
  mocks.runPrelude.mockResolvedValue({ prelude: EMPTY_PRELUDE });
  const client = new QueryClient(queryClientConfig);
  const { RunSetup } = await import('./run-setup');
  render(
    <QueryClientProvider client={client}>
      <RunSetup
        mode="start"
        context={{ slug: 'alpha', run: null }}
        overlay={{ open: true, onOpenChange: () => {}, title: 'Start a run' }}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skills.mockResolvedValue([]);
  mocks.plan.mockResolvedValue(null);
  mocks.verifyPreflight.mockResolvedValue({ phases: [], computedAt: '' });
});

describe('the phone layout', () => {
  it('is a full-screen sheet sized by --app-height, with the stage bar and the buttons outside the scroller', async () => {
    await mount();
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('h-(--app-height)');
    expect(dialog.className).toContain('inset-x-0 top-0');
    expect(dialog.className).not.toMatch(/dvh/);
    // The bar and the footer are the frame's, not the body's.
    const body = dialog.querySelector('.overflow-y-auto')!;
    expect(body.contains(screen.getByRole('tablist'))).toBe(false);
    expect(body.contains(screen.getByRole('button', { name: 'Cancel' }))).toBe(false);
    // No ticket pane on a phone.
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('shows Launch on the review only, and Next between the stages', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    // Opens on Decisions (phase 11); one Next reaches What runs, two reach How.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('tab', { name: /What/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('tab', { name: /How/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('tab', { name: /Review/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
  });

  it('reads the short stage names, and every stage is one tap away', async () => {
    await mount();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    fireEvent.click(screen.getByRole('tab', { name: /Money/ }));
    expect(screen.getByRole('tab', { name: /Money/ }).getAttribute('aria-selected')).toBe('true');
    // Every tab is thumb-high on a coarse pointer, by class.
    for (const tab of tabs) expect(tab.className).toContain('[@media(hover:none)]:min-h-(--tap-min)');
  });
});
