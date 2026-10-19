/**
 * Your turn, the page (7.0, quiet-console phase 8; control-tower phase 137,
 * #214, exit criterion 1: the six sections render in order with the same
 * rows as 6.2).
 *
 *   TP-1 the headline is the heading, the round its lead, then the six sections in order;
 *   TP-2 the filters and the search live in the address — an address narrows
 *        the page, and a select in the Filter slot writes its word into the address;
 *   TP-3 *Done* holds the day's settled items and, under them, the ledger's older ones;
 *   TP-4 *Export* writes ONE Markdown document of the open items with their guides;
 *   TP-5 `#/turn/<id>` opens that item (aria-current) — even one folded under Coming up;
 *        an id the turn no longer holds says so;
 *   TP-6 the handled log is the last section, folded with its count;
 *   TP-7 Everything unfolds Done and the handled log and opens every folded card;
 *   TP-8 Inspect hands the panel the item, and its Overview reads `GET /api/turn/:id`;
 *   TP-9 *Withdraw* posts the console's dismiss through the owner door, and the
 *        item is HELD on the page until the server's `turn` event (#270).
 *   TP-v2 (turn-by-turn phase 9) — the block at the end of this file.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { read, explain, humanSteps, owner, post, listeners, inspected } = vi.hoisted(() => ({
  read: vi.fn(),
  explain: vi.fn(),
  humanSteps: vi.fn(),
  owner: vi.fn(),
  post: vi.fn(),
  listeners: [] as { name: string; fn: (data: unknown, name: string) => void }[],
  inspected: vi.fn(),
}));

// Every read and write of the page meets the one http door under `data/`.
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) => {
      if (/^\/api\/turn\/[^?]+/.test(path)) return explain(path);
      if (path.startsWith('/api/turn')) return read(path);
      if (path.startsWith('/api/human-steps')) return humanSteps(path);
      if (path.startsWith('/api/owner')) return owner(path);
      return Promise.reject(new actual.ApiError(`unmocked ${path}`, 500, path));
    },
    post: (path: string, body?: unknown) => post(path, body),
  };
});
// The server's `turn` event is the one thing that ends a hold (#270).
vi.mock('@/data/live', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/live')>();
  return {
    ...actual,
    onSse: (name: string, fn: (data: unknown, name: string) => void) => {
      listeners.push({ name, fn });
      return () => {
        const at = listeners.findIndex((one) => one.fn === fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
});
vi.mock('@/shell/panel/inspector-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shell/panel/inspector-host')>();
  return { ...actual, inspect: (record: unknown) => inspected(record) };
});

import { humanStepView, type HumanStepKind, type HumanStepState } from '@shared/human-step-model.js';
import type { HumanStepRecord, PermissionRecord, TurnAnswer, TurnItem } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import { turnMarkdown } from './export';
import { ExplainOverview } from './inspector';
import TurnPage from './index';
import { filtersOf, sectionsOf } from './page-model';

const AT = '2026-10-07T12:00:00.000Z';

function item(
  id: string,
  kind: HumanStepKind,
  state: HumanStepState,
  group: TurnItem['group'],
  over: Partial<TurnItem> = {},
): TurnItem {
  return {
    item: id,
    record: 'ledger',
    source: 'declared',
    kind,
    why: kind === 'decision' ? 'decision' : 'identity',
    proofType: kind === 'decision' ? 'answer' : 'probe',
    group,
    rows: [`human-step:alpha:3:${id}`],
    title: `Item ${id}`,
    need: '',
    how: '',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    since: '2026-10-07T10:00:00.000Z',
    href: '/plan/alpha/phase/3',
    actions: [],
    humanStep: humanStepView({ kind, title: `Item ${id}`, state, stepId: id }),
    step: {
      id,
      kind,
      title: `Item ${id}`,
      state,
      why: 'identity',
      whySource: 'declared',
      proofType: 'probe',
      attempts: 0,
      waiters: [],
      declaredAt: '2026-10-07T10:00:00.000Z',
      birth: 'session',
      guide:
        id === 'now-1'
          ? {
              version: 1,
              lang: 'en',
              dir: 'ltr',
              summary: 'Only you can sign the CLI in.',
              steps: [{ text: 'Run the sign-in', code: 'gh auth login --web' }],
              trouble: [],
            }
          : undefined,
    } as TurnItem['step'],
    ...over,
  };
}

const ASK: PermissionRecord = {
  wall: 'ask',
  tool: 'Bash',
  rule: 'Bash(npm test:*)',
  command: 'npm test --workspace viewer',
  need: 'The phase runs its own suite before it hands off.',
  family: 'any',
  risk: 'low',
  scopes: ['call', 'phase', 'plan', 'repository', 'always'],
};

const PERMIT = item('permit-1', 'permission', 'notified', 'now', {
  why: 'permission',
  proofType: 'grant',
  permission: ASK,
  runId: 'r-1',
  actions: [
    {
      verb: 'grant',
      label: 'Grant — this one call',
      endpoint: '/api/human-steps/permit-1/grant',
      method: 'POST',
      body: { scope: 'call' },
    },
    { verb: 'deny', label: 'Deny', endpoint: '/api/human-steps/permit-1/deny', method: 'POST' },
  ],
});

function answer(over: Partial<TurnAnswer['groups']> = {}): TurnAnswer {
  const groups: TurnAnswer['groups'] = {
    approve: [],
    now: [item('now-1', 'browser-login', 'notified', 'now')],
    decide: [
      item('decide-1', 'decision', 'notified', 'decide', {
        slug: 'beta',
        phase: 2,
        rows: ['human-step:beta:2:decide-1'],
      }),
    ],
    upcoming: [item('up-1', 'operator-act', 'upcoming', 'upcoming')],
    checking: [item('check-1', 'physical', 'checking', 'checking')],
    done: [item('done-1', 'secret-entry', 'proven', 'done')],
    ...over,
  };
  return {
    round: { at: AT, n: 14, ranAt: AT, changedAt: '2026-10-07T11:50:00.000Z' },
    headline: 'Two things wait on you; one unblocks phase 4.',
    groups,
    handled: [
      {
        id: 'h-1',
        at: AT,
        first: '2026-10-07T09:00:00.000Z',
        source: 'auto-grant',
        what: 'Allowed git push of the run branch',
        slug: 'alpha',
        phase: 3,
        count: 3,
        links: [{ kind: 'commit', ref: '41bc1f14abcdef' }],
      },
    ],
    counts: {
      approve: groups.approve.length,
      now: groups.now.length,
      decide: groups.decide.length,
      upcoming: groups.upcoming.length,
      checking: groups.checking.length,
      done: groups.done.length,
      total:
        groups.approve.length +
        groups.now.length +
        groups.decide.length +
        groups.upcoming.length +
        groups.checking.length,
      handled: 1,
    },
    seen: null,
    issues: { count: 2, href: '/repo/issues?state=draft' },
  };
}

const ANSWER = answer();

const OLDER: HumanStepRecord = {
  id: 'old-1',
  kind: 'claude-login',
  title: 'Sign Claude in again',
  where: 'host',
  birth: 'console',
  slug: 'alpha',
  phase: 1,
  state: 'proven',
  declaredAt: '2026-10-01T10:00:00.000Z',
  at: '2026-10-01T11:00:00.000Z',
  opened: 1,
};

/**
 * 7.1's page was the cards with every section on one page: these tests read
 * it at that address (`?view=cards&tab=all`, one-pool phase 14) unless the
 * hash names its own view or tab. TP-14 below reads the 8.0 defaults.
 */
function cardsAddress(hash: string): string {
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  if (!params.has('view')) params.set('view', 'cards');
  if (!params.has('tab')) params.set('tab', 'all');
  return `${path}?${params.toString()}`;
}

function mount(hash = '#/turn', onNavigate = vi.fn(), { legacy = true }: { legacy?: boolean } = {}) {
  hash = legacy ? cardsAddress(hash) : hash;
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={hash} onNavigate={onNavigate}>
        <TurnPage route={parseHash(hash) as Route} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return { onNavigate, client };
}

const section = (id: string) =>
  screen.getAllByTestId('turn-section').find((el) => el.getAttribute('data-section') === id)!;

/** Open the Filter slot (a desk's popover) and hand back its panel. */
async function openFilter(): Promise<HTMLElement> {
  fireEvent.click(document.querySelector<HTMLElement>('[data-slot="filter"]')!);
  return screen.findByRole('dialog', { name: 'Filter' });
}

beforeEach(() => {
  read.mockReset();
  explain.mockReset();
  humanSteps.mockReset();
  owner.mockReset();
  post.mockReset();
  inspected.mockReset();
  listeners.length = 0;
  read.mockResolvedValue(ANSWER);
  humanSteps.mockResolvedValue({
    steps: [OLDER],
    reminders: { series: [], quiet: null },
    can: { openHost: false, terminal: false, resume: false },
  });
  owner.mockResolvedValue({
    state: 'unenrolled',
    mode: 'unenrolled',
    keys: [],
    session: null,
    requests: [],
    relyingParty: { id: 'localhost', origin: 'http://localhost:4130' },
  });
  window.localStorage.clear();
  setPrefs({ everything: {} });
  Element.prototype.scrollIntoView = vi.fn();
});

describe('TP-1 the headline, the round and the sections', () => {
  it('draws them in order', async () => {
    mount();
    expect((await screen.findByTestId('turn-headline')).textContent).toBe(ANSWER.headline);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ANSWER.headline);
    expect(screen.getByTestId('turn-round').textContent).toContain('Round 14');
    const sections = screen.getAllByTestId('turn-section').map((s) => s.getAttribute('data-section'));
    // An empty group folds into the one shared line (one-pool phase 14, #377): Approve is empty here.
    expect(sections).toEqual(['now', 'decide', 'checking', 'upcoming', 'done', 'handled']);
    expect(screen.getByTestId('turn-empty-groups').textContent).toBe('Nothing to approve.');
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent?.replace(/\d+$/, ''));
    // The groups v2 (turn-by-turn phase 9), then the handled log, then where the plans stand.
    expect(headings).toEqual([
      'Do now',
      'Decide',
      'Being checked',
      'Coming up',
      'Done',
      'Handled by the AI',
      'Where the plans stand',
    ]);
    expect(screen.getByTestId('turn-issues').textContent).toContain('2 issue drafts wait');
    // The page remembers the look, for the next one's handled count.
    expect(window.localStorage.getItem('turn:seen')).toBe(AT);
    // The root carries the mark `check-dist` finds the lazy chunk by.
    expect(screen.getByTestId('turn-page').hasAttribute('data-turn-page')).toBe(true);
  });
});

describe('TP-2 the filters live in the address', () => {
  it('an address narrows the page, and the note says so', async () => {
    mount('#/turn?plan=beta');
    await screen.findByTestId('turn-headline');
    const items = screen.getAllByTestId('turn-item').map((el) => el.getAttribute('data-item'));
    expect(items).toEqual(['decide-1']);
    expect(screen.getAllByText(/hidden by the filters/).length).toBeGreaterThan(0);
    // Five, because Done's settled item counts too — the note counts rows, the headline counts the open.
    expect(screen.getByTestId('turn-narrowed').textContent).toMatch(/Showing 1 of 5 items/);
  });

  it('a select in the Filter slot writes its word into the address, keeping the item it names', async () => {
    const { onNavigate } = mount('#/turn/now-1');
    await screen.findByTestId('turn-headline');
    const panel = await openFilter();
    fireEvent.change(within(panel).getByTestId('turn-filter-plan'), { target: { value: 'beta' } });
    expect(onNavigate).toHaveBeenLastCalledWith(expect.stringMatching(/^#\/turn\/now-1\?.*plan=beta/));
  });

  it('the search is a filter too', () => {
    const narrowed = sectionsOf(ANSWER, filtersOf({ q: 'gh auth' }));
    expect(narrowed.flatMap((s) => s.items.map((i) => i.item))).toEqual(['now-1']);
  });
});

describe('TP-3 Done', () => {
  it('holds the day’s settled items and the ledger’s older ones, folded with its count', async () => {
    mount();
    await screen.findByTestId('turn-headline');
    const done = section('done');
    expect(within(done).queryByTestId('turn-item')).toBeNull();
    fireEvent.click(within(done).getByRole('button', { name: /What was settled/ }));
    expect(within(done).getByTestId('turn-item').getAttribute('data-item')).toBe('done-1');
    expect(within(done).getByTestId('turn-done-earlier').textContent).toContain('Sign Claude in again');
  });
});

describe('TP-4 Export', () => {
  it('writes one Markdown document of the open items with their guides', () => {
    const text = turnMarkdown(ANSWER, sectionsOf(ANSWER, {}), new Map());
    expect(text.startsWith('# Your turn\n')).toBe(true);
    expect(text).toContain(ANSWER.headline);
    expect(text).toContain('## Do now');
    expect(text).toContain('### Item now-1');
    expect(text).toContain('gh auth login --web');
    expect(text).toContain('#### Steps');
    expect(text).toContain('## Coming up');
    // Settled is not open.
    expect(text).not.toContain('Item done-1');
    expect(text.match(/^# /gm)).toHaveLength(1);
  });
});

describe('TP-5 an item by its address', () => {
  it('opens the named item, even one folded under Coming up', async () => {
    mount('#/turn/up-1');
    await screen.findByTestId('turn-headline');
    const named = screen.getAllByTestId('turn-item').find((el) => el.getAttribute('data-item') === 'up-1')!;
    expect(named.getAttribute('aria-current')).toBe('true');
    expect(within(named).getByTestId('turn-body').className).toContain('flex');
  });

  it('says so when the item is no longer waiting', async () => {
    mount('#/turn/gone-1');
    expect((await screen.findByTestId('turn-item-gone')).textContent).toContain('no longer waiting');
  });
});

describe('TP-6 the handled log', () => {
  it('is the last section, folded with its count', async () => {
    mount();
    await screen.findByTestId('turn-headline');
    const handled = screen.getAllByTestId('turn-section').at(-1)!;
    expect(handled.getAttribute('data-section')).toBe('handled');
    expect(within(handled).queryByTestId('turn-handled')).toBeNull();
    fireEvent.click(within(handled).getByRole('button', { name: /What the AI handled/ }));
    const row = within(handled).getByTestId('turn-handled-row');
    expect(row.textContent).toContain('A standing grant allowed it');
    expect(row.textContent).toContain('×3');
    expect(row.textContent).toContain('commit 41bc1f14');
  });
});

describe('TP-7 Everything', () => {
  it('unfolds Done and the handled log, and opens every folded card', async () => {
    setPrefs({ everything: { turn: true } });
    mount();
    await screen.findByTestId('turn-headline');
    expect(within(section('done')).getByTestId('turn-item').getAttribute('data-item')).toBe('done-1');
    expect(within(section('handled')).getByTestId('turn-handled-row')).toBeTruthy();
    const coming = within(section('upcoming')).getByTestId('turn-item');
    expect(within(coming).queryByTestId('turn-item-toggle')).toBeNull();
    expect(within(coming).getByTestId('turn-body').className).toContain('flex');
  });
});

describe('TP-8 Inspect', () => {
  it('hands the panel the item, keyed, with its state', async () => {
    mount();
    await screen.findByTestId('turn-headline');
    const card = screen.getAllByTestId('turn-item').find((el) => el.getAttribute('data-item') === 'now-1')!;
    fireEvent.click(within(card).getByTestId('turn-inspect'));
    expect(inspected).toHaveBeenCalledTimes(1);
    const record = inspected.mock.calls[0]![0] as { key: string; title: string; overview: unknown };
    expect(record.key).toBe('turn:now-1');
    expect(record.title).toBe('Item now-1');
    expect(record.overview).toBeTruthy();
  });

  it('its Overview reads the explain view, GET /api/turn/:id, and says why only a person fits it', async () => {
    explain.mockResolvedValue({
      ok: true,
      item: {
        id: 'now-1',
        kind: 'browser-login',
        title: 'Item now-1',
        state: 'notified',
        birth: 'session',
        slug: 'alpha',
        phase: 3,
        why: 'identity',
        whySource: 'declared',
        whyPerson: 'Only you can sign in: only you can sign in as yourself.',
        commands: ['gh auth login --web'],
        proofType: 'probe',
        proof: 'cmd:"gh auth status"',
        attempts: 2,
        verdicts: [],
        waiters: [{ slug: 'alpha', phase: 3 }],
        declaredAt: '2026-10-07T10:00:00.000Z',
        at: '2026-10-07T10:00:00.000Z',
      },
    });
    const client = new QueryClient({ ...queryClientConfig, defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouterProvider initial="#/turn">
          <ExplainOverview item={ANSWER.groups.now[0]!} record={undefined} />
        </MemoryRouterProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(explain).toHaveBeenCalledWith('/api/turn/now-1'));
    expect((await screen.findByTestId('turn-explain-why')).textContent).toContain(
      'only you can sign in as yourself',
    );
    expect(screen.getByTestId('turn-explain-commands').textContent).toContain('gh auth login --web');
    expect(screen.getByTestId('turn-explain').textContent).toContain('alpha phase 3');
  });
});

describe('TP-9 Withdraw, and the hold (#270)', () => {
  it('posts the console’s dismiss through the owner door, holds the item until the turn event, then lets it go', async () => {
    post.mockResolvedValue({ ok: true, step: { ...ANSWER.groups.now[0]!.step, state: 'dismissed' } });
    const { client } = mount();
    await screen.findByTestId('turn-headline');
    const card = screen.getAllByTestId('turn-item').find((el) => el.getAttribute('data-item') === 'now-1')!;
    fireEvent.click(within(card).getByTestId('turn-withdraw'));
    // The press has to be meant: the confirm keeps the button's own word.
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Withdraw this item?');
    // From here the server no longer lists the item …
    read.mockResolvedValue(answer({ now: [] }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/human-steps/now-1/dismiss', {}));
    // … and the page re-reads it, yet the item stays where it stood, saying what was pressed.
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
    const held = await screen.findByTestId('turn-settling');
    expect(held.textContent).toContain('Withdrawn');
    const row = held.closest('[data-testid="turn-item"]')!;
    expect(row.getAttribute('data-item')).toBe('now-1');
    expect(row.hasAttribute('data-settling')).toBe(true);
    expect(section('now').contains(row)).toBe(true);
    // Only the server's `turn` event lets it go.
    expect(listeners.some((one) => one.name === 'turn')).toBe(true);
    act(() => {
      for (const one of listeners.filter((l) => l.name === 'turn')) one.fn({ round: 15 }, 'turn');
    });
    await client.invalidateQueries();
    await waitFor(() =>
      expect(screen.queryAllByTestId('turn-item').map((el) => el.getAttribute('data-item'))).not.toContain(
        'now-1',
      ),
    );
  });

  it('a grant that went through is held the same way, and leaves on the event (#270)', async () => {
    read.mockResolvedValue(answer({ now: [PERMIT] }));
    post.mockResolvedValue({
      ok: true,
      granted: { id: 'g-1', rule: 'Bash(npm test:*)', scope: 'call', state: 'live' },
      resumes: [],
    });
    mount();
    await screen.findByTestId('turn-headline');
    const card = screen
      .getAllByTestId('turn-item')
      .find((el) => el.getAttribute('data-item') === 'permit-1')!;
    read.mockResolvedValue(answer({ now: [] }));
    fireEvent.click(within(card).getByTestId('turn-primary'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/human-steps/permit-1/grant', { scope: 'call' }),
    );
    const held = await screen.findByTestId('turn-settling');
    expect(held.textContent).toContain('Granted for this one call');
    expect(held.closest('[data-testid="turn-item"]')!.getAttribute('data-item')).toBe('permit-1');
    act(() => {
      for (const one of listeners.filter((l) => l.name === 'turn')) one.fn({ round: 15 }, 'turn');
    });
    await waitFor(() => expect(screen.queryByTestId('turn-settling')).toBeNull());
    expect(screen.queryAllByTestId('turn-item').map((el) => el.getAttribute('data-item'))).not.toContain(
      'permit-1',
    );
  });
});

/* ------------------------------------------------------------------ *
 * TP-v2 (turn-by-turn phase 9): the strip, the groups v2 with an empty
 * group's one line, Group · Sort · View in the address, `#/turn/<id>`
 * opening the panel for a ledger and a projected item, the reason said once
 * (#332), the heads-ups, where the plans stand, and Export's options,
 * timing and approval blocks.
 * ------------------------------------------------------------------ */

const GATE: TurnItem = {
  ...item('gate-1', 'decision', 'notified', 'approve'),
  record: 'projected',
  source: 'gate',
  why: 'decision',
  proofType: 'answer',
  type: 'approve',
  personStatus: 'todo',
  readiness: 'now',
  route: 'gate',
  rows: ['gate:alpha:4'],
  title: 'Open the gate on phase 4',
  need: 'A person signs this phase off.',
  step: undefined,
  humanStep: undefined,
  timing: { assignedAt: '2026-10-07T11:00:00.000Z', deadline: '2026-10-07T15:00:00.000Z' },
  approval: {
    what: 'Phase 4 starts once the gate opens.',
    askedBy: 'The plan, on phase 4',
    ifApproved: 'The gate opens and phase 4 boards.',
    ifDenied: 'The gate stays shut; the phase waits.',
  },
  options: [
    {
      id: 'approve',
      label: 'Approve',
      recommended: true,
      consequence: 'phase 4 boards',
      verb: { method: 'POST', endpoint: '/api/plan/alpha/gate/4/approve' },
    },
    { id: 'deny', label: 'Deny', verb: { method: 'POST', endpoint: '/api/plan/alpha/gate/4/deny' } },
  ],
};

function v2(): TurnAnswer {
  const base = answer({ approve: [GATE] });
  return {
    ...base,
    counts: { ...base.counts, approve: 1, total: base.counts.total + 1 },
    strip: {
      todo: 3,
      checking: 1,
      passedToday: 1,
      nextDeadline: { at: '2026-10-07T15:00:00.000Z', item: 'gate-1', title: 'Open the gate on phase 4' },
    },
    headsUp: [
      {
        ...item('eref:E-1', 'operator-act', 'notified', 'upcoming'),
        record: 'projected',
        type: 'know',
        title: 'The site moves to its own domain',
        step: undefined,
        humanStep: undefined,
      },
    ],
  };
}

describe('TP-v2 the page in 7.0’s grammar (turn-by-turn phase 9)', () => {
  it('draws the strip — to do, checking, passed today, the live line and the next deadline', async () => {
    read.mockResolvedValue(v2());
    mount();
    const strip = await screen.findByTestId('turn-strip');
    expect(within(strip).getByTestId('turn-strip-todo').getAttribute('data-value')).toBe('3');
    expect(within(strip).getByTestId('turn-strip-todo').textContent).toBe('3to do');
    expect(within(strip).getByTestId('turn-strip-checking').getAttribute('data-value')).toBe('1');
    expect(within(strip).getByTestId('turn-strip-passed').textContent).toContain('passed today');
    expect(within(strip).getByTestId('turn-round').textContent).toContain('Round 14');
    const next = within(strip).getByTestId('turn-next-deadline');
    expect(next.textContent).toContain('Next deadline: Open the gate on phase 4');
    expect(within(next).getByRole('link').getAttribute('href')).toBe('#/turn/gate-1');
  });

  it('says "none set" when no open item carries a deadline, and counts the groups for a 7.0 answer', async () => {
    mount();
    const strip = await screen.findByTestId('turn-strip');
    expect(within(strip).getByTestId('turn-next-deadline').textContent).toBe('Next deadline: none set.');
    expect(within(strip).getByTestId('turn-strip-todo').getAttribute('data-value')).toBe('2');
  });

  it('draws the six groups in order with their counts, Handled by the AI after them, and an empty group in one line', async () => {
    read.mockResolvedValue(v2());
    mount();
    await screen.findByTestId('turn-headline');
    const ids = screen.getAllByTestId('turn-section').map((s) => s.getAttribute('data-section'));
    expect(ids).toEqual(['approve', 'now', 'decide', 'checking', 'upcoming', 'done', 'handled']);
    const heads = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent?.replace(/\d+$/, ''))
      .slice(0, 7);
    expect(heads).toEqual([
      'Approve',
      'Do now',
      'Decide',
      'Being checked',
      'Coming up',
      'Done',
      'Handled by the AI',
    ]);
    expect(within(section('approve')).getByTestId('turn-item').getAttribute('data-item')).toBe('gate-1');
    // An empty group folds into one plain line shared by every empty group (#377).
    read.mockResolvedValue({ ...v2(), groups: { ...v2().groups, decide: [] } });
    mount();
    await waitFor(() => expect(screen.getAllByText('Nothing to decide.').length).toBeGreaterThan(0));
  });

  it('draws the heads-ups after the handled log, and where the plans stand last', async () => {
    read.mockResolvedValue(v2());
    mount();
    const heads = await screen.findByTestId('turn-heads-up');
    expect(within(heads).getByTestId('turn-item').getAttribute('data-item')).toBe('eref:E-1');
    const plans = screen.getByTestId('turn-plans');
    expect(
      within(plans)
        .getAllByTestId('turn-plan')
        .map((p) => p.getAttribute('data-plan')),
    ).toEqual(['alpha', 'beta']);
    const waiting = within(plans).getAllByTestId('turn-plan-waiting')[0]!;
    expect(waiting.textContent).toBe('2 wait on you');
    expect(waiting.getAttribute('href')).toMatch(/^#\/turn\?.*plan=alpha/);
    // The order on the page: the handled log, then the heads-ups, then the plans.
    const handled = section('handled');
    expect(handled.compareDocumentPosition(heads) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heads.compareDocumentPosition(plans) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps Status, Time, Plan, Type and Goes to in the Filter slot, each written into the address', async () => {
    read.mockResolvedValue(v2());
    const { onNavigate } = mount('#/turn');
    await screen.findByTestId('turn-headline');
    const panel = await openFilter();
    for (const name of ['status', 'time', 'plan', 'type', 'to']) {
      expect(within(panel).getByTestId(`turn-filter-${name}`)).toBeTruthy();
    }
    // The 7.0 four wait under Everything.
    expect(within(panel).queryByTestId('turn-filter-kind')).toBeNull();
    fireEvent.change(within(panel).getByTestId('turn-filter-type'), { target: { value: 'approve' } });
    expect(onNavigate).toHaveBeenLastCalledWith(expect.stringMatching(/^#\/turn\?.*type=approve/));
    fireEvent.change(within(panel).getByTestId('turn-filter-to'), { target: { value: 'gate' } });
    expect(onNavigate).toHaveBeenLastCalledWith(expect.stringContaining('to=gate'));
  });

  it('an address narrows by the card’s words', async () => {
    read.mockResolvedValue(v2());
    mount('#/turn?type=approve');
    await screen.findByTestId('turn-headline');
    expect(
      screen
        .getAllByTestId('turn-item')
        .filter((el) => el.closest('[data-testid="turn-section"]'))
        .map((el) => el.getAttribute('data-item')),
    ).toEqual(['gate-1']);
  });

  it('groups the cards by plan from the address; what is over is not regrouped', async () => {
    read.mockResolvedValue(v2());
    mount('#/turn?group=plan&view=cards');
    await screen.findByTestId('turn-headline');
    const ids = screen.getAllByTestId('turn-section').map((s) => s.getAttribute('data-section'));
    expect(ids).toEqual(['plan:alpha', 'plan:beta', 'done', 'handled']);
  });

  it('#/turn/<id> focuses a ledger item and opens the panel on it', async () => {
    mount('#/turn/now-1');
    await screen.findByTestId('turn-headline');
    const named = screen.getAllByTestId('turn-item').find((el) => el.getAttribute('data-item') === 'now-1')!;
    expect(named.getAttribute('aria-current')).toBe('true');
    await waitFor(() => expect(inspected).toHaveBeenCalled());
    expect((inspected.mock.calls.at(-1)![0] as { key: string }).key).toBe('turn:now-1');
  });

  it('#/turn/<id> focuses a projected item and opens the panel on it too', async () => {
    read.mockResolvedValue(v2());
    mount('#/turn/gate-1');
    await screen.findByTestId('turn-headline');
    const named = screen.getAllByTestId('turn-item').find((el) => el.getAttribute('data-item') === 'gate-1')!;
    expect(named.getAttribute('aria-current')).toBe('true');
    await waitFor(() => expect(inspected).toHaveBeenCalled());
    const record = inspected.mock.calls.at(-1)![0] as { key: string; raw: string };
    expect(record.key).toBe('turn:gate-1');
    expect(record.raw).toContain('"source": "gate"');
  });

  it('the inspector says why only a person fits it ONCE (#332)', async () => {
    const client = new QueryClient({ ...queryClientConfig, defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouterProvider initial="#/turn">
          <ExplainOverview item={GATE} record={undefined} />
        </MemoryRouterProvider>
      </QueryClientProvider>,
    );
    const why = screen.getByTestId('turn-explain-why').textContent!;
    expect(why).toBe('A person signs this phase off.');
    const overview = screen.getByTestId('turn-explain').textContent!;
    expect(overview.split('A person signs this phase off.').length - 1).toBe(1);
  });

  it('Export carries the options, the timing and the approval block', () => {
    const text = turnMarkdown(v2(), sectionsOf(v2(), {}), new Map());
    expect(text).toContain('## Approve');
    expect(text).toContain('### Open the gate on phase 4');
    expect(text).toContain('- Type: Approval');
    expect(text).toContain('- Status: To do, NOW');
    expect(text).toContain('- Deadline: 2026-10-07T15:00:00.000Z');
    expect(text).toContain('- Assigned: 2026-10-07T11:00:00.000Z');
    expect(text).toContain('- Goes to: The gate');
    expect(text).toContain('#### The approval');
    expect(text).toContain('- If approved: The gate opens and phase 4 boards.');
    expect(text).toContain('- If denied: The gate stays shut; the phase waits.');
    expect(text).toContain('#### The options');
    expect(text).toContain('- Approve (recommended): phase 4 boards');
    expect(text).toContain('- Deny');
  });
});

/*
 * TP-14 (one-pool phase 14, #377 #366) — the page a person works FROM: the
 * list by default with the card in the panel on selection, the board grouped
 * by plan, the tabs, the chips with counts, a plan's own view, and a bulk
 * *Not doing* that settles every picked item.
 */
function v14(): TurnAnswer {
  const typed = (
    it: TurnItem,
    type: TurnItem['type'],
    status: TurnItem['personStatus'] = 'todo',
  ): TurnItem => ({
    ...it,
    type,
    personStatus: status,
    readiness: 'now',
    step: it.step ? ({ ...it.step, allowDecline: true } as TurnItem['step']) : it.step,
  });
  return answer({
    now: [
      typed(item('now-1', 'browser-login', 'notified', 'now'), 'do'),
      typed(item('now-2', 'operator-act', 'notified', 'now', { slug: 'beta', phase: 5 }), 'do'),
    ],
    decide: [typed(item('decide-1', 'decision', 'notified', 'decide', { slug: 'beta', phase: 2 }), 'decide')],
    checking: [typed(item('check-1', 'physical', 'checking', 'checking'), 'do', 'checking')],
    upcoming: [],
    done: [typed(item('done-1', 'secret-entry', 'proven', 'done'), 'do', 'passed')],
  });
}

describe('TP-14 the list, the board, the tabs and the chips (one-pool phase 14)', () => {
  it('opens on the list: one line per open item, Done and Handled on their own tabs, empty groups in one line', async () => {
    read.mockResolvedValue(v14());
    mount('#/turn', vi.fn(), { legacy: false });
    await screen.findByTestId('turn-headline');
    expect(screen.getByTestId('turn-page-body').getAttribute('data-view')).toBe('list');
    const rows = screen.getAllByTestId('turn-row').map((el) => el.getAttribute('data-item'));
    expect(rows).toEqual(['now-1', 'now-2', 'decide-1', 'check-1']);
    expect(screen.queryByTestId('turn-item')).toBeNull();
    expect(screen.getByTestId('turn-empty-groups').textContent).toBe('Nothing to approve or coming up.');
    const tabs = screen.getByRole('navigation', { name: 'Which items' });
    const open = within(tabs).getByRole('link', { name: /^Open/ });
    expect(open.getAttribute('aria-current')).toBe('page');
    expect(open.textContent).toContain('4');
    expect(within(tabs).getByRole('link', { name: /^Done/ }).getAttribute('href')).toBe('#/turn?tab=done');
  });

  it('selecting a line names it in the address and opens its whole card in the panel', async () => {
    read.mockResolvedValue(v14());
    const { onNavigate } = mount('#/turn', vi.fn(), { legacy: false });
    await screen.findByTestId('turn-headline');
    const row = screen.getAllByTestId('turn-row').find((el) => el.getAttribute('data-item') === 'decide-1')!;
    fireEvent.click(within(row).getByRole('button'));
    expect(onNavigate).toHaveBeenLastCalledWith('#/turn/decide-1');
  });

  it('#/turn/<id> on the list marks the line and hands the panel the card', async () => {
    read.mockResolvedValue(v14());
    mount('#/turn/now-2', vi.fn(), { legacy: false });
    await screen.findByTestId('turn-headline');
    const row = screen.getAllByTestId('turn-row').find((el) => el.getAttribute('data-item') === 'now-2')!;
    expect(row.hasAttribute('data-selected')).toBe(true);
    await waitFor(() => expect(inspected).toHaveBeenCalled());
    const record = inspected.mock.calls.at(-1)![0] as { key: string; overview: { type: { name: string } } };
    expect(record.key).toBe('turn:now-2');
    expect(record.overview.type.name).toBe('PanelCard');
  });

  it('?view=board&group=plan draws a lane per plan, in columns by the person’s status', async () => {
    read.mockResolvedValue(v14());
    mount('#/turn?view=board&group=plan&tab=open', vi.fn(), { legacy: false });
    await screen.findByTestId('turn-headline');
    const board = screen.getByTestId('turn-board');
    const lanes = within(board).getAllByTestId('turn-board-lane');
    expect(lanes.map((lane) => lane.getAttribute('data-lane'))).toEqual(['plan:alpha', 'plan:beta']);
    const columns = within(lanes[0]!).getAllByTestId('turn-board-column');
    expect(columns.map((c) => c.getAttribute('data-column'))).toEqual([
      'todo',
      'checking',
      'redo',
      'owner',
      'done',
    ]);
    const todo = columns[0]!;
    expect(
      within(todo)
        .getAllByTestId('turn-tile')
        .map((t) => t.getAttribute('data-item')),
    ).toEqual(['now-1']);
    expect(
      within(columns[1]!)
        .getAllByTestId('turn-tile')
        .map((t) => t.getAttribute('data-item')),
    ).toEqual(['check-1']);
  });

  it('draws the timeline, one bar per item', async () => {
    read.mockResolvedValue(v14());
    mount('#/turn?view=timeline', vi.fn(), { legacy: false });
    await screen.findByTestId('turn-headline');
    expect(screen.getAllByTestId('turn-timeline-row')).toHaveLength(4);
  });

  it('shows the Done tab alone, with the ledger’s older steps', async () => {
    read.mockResolvedValue(v14());
    mount('#/turn?tab=done', vi.fn(), { legacy: false });
    await screen.findByTestId('turn-headline');
    expect(screen.getAllByTestId('turn-section').map((el) => el.getAttribute('data-section'))).toEqual([
      'done',
    ]);
    expect(screen.getAllByTestId('turn-row').map((el) => el.getAttribute('data-item'))).toEqual(['done-1']);
  });

  it('draws every filter as chips with counts, and a chip writes its word into the address', async () => {
    read.mockResolvedValue(v14());
    const { onNavigate } = mount('#/turn', vi.fn(), { legacy: false });
    await screen.findByTestId('turn-headline');
    const chips = screen.getByTestId('turn-chips');
    const plan = within(chips).getByRole('group', { name: 'Plan' });
    const beta = within(plan)
      .getAllByRole('button')
      .find((b) => b.getAttribute('data-value') === 'beta')!;
    expect(beta.textContent).toBe('beta2');
    expect(beta.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(beta);
    expect(onNavigate).toHaveBeenLastCalledWith('#/turn?plan=beta');
  });

  it('a bulk Not doing settles every picked item, once the undo window ends', async () => {
    read.mockResolvedValue(v14());
    post.mockImplementation((path: string) =>
      Promise.resolve({ ok: true, step: { id: path.split('/')[3], state: 'declined' } }),
    );
    mount('#/turn', vi.fn(), { legacy: false });
    await screen.findByTestId('turn-headline');
    for (const id of ['now-1', 'now-2']) {
      const row = screen.getAllByTestId('turn-row').find((el) => el.getAttribute('data-item') === id)!;
      fireEvent.click(within(row).getByTestId('turn-row-pick'));
    }
    const bar = screen.getByTestId('turn-bulk');
    expect(bar.textContent).toContain('2 picked');
    fireEvent.click(within(bar).getByTestId('turn-bulk-decline'));
    fireEvent.change(within(bar).getByTestId('turn-bulk-reason'), { target: { value: 'Not this week' } });
    fireEvent.click(within(bar).getByTestId('turn-bulk-decline-send'));
    expect(screen.getByTestId('turn-bulk-held').textContent).toContain('Not doing 2 items');
    // Nothing is sent inside the undo window…
    expect(post).not.toHaveBeenCalled();
    // …and both are sent when it ends.
    await waitFor(
      () =>
        expect(post.mock.calls.map((call) => call[0])).toEqual([
          '/api/human-steps/now-1/decline',
          '/api/human-steps/now-2/decline',
        ]),
      { timeout: 8000 },
    );
    expect(post.mock.calls[0]![1]).toEqual({ reason: 'Not this week' });
  }, 15_000);
});

describe('TP-14 a plan’s own Your turn (#366)', () => {
  it('renders only that plan’s items, with no Plan chips and no plans strip', async () => {
    const { TurnBody } = await import('./index');
    read.mockResolvedValue(v14());
    const client = new QueryClient({
      ...queryClientConfig,
      defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
    });
    const hash = '#/plan/beta/turn';
    render(
      <QueryClientProvider client={client}>
        <MemoryRouterProvider initial={hash} onNavigate={vi.fn()}>
          <TurnBody route={parseHash(hash) as Route} base="plan/beta/turn" focus={null} plan="beta" />
        </MemoryRouterProvider>
      </QueryClientProvider>,
    );
    await screen.findByTestId('turn-page-body');
    expect(screen.getAllByTestId('turn-row').map((el) => el.getAttribute('data-item'))).toEqual([
      'now-2',
      'decide-1',
    ]);
    expect(within(screen.getByTestId('turn-chips')).queryByRole('group', { name: 'Plan' })).toBeNull();
    expect(screen.queryByTestId('turn-plans')).toBeNull();
    // The plan scope is the page's own, never a filter to clear.
    expect(screen.queryByTestId('turn-narrowed')).toBeNull();
  });
});
