/**
 * The ⌘K palette (7.0, quiet-console phase 3) — go · find · do.
 *
 * Ported from `app/command/palette.test.tsx`, which had absorbed the old search
 * page's tests in 3.0: two characters before the server is asked, a hit lands
 * on the thing it matched, a snippet is never parsed as markup, and a closed
 * plan stays in the results AND says so — search that hides history is search
 * you stop trusting. A row is a command-list item rather than an `<a>`, so
 * "goes to the right place" is asserted against where the palette navigates.
 *
 * What 7.0 made true, pinned here too: the groups read go · find · do; *do*
 * carries every act from anywhere — pressed twice where the address names its
 * record, else its terminal line copied or its door — a verb this console
 * cannot press offered DISABLED and naming its flag (the builders themselves
 * are `actions.test.ts`'s); a settings section is found by what is inside it; Escape and every
 * navigation close it, because open is the address (`?k=`). And the way in is
 * no longer the dialog's: the chord lives in `shortcut.ts`, on first paint, so
 * the dialog's chunk (cmdk) loads only once the address asks for it — the
 * harness below hangs both the way `App.tsx` does.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_VERBS } from '@shared/verb-model.js';
import type { ConsoleState, PlanSummary, SlimRun } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { queryClientConfig } from '@/data/keys';
import { SURFACE } from '@/data/surface';
import { setPrefs } from '@/lib/prefs';
import { expectNoAxeViolations } from '@/test/axe';
import { MemoryRouterProvider, useNavigate, useRoute } from '../router';
import { hrefOf, openOverlay } from '../routes';
import Palette from './palette';
import { usePaletteShortcut } from './shortcut';

const { search, plans, runList, pressVerb } = vi.hoisted(() => ({
  search: vi.fn(),
  plans: vi.fn(),
  runList: vi.fn(),
  pressVerb: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, runList, api: { ...actual.api, search, plans } };
});

// The press itself is `data/verbs.ts`'s, through the one owner door, and is
// tested there; what is the palette's is WHEN it hands a verb over, and with what.
vi.mock('@/data/verbs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/verbs')>()),
  pressVerb,
}));

const STATE: ConsoleState = {
  autopilot: true,
  allowRun: false,
  allowWrites: false,
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  searchDocs: 42,
  unread: 0,
};

const COUNTS: ShellCounts = {
  plans: 3,
  phases: 11,
  ready: 2,
  approvals: 0,
  unread: 0,
  needsYou: 0,
  asks: 0,
  sessions: 0,
  agentSessions: 0,
  terminalSessions: 0,
  mcpAttention: 0,
};

const plan = (over: Partial<PlanSummary> & { slug: string }): PlanSummary => ({
  kind: 'plan',
  phases: 4,
  ready: [],
  status: 'active',
  closed: false,
  ...over,
});

const run = (over: Partial<SlimRun> = {}): SlimRun =>
  ({
    id: 'r1',
    slug: 'demo',
    status: 'running',
    activePhase: 3,
    phases: {},
    verifying: {},
    ...over,
  }) as SlimRun;

const hit = (over: Record<string, unknown> = {}) => ({
  slug: 'demo',
  kind: 'plan',
  section: 'Context',
  title: 't',
  score: 1,
  snippet: 'the cart api',
  ...over,
});

/** The palette as `App.tsx` hangs it: the chord from first paint, the dialog only while the address says `?k=`. */
function PaletteHost({ state, counts }: { state: ConsoleState; counts: ShellCounts }) {
  const route = useRoute();
  usePaletteShortcut(route, useNavigate());
  return openOverlay(route) === 'palette' ? <Palette route={route} state={state} counts={counts} /> : null;
}

/** The console at an address — a palette's, `?k=<term>`, or a page's. `onNavigate` is where a press lands. */
function mount(address: string, over: Partial<ConsoleState> = {}) {
  const onNavigate = vi.fn();
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address} onNavigate={onNavigate}>
        <PaletteHost state={{ ...STATE, ...over }} counts={COUNTS} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return { ...view, onNavigate };
}

/** The palette, open on the Runs page with `term` typed. */
const palette = (term = '', over: Partial<ConsoleState> = {}) => mount(hrefOf('runs', { k: term }), over);

/**
 * One row, found by its label rather than by its accessible name: a row's
 * name is its label AND its hint, so `/Settings/` would also match every
 * section row's "Settings" hint. The label is the unambiguous half.
 */
const rowNamed = async (
  label: string | RegExp,
  within_: HTMLElement = document.body,
): Promise<HTMLElement> => {
  const text = await within(within_).findByText(label, { selector: 'span' });
  return text.closest('[cmdk-item]') as HTMLElement;
};

/** A group's rows, by label, in the order drawn. */
const labelsIn = (group: string) =>
  within(screen.getByRole('group', { name: group }))
    .getAllByRole('option')
    .map((option) => option.querySelector('span')?.textContent);

const dialogGone = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

beforeEach(() => {
  vi.clearAllMocks();
  plans.mockResolvedValue([]);
  runList.mockResolvedValue([]);
  search.mockResolvedValue({ query: '', total: 0, groups: [] });
  pressVerb.mockResolvedValue({ state: 'done' });
});

afterEach(() => {
  // The appearance is module state the cases below change on purpose.
  setPrefs({ theme: 'system', density: 'comfortable' });
});

describe('go · find · do', () => {
  it('reads in that order: the places, then what it finds, then the verbs — and says how much it searches', async () => {
    plans.mockResolvedValue([plan({ slug: 'alpha', ready: [4] })]);
    runList.mockResolvedValue([run()]);
    palette();
    await rowNamed('alpha');
    await rowNamed('demo');
    const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map(
      (heading) => heading.textContent,
    );
    // *Find* is one heading per kind of thing found: plans and their ready
    // phases, runs, the settings sections (and the documents, once typed).
    expect(headings).toEqual(['Go to', 'Plans', 'Runs', 'Settings', 'Do']);
    expect(screen.getByText('3 plans, 11 phases, 42 documents indexed')).toBeInTheDocument();
  });

  it('goes to every place this console has, Your turn and Help, and to none it has not', async () => {
    palette();
    await screen.findByRole('group', { name: 'Go to' });
    // Read off the nav, so a place that exists is a row without anyone
    // remembering to add one. Logs is 7.0's name for Debug.
    expect(labelsIn('Go to')).toEqual([
      'Runs',
      // A place of its own since one-pool phase 14 — read off the nav, never added twice.
      'Your turn',
      'Plans',
      'Repo',
      'Insights',
      'Logs',
      'Settings',
      'Help',
    ]);
  });

  it('opens a place, and is closed by it — the address it went to carries no ?k=', async () => {
    const { onNavigate } = palette();
    fireEvent.click(await rowNamed('Logs'));
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('logs'));
    expect(onNavigate.mock.calls.flat().some((path) => String(path).includes('k='))).toBe(false);
    await dialogGone();
  });

  it('opens Your turn — and finds it by what is on it, not only by its name', async () => {
    const { onNavigate } = palette('needs me');
    const row = await rowNamed('Your turn');
    expect(within(screen.getByRole('group', { name: 'Go to' })).getByText('Your turn')).toBeInTheDocument();
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('turn'));
  });

  it('opens Help over the page it was opened on', async () => {
    const { onNavigate } = mount(hrefOf('plans', { view: 'cards', k: '' }));
    fireEvent.click(await rowNamed('Help'));
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('plans', { view: 'cards', help: '' }));
  });

  it('offers what a flag governs only where the flag is on', async () => {
    palette('', { allowTerminal: true, allowAgent: true, allowWrites: true });
    expect(await rowNamed('Open a terminal')).toBeTruthy();
    expect(await rowNamed('Open an agent session')).toBeTruthy();
    expect(await rowNamed('New plan…')).toBeTruthy();
    expect(labelsIn('Go to')).toContain('Sessions');
  });

  it('names every plan and every phase that could start — and no document', async () => {
    plans.mockResolvedValue([
      plan({ slug: 'alpha', title: 'The alpha plan', phases: 9, ready: [4, 5] }),
      plan({ slug: 'docs', kind: 'document', phases: 0 }),
    ]);
    const first = palette();
    fireEvent.click(await rowNamed('The alpha plan'));
    expect(first.onNavigate).toHaveBeenLastCalledWith(hrefOf('plan/alpha/phases'));
    first.unmount();

    // `/api/plans` sends the queue as bare numbers, so a ready phase is
    // addressable by number under its plan's name — the fastest route to the
    // thing that can actually start.
    const second = palette();
    expect(await rowNamed('Phase 5')).toBeTruthy();
    fireEvent.click(await rowNamed('Phase 4'));
    expect(second.onNavigate).toHaveBeenLastCalledWith(hrefOf('plan/alpha/phase/4'));
    expect(screen.queryByText('docs', { selector: 'span' })).toBeNull();
  });

  it('finds every run by its plan, saying what it is doing, and opens its run page', async () => {
    runList.mockResolvedValue([run()]);
    const { onNavigate } = palette();
    const row = await rowNamed('demo');
    expect(within(screen.getByRole('group', { name: 'Runs' })).getByText('demo')).toBeInTheDocument();
    expect(within(row).getByText('running, phase 3')).toBeInTheDocument();
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('plan/demo/run'));
  });

  it('holds one row per Settings section', async () => {
    palette();
    await screen.findByRole('group', { name: 'Settings' });
    // The place's own titles (quiet-console phase 21): "MCP servers" as its
    // heading says it, and Everything, every key the console stores, last.
    expect(labelsIn('Settings')).toEqual([
      'Essentials',
      'Appearance',
      'Automation',
      'Notifications',
      'Accounts',
      'MCP servers',
      'Hooks',
      'Permissions',
      'This instance',
      'Everything',
    ]);
  });

  it('finds a settings section by what is INSIDE it, and opens that section', async () => {
    // `grants` is no section's name: it is the registry's word for a route
    // doored at Settings ▸ Permissions.
    const { onNavigate } = palette('grants');
    const settings = await screen.findByRole('group', { name: 'Settings' });
    const row = await rowNamed('Permissions', settings);
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('settings/permissions'));
  });

  it('narrows as it is typed into', async () => {
    const { onNavigate } = palette();
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'launcher' } });
    const settings = await screen.findByRole('group', { name: 'Settings' });
    expect(await rowNamed('Essentials', settings)).toBeTruthy();
    // What is typed is the box's, never the address's: a palette is transient.
    expect(input).toHaveValue('launcher');
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('the verbs', () => {
  /** Every act the table holds and the registry draws — what *do* offers from anywhere. */
  const ACTS = (() => {
    const registered = new Set(SURFACE.filter((row) => row.kind === 'verb').map((row) => row.verb));
    return (OPERATOR_VERBS as readonly { name: string; kind: string }[])
      .filter((verb) => verb.kind === 'act' && registered.has(verb.name))
      .map((verb) => verb.name);
  })();

  it('offers every act from anywhere, after its own — by its name, or by the line a terminal presses it with', async () => {
    palette();
    // The acts no route answers come last, as their lines.
    await rowNamed('phase-console doctor --stop-strays');
    const offered = labelsIn('Do');
    expect(ACTS.length).toBeGreaterThan(40);
    for (const verb of ACTS) {
      expect(
        offered.some((label) => label === verb || label?.startsWith(`phase-console run ${verb} `)),
        verb,
      ).toBe(true);
    }
    expect(offered.at(-1)).toMatch(/^phase-console /);
  });

  it('offers a verb this console cannot press DISABLED, naming the flag it lacks — and presses nothing', async () => {
    const { onNavigate } = mount(hrefOf('plan/demo/run', { k: '' }), { allowRun: false });
    const pause = await rowNamed('pause');
    expect(pause).toHaveAttribute('aria-disabled', 'true');
    expect(within(pause).getByText('Needs --allow-run')).toBeInTheDocument();
    fireEvent.click(pause);
    expect(pressVerb).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    // A read needs no flag.
    expect(await rowNamed('accounts')).toHaveAttribute('aria-disabled', 'false');
  });

  it('goes to where the registry draws a read', async () => {
    const { onNavigate } = palette();
    fireEvent.click(await rowNamed('accounts'));
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('settings/accounts'));
    expect(pressVerb).not.toHaveBeenCalled();
  });

  it('presses an act twice — the first press arms it, the second hands it over — with the address’s arguments', async () => {
    const { onNavigate } = mount(hrefOf('plan/demo/run', { k: '' }), { allowRun: true });
    const pause = await rowNamed('pause');
    expect(pause).toHaveAttribute('aria-disabled', 'false');
    // The run it would act on is named before it is pressed.
    expect(pause.textContent).toContain('(demo)');

    fireEvent.click(pause);
    expect(pressVerb).not.toHaveBeenCalled();
    expect(within(pause).getByText('Press again to confirm')).toBeInTheDocument();

    fireEvent.click(pause);
    expect(pressVerb).toHaveBeenCalledTimes(1);
    expect(pressVerb).toHaveBeenCalledWith('pause', { slug: 'demo' }, {});
    // …and the palette is gone from the page it was opened on.
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('plan/demo/run'));
    await dialogGone();
  });

  it('presses a lane verb on the phase the address names — its slug and phase in the body, as the CLI sends them', async () => {
    mount(hrefOf('plan/demo/phase/3', { k: '' }), { allowRun: true });
    const pin = await rowNamed('pin');
    expect(pin.textContent).toContain('(demo, phase 3)');
    fireEvent.click(pin);
    fireEvent.click(pin);
    expect(pressVerb).toHaveBeenCalledWith('pin', {}, { slug: 'demo', phase: 3 });
  });

  it('copies a terminal line rather than pressing anything, says so, and closes', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const { onNavigate } = palette('strays');
      fireEvent.click(await rowNamed('phase-console doctor --stop-strays'));
      expect(writeText).toHaveBeenCalledWith('phase-console doctor --stop-strays');
      expect(pressVerb).not.toHaveBeenCalled();
      expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('runs'));
      await dialogGone();
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('goes to a run’s read on THAT run’s page — the plan’s slug carried', async () => {
    const { onNavigate } = mount(hrefOf('plan/demo/run', { k: '' }));
    fireEvent.click(await rowNamed('journal'));
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('plan/demo/run'));
  });

  it('opens the Issues desk — and finds it by the words of triage', async () => {
    const { onNavigate } = palette('triage');
    fireEvent.click(await rowNamed('The Issues desk'));
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('repo/issues'));
  });

  it('sends Freeze all to the board and fires nothing on the way', async () => {
    // Freezing stops every session on the machine mid-token, so three typed
    // letters must not be able to do it: the palette NAVIGATES to the board,
    // where the button and its confirm live.
    const { onNavigate } = palette('', { allowRun: true });
    fireEvent.click(await rowNamed('Freeze the whole console…'));
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('runs', { view: 'groups' }));
    expect(pressVerb).not.toHaveBeenCalled();
  });

  it('offers no Freeze all on a console that cannot run anything', async () => {
    palette('', { allowRun: false });
    expect(await rowNamed('Runs')).toBeTruthy();
    expect(screen.queryByText('Freeze the whole console…', { selector: 'span' })).toBeNull();
  });

  it('changes the density from here, and the change reaches the document', async () => {
    // The palette's claim is that it reaches everything, and the one
    // preference an operator changes with their hands on the keyboard is this
    // one. `data-density` on the root is the whole switch — the default is the
    // attribute's ABSENCE, never a second spelling of one state.
    palette();
    fireEvent.click(await rowNamed('Density: Compact'));
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    await dialogGone();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(await rowNamed('Density: Comfortable'));
    expect(document.documentElement.getAttribute('data-density')).toBeNull();
  });

  it('changes the theme from here — the header has no toggle any more (7.0)', async () => {
    palette();
    fireEvent.click(await rowNamed('Theme: Night'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await dialogGone();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(await rowNamed('Theme: Auto'));
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });
});


describe('the full-text leg', () => {
  it('does not ask the server for one character', async () => {
    palette('a');
    // The palette still renders — the places and the verbs are always there.
    expect(await rowNamed('Plans')).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  });

  it('sends every hit to the right place for its kind', async () => {
    search.mockResolvedValue({
      query: 'cart',
      total: 3,
      groups: [
        {
          slug: 'demo',
          title: 'demo plan',
          hits: [
            hit({ kind: 'phase', phase: 3, section: 'Phase 3' }),
            hit({ kind: 'handoff', phase: 2, section: 'State now', snippet: 'cart done' }),
            hit({ kind: 'plan', snippet: 'cart everywhere' }),
          ],
        },
      ],
    });

    for (const [i, expected] of [
      hrefOf('plan/demo/phase/3'),
      hrefOf('plan/demo/handoff/2'),
      hrefOf('plan/demo/source'),
    ].entries()) {
      const { onNavigate, unmount } = palette('cart');
      // Wait for the ROWS, not the heading: the heading — and one disabled row —
      // is also what the "Searching…" state renders, so finding it proves
      // nothing landed.
      const rows = await waitFor(() => {
        const found = within(screen.getByRole('group', { name: /^In the documents/ })).getAllByRole('option');
        expect(found).toHaveLength(3);
        return found;
      });
      fireEvent.click(rows[i]!);
      expect(onNavigate, expected).toHaveBeenLastCalledWith(expected);
      unmount();
    }
  });

  it('marks the matched terms without letting the snippet be parsed as markup', async () => {
    search.mockResolvedValue({
      query: 'cart',
      total: 1,
      groups: [
        {
          slug: 'demo',
          title: 'demo plan',
          hits: [hit({ snippet: 'the cart <script>alert(1)</script> api' })],
        },
      ],
    });
    palette('cart');
    await waitFor(() => {
      const marks = screen.getAllByText('cart');
      expect(marks.some((el) => el.tagName === 'MARK')).toBe(true);
    });
    // The snippet is React text, so the tag is inert regardless of any sanitizer.
    expect(document.querySelector('[role="dialog"] script')).toBeNull();
    expect(screen.getByText(/<script>/)).toBeInTheDocument();
  });

  it('says nothing matched rather than showing an empty list', async () => {
    const { onNavigate } = palette('zzzz');
    await waitFor(() => expect(search).toHaveBeenCalled());
    // No document matched AND no row matched, so the list is empty — which is
    // when the empty state shows.
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('keeps a closed plan in the results, and says that it is closed', async () => {
    plans.mockResolvedValue([
      plan({ slug: 'gone', status: 'abandoned', closed: true }),
      plan({ slug: 'demo', ready: [2] }),
    ]);
    search.mockResolvedValue({
      query: 'cart',
      total: 2,
      groups: [
        { slug: 'gone', title: 'walked away', hits: [hit({ slug: 'gone', score: 2 })] },
        { slug: 'demo', title: 'demo plan', hits: [hit()] },
      ],
    });
    palette('cart');
    const documents = await screen.findByRole('group', { name: /^In the documents/ });
    // Present, both of them — relevance is the only ranking a search has.
    await waitFor(() => expect(within(documents).getByText('gone')).toBeInTheDocument());
    expect(within(documents).getByText('demo')).toBeInTheDocument();
    // Marked exactly once: the closed one.
    expect(within(documents).getAllByText('closed')).toHaveLength(1);
  });
});

describe('the way in and out', () => {
  it('opens on ⌘K from any page, ON that page — its own query kept', async () => {
    const { onNavigate } = mount(hrefOf('runs', { bay: 'live' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('runs', { bay: 'live', k: '' }));
    expect(await screen.findByRole('dialog', { name: 'Search and commands' })).toBeInTheDocument();
  });

  it('closes on a second ⌘K, back to the page it was opened on', async () => {
    const { onNavigate } = mount(hrefOf('runs', { bay: 'live', k: '' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('runs', { bay: 'live' }));
    await dialogGone();
  });

  it('closes on Escape, back to the page it was opened on', async () => {
    const { onNavigate } = mount(hrefOf('runs', { bay: 'live', k: 'cart' }));
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('runs', { bay: 'live' }));
    await dialogGone();
  });

  it('opens on `/` — but never while something is being typed into', () => {
    const { onNavigate } = mount(hrefOf('plans'));
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '/' });
    expect(onNavigate).not.toHaveBeenCalled();
    input.remove();

    fireEvent.keyDown(window, { key: '/' });
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('plans', { k: '' }));
  });

  /**
   * Ctrl-K is kill-to-end-of-line in every shell, and the console ships a
   * terminal. xterm's hidden helper textarea bubbles the keystroke to the
   * window listener, so the palette once opened ON TOP of the shell and ate
   * the shortcut — in the one surface that owns its whole keyboard.
   */
  it('leaves Ctrl-K to a focused terminal, and still opens on ⌘K there', () => {
    const { onNavigate } = mount(hrefOf('sessions/abc'));
    const term = document.createElement('div');
    term.className = 'phase-term';
    const helper = document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';
    term.appendChild(helper);
    document.body.appendChild(term);

    fireEvent.keyDown(helper, { key: 'k', ctrlKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
    // ⌘ is not a terminal chord anywhere, so it stays the way in.
    fireEvent.keyDown(helper, { key: 'k', metaKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('sessions/abc', { k: '' }));
    term.remove();
  });

  it('still opens on Ctrl-K away from a terminal', () => {
    const { onNavigate } = mount(hrefOf('runs'));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(onNavigate).toHaveBeenLastCalledWith(hrefOf('runs', { k: '' }));
  });

  /**
   * An overlay has to own focus, name itself and be escapable, so a missing
   * accessible name or a listbox with no owner goes unnoticed precisely here.
   * Mounted OPEN, with plans and runs in it, so what is checked is what an
   * operator meets.
   */
  it('opens with no axe violations, with results in it', async () => {
    plans.mockResolvedValue([plan({ slug: 'alpha', ready: [4] })]);
    runList.mockResolvedValue([run()]);
    palette();
    const dialog = await screen.findByRole('dialog');
    await rowNamed('alpha');
    await expectNoAxeViolations(dialog);
  });
});
