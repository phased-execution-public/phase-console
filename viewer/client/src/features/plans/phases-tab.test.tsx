/**
 * The Phases tab: grouped by what a phase wants, not by its number.
 *
 * Four properties, each one a thing the old flat list could not do:
 *
 * 1. **The groups are the run page's.** Same `PHASE_GROUPS`, same `groupRows`,
 *    so "Needs you" cannot come to mean two things on two pages.
 * 2. **Done is collapsed and remembered.** On this estate Done is most of the
 *    plan, and a section that re-opens on every navigation is a section being
 *    re-collapsed rather than read.
 * 3. **The claim is on the row.** A `done` phase that nothing on disk backs is
 *    the single most useful thing this list can say, and the plan page did not
 *    say it at all. Absent `proof` renders nothing — a console whose server
 *    predates the model must not show a tick it was never told about.
 * 4. **The drawer is reused, not rebuilt** — `features/runs/phase-drawer`, and
 *    it asks for nothing until it is opened.
 * 5. **`in-progress` is a CLAIM, and the row says which kind.** This file used
 *    to pin the opposite: its board fixture carried a bare
 *    `{ state: 'in-progress' }` and the group-order assertion read that row as
 *    "Running" with nothing behind it — the exact lie B2(a) is about. A phase
 *    of one plan on this estate painted Running for 18 DAYS over no run, no
 *    lock and no process, because the board's word comes from a `status:` line
 *    in a markdown file. The rewrite below asserts both halves: a stale claim
 *    is badged "claimed running" and is not a link, and a live one pulses and
 *    opens its lane.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';
import type { PhaseView, PlanDetail } from '@/lib/api';
import { PhasesTab } from './phases-tab';

const { phaseDiagnosis, rulings, state, plan } = vi.hoisted(() => ({
  phaseDiagnosis: vi.fn(),
  rulings: vi.fn(),
  state: vi.fn(),
  // The tab never calls it; the L2 sheet does, on open, for the prose this
  // tab deliberately does not fetch.
  plan: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, phaseDiagnosis, rulings, state, plan } };
});

const phase = (over: Partial<PhaseView> = {}): PhaseView =>
  ({
    phase: 1,
    title: 'Foundations',
    state: 'done',
    size: 'M',
    weight: 40_000,
    gated: false,
    bullets: [],
    ...over,
  }) as unknown as PhaseView;

const detail = (phases: PhaseView[]): PlanDetail =>
  ({ summary: { slug: 'demo' }, phases }) as unknown as PlanDetail;

/**
 * `live` and `proof` for a phase something IS working, and for one only a
 * markdown file says is. The two differ by exactly the facts the server
 * measures — that is the point of the pair.
 */
const LIVE = { via: 'run', session: 'sess-5', pid: 4242 } as const;
const RUNNING_PROOF = {
  board: 'in-progress',
  handoff: 'in-progress',
  verification: 'none',
  qa: 'off',
  evidenced: false,
  stale: false,
  why: ['live: a run this console can see (session sess-5)'],
};
const STALE_PROOF = {
  ...RUNNING_PROOF,
  stale: true,
  why: ['live: nothing is running this — no run, no live lock, no session. the board word is a claim'],
};

const BOARD = [
  phase({ phase: 1, title: 'Foundations', state: 'done' }),
  phase({ phase: 2, title: 'Surface', state: 'ready' }),
  phase({ phase: 3, title: 'Cutover', state: 'waiting' }),
  phase({ phase: 4, title: 'Docs', state: 'stuck' }),
  // Genuinely running: a witness, and a proof that says so. The group-order
  // assertion below needs a row in the Running group, and it must be an honest
  // one — the version of this fixture that carried the board word ALONE is
  // what pinned the lie.
  phase({ phase: 5, title: 'Ship', state: 'in-progress', live: LIVE, proof: RUNNING_PROOF } as never),
];

function mount(view: PlanDetail) {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <TooltipProvider>
        <PhasesTab detail={view} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  /* `localStorage.clear()` is not enough on its own: `lib/prefs` keeps the
     preference in memory as well, so a test that opened the Done group left it
     open for every test after it. Reset to the real default explicitly — the
     collapsed set the tab itself falls back to. */
  setPrefs({ planPhasesCollapsed: ['done'] });
  state.mockResolvedValue({ allowTerminal: false, autopilot: true });
  // The whole shape the endpoint really sends — `workingTree` is not optional
  // on the wire, and a fixture that omits it tests a payload no server emits.
  phaseDiagnosis.mockResolvedValue({
    slug: 'demo',
    phase: 4,
    boardState: 'stuck',
    blockedOn: 'board',
    situation: null,
    evidence: [],
    workingTree: [],
    ways: [],
  });
  rulings.mockResolvedValue({ rulings: [] });
  plan.mockResolvedValue(detail(BOARD));
});

describe('the two rungs a phase card owes', () => {
  it('offers L2 beside the L1 drawer, on every card', async () => {
    mount(detail(BOARD));
    // Every card, not just the first — a control that appears on one row is a
    // control a reader learns not to look for.
    for (const p of [2, 3, 4, 5]) {
      expect(screen.getByRole('button', { name: `Inspect phase ${p}` })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Inspect phase 2' }));
    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveTextContent(/Phase 02 — Surface/);
    // L3 is in there too, folded, and named.
    expect(within(sheet).getByRole('button', { name: 'Raw record' })).toBeInTheDocument();
  });

  it('re-reads the phase on every tick rather than holding the object it opened on', async () => {
    // The stream replaces every `PhaseView` in `detail.phases` on each tick. A
    // sheet that closed over the object it was opened with would go on
    // reporting the state from BEFORE the tick that changed it — indefinitely,
    // on the surface someone opened precisely to watch a phase move.
    const view = mount(detail(BOARD));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect phase 3' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Waiting')).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={new QueryClient(queryClientConfig)}>
        <TooltipProvider>
          <PhasesTab
            detail={detail(BOARD.map((p) => (p.phase === 3 ? phase({ ...p, state: 'ready' }) : p)))}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(within(await screen.findByRole('dialog')).getByText('Next up')).toBeInTheDocument();
  });
});

describe('the Phases tab', () => {
  /*
   * This list IS the departures board on a phone (`route-tab.tsx` swaps to it
   * under the breakpoint), so a fact the board carries and this does not is a
   * fact a phone cannot read at all. Size used to be a bare letter here while
   * the board's Size cell carried the letter AND the estimate under it.
   */
  it("carries the board's Size cell, estimate and all", () => {
    const view = detail([phase({ phase: 2, title: 'Surface', state: 'ready', size: 'L' })]);
    (view as { eta?: unknown }).eta = {
      perPhase: [{ phase: 2, weight: 90_000, estMs: 5_400_000, basis: 'plan', label: '~1.5 h' }],
    };
    mount(view);
    expect(screen.getByText('L')).toBeInTheDocument();
    expect(screen.getByText('~1.5 h')).toBeInTheDocument();
  });

  it('groups by state, worst first, and drops the groups with nothing in them', () => {
    mount(detail(BOARD));
    const headings = screen.getAllByRole('button', { expanded: true }).map((b) => b.textContent ?? '');
    const shut = screen.getAllByRole('button', { expanded: false }).map((b) => b.textContent ?? '');
    const all = [...headings, ...shut].join('|');
    // The five that have rows, in `PHASE_GROUPS` order.
    expect(all).toMatch(/Needs you.*Running.*Ready.*Waiting.*Done/s);
  });

  it('drops a group with no phases in it rather than showing an empty one', () => {
    mount(detail([phase({ phase: 1, state: 'ready' })]));
    expect(screen.queryByText('Needs you')).toBeNull();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('opens with Done collapsed — and the collapse survives a remount', () => {
    const first = mount(detail(BOARD));
    // Collapsed by default: the card is not rendered at all.
    expect(screen.queryByText('Foundations')).toBeNull();

    const done = screen.getByRole('button', { name: /Done/ });
    expect(done).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(done);
    expect(screen.getByText('Foundations')).toBeInTheDocument();

    first.unmount();
    mount(detail(BOARD));
    // The choice is the operator's, and it is stored as the COLLAPSED ids — so
    // re-opening Done keeps it open across a navigation.
    expect(screen.getByText('Foundations')).toBeInTheDocument();
  });

  it('carries the claim-versus-evidence badge, and nothing when there is no proof', () => {
    mount(
      detail([
        phase({
          phase: 4,
          title: 'Docs',
          state: 'stuck',
          proof: {
            board: 'done',
            handoff: 'absent',
            verification: 'none',
            qa: 'off',
            evidenced: false,
            why: [],
          },
        } as unknown as Partial<PhaseView>),
        phase({ phase: 2, title: 'Surface', state: 'ready' }),
      ]),
    );
    expect(screen.getByText('claimed only')).toBeInTheDocument();
    // The `ready` row has no `proof` at all — and says nothing rather than
    // claiming the phase is fine.
    expect(screen.queryByText('evidenced')).toBeNull();
  });

  it("renders the run page's drawer per row, and asks for nothing until it is opened", async () => {
    mount(detail([phase({ phase: 4, title: 'Docs', state: 'stuck' })]));
    const drawer = screen.getByText('Why is this not done?');
    // The whole reason the drawer fetches on OPEN: `git status` plus two script
    // runs, per row, on a page where most rows are never opened.
    expect(phaseDiagnosis).not.toHaveBeenCalled();

    // jsdom does not fire `toggle` off a summary click, so open it directly.
    const details = drawer.closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() => expect(phaseDiagnosis).toHaveBeenCalledWith('demo', 4));
  });

  it('makes the number and the title links into the phase, and the card not one', () => {
    const { container } = mount(detail([phase({ phase: 2, title: 'Surface', state: 'ready' })]));
    const links = within(container).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toContain('#/plan/demo/phase/2');
    // Exactly two — the number and the title. A single anchor stretched over
    // the whole card is what left nowhere to put the drawer.
    expect(links.filter((a) => a.getAttribute('href') === '#/plan/demo/phase/2')).toHaveLength(2);
  });
});

describe('an in-progress phase: the claim, and the fact behind it', () => {
  it('badges a claim nothing is running as "claimed running", and does NOT link it', () => {
    // B2(a) reduced to one row. `state: 'in-progress'` came out of a handoff's
    // frontmatter; `live` is absent because the server looked and found no run,
    // no vouched lock and no live session. The row must say which of the two
    // it is — and must not offer a link to a session that is not there.
    const { container } = mount(
      detail([phase({ phase: 5, title: 'Ship', state: 'in-progress', proof: STALE_PROOF } as never)]),
    );
    expect(screen.getByText('claimed running')).toBeInTheDocument();
    // The state chip is still rendered — the board word is not hidden, it is
    // qualified — but nothing wraps it in an anchor.
    const links = within(container).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href') ?? '')).toEqual(
      expect.arrayContaining(['#/plan/demo/phase/5']),
    );
    expect(links.some((a) => (a.getAttribute('href') ?? '').includes('lane='))).toBe(false);
    expect(container.querySelector('.animate-pulse-soft')).toBeNull();
  });

  it('leaves a genuinely-running phase unbadged, pulsing, and linked to its lane', () => {
    // The negative case, and the reason the badge means anything: when the
    // server DID find something, the row says nothing extra and becomes a way
    // to get to it.
    const { container } = mount(
      detail([
        phase({ phase: 5, title: 'Ship', state: 'in-progress', live: LIVE, proof: RUNNING_PROOF } as never),
      ]),
    );
    expect(screen.queryByText('claimed running')).toBeNull();
    const links = within(container).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toContain('#/plan/demo/run?lane=p5');
    expect(container.querySelector('.animate-pulse-soft')).not.toBeNull();
  });

  it('says nothing at all when the server never measured it', () => {
    // A console built after its server: `stale` absent must read as "not
    // measured", never as "measured and empty". A warn chip nobody measured is
    // worse than no chip.
    const { container } = mount(
      detail([
        phase({
          phase: 5,
          title: 'Ship',
          state: 'in-progress',
          proof: { ...RUNNING_PROOF, stale: undefined },
        } as never),
      ]),
    );
    expect(screen.queryByText('claimed running')).toBeNull();
    expect(screen.queryByText('claimed only')).toBeNull();
    expect(container.querySelector('.animate-pulse-soft')).toBeNull();
  });
});
