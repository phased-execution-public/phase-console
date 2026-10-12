/**
 * The launch flow on a phone (control-tower phase 22; 7.0, quiet-console phase
 * 13): a full-screen sheet whose footer — Cancel and the one Launch — is fixed
 * outside the scroller, over the departure notice. The nine categories are one
 * column of one-line rows, and each row's one verb opens its controls IN PLACE
 * under its line, inside the same scroller — the page grammar's expand, the
 * same on a phone as on a desk. No stage bar, no Next, no Back: Launch is on
 * the screen whatever is open.
 *
 * Its own file because `lib/media.ts` caches each media query the first time
 * it is asked, per module — so the phone answer has to be installed before
 * the first render in this module, and no other test in the file may want
 * the desk.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/data/keys';

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runStart: vi.fn(),
  plan: vi.fn(),
  verifyPreflight: vi.fn(),
  runPrelude: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
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

/** The nine tiles a start draws, in the order it draws them. */
const TILES = [
  'Scope',
  'Engine',
  'Safety',
  'Git',
  'Money and stops',
  'Review and QA',
  'Tools',
  'Accounts',
  'Decisions',
];

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

/** A row's one button — Edit, or Answer on a summons. */
const row = (label: string) => screen.getByRole('button', { name: new RegExp(`^(Edit|Answer) ${label}$`) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skills.mockResolvedValue([]);
  mocks.plan.mockResolvedValue(null);
  mocks.verifyPreflight.mockResolvedValue({ phases: [], computedAt: '' });
});

describe('the phone layout', () => {
  it('is a full-screen sheet sized by --app-height, with no stage bar and the buttons outside the scroller', async () => {
    await mount();
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('h-(--app-height)');
    expect(dialog.className).toContain('inset-x-0 top-0');
    expect(dialog.className).not.toMatch(/dvh/);
    // One screen since control-tower phase 22: nothing to step through.
    expect(screen.queryByRole('tablist')).toBeNull();
    // The quick view scrolls; Cancel and Launch are the frame's, not the body's.
    const body = dialog.querySelector('.overflow-y-auto')!;
    expect(body.contains(screen.getByTestId('quick-view'))).toBe(true);
    expect(body.contains(screen.getByRole('button', { name: 'Cancel' }))).toBe(false);
    expect(body.contains(screen.getByTestId('launch-submit'))).toBe(false);
    // No ticket pane on a phone.
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('keeps Launch in the footer while a row opens in place, with no Next or Back anywhere', async () => {
    await mount();
    // The departure line above the rows has already said what Launch does.
    const launch = screen.getByTestId('launch-submit');
    expect(launch).toHaveAccessibleName('Start');
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

    // A row opens its controls in place: the list stays, the region is under its line.
    fireEvent.click(row('Money and stops'));
    const list = screen.getByRole('list', { name: 'Settings by category' });
    const region = within(list).getByRole('region', { name: 'Money and stops' });
    expect(region.closest('li[data-category]')?.getAttribute('data-category')).toBe('money');
    expect(within(region).getByLabelText('Budget for the run ($)')).toBeTruthy();
    expect(screen.getByRole('dialog').querySelector('.overflow-y-auto')!.contains(region)).toBe(true);
    // The same Launch, still in the fixed footer — and still no stepping.
    expect(screen.getByTestId('launch-submit')).toBe(launch);
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

    // Done folds it again.
    fireEvent.click(screen.getByRole('button', { name: 'Done Money and stops' }));
    expect(screen.queryByRole('region', { name: 'Money and stops' })).toBeNull();
  });

  it('lays the categories out as one column of rows, each with ONE thumb-high verb that opens it', async () => {
    await mount();
    const list = screen.getByRole('list', { name: 'Settings by category' });
    // One column of rows — never a grid of tiles.
    expect(list.className).toContain('flex-col');
    expect(list.className).not.toMatch(/\bgrid\b/);
    const labels = (Array.from(list.children) as HTMLElement[]).map((line) => {
      // One verb a row, thumb-high on a coarse pointer, by the kit's own class.
      const [verb, ...rest] = within(line).getAllByRole('button');
      expect(rest).toHaveLength(0);
      expect(verb!.className).toContain('[@media(hover:none)]:min-h-(--tap-min)');
      return verb!.getAttribute('aria-label')!.replace(/^(Edit|Answer) /, '');
    });
    expect(labels).toEqual(TILES);
    // Each row opens its own controls, one at a time, and Done is the one tap back.
    for (const label of TILES) {
      fireEvent.click(row(label));
      expect(screen.getAllByRole('region', { name: label })).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: `Done ${label}` }));
      expect(screen.queryByRole('region', { name: label })).toBeNull();
    }
  });
});
