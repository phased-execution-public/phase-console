/**
 * The Repo destination — the properties that make it worth reading rather than
 * pretty, pinned so they cannot quietly stop being true.
 *
 * Every case here is a fact Phase 8's endpoint contract went to some trouble to
 * express, and every one of them is a fact a redraw would lose:
 *
 *  - **`tipsTruncated` is a SECOND flag.** "More commits below" and "this walk
 *    does not cover every branch" are different failures. Folding them loses
 *    the one that matters, because a partial graph presented as complete is
 *    worse than a short one.
 *  - **`via` on a checkout is evidence, not decoration.** `record` is the run
 *    record; `branch` is a guess from a name an operator can type. A reclaim
 *    screen that draws them alike is the one screen where that costs somebody
 *    their work.
 *  - **`scanned` rides with the settle list.** The history is a TAIL, and a
 *    surface that shows it without the window claims a completeness it has not
 *    got.
 *  - **`ahead`/`behind` absent is NOT zero.** An untracked branch is not "up to
 *    date"; a row past the divergence cap was not measured.
 *  - **git could not answer ≠ nothing changed.** Three different refusals, three
 *    different sentences.
 *  - **An absent `unified=` is not `unified=0`.** The client half of the rule
 *    P8's round-2 High was about: a permissive floor makes a coercion's zero
 *    indistinguishable from silence.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { expectNoAxeViolations } from '@/test/axe';
import { queryClientConfig, sameFileList } from '@/lib/queries';
import type { ConsoleState, RepoBranches, RepoCheckouts, RepoDiff, RepoGraph, RepoSettles } from '@/lib/api';
import RepoPage from './index';
import { packLanes, decorateRef, parseRunRef } from './lanes';
import { repoHref, sectionFor } from './routes';
import { patchFile, listFile } from './diff';
import { divergence } from './branches';

const { state, repoTargets, repoGraph, repoBranches, repoCheckouts, repoDiff, repoSettles } = vi.hoisted(
  () => ({
    state: vi.fn(),
    repoTargets: vi.fn(),
    repoGraph: vi.fn(),
    repoBranches: vi.fn(),
    repoCheckouts: vi.fn(),
    repoDiff: vi.fn(),
    repoSettles: vi.fn(),
  }),
);

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, state, repoTargets, repoGraph, repoBranches, repoCheckouts, repoDiff, repoSettles },
  };
});

const STATE = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'dist',
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 1,
  platform: 'darwin',
  // `homePath` shortens a path under this to `~/…`. Deliberately not a macOS
  // home: `scrub.sh` refuses that shape in a committed file, and rightly so —
  // a test fixture is the easiest place for a machine's identity to leak.
  home: '/home/x',
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  unread: 0,
} as unknown as ConsoleState;

const EMPTY_GRAPH: RepoGraph = { commits: [], tips: [], tipsTruncated: false, truncated: false };

function commit(sha: string, parents: string[], extra: Partial<RepoGraph['commits'][number]> = {}) {
  return {
    sha,
    short: sha.slice(0, 7),
    parents,
    refs: [],
    subject: `subject ${sha}`,
    author: 'p9',
    at: '2026-09-01T12:00:00Z',
    ...extra,
  };
}

function routeOf(hash: string) {
  const [path, queryPart] = hash.replace(/^#\//, '').split('?');
  return {
    segments: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
    path,
  };
}

/**
 * Mount the destination at a hash.
 *
 * `go(nextHash)` re-renders at a DIFFERENT route on the SAME QueryClient, which
 * is the only way to exercise anything about held-over data: the harness used
 * to pass a static `route`, so a route change was inexpressible and the test
 * named for `sameFileList` asserted that `rerender` was a function (QA round 3,
 * F-2). A tautology in the place a regression guard was supposed to be.
 *
 * ⚠️ It moves the `route` PROP and not `MemoryRouterProvider`'s hash, which is
 * a lazy `useState` initializer and therefore fixed at mount (QA round 4, F-6).
 * Nothing under `features/repo/` reads router context — every one of them takes
 * `route` — so the two agree today. A component that reads the hash would need
 * this harness to remount the provider, and remounting is NOT free here: a
 * fresh observer has no previous data, so `placeholderData` would never fire
 * and the tests this helper exists for would pass for the wrong reason.
 */
function mount(hash: string) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const tree = (at: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={at}>
        <RepoPage route={routeOf(at)} />
      </MemoryRouterProvider>
    </QueryClientProvider>
  );
  const view = render(tree(hash));
  return { ...view, go: (next: string) => view.rerender(tree(next)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(STATE);
  repoTargets.mockResolvedValue({ targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] });
  repoGraph.mockResolvedValue(EMPTY_GRAPH);
  repoBranches.mockResolvedValue({
    branches: [],
    truncated: false,
    divergenceTruncated: false,
  } satisfies RepoBranches);
  repoCheckouts.mockResolvedValue({ checkouts: [], truncated: false } satisfies RepoCheckouts);
  repoDiff.mockResolvedValue({ files: [], filesTruncated: false, fileCount: 0 } satisfies RepoDiff);
  repoSettles.mockResolvedValue({
    events: [],
    truncated: false,
    scanned: { runs: 25, entriesPerRun: 500 },
  } satisfies RepoSettles);
});

/* ------------------------------------------------------------------ *
 * The lane packer
 * ------------------------------------------------------------------ */

describe('packLanes puts a history in columns without reordering it', () => {
  it('keeps a straight line in one lane', () => {
    const { rows, laneCount } = packLanes([commit('c', ['b']), commit('b', ['a']), commit('a', [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(laneCount).toBe(1);
    // The root commit has no parent, so nothing is drawn below it.
    expect(rows[2].links).toEqual([]);
  });

  it('gives a merge’s second parent a lane of its own, and takes it back at the join', () => {
    // m ─┬─ a ── base
    //    └─ b ──┘
    const { rows, laneCount } = packLanes([
      commit('m', ['a', 'b']),
      commit('a', ['base']),
      commit('b', ['base']),
      commit('base', []),
    ]);
    expect(laneCount).toBe(2);
    expect(rows[0].lane).toBe(0);
    // Two lines leave the merge's dot — that is the whole picture a sha list
    // cannot draw.
    expect(rows[0].links.filter((l) => l.fromCommit)).toHaveLength(2);
    expect(rows[1].lane).toBe(0);
    expect(rows[2].lane).toBe(1);
    // Both branches reach `base`, and it sits in the leftmost of the two lanes
    // that were waiting for it — the other is freed rather than left drawing a
    // line to nothing.
    expect(rows[3].lane).toBe(0);
    expect(rows[3].links).toEqual([]);
  });

  it('counts the widest lane anything was DRAWN in, not the slots it allocated', () => {
    // A fork that closes immediately must not leave the graph three wide.
    const { laneCount } = packLanes([commit('m', ['a', 'b']), commit('a', []), commit('b', [])]);
    expect(laneCount).toBe(2);
  });

  it('separates a parent outside the walk from a root commit', () => {
    const { rows } = packLanes([commit('c', ['gone'])]);
    // Both draw nothing below them; only one of them is the window's edge, and
    // a line that simply stops looks like history that ended.
    expect(rows[0].danglingParents).toEqual(['gone']);
    expect(packLanes([commit('r', [])]).rows[0].danglingParents).toEqual([]);
  });
});

/*
 * QA round 1 found three Mediums and ten Lows over `54d51aa` and passed the
 * phase anyway. These pin the ones that were real defects rather than prose,
 * because a finding fixed without a test is a finding that comes back.
 */
describe('the drawing says what the packer knows (QA round 1, M3 + L1)', () => {
  it('marks a lane waiting for a commit outside the walk, so it can be drawn dashed', () => {
    const { rows } = packLanes([commit('c', ['gone'])]);
    expect(rows[0].links).toEqual([{ from: 0, to: 0, fromCommit: true, dangling: true }]);
    // ...and a parent that IS in the walk is an ordinary solid line. The dashed
    // stub used to be a SECOND element at the same coordinates as this one,
    // which is to say it was drawn and then covered, every time.
    const inWalk = packLanes([commit('c', ['b']), commit('b', [])]);
    expect(inWalk.rows[0].links[0].dangling).toBe(false);
  });

  it('names the lanes that were waiting for THIS commit, by identity', () => {
    // The renderer needs "which arriving lane ends here", and index is not
    // identity: `firstFree` re-allocates a freed slot within the SAME row
    // whenever the commit has a second parent, so asking "is that index
    // occupied below?" answers yes for a lane whose occupant changed. That is
    // round 2's M-2 — the residual of round 1's fix for round 1's M3.
    const { rows } = packLanes([
      commit('mc', ['mb', 'c1']),
      commit('mb', ['base', 'b1']),
      commit('c1', ['base']),
      commit('b1', ['base']),
      commit('base', ['prev', 'atip']),
      commit('prev', []),
      commit('atip', []),
    ]);
    const base = rows.find((r) => r.commit.sha === 'base')!;
    // Two lanes were waiting for `base`; the leftmost continues, and BOTH of
    // the others must bend into its dot however their slots are then reused.
    // `toHaveLength(2)`, not `toBeGreaterThan(0)` — truncating `merged` to one
    // entry left the weaker assertion green, which is byte-identical to the
    // shape round 3 was convened over, 590 lines further up, in the same
    // commit (QA round 4, F-5).
    expect(base.merged).toHaveLength(2);
    for (const lane of base.merged) expect(lane).not.toBe(base.lane);
    // ...and the freed slots ARE reused in the same row, which is exactly why
    // an index-based predicate got this wrong.
    expect(base.links.some((l) => base.merged.includes(l.to))).toBe(true);
  });

  it('reports no merge for a plain linear row', () => {
    const { rows } = packLanes([commit('c', ['b']), commit('b', [])]);
    expect(rows.map((r) => r.merged)).toEqual([[], []]);
  });

  it('lets a merged-back lane be told apart from one passing through', () => {
    // `a` and `b` both reach `base`; at `base`'s row lane 1 is FREED and lane 0
    // continues. The renderer decides "join the dot" vs "run straight" from
    // exactly this — an arriving lane that this row sends nothing back down.
    const { rows } = packLanes([
      commit('m', ['a', 'b']),
      commit('a', ['base']),
      commit('b', ['base']),
      commit('base', []),
    ]);
    const arriving = rows[2].links.map((l) => l.to);
    expect(arriving).toContain(1);
    // `base` sends nothing anywhere, so neither arriving lane continues: both
    // join its dot instead of stopping beside it.
    expect(rows[3].links).toEqual([]);
  });
});

describe('a decoration is read, never trusted', () => {
  it('reads the console’s own branch shapes', () => {
    expect(parseRunRef('pe/demo')).toEqual({ slug: 'demo' });
    expect(parseRunRef('pe/demo-p4')).toEqual({ slug: 'demo', phase: 4 });
    // A hyphen, not a slash: `pe/<slug>/p4` is impossible in git while
    // `pe/<slug>` exists, which is why the lane branch is a sibling.
    expect(parseRunRef('pe/a-b-c-p12')).toEqual({ slug: 'a-b-c', phase: 12 });
    expect(parseRunRef('main')).toBeUndefined();
  });

  it('tells a tag from a branch and the trunk from both', () => {
    expect(decorateRef('tag: v1.0').kind).toBe('tag');
    expect(decorateRef('main', 'main').kind).toBe('trunk');
    expect(decorateRef('pe/demo-p4', 'main').kind).toBe('lane');
    expect(decorateRef('feature/x', 'main').kind).toBe('branch');
  });
});

/* ------------------------------------------------------------------ *
 * The sections
 * ------------------------------------------------------------------ */

describe('the graph says which of its two truncations happened', () => {
  it('warns that a walk missed branches, separately from missing commits', async () => {
    repoGraph.mockResolvedValue({
      ...EMPTY_GRAPH,
      commits: [commit('a1', [])],
      tips: ['main'],
      trunk: 'main',
      tipsTruncated: true,
    } satisfies RepoGraph);
    mount('#/repo');
    expect(await screen.findByTestId('tips-truncated')).toBeTruthy();
  });

  it('does not warn when the walk covered everything', async () => {
    repoGraph.mockResolvedValue({ ...EMPTY_GRAPH, commits: [commit('a1', [])], tips: ['main'] });
    mount('#/repo');
    await screen.findAllByTestId('commit-row');
    expect(screen.queryByTestId('tips-truncated')).toBeNull();
  });

  it('turns a refused named walk into a way out rather than a dead end', async () => {
    // The server refuses a `ref=` it cannot validate, and `/api/repo/branches`
    // can legitimately emit a name it will refuse (P8 QA5-M1). The page cannot
    // fix that from here; it can stop the reader concluding the branch is gone.
    // A 400 specifically: that is the `no such ref here` refusal. A rejection
    // with no status at all (a dead network) is not, and must not claim to know
    // anything about the branch either.
    repoGraph.mockRejectedValue(Object.assign(new Error('no such ref here'), { status: 400 }));
    mount('#/repo?ref=heads/1.0');
    const hint = await screen.findByTestId('ref-walk-hint');
    expect(hint.textContent).toMatch(/the branch is fine, the request is not/i);
    expect(screen.getByRole('link', { name: /walk every branch/i })).toBeTruthy();
  });

  it('does not blame a ref for a refusal that is not about the ref', async () => {
    // A 404 is `unknown repository`. Telling somebody "the branch is fine" then
    // is a confident answer to a question nobody asked.
    const notFound = Object.assign(new Error('unknown repository'), { status: 404 });
    repoGraph.mockRejectedValue(notFound);
    mount('#/repo?ref=main&repo=nope');
    await screen.findByText(/unknown repository/i);
    expect(screen.queryByTestId('ref-walk-hint')).toBeNull();
  });

  it('does not blame a ref when no ref was named', async () => {
    repoGraph.mockRejectedValue(Object.assign(new Error('boom'), { status: 400 }));
    mount('#/repo');
    await screen.findByText(/boom/i);
    expect(screen.queryByTestId('ref-walk-hint')).toBeNull();
  });

  it('does not blame a ref for a failure that carries no status at all', async () => {
    // A dead network rejects with a plain Error. "The branch is fine" is not
    // something this page knows in that case either.
    repoGraph.mockRejectedValue(new Error('Failed to fetch'));
    mount('#/repo?ref=main');
    await screen.findByText(/failed to fetch/i);
    expect(screen.queryByTestId('ref-walk-hint')).toBeNull();
  });

  it('draws a row per commit with the sha on it, so a graph is quotable', async () => {
    repoGraph.mockResolvedValue({
      ...EMPTY_GRAPH,
      commits: [commit('aaaaaaaa11', ['bbbbbbbb22']), commit('bbbbbbbb22', [])],
      tips: ['main'],
    });
    mount('#/repo');
    const rows = await screen.findAllByTestId('commit-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-sha')).toBe('aaaaaaaa11');
  });
});

describe('branches: an absent number is never zero', () => {
  it('shows a dash for an untracked branch rather than "0 ahead · 0 behind"', async () => {
    repoBranches.mockResolvedValue({
      branches: [{ name: 'pe/x', head: 'a'.repeat(40), short: 'aaaaaaa', current: false, trunk: false }],
      truncated: false,
      divergenceTruncated: false,
    } satisfies RepoBranches);
    mount('#/repo/branches');
    await screen.findByTestId('branch-row');
    expect(screen.queryByText(/0 ahead/)).toBeNull();
  });

  it('says a capped divergence pass was NOT MEASURED, which is not zero', async () => {
    repoBranches.mockResolvedValue({
      branches: [{ name: 'main', head: 'a'.repeat(40), short: 'aaaaaaa', current: true, trunk: true }],
      truncated: false,
      divergenceTruncated: true,
    } satisfies RepoBranches);
    mount('#/repo/branches');
    expect(await screen.findByTestId('divergence-truncated')).toBeTruthy();
  });

  it('admits when the trunk it names has no row in its own list', async () => {
    repoBranches.mockResolvedValue({
      branches: [{ name: 'other', head: 'b'.repeat(40), short: 'bbbbbbb', current: false, trunk: false }],
      trunk: 'main',
      truncated: true,
      divergenceTruncated: false,
    } satisfies RepoBranches);
    mount('#/repo/branches');
    expect(await screen.findByTestId('trunk-missing')).toBeTruthy();
  });

  it('distinguishes a run read from a NAME from a tree that actually holds the branch', async () => {
    repoBranches.mockResolvedValue({
      branches: [
        {
          name: 'pe/demo-p4',
          head: 'c'.repeat(40),
          short: 'ccccccc',
          current: false,
          trunk: false,
          run: { slug: 'demo', phase: 4 },
          heldBy: ['/state/worktrees/run1/p4'],
        },
      ],
      truncated: false,
      divergenceTruncated: false,
    } satisfies RepoBranches);
    mount('#/repo/branches');
    const run = await screen.findByTestId('branch-run');
    // The chip's own title says it is a reading — the row next to it is the
    // one backed by the registry.
    expect(run.getAttribute('title')).toMatch(/branch name/i);
    expect(screen.getByTestId('branch-held')).toBeTruthy();
  });
});

describe('working trees: the attribution column is the reclaim decision', () => {
  const tree = (over: Partial<RepoCheckouts['checkouts'][number]>) =>
    ({
      dir: '/state/x',
      repo: 'root',
      root: false,
      managed: true,
      prunable: false,
      role: 'debris',
      ...over,
    }) as RepoCheckouts['checkouts'][number];

  it('draws a record-backed row and a guessed row differently', async () => {
    repoCheckouts.mockResolvedValue({
      checkouts: [
        tree({
          dir: '/state/a',
          role: 'lane',
          via: 'record',
          run: { slug: 'demo', phase: 4, runId: 'run1', status: 'finished', live: false },
        }),
        tree({ dir: '/state/b', role: 'debris', via: 'branch', run: { slug: 'gone', phase: 9 } }),
      ],
      truncated: false,
    } satisfies RepoCheckouts);
    mount('#/repo/trees');
    const chips = await screen.findAllByTestId('via-chip');
    expect(chips.map((c) => c.getAttribute('data-via'))).toEqual(['record', 'branch']);
    // And the guessed one says so in words, not only in colour.
    expect(chips[1].getAttribute('title')).toMatch(/not evidence/i);
  });

  it('never claims liveness for a row with no record behind it', async () => {
    repoCheckouts.mockResolvedValue({
      checkouts: [tree({ via: 'branch', run: { slug: 'gone' } })],
      truncated: false,
    } satisfies RepoCheckouts);
    mount('#/repo/trees');
    await screen.findByTestId('checkout-row');
    expect(screen.queryByText('live')).toBeNull();
    expect(screen.queryByText('stopped')).toBeNull();
  });

  it('warns before a reclaim, and counts the trees it is warning about', async () => {
    repoCheckouts.mockResolvedValue({
      checkouts: [tree({ dir: '/state/a', via: 'branch', run: { slug: 'gone' } }), tree({ dir: '/state/b' })],
      truncated: false,
    } satisfies RepoCheckouts);
    mount('#/repo/trees');
    expect(await screen.findByTestId('debris-note')).toBeTruthy();
  });

  it('names where a detached tree stands instead of leaving the column blank', async () => {
    repoCheckouts.mockResolvedValue({
      checkouts: [tree({ detached: 'detached@abcdef012345' })],
      truncated: false,
    } satisfies RepoCheckouts);
    mount('#/repo/trees');
    expect(await screen.findByText('detached@abcdef012345')).toBeTruthy();
  });
});

describe('settles: the window is on the page, not in a log', () => {
  it('renders `scanned` even when there is nothing to show', async () => {
    mount('#/repo/settles');
    const note = await screen.findByTestId('settles-scanned');
    expect(note.textContent).toMatch(/25 run journals/);
    expect(note.textContent).toMatch(/500 entries/);
  });

  it('keeps the same moment from two sources, because they are two pieces of evidence', async () => {
    repoSettles.mockResolvedValue({
      events: [
        { slug: 'demo', runId: 'r1', at: '2026-09-01T12:00:00Z', kind: 'settled', via: 'record' },
        { slug: 'demo', runId: 'r1', at: '2026-09-01T12:00:00Z', kind: 'settled', via: 'journal' },
      ],
      truncated: false,
      scanned: { runs: 25, entriesPerRun: 500 },
    } satisfies RepoSettles);
    mount('#/repo/settles');
    const rows = await screen.findAllByTestId('settle-row');
    expect(rows.map((r) => r.getAttribute('data-via'))).toEqual(['record', 'journal']);
  });
});

describe('changes: three refusals, three sentences', () => {
  it('says an empty range is an ANSWER, not a failure', async () => {
    mount('#/repo/diff');
    expect(await screen.findByText(/nothing changed in this range/i)).toBeTruthy();
  });

  it('says a failed patch means nothing at all', async () => {
    repoDiff.mockResolvedValue({
      files: [{ path: 'a.ts', additions: 1, deletions: 0, binary: false }],
      filesTruncated: false,
      fileCount: 1,
      patch: { text: '', truncated: false, failed: true, path: 'a.ts' },
    } satisfies RepoDiff);
    mount('#/repo/diff?path=a.ts');
    expect(await screen.findByTestId('patch-failed')).toBeTruthy();
  });

  it('says a capped file list is capped, rather than reporting a smaller diff', async () => {
    repoDiff.mockResolvedValue({
      files: [{ path: 'a.ts', additions: 1, deletions: 0, binary: false }],
      filesTruncated: true,
      fileCount: 900,
    } satisfies RepoDiff);
    mount('#/repo/diff');
    expect(await screen.findByTestId('files-truncated')).toBeTruthy();
  });

  it('says a picked path is not in this range, rather than drawing nothing (QA round 1, M1)', async () => {
    // A `?path=` deep link outlives the range it was made in. Every one of them
    // used to land on a blank pane that said nothing at all.
    repoDiff.mockResolvedValue({
      files: [{ path: 'a.ts', additions: 1, deletions: 0, binary: false }],
      filesTruncated: false,
      fileCount: 1,
    } satisfies RepoDiff);
    mount('#/repo/diff?path=gone.ts');
    const note = await screen.findByTestId('path-not-in-range');
    expect(note.textContent).toMatch(/gone\.ts/);
    expect(screen.queryByText(/changed nothing in this range/i)).toBeNull();
  });

  it('calls a mode-only change what it is, not "changed nothing" (QA round 1, M2)', async () => {
    // A file with a real numstat row whose patch carries no hunks is a mode or
    // metadata change. Overriding the accurate sentence with the empty-range
    // one told a `chmod +x` it had not changed.
    repoDiff.mockResolvedValue({
      files: [{ path: 'a.sh', additions: 0, deletions: 0, binary: false }],
      filesTruncated: false,
      fileCount: 1,
      patch: {
        path: 'a.sh',
        truncated: false,
        failed: false,
        text: 'diff --git a/a.sh b/a.sh\nold mode 100644\nnew mode 100755\n',
      },
    } satisfies RepoDiff);
    mount('#/repo/diff?path=a.sh');
    expect(await screen.findByText(/mode or metadata change only/i)).toBeTruthy();
    expect(screen.queryByText(/changed nothing in this range/i)).toBeNull();
  });

  it('renders a real patch through the shared parser', async () => {
    repoDiff.mockResolvedValue({
      files: [{ path: 'a.ts', additions: 1, deletions: 1, binary: false }],
      filesTruncated: false,
      fileCount: 1,
      patch: {
        path: 'a.ts',
        truncated: false,
        failed: false,
        text: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1,2 +1,2 @@',
          ' keep',
          '-old line',
          '+new line',
          '',
        ].join('\n'),
      },
    } satisfies RepoDiff);
    mount('#/repo/diff?path=a.ts');
    expect(await screen.findByText('new line')).toBeTruthy();
    expect(screen.getByText('old line')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * The URL is the state
 * ------------------------------------------------------------------ */

describe('every view here is quotable', () => {
  it('sends no empty parameter — silence and "" are the same bug on the server', () => {
    expect(repoHref('graph', { repo: undefined, ref: '' })).toBe('#/repo');
    expect(repoHref('diff', { repo: 'sub', path: 'a.ts' })).toBe('#/repo/diff?repo=sub&path=a.ts');
    // `graph` is what `#/repo` means, so it takes no segment of its own.
    expect(repoHref('graph', { ref: 'main' })).toBe('#/repo?ref=main');
  });

  it('resolves an unknown section to the graph rather than 404ing a bookmark', () => {
    expect(sectionFor(undefined)).toBe('graph');
    expect(sectionFor('nonsense')).toBe('graph');
    expect(sectionFor('trees')).toBe('trees');
  });

  it('asks the server for the section the URL names', async () => {
    mount('#/repo/branches?repo=sub');
    await screen.findByRole('heading', { name: 'Repo' });
    expect(repoBranches).toHaveBeenCalledWith('sub');
    expect(repoGraph).not.toHaveBeenCalled();
  });

  it('does not send `unified=` for a URL that never asked, which the server would read as 0', async () => {
    mount('#/repo/diff');
    await screen.findByText(/nothing changed in this range/i);
    expect(repoDiff).toHaveBeenCalledWith(expect.objectContaining({ unified: 3 }));
  });

  it('sends an explicit unified=0, because no context is a real request', async () => {
    mount('#/repo/diff?unified=0');
    await screen.findByText(/nothing changed in this range/i);
    expect(repoDiff).toHaveBeenCalledWith(expect.objectContaining({ unified: 0 }));
  });
});

/* ------------------------------------------------------------------ *
 * The numstat spine
 * ------------------------------------------------------------------ */

describe('a file list row is not a parsed patch', () => {
  it('does not guess `added` from a file that only gained lines', () => {
    // `--numstat` reports counts, never the change KIND. Guessing from
    // `deletions === 0` is wrong for any file whose edit only added lines.
    expect(listFile({ path: 'a.ts', additions: 9, deletions: 0, binary: false }).status).toBe('modified');
    expect(
      listFile({ path: 'b.ts', oldPath: 'a.ts', additions: 0, deletions: 0, binary: false }).status,
    ).toBe('renamed');
  });

  it('falls back to the list row when the patch is for another file', () => {
    const diff: RepoDiff = {
      files: [{ path: 'a.ts', additions: 2, deletions: 1, binary: false }],
      filesTruncated: false,
      fileCount: 1,
      patch: { path: 'b.ts', text: 'diff --git a/b.ts b/b.ts\n', truncated: false, failed: false },
    };
    // The counts are still git's own; what is missing is the hunks.
    expect(patchFile(diff, 'a.ts')).toMatchObject({ path: 'a.ts', additions: 2, hunks: [] });
  });

  it('carries the patch’s own truncation onto the file it parsed', () => {
    const diff: RepoDiff = {
      files: [{ path: 'a.ts', additions: 1, deletions: 0, binary: false }],
      filesTruncated: false,
      fileCount: 1,
      patch: {
        path: 'a.ts',
        truncated: true,
        failed: false,
        text: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n keep\n+added\n',
      },
    };
    expect(patchFile(diff, 'a.ts')?.truncated).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Accessibility
 * ------------------------------------------------------------------ *
 *
 * `features/a11y.test.tsx` renders `#/repo` and settles on the glance card, so
 * it never reaches the four tables this phase added — and a table is exactly
 * the shape axe is useful on (a named table, a header row, and a button in
 * every first cell). Populated data is the whole point: an empty table has no
 * rows to get wrong.
 */

describe('the populated tables pass axe', () => {
  it('the commit graph', async () => {
    repoGraph.mockResolvedValue({
      ...EMPTY_GRAPH,
      commits: [commit('a1', ['b2'], { refs: ['main', 'pe/demo-p4'] }), commit('b2', [])],
      tips: ['main'],
      trunk: 'main',
    });
    const { container } = mount('#/repo');
    await screen.findAllByTestId('commit-row');
    await expectNoAxeViolations(container);
  });

  it('the working trees table, with every role drawn at once', async () => {
    repoCheckouts.mockResolvedValue({
      checkouts: [
        {
          dir: '/repo',
          repo: 'root',
          root: true,
          managed: false,
          prunable: false,
          role: 'root',
          branch: 'main',
        },
        {
          dir: '/state/a',
          repo: 'root',
          root: false,
          managed: true,
          prunable: false,
          role: 'lane',
          via: 'record',
          run: { slug: 'demo', phase: 4, runId: 'run1', status: 'finished', live: false },
        },
        {
          dir: '/state/b',
          repo: 'root',
          root: false,
          managed: true,
          prunable: true,
          role: 'debris',
          via: 'branch',
          run: { slug: 'gone' },
          detached: 'detached@abcdef012345',
        },
      ],
      truncated: false,
    } satisfies RepoCheckouts);
    const { container } = mount('#/repo/trees');
    await screen.findAllByTestId('checkout-row');
    await expectNoAxeViolations(container);
  });

  it('the diff, which is a table of lines inside a scroller', async () => {
    repoDiff.mockResolvedValue({
      files: [{ path: 'a.ts', additions: 1, deletions: 1, binary: false }],
      filesTruncated: false,
      fileCount: 1,
      patch: {
        path: 'a.ts',
        truncated: false,
        failed: false,
        text: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n',
      },
    } satisfies RepoDiff);
    const { container } = mount('#/repo/diff?path=a.ts');
    await screen.findByRole('table', { name: 'Diff of a.ts' });
    await expectNoAxeViolations(container);
  });
});

describe('an absent number is absent on the side it is absent from (QA round 1, L4)', () => {
  it('never fills the measured half of a pair with a zero', () => {
    const base = { name: 'x', head: 'a'.repeat(40), short: 'aaaaaaa', current: false, trunk: false };
    expect(divergence({ ...base, ahead: 3, behind: 1 })).toBe('3 ahead · 1 behind');
    expect(divergence(base)).toBe('—');
    // The case that was wrong: one side measured, the other not. `?? 0` printed
    // a number nothing had counted.
    expect(divergence({ ...base, ahead: 3 })).toBe('3 ahead · — behind');
    expect(divergence({ ...base, behind: 2 })).toBe('— ahead · 2 behind');
  });
});

describe('a link built from a bad URL is still a link (QA round 1, L7 + L8)', () => {
  it('drops an empty ref rather than asking for a named walk of nothing', async () => {
    mount('#/repo?ref=');
    await screen.findByRole('heading', { name: 'Repo' });
    expect(repoGraph).toHaveBeenCalledWith(expect.objectContaining({ limit: 120 }));
    expect(repoGraph.mock.calls[0][0].ref).toBeUndefined();
  });

  it('falls back once for a non-numeric unified, instead of splicing NaN into every href', async () => {
    mount('#/repo/diff?unified=abc');
    await screen.findByText(/nothing changed in this range/i);
    expect(repoDiff).toHaveBeenCalledWith(expect.objectContaining({ unified: 3 }));
    // The links on the page are built from the same sanitised value, so none of
    // them carries the string `NaN`.
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      expect(a.getAttribute('href')).not.toMatch(/NaN/);
    }
  });
});

describe('a deep link that outlived its walk says so (QA round 1, L2)', () => {
  it('names a commit this page does not hold instead of opening nothing', async () => {
    repoGraph.mockResolvedValue({ ...EMPTY_GRAPH, commits: [commit('a1', [])], tips: ['main'] });
    mount('#/repo?commit=deadbeef');
    const note = await screen.findByTestId('commit-off-page');
    expect(note.textContent).toMatch(/deadbeef/);
  });

  it('says nothing when the commit IS on the page', async () => {
    repoGraph.mockResolvedValue({ ...EMPTY_GRAPH, commits: [commit('a1', [])], tips: ['main'] });
    mount('#/repo?commit=a1');
    await screen.findAllByTestId('commit-row');
    expect(screen.queryByTestId('commit-off-page')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The DRAWING, not only the data behind it
 * ------------------------------------------------------------------ *
 *
 * Round 2's M-2 was a renderer bug that both of round 1's new tests missed,
 * because both asserted `packLanes` output alone. A predicate about what is on
 * screen has to be checked on screen.
 */

describe('the lane gutter draws what the packer said (QA round 2, M-2 + L-1)', () => {
  it('bends a merged-back lane into the dot instead of stopping it beside one', async () => {
    repoGraph.mockResolvedValue({
      ...EMPTY_GRAPH,
      commits: [
        commit('mc', ['mb', 'c1']),
        commit('mb', ['base', 'b1']),
        commit('c1', ['base']),
        commit('b1', ['base']),
        commit('base', ['prev', 'atip']),
        commit('prev', []),
        commit('atip', []),
      ],
      tips: ['main'],
      trunk: 'main',
    });
    const { container } = mount('#/repo');
    await screen.findAllByTestId('commit-row');
    // `base` is the fifth row; every lane arriving at it that was waiting for
    // it is a curve, and a curve is the only shape that reaches the dot.
    const rows = container.querySelectorAll('[data-testid="commit-row"]');
    const baseCell = rows[4].querySelector('svg')!;
    // EXACTLY two, not "more than none". Round 1's index-based predicate drew
    // one of these two correctly and stubbed the other, so `toBeGreaterThan(0)`
    // — which is what this line said until round 3 measured it — passes on the
    // bug it is named for. A guard that cannot fail is not a guard.
    expect(baseCell.querySelectorAll('[data-testid="lane-merge"]')).toHaveLength(2);
  });

  it('keeps a dangling edge dashed across the band, not dashed then solid', async () => {
    // Half a dashed line followed by half a solid one is two different claims
    // about one edge.
    repoGraph.mockResolvedValue({
      ...EMPTY_GRAPH,
      commits: [commit('a1', ['unreached']), commit('a2', ['unreached2'])],
      tips: ['main'],
      truncated: true,
    });
    const { container } = mount('#/repo');
    await screen.findAllByTestId('commit-row');
    const arriving = container.querySelectorAll('[data-testid="lane-through"]');
    expect(arriving.length).toBeGreaterThan(0);
    for (const el of Array.from(arriving)) {
      expect(el.getAttribute('stroke-dasharray')).toBe('2 3');
    }
  });
});

describe('a held-over answer is never rendered as this file’s (QA round 2, M-1)', () => {
  const PATCH_A = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n keep\n+nine\n';
  const withPatch = (path: string, text: string): RepoDiff => ({
    files: [
      { path: 'a.ts', additions: 9, deletions: 0, binary: false },
      { path: 'b.ts', additions: 2, deletions: 2, binary: false },
    ],
    filesTruncated: false,
    fileCount: 2,
    patch: { path, text, truncated: false, failed: false },
  });

  it('never describes content the response did not carry', async () => {
    // A response whose `patch` is for ANOTHER file — a stale placeholder, or a
    // server answering out of order. `patchFile` falls back to the numstat row
    // so the counts stay right, and a zero-hunk row is indistinguishable from a
    // genuine mode-only change, so "no textual change" got said about a file
    // that changed nine lines. Round 1's M2 through a third door.
    repoDiff.mockResolvedValue(withPatch('b.ts', 'diff --git a/b.ts b/b.ts\n'));
    mount('#/repo/diff?path=a.ts');
    const note = await screen.findByTestId('patch-absent');
    expect(note.textContent).toMatch(/no patch for/i);
    // The counts git DID report survive, because those are real.
    expect(note.textContent).toMatch(/\+9/);
    expect(screen.queryByText(/mode or metadata change only/i)).toBeNull();
  });

  it('still lets a real mode-only change say so', async () => {
    // The other side of the same fence: this patch IS for the picked file and
    // genuinely has no hunks.
    repoDiff.mockResolvedValue({
      files: [{ path: 'a.sh', additions: 0, deletions: 0, binary: false }],
      filesTruncated: false,
      fileCount: 1,
      patch: {
        path: 'a.sh',
        truncated: false,
        failed: false,
        text: 'diff --git a/a.sh b/a.sh\nold mode 100644\nnew mode 100755\n',
      },
    } satisfies RepoDiff);
    mount('#/repo/diff?path=a.sh');
    expect(await screen.findByText(/mode or metadata change only/i)).toBeTruthy();
    expect(screen.queryByTestId('patch-absent')).toBeNull();
  });

  it('holds the file list across a change of PATH', async () => {
    // The whole point of the placeholder: picking a file must not blank the
    // list it was picked from.
    repoDiff.mockResolvedValue(withPatch('a.ts', 'diff --git a/a.ts b/a.ts\n'));
    const { go } = mount('#/repo/diff');
    await screen.findAllByRole('button', { name: /a\.ts/ });
    let resolve: ((v: RepoDiff) => void) | undefined;
    repoDiff.mockReturnValue(new Promise<RepoDiff>((r) => (resolve = r)));
    go('#/repo/diff?path=b.ts');
    // Still on screen while the next answer is in flight.
    expect(screen.getAllByRole('button', { name: /a\.ts/ }).length).toBeGreaterThan(0);
    resolve?.(withPatch('b.ts', 'diff --git a/b.ts b/b.ts\n'));
  });

  it('does NOT hold it across a change of range', async () => {
    // The header would otherwise say "N files between X and Y" off the previous
    // range while the URL names a different one.
    repoDiff.mockResolvedValue(withPatch('a.ts', 'diff --git a/a.ts b/a.ts\n'));
    const { go } = mount('#/repo/diff?base=v1&tip=v2');
    await screen.findAllByRole('button', { name: /a\.ts/ });
    repoDiff.mockReturnValue(new Promise<RepoDiff>(() => {}));
    go('#/repo/diff?base=v8&tip=v9');
    // The old range's list is gone — it was never an answer about this range.
    expect(screen.queryByRole('button', { name: /a\.ts/ })).toBeNull();
  });

  it('does not draw the held-over patch at the previous context width', async () => {
    // `stale` was deletable with 2262/2262 green (QA round 4, F-1): dropping
    // `unified` from the predicate made `isPlaceholderData` the ONLY thing
    // standing between the reader and a patch computed at the old width, and
    // `patchIsForPicked` is true in that case so it guards nothing here. The
    // content would not be false, but it would not be what the control says.
    repoDiff.mockResolvedValue(withPatch('a.ts', PATCH_A));
    const { go } = mount('#/repo/diff?path=a.ts');
    await screen.findByText('nine');
    repoDiff.mockReturnValue(new Promise<RepoDiff>(() => {}));
    go('#/repo/diff?path=a.ts&unified=12');
    // The list survives — that is the point of the placeholder — and the patch
    // pane says it is fetching rather than showing the 3-line-context body.
    expect(screen.getAllByRole('button', { name: /a\.ts/ }).length).toBeGreaterThan(0);
    expect(screen.getByTestId('patch-loading')).toBeTruthy();
    expect(screen.queryByText('nine')).toBeNull();
  });

  it('holds it across a change of `unified`, which cannot move the file list', () => {
    // The server builds `files` from `diffStat` before it reads `unified`, so
    // comparing it blanked the whole panel — list, header, banner and the
    // control just clicked — on every toggle (QA round 3, F-3).
    const base = { repo: 'r', base: 'v1', tip: 'v2' };
    expect(sameFileList({ ...base, unified: 3 }, { ...base, unified: 0 })).toBe(true);
    expect(sameFileList({ ...base, bytes: 1 }, { ...base, bytes: 2 })).toBe(true);
    expect(sameFileList({ ...base, path: 'a' }, { ...base, path: 'b' })).toBe(true);
    // ...and the three that DO move it.
    expect(sameFileList(base, { ...base, repo: 'other' })).toBe(false);
    expect(sameFileList(base, { ...base, base: 'v8' })).toBe(false);
    expect(sameFileList(base, { ...base, tip: 'v9' })).toBe(false);
  });
});

describe('the walk stops where the server stops (QA round 2, L-4)', () => {
  it('offers Show more below the ceiling, and stops AT it', async () => {
    repoGraph.mockResolvedValue({
      ...EMPTY_GRAPH,
      commits: [commit('a1', [])],
      tips: ['main'],
      truncated: true,
    });
    mount('#/repo');
    // 120 → 240 → 360 → 480 → 500, the server's own ceiling. Past it the button
    // would ask for a page it already has, which is a control that does
    // nothing — and the old test stopped at the first press, so it passed on
    // the version that had no cap at all (QA round 3, F-5).
    for (let i = 0; i < 4; i += 1) {
      fireEvent.click(await screen.findByRole('button', { name: /show more/i }));
    }
    await screen.findByText(/the server’s own ceiling/i);
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull();
  });

  it('says which files a truncated list cannot rule out', async () => {
    repoDiff.mockResolvedValue({
      files: [{ path: 'a.ts', additions: 1, deletions: 0, binary: false }],
      filesTruncated: true,
      fileCount: 900,
    } satisfies RepoDiff);
    mount('#/repo/diff?path=gone.ts');
    const note = await screen.findByTestId('path-not-in-range');
    // NOT "is not among the files this range changed" — a capped list cannot
    // support that absolute.
    expect(note.textContent).toMatch(/may well have changed/i);
  });
});

describe('working trees: a superproject\u2019s registry names each tree\u2019s repository', () => {
  const row = (dir: string, repo: string, role: 'root' | 'operator' = 'root') =>
    ({
      dir,
      repo,
      root: role === 'root',
      managed: false,
      prunable: false,
      role,
      branch: 'main',
    }) as RepoCheckouts['checkouts'][number];

  it('draws the Repository column only when more than one repository answered', async () => {
    // A hub is several repositories: the root that holds the plans and the
    // submodules the phases edit. The registry used to stop at the root, and a
    // hub console showed none of a submodule\u2019s trees.
    repoCheckouts.mockResolvedValue({
      checkouts: [
        row('/hub', 'root'),
        row('/hub/phased-execution', 'phased-execution'),
        row('/work/pe-p7', 'phased-execution', 'operator'),
      ],
      truncated: false,
    } satisfies RepoCheckouts);
    mount('#/repo/trees');
    await screen.findAllByTestId('checkout-row');
    expect(screen.getByRole('columnheader', { name: 'Repository' })).toBeTruthy();
    const cells = screen.getAllByTestId('checkout-repo').map((c) => c.textContent);
    expect(cells).toEqual(['root', 'phased-execution', 'phased-execution']);
  });

  it('draws no Repository column for a single repository', async () => {
    repoCheckouts.mockResolvedValue({
      checkouts: [row('/repo', 'root'), row('/state/a', 'root', 'operator')],
      truncated: false,
    } satisfies RepoCheckouts);
    mount('#/repo/trees');
    await screen.findAllByTestId('checkout-row');
    expect(screen.queryByRole('columnheader', { name: 'Repository' })).toBeNull();
    expect(screen.queryByTestId('checkout-repo')).toBeNull();
  });
});
