/**
 * Repo — the properties that make it worth reading rather than pretty, pinned
 * so they cannot quietly stop being true (ported from 6.2's
 * `features/repo/repo.test.tsx` in quiet-console phase 17, with 7.0's
 * addresses, toolbar and panel).
 *
 *  - **`tipsTruncated` is a SECOND flag.** "More commits below" and "this walk
 *    does not cover every branch" are different failures; a partial graph read
 *    as whole is worse than a short one.
 *  - **Attribution is evidence, not decoration.** `record` is the run record,
 *    `by name` a guess from a name a person can type.
 *  - **`scanned` rides with the settle list.** The history is a TAIL.
 *  - **Ahead and behind absent are NOT zero.**
 *  - **git could not answer ≠ nothing changed.** Three refusals, three
 *    sentences.
 *  - **An absent `unified=` is not `unified=0`.**
 *  - **Every record is inspectable**, and the address names it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`); every request is logged whole. */
const server = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  calls: [] as string[],
}));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    server.calls.push(path);
    const read = server.reads[path.split('?')[0]!];
    if (read instanceof Error) throw read;
    if (typeof read === 'function') return (read as (path: string) => unknown)(path);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { RepoBranches, RepoCheckouts, RepoDiff, RepoGraph, RepoSettles } from '@/data/api';
import { ApiError } from '@/data/http';
import { queryClientConfig } from '@/data/keys';
import { sameFileList } from '@/data/repo';
import { setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { expectNoAxeViolations } from '@/test/axe';
import { TooltipProvider } from '@/ui/tooltip';
import { listFile, patchFile } from './diff';
import { GUTTER_MAX, LANE_CAP, LANE_W, ROW_H, graphColumns } from './graph';
import RepoPlace from './index';
import { decorateRef, packLanes, parseRunRef } from './lanes';
import { divergenceWords } from './model';
import { repoSectionHref, repoSectionOf, unifiedOf } from './routes';

vi.setConfig({ testTimeout: 20_000 });

const here = dirname(fileURLToPath(import.meta.url));

const STATE = {
  autopilot: true,
  root: { path: '/repo', ok: true },
  // `homePath` shortens a path under this to `~/…`. Not a macOS home: the
  // scrub refuses that shape in a committed file.
  home: '/home/x',
  repo: { available: true, branch: 'main', dirty: [] },
};

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
  const [path = '', queryPart] = hash.replace(/^#\//, '').split('?');
  return {
    segments: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
    path,
  };
}

/**
 * Mount the place at a hash, with the panel's body beside it. `go(next)`
 * re-renders at another address on the SAME query client — the only way to
 * see anything about a held-over answer, since a fresh observer has none.
 */
function mount(hash: string) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const tree = (at: string) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RepoPlace route={routeOf(at)} />
        <aside data-testid="panel">
          <InspectorHost />
        </aside>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(tree(hash));
  return { ...view, go: (next: string) => view.rerender(tree(next)) };
}

const callsTo = (prefix: string) => server.calls.filter((path) => path.startsWith(prefix));

/** Radix tabs move on a primary mouse-down, never on a click. */
const openTab = (panel: HTMLElement, name: string) =>
  fireEvent.mouseDown(within(panel).getByRole('tab', { name }), { button: 0 });

beforeEach(() => {
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  __resetInspectorForTests();
  window.location.hash = '';
  server.calls = [];
  server.reads = {
    '/api/state': STATE,
    '/api/repo/targets': { targets: [{ key: 'root', dir: '/repo', label: 'repo', kind: 'root' }] },
    '/api/repo/graph': EMPTY_GRAPH,
    '/api/repo/branches': {
      branches: [],
      truncated: false,
      divergenceTruncated: false,
    } satisfies RepoBranches,
    '/api/repo/checkouts': { checkouts: [], truncated: false } satisfies RepoCheckouts,
    '/api/repo/diff': { files: [], filesTruncated: false, fileCount: 0 } satisfies RepoDiff,
    '/api/repo/settles': {
      events: [],
      truncated: false,
      scanned: { runs: 25, entriesPerRun: 500 },
    } satisfies RepoSettles,
  };
});
afterEach(() => __resetInspectorForTests());

/* ------------------------------------------------------------------ *
 * The lane packer
 * ------------------------------------------------------------------ */

describe('packLanes puts a history in columns without reordering it', () => {
  it('keeps a straight line in one lane', () => {
    const { rows, laneCount } = packLanes([commit('c', ['b']), commit('b', ['a']), commit('a', [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(laneCount).toBe(1);
    // The root commit has no parent, so nothing is drawn below it.
    expect(rows[2]!.links).toEqual([]);
  });

  it('gives a merge’s second parent a lane of its own, and takes it back at the join', () => {
    const { rows, laneCount } = packLanes([
      commit('m', ['a', 'b']),
      commit('a', ['base']),
      commit('b', ['base']),
      commit('base', []),
    ]);
    expect(laneCount).toBe(2);
    expect(rows[0]!.lane).toBe(0);
    expect(rows[0]!.links.filter((l) => l.fromCommit)).toHaveLength(2);
    expect(rows[1]!.lane).toBe(0);
    expect(rows[2]!.lane).toBe(1);
    expect(rows[3]!.lane).toBe(0);
    expect(rows[3]!.links).toEqual([]);
  });

  it('counts the widest lane anything was DRAWN in, not the slots it allocated', () => {
    const { laneCount } = packLanes([commit('m', ['a', 'b']), commit('a', []), commit('b', [])]);
    expect(laneCount).toBe(2);
  });

  it('separates a parent outside the walk from a root commit', () => {
    const { rows } = packLanes([commit('c', ['gone'])]);
    expect(rows[0]!.danglingParents).toEqual(['gone']);
    expect(packLanes([commit('r', [])]).rows[0]!.danglingParents).toEqual([]);
  });

  it('marks a lane waiting for a commit outside the walk, so it can be drawn dashed', () => {
    const { rows } = packLanes([commit('c', ['gone'])]);
    expect(rows[0]!.links).toEqual([{ from: 0, to: 0, fromCommit: true, dangling: true }]);
    expect(packLanes([commit('c', ['b']), commit('b', [])]).rows[0]!.links[0]!.dangling).toBe(false);
  });

  it('names the lanes that were waiting for THIS commit, by identity', () => {
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
    // Exactly two: a weaker assertion passes on the one-short drawing.
    expect(base.merged).toHaveLength(2);
    for (const lane of base.merged) expect(lane).not.toBe(base.lane);
    // …and the freed slots ARE reused in the same row, which is why an index is not an identity.
    expect(base.links.some((l) => base.merged.includes(l.to))).toBe(true);
  });

  it('reports no merge for a plain linear row', () => {
    const { rows } = packLanes([commit('c', ['b']), commit('b', [])]);
    expect(rows.map((r) => r.merged)).toEqual([[], []]);
  });
});

describe('a decoration is read, never trusted', () => {
  it('reads the console’s own branch shapes', () => {
    expect(parseRunRef('pe/demo')).toEqual({ slug: 'demo' });
    expect(parseRunRef('pe/demo-p4')).toEqual({ slug: 'demo', phase: 4 });
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
 * The addresses
 * ------------------------------------------------------------------ */

describe('the five sections are addresses, and 6.2’s spellings still land', () => {
  it('writes each section’s address, with only what was asked for', () => {
    expect(repoSectionHref('history', { repo: undefined, ref: '' })).toBe('#/repo');
    expect(repoSectionHref('history', { ref: 'main' })).toBe('#/repo?ref=main');
    expect(repoSectionHref('branches', { repo: 'sub' })).toBe('#/repo/branches?repo=sub');
    expect(repoSectionHref('trees')).toBe('#/repo/trees');
    expect(repoSectionHref('changes', { repo: 'sub', path: 'a.ts' })).toBe(
      '#/repo/changes?repo=sub&path=a.ts',
    );
    expect(repoSectionHref('settles', { slug: 'demo' })).toBe('#/repo/settles?slug=demo');
  });

  it('reads graph, history and diff as their sections, and anything else as History', () => {
    expect(repoSectionOf(undefined)).toBe('history');
    expect(repoSectionOf('graph')).toBe('history');
    expect(repoSectionOf('history')).toBe('history');
    expect(repoSectionOf('diff')).toBe('changes');
    expect(repoSectionOf('changes')).toBe('changes');
    expect(repoSectionOf('trees')).toBe('trees');
    expect(repoSectionOf('nonsense')).toBe('history');
  });

  it('draws one section nav of real links, the repository carried along', async () => {
    server.reads['/api/repo/targets'] = {
      targets: [
        { key: 'root', dir: '/repo', label: 'repo', kind: 'root' },
        { key: 'sub', dir: '/repo/sub', label: 'sub', kind: 'submodule' },
      ],
    };
    mount('#/repo/branches?repo=sub');
    const nav = await screen.findByRole('navigation', { name: 'Repo sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(
      expect.arrayContaining(['History', 'Branches', 'Working trees', 'Changes', 'Settles', 'Issues']),
    );
    expect(within(nav).getByRole('link', { name: 'Branches' })).toHaveAttribute('aria-current', 'page');
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Changes' })).toHaveAttribute(
        'href',
        '#/repo/changes?repo=sub',
      ),
    );
  });

  it('asks the server for the section the address names', async () => {
    mount('#/repo/branches?repo=sub');
    await screen.findByRole('navigation', { name: 'Repo sections' });
    await waitFor(() => expect(callsTo('/api/repo/branches')).toEqual(['/api/repo/branches?repo=sub']));
    expect(callsTo('/api/repo/graph')).toEqual([]);
  });

  it('lands 6.2’s #/repo/diff on Changes', async () => {
    mount('#/repo/diff');
    expect(await screen.findByText(/nothing changed in this range/i)).toBeTruthy();
    expect(screen.getByTestId('repo-page')).toHaveAttribute('data-section', 'changes');
  });
});

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

describe('History says which of its two truncations happened', () => {
  it('warns that a walk missed branches, separately from missing commits', async () => {
    server.reads['/api/repo/graph'] = {
      ...EMPTY_GRAPH,
      commits: [commit('a1', [])],
      tips: ['main'],
      trunk: 'main',
      tipsTruncated: true,
    } satisfies RepoGraph;
    mount('#/repo');
    expect(await screen.findByTestId('tips-truncated')).toBeTruthy();
  });

  it('does not warn when the walk covered everything', async () => {
    server.reads['/api/repo/graph'] = { ...EMPTY_GRAPH, commits: [commit('a1', [])], tips: ['main'] };
    mount('#/repo');
    await screen.findAllByTestId('commit-row');
    expect(screen.queryByTestId('tips-truncated')).toBeNull();
  });

  it('turns a refused named walk into a way out rather than a dead end', async () => {
    server.reads['/api/repo/graph'] = new ApiError('no such ref here', 400, '/api/repo/graph');
    mount('#/repo?ref=heads/1.0');
    const hint = await screen.findByTestId('ref-walk-hint');
    expect(hint.textContent).toMatch(/the branch is fine, the request is not/i);
    expect(within(hint).getByRole('link', { name: /walk every branch/i })).toHaveAttribute('href', '#/repo');
  });

  it('does not blame a ref for a refusal that is not about the ref', async () => {
    server.reads['/api/repo/graph'] = new ApiError('unknown repository', 404, '/api/repo/graph');
    mount('#/repo?ref=main&repo=nope');
    await screen.findByText(/unknown repository/i);
    expect(screen.queryByTestId('ref-walk-hint')).toBeNull();
  });

  it('does not blame a ref when no ref was named, nor for a failure with no status', async () => {
    server.reads['/api/repo/graph'] = new ApiError('boom', 400, '/api/repo/graph');
    const first = mount('#/repo');
    await screen.findByText(/boom/i);
    expect(screen.queryByTestId('ref-walk-hint')).toBeNull();
    first.unmount();
    server.reads['/api/repo/graph'] = new Error('Failed to fetch');
    mount('#/repo?ref=main');
    await screen.findByText(/failed to fetch/i);
    expect(screen.queryByTestId('ref-walk-hint')).toBeNull();
  });

  it('draws a real table row per commit with the sha on it, so a graph is quotable', async () => {
    server.reads['/api/repo/graph'] = {
      ...EMPTY_GRAPH,
      commits: [commit('aaaaaaaa11', ['bbbbbbbb22']), commit('bbbbbbbb22', [])],
      tips: ['main'],
    };
    mount('#/repo');
    const rows = await screen.findAllByTestId('commit-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tagName).toBe('TR');
    expect(rows[0]!.getAttribute('data-sha')).toBe('aaaaaaaa11');
    expect(screen.getByRole('table', { name: 'Commit history' })).toBeTruthy();
    // The subject is a real link to the commit, inspected.
    expect(within(rows[0]!).getByRole('link', { name: /Commit aaaaaaa/ })).toHaveAttribute(
      'href',
      '#/repo?commit=aaaaaaaa11',
    );
  });

  it('names a commit’s first ref whole and counts the rest, every one on the hover', async () => {
    // Three refs shrunk side by side read as `m…`, `origi…`, `v6…`: one name
    // that names something, and a count, is what a 176 px track can say.
    server.reads['/api/repo/graph'] = {
      ...EMPTY_GRAPH,
      commits: [commit('aaaaaaaa11', [], { refs: ['HEAD -> pe/demo', 'origin/pe/demo', 'tag: v1.0.0'] })],
      tips: ['pe/demo'],
    };
    mount('#/repo');
    const row = (await screen.findAllByTestId('commit-row'))[0]!;
    const names = within(row).getAllByTestId('ref-name');
    expect(names.map((n) => n.textContent)).toEqual(['HEAD -> pe/demo']);
    const line = names[0]!.parentElement!;
    expect(line.textContent).toBe('HEAD -> pe/demo+2 more');
    expect(line.getAttribute('title')).toBe('HEAD -> pe/demo\norigin/pe/demo\ntag: v1.0.0');
  });

  it('draws the gutter aria-hidden, one lane sixteen pixels, never wider than 128', async () => {
    expect(LANE_W * LANE_CAP).toBe(GUTTER_MAX);
    expect(GUTTER_MAX).toBeLessThanOrEqual(128);
    // Twelve parallel tips: the drawing stops at the cap and says so.
    const tips = Array.from({ length: 12 }, (_, i) => commit(`t${i}`, [`gone${i}`]));
    server.reads['/api/repo/graph'] = { ...EMPTY_GRAPH, commits: tips, tips: ['main'] };
    mount('#/repo');
    const rows = await screen.findAllByTestId('commit-row');
    for (const row of rows) {
      const svg = row.querySelector('svg')!;
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(Number(svg.getAttribute('width'))).toBeLessThanOrEqual(GUTTER_MAX);
      expect(Number(svg.getAttribute('height'))).toBe(ROW_H);
    }
    expect((await screen.findByTestId('lanes-clipped')).textContent).toMatch(/12 lanes were packed/);
  });

  it('bends a merged-back lane into the dot instead of stopping it beside one', async () => {
    server.reads['/api/repo/graph'] = {
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
    };
    mount('#/repo');
    const rows = await screen.findAllByTestId('commit-row');
    // `base` is the fifth row: both lanes that waited for it curve into its dot.
    expect(rows[4]!.querySelectorAll('[data-lane="merge"]')).toHaveLength(2);
  });

  it('keeps an edge into unreached history dashed across the band, not dashed then solid', async () => {
    server.reads['/api/repo/graph'] = {
      ...EMPTY_GRAPH,
      commits: [commit('a1', ['unreached']), commit('a2', ['unreached2'])],
      tips: ['main'],
      truncated: true,
    };
    const { container } = mount('#/repo');
    await screen.findAllByTestId('commit-row');
    const arriving = container.querySelectorAll('[data-lane="through"]');
    expect(arriving.length).toBeGreaterThan(0);
    for (const el of Array.from(arriving)) expect(el.getAttribute('stroke-dasharray')).toBe('2 3');
  });

  it('cuts its columns by priority to the width, the sha last, and draws them all with Everything', () => {
    expect(graphColumns(328, false, 1)).toEqual(['commit']);
    expect(graphColumns(736, false, 1)).toEqual(['refs', 'at', 'commit']);
    expect(graphColumns(1100, false, 2)).toEqual(['refs', 'author', 'at', 'commit']);
    expect(graphColumns(328, true, 1)).toEqual(['refs', 'author', 'at', 'commit']);
    // Unmeasured — no layout yet — draws every column rather than guessing.
    expect(graphColumns(undefined, false, 1)).toEqual(['refs', 'author', 'at', 'commit']);
  });

  it('finds a commit by subject, author, sha or ref, and draws a found row as its dot alone', async () => {
    server.reads['/api/repo/graph'] = {
      ...EMPTY_GRAPH,
      commits: [
        commit('a1', ['b2'], { subject: 'Settle the lane', refs: ['pe/demo-p4'] }),
        commit('b2', ['c3']),
        commit('c3', []),
      ],
      tips: ['main'],
    };
    mount('#/repo');
    await screen.findAllByTestId('commit-row');
    fireEvent.change(screen.getByRole('searchbox', { name: /Find a commit/ }), { target: { value: 'demo' } });
    const rows = screen.getAllByTestId('commit-row');
    expect(rows).toHaveLength(1);
    // Two rows that are no longer neighbours share no line.
    expect(rows[0]!.querySelector('td')!.querySelectorAll('path, line')).toHaveLength(0);
    expect(rows[0]!.querySelector('circle')).toBeTruthy();
    expect(screen.getByText(/1 of 3 commits match/)).toBeTruthy();
  });

  it('says in words what the walk covers, and offers every branch and one branch alone', async () => {
    server.reads['/api/repo/graph'] = {
      ...EMPTY_GRAPH,
      commits: [commit('a1', [])],
      tips: ['main', 'pe/demo', 'pe/demo-p4'],
      trunk: 'main',
    };
    mount('#/repo');
    expect((await screen.findByTestId('graph-walk-words')).textContent).toBe(
      'Walking main and 2 run branches.',
    );
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const walk = await screen.findByTestId('graph-walk');
    fireEvent.click(within(walk).getByRole('radio', { name: /Every branch/ }));
    expect(window.location.hash).toBe('#/repo?all=1');
    fireEvent.click(within(walk).getByRole('radio', { name: /Only pe\/demo-p4/ }));
    expect(window.location.hash).toBe('#/repo?ref=pe%2Fdemo-p4');
  });

  it('asks for every branch with all=1 and says so', async () => {
    server.reads['/api/repo/graph'] = { ...EMPTY_GRAPH, commits: [commit('a1', [])], tips: ['main', 'x'] };
    mount('#/repo?all=1');
    expect((await screen.findByTestId('graph-walk-words')).textContent).toBe('Walking every branch: 2 tips.');
    expect(callsTo('/api/repo/graph')[0]).toMatch(/[?&]all=1/);
  });

  it('drops an empty ref rather than asking for a named walk of nothing', async () => {
    mount('#/repo?ref=');
    await screen.findByRole('navigation', { name: 'Repo sections' });
    await waitFor(() => expect(callsTo('/api/repo/graph')).toEqual(['/api/repo/graph?limit=120']));
  });

  it('offers Show more below the ceiling, and stops AT it', async () => {
    server.reads['/api/repo/graph'] = {
      ...EMPTY_GRAPH,
      commits: [commit('a1', [])],
      tips: ['main'],
      truncated: true,
    };
    mount('#/repo');
    // 120 → 240 → 360 → 480 → 500, the server's own ceiling.
    for (let i = 0; i < 4; i += 1) {
      fireEvent.click(await screen.findByRole('button', { name: /show more/i }));
    }
    await screen.findByText(/the server’s own ceiling/i);
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull();
    expect(callsTo('/api/repo/graph').at(-1)).toMatch(/limit=500/);
  });
});

describe('a commit is a record in the panel, and its address opens it', () => {
  it('opens the commit the address names, with its parents, refs and what it changed', async () => {
    server.reads['/api/repo/graph'] = {
      ...EMPTY_GRAPH,
      commits: [
        commit('a1aaaaaaaa', ['b2bbbbbbbb', 'zz99999999'], { refs: ['main', 'pe/demo-p4'] }),
        commit('b2bbbbbbbb', []),
      ],
      tips: ['main'],
      trunk: 'main',
    };
    mount('#/repo?commit=a1aaaaaaaa');
    const panel = screen.getByTestId('panel');
    expect(await within(panel).findByText('subject a1aaaaaaaa')).toBeTruthy();
    // The parent outside the walk is named as the window's edge, not a loss.
    expect(within(panel).getByTestId('dangling-parents').textContent).toMatch(/zz99999: beyond this walk/);
    expect(within(panel).getByRole('link', { name: 'b2bbbbb' })).toHaveAttribute(
      'href',
      '#/repo?commit=b2bbbbbbbb',
    );
    openTab(panel, 'Actions');
    expect(within(panel).getByRole('link', { name: 'What this commit changed' })).toHaveAttribute(
      'href',
      '#/repo/changes?tip=a1aaaaaaaa',
    );
    expect(within(panel).getByRole('link', { name: 'Walk pe/demo-p4 alone' })).toHaveAttribute(
      'href',
      '#/repo?ref=pe%2Fdemo-p4',
    );
    // The row on show is marked.
    const row = screen.getAllByTestId('commit-row')[0]!;
    expect(row).toHaveAttribute('aria-current', 'true');
  });

  it('names a commit this page does not hold instead of opening nothing', async () => {
    server.reads['/api/repo/graph'] = { ...EMPTY_GRAPH, commits: [commit('a1', [])], tips: ['main'] };
    mount('#/repo?commit=deadbeef');
    expect((await screen.findByTestId('commit-off-page')).textContent).toMatch(/deadbeef/);
  });

  it('says nothing when the commit IS on the page', async () => {
    server.reads['/api/repo/graph'] = { ...EMPTY_GRAPH, commits: [commit('a1', [])], tips: ['main'] };
    mount('#/repo?commit=a1');
    await screen.findAllByTestId('commit-row');
    expect(screen.queryByTestId('commit-off-page')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Branches
 * ------------------------------------------------------------------ */

describe('branches: an absent number is never zero', () => {
  it('shows a dash for an untracked branch rather than "0 ahead"', async () => {
    server.reads['/api/repo/branches'] = {
      branches: [{ name: 'pe/x', head: 'a'.repeat(40), short: 'aaaaaaa', current: false, trunk: false }],
      truncated: false,
      divergenceTruncated: false,
    } satisfies RepoBranches;
    mount('#/repo/branches');
    await screen.findAllByTestId('branch-row');
    expect(screen.queryByText(/0 ahead/)).toBeNull();
  });

  it('says a capped divergence pass was NOT MEASURED, which is not zero', async () => {
    server.reads['/api/repo/branches'] = {
      branches: [{ name: 'main', head: 'a'.repeat(40), short: 'aaaaaaa', current: true, trunk: true }],
      truncated: false,
      divergenceTruncated: true,
    } satisfies RepoBranches;
    mount('#/repo/branches');
    expect(await screen.findByTestId('divergence-truncated')).toBeTruthy();
  });

  it('admits when the trunk it names has no row in its own list', async () => {
    server.reads['/api/repo/branches'] = {
      branches: [{ name: 'other', head: 'b'.repeat(40), short: 'bbbbbbb', current: false, trunk: false }],
      trunk: 'main',
      truncated: true,
      divergenceTruncated: false,
    } satisfies RepoBranches;
    mount('#/repo/branches');
    expect(await screen.findByTestId('trunk-missing')).toBeTruthy();
    expect(screen.getByTestId('branches-truncated')).toBeTruthy();
  });

  it('tells a run read from a NAME from a tree that actually holds the branch', async () => {
    server.reads['/api/repo/branches'] = {
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
    } satisfies RepoBranches;
    mount('#/repo/branches');
    const run = (await screen.findAllByTestId('branch-run'))[0]!;
    expect(run.getAttribute('title')).toMatch(/branch name/i);
    expect(screen.getAllByTestId('branch-held').length).toBeGreaterThan(0);
  });

  it('never fills the measured half of a pair with a zero', () => {
    const base = { name: 'x', head: 'a'.repeat(40), short: 'aaaaaaa', current: false, trunk: false };
    expect(divergenceWords({ ...base, ahead: 3, behind: 1 })).toBe('3 ahead, 1 behind');
    expect(divergenceWords({})).toBe('—');
    expect(divergenceWords({ ...base, ahead: 3 })).toBe('3 ahead, — behind');
    expect(divergenceWords({ ...base, behind: 2 })).toBe('— ahead, 2 behind');
  });

  it('opens the branch the address names, saying which claim is evidence', async () => {
    server.reads['/api/repo/branches'] = {
      branches: [
        {
          name: 'pe/demo-p4',
          head: 'c'.repeat(40),
          short: 'ccccccc',
          current: false,
          trunk: false,
          run: { slug: 'demo', phase: 4 },
        },
      ],
      trunk: 'main',
      truncated: false,
      divergenceTruncated: false,
    } satisfies RepoBranches;
    mount('#/repo/branches?branch=pe%2Fdemo-p4');
    const panel = screen.getByTestId('panel');
    expect(await within(panel).findByText(/demo P4: read from the branch name/)).toBeTruthy();
    expect(within(panel).getByText(/None: this branch is not tracked/)).toBeTruthy();
    expect(within(panel).getByText(/No working tree stands on it/)).toBeTruthy();
    openTab(panel, 'Actions');
    expect(within(panel).getByRole('link', { name: 'Changes against main' })).toHaveAttribute(
      'href',
      '#/repo/changes?base=main&tip=pe%2Fdemo-p4',
    );
  });

  it('a second press on the row the address already names opens the panel again', async () => {
    server.reads['/api/repo/branches'] = {
      branches: [{ name: 'main', head: 'a'.repeat(40), short: 'aaaaaaa', current: true, trunk: true }],
      truncated: false,
      divergenceTruncated: false,
    } satisfies RepoBranches;
    window.location.hash = '#/repo/branches?branch=main';
    mount('#/repo/branches?branch=main');
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('phase-console.prefs') ?? '{}')?.panel?.open ?? true).toBe(true),
    );
    const { closePanel } = await import('@/shell/panel/modes');
    act(() => closePanel());
    const row = (await screen.findAllByTestId('branch-row'))[0]!;
    fireEvent.click(within(row).getAllByRole('link')[0]!);
    const { getPrefs } = await import('@/lib/prefs');
    expect(getPrefs().panel.open).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Working trees
 * ------------------------------------------------------------------ */

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

  it('draws a record-backed row and a guessed row differently, in words', async () => {
    server.reads['/api/repo/checkouts'] = {
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
    } satisfies RepoCheckouts;
    mount('#/repo/trees');
    await screen.findAllByTestId('checkout-row');
    const vias = screen.getAllByTestId('via');
    expect([...new Set(vias.map((c) => c.getAttribute('data-via')))]).toEqual(['record', 'branch']);
    const guessed = vias.find((c) => c.getAttribute('data-via') === 'branch')!;
    expect(guessed.textContent).toBe('by name');
    expect(guessed.getAttribute('title')).toMatch(/not evidence/i);
  });

  it('never claims liveness for a row with no record behind it', async () => {
    server.reads['/api/repo/checkouts'] = {
      checkouts: [tree({ via: 'branch', run: { slug: 'gone' } })],
      truncated: false,
    } satisfies RepoCheckouts;
    mount('#/repo/trees');
    await screen.findAllByTestId('checkout-row');
    expect(document.querySelector('[data-vocab="presence"]')).toBeNull();
  });

  it('warns before a reclaim, and counts the trees it is warning about', async () => {
    server.reads['/api/repo/checkouts'] = {
      checkouts: [tree({ dir: '/state/a', via: 'branch', run: { slug: 'gone' } }), tree({ dir: '/state/b' })],
      truncated: false,
    } satisfies RepoCheckouts;
    mount('#/repo/trees');
    expect((await screen.findByTestId('debris-note')).textContent).toMatch(/2 trees are/);
  });

  it('names where a detached tree stands instead of leaving the column blank', async () => {
    server.reads['/api/repo/checkouts'] = {
      checkouts: [tree({ detached: 'detached@abcdef012345' })],
      truncated: false,
    } satisfies RepoCheckouts;
    mount('#/repo/trees');
    expect((await screen.findAllByText('detached@abcdef012345')).length).toBeGreaterThan(0);
  });

  it('draws the Repository column only when more than one repository answered', async () => {
    const row = (dir: string, repo: string, role: 'root' | 'operator' = 'root') =>
      tree({ dir, repo, role, managed: false, root: role === 'root', branch: 'main' });
    server.reads['/api/repo/checkouts'] = {
      checkouts: [
        row('/hub', 'root'),
        row('/hub/phased-execution', 'phased-execution'),
        row('/work/pe-p7', 'phased-execution', 'operator'),
      ],
      truncated: false,
    } satisfies RepoCheckouts;
    const first = mount('#/repo/trees');
    await screen.findAllByTestId('checkout-row');
    expect(screen.getByRole('columnheader', { name: 'Repository' })).toBeTruthy();
    expect(screen.getAllByTestId('checkout-repo').map((c) => c.textContent)).toEqual([
      'root',
      'phased-execution',
      'phased-execution',
    ]);
    first.unmount();
    server.reads['/api/repo/checkouts'] = {
      checkouts: [row('/repo', 'root'), row('/state/a', 'root', 'operator')],
      truncated: false,
    } satisfies RepoCheckouts;
    mount('#/repo/trees');
    await screen.findAllByTestId('checkout-row');
    expect(screen.queryByRole('columnheader', { name: 'Repository' })).toBeNull();
  });

  it('opens the tree the address names, with its run and where it leads', async () => {
    server.reads['/api/repo/checkouts'] = {
      checkouts: [
        tree({
          dir: '/home/x/state/a',
          role: 'lane',
          branch: 'pe/demo-p4',
          via: 'record',
          run: { slug: 'demo', phase: 4, runId: 'run1', status: 'finished', live: false },
        }),
      ],
      truncated: false,
    } satisfies RepoCheckouts;
    mount(`#/repo/trees?tree=${encodeURIComponent('/home/x/state/a')}`);
    const panel = screen.getByTestId('panel');
    expect(
      await within(panel).findByText(/The run record says so: demo, phase 4, run run1, finished/),
    ).toBeTruthy();
    openTab(panel, 'Actions');
    expect(within(panel).getByRole('link', { name: 'The run, demo' })).toHaveAttribute(
      'href',
      '#/plan/demo/run?view=history&run=run1',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Settles
 * ------------------------------------------------------------------ */

describe('settles: the window is on the page, not in a log', () => {
  it('draws `scanned` even when there is nothing to show', async () => {
    mount('#/repo/settles');
    const note = await screen.findByTestId('settles-scanned');
    expect(note.textContent).toMatch(/25 run journals/);
    expect(note.textContent).toMatch(/500 entries/);
  });

  it('keeps the same moment from two sources, because they are two pieces of evidence', async () => {
    server.reads['/api/repo/settles'] = {
      events: [
        { slug: 'demo', runId: 'r1', at: '2026-09-01T12:00:00Z', kind: 'settled', via: 'record' },
        { slug: 'demo', runId: 'r1', at: '2026-09-01T12:00:00Z', kind: 'settled', via: 'journal' },
      ],
      truncated: false,
      scanned: { runs: 25, entriesPerRun: 500 },
    } satisfies RepoSettles;
    mount('#/repo/settles');
    await screen.findAllByTestId('settle-row');
    const vias = [...new Set(screen.getAllByTestId('settle-row').map((r) => r.getAttribute('data-via')))];
    expect(vias).toEqual(['record', 'journal']);
  });

  it('asks the server for one plan by address, and opens a settle with the run id 6.2 never showed', async () => {
    server.reads['/api/repo/settles'] = {
      events: [
        {
          slug: 'demo',
          runId: 'r1abc',
          at: '2026-09-01T12:00:00Z',
          kind: 'failed',
          via: 'journal',
          detail: 'no fast-forward',
        },
      ],
      truncated: false,
      scanned: { runs: 5, entriesPerRun: 500 },
    } satisfies RepoSettles;
    mount('#/repo/settles?slug=demo&event=r1abc%3A2026-09-01T12%3A00%3A00Z%3Afailed%3Ajournal%3A');
    const panel = screen.getByTestId('panel');
    expect(await within(panel).findByText('r1abc')).toBeTruthy();
    expect(callsTo('/api/repo/settles')).toEqual(['/api/repo/settles?slug=demo']);
  });
});

/* ------------------------------------------------------------------ *
 * Changes
 * ------------------------------------------------------------------ */

describe('changes: three refusals, three sentences', () => {
  it('says an empty range is an ANSWER, not a failure', async () => {
    mount('#/repo/changes');
    expect(await screen.findByText(/nothing changed in this range/i)).toBeTruthy();
    expect(screen.getByTestId('diff-range').textContent).toBe(
      '0 files changed in the working tree against HEAD.',
    );
  });

  it('says a failed patch means nothing at all', async () => {
    server.reads['/api/repo/diff'] = {
      files: [{ path: 'a.ts', additions: 1, deletions: 0, binary: false }],
      filesTruncated: false,
      fileCount: 1,
      patch: { text: '', truncated: false, failed: true, path: 'a.ts' },
    } satisfies RepoDiff;
    mount('#/repo/changes?path=a.ts');
    expect(await screen.findByTestId('patch-failed')).toBeTruthy();
  });

  it('says a capped file list is capped, rather than reporting a smaller diff', async () => {
    server.reads['/api/repo/diff'] = {
      files: [{ path: 'a.ts', additions: 1, deletions: 0, binary: false }],
      filesTruncated: true,
      fileCount: 900,
    } satisfies RepoDiff;
    mount('#/repo/changes');
    expect(await screen.findByTestId('files-truncated')).toBeTruthy();
  });

  it('says an opened path is not in this range, rather than drawing nothing', async () => {
    server.reads['/api/repo/diff'] = {
      files: [{ path: 'a.ts', additions: 1, deletions: 0, binary: false }],
      filesTruncated: false,
      fileCount: 1,
    } satisfies RepoDiff;
    mount('#/repo/changes?path=gone.ts');
    const note = await screen.findByTestId('path-not-in-range');
    expect(note.textContent).toMatch(/gone\.ts is not among the files this range changed/);
  });

  it('says which files a capped list cannot rule out', async () => {
    server.reads['/api/repo/diff'] = {
      files: [{ path: 'a.ts', additions: 1, deletions: 0, binary: false }],
      filesTruncated: true,
      fileCount: 900,
    } satisfies RepoDiff;
    mount('#/repo/changes?path=gone.ts');
    expect((await screen.findByTestId('path-not-in-range')).textContent).toMatch(/may well have changed/i);
  });

  it('calls a mode-only change what it is, not "changed nothing"', async () => {
    server.reads['/api/repo/diff'] = {
      files: [{ path: 'a.sh', additions: 0, deletions: 0, binary: false }],
      filesTruncated: false,
      fileCount: 1,
      patch: {
        path: 'a.sh',
        truncated: false,
        failed: false,
        text: 'diff --git a/a.sh b/a.sh\nold mode 100644\nnew mode 100755\n',
      },
    } satisfies RepoDiff;
    mount('#/repo/changes?path=a.sh');
    expect(await screen.findByText(/mode or metadata change only/i)).toBeTruthy();
    expect(screen.queryByTestId('patch-absent')).toBeNull();
  });

  it('opens a file in place: its row says so, and its patch is drawn under it', async () => {
    server.reads['/api/repo/diff'] = {
      files: [
        { path: 'a.ts', additions: 1, deletions: 1, binary: false },
        { path: 'b.ts', additions: 4, deletions: 0, binary: false },
      ],
      filesTruncated: false,
      fileCount: 2,
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
    } satisfies RepoDiff;
    mount('#/repo/changes?path=a.ts');
    expect(await screen.findByText('new line')).toBeTruthy();
    expect(screen.getByText('old line')).toBeTruthy();
    const files = screen.getAllByTestId('diff-file');
    expect(within(files[0]!).getByRole('button', { name: /a\.ts/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(files[1]!).getByRole('button', { name: /b\.ts/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // The patch sits inside the opened file's own item.
    expect(within(files[0]!).getByRole('table', { name: 'Diff of a.ts' })).toBeTruthy();
    fireEvent.click(within(files[1]!).getByRole('button', { name: /b\.ts/ }));
    expect(window.location.hash).toBe('#/repo/changes?path=b.ts');
  });

  it('never describes content the answer did not carry', async () => {
    server.reads['/api/repo/diff'] = {
      files: [
        { path: 'a.ts', additions: 9, deletions: 0, binary: false },
        { path: 'b.ts', additions: 2, deletions: 2, binary: false },
      ],
      filesTruncated: false,
      fileCount: 2,
      patch: { path: 'b.ts', text: 'diff --git a/b.ts b/b.ts\n', truncated: false, failed: false },
    } satisfies RepoDiff;
    mount('#/repo/changes?path=a.ts');
    const note = await screen.findByTestId('patch-absent');
    expect(note.textContent).toMatch(/no patch for/i);
    expect(note.textContent).toMatch(/\+9/);
    expect(screen.queryByText(/mode or metadata change only/i)).toBeNull();
  });
});

describe('changes: an absent unified= is not unified=0', () => {
  it('sends git’s default for an address that never asked', async () => {
    mount('#/repo/changes');
    await screen.findByText(/nothing changed in this range/i);
    expect(callsTo('/api/repo/diff')).toEqual(['/api/repo/diff?unified=3']);
  });

  it('sends an explicit unified=0, because no context is a real request', async () => {
    mount('#/repo/changes?unified=0');
    await screen.findByText(/nothing changed in this range/i);
    expect(callsTo('/api/repo/diff')).toEqual(['/api/repo/diff?unified=0']);
  });

  it('falls back once for a value that is no number, so no link carries NaN', async () => {
    expect(unifiedOf('abc')).toBe(3);
    expect(unifiedOf('')).toBe(3);
    expect(unifiedOf(undefined)).toBe(3);
    expect(unifiedOf('0')).toBe(0);
    mount('#/repo/changes?unified=abc');
    await screen.findByText(/nothing changed in this range/i);
    expect(callsTo('/api/repo/diff')).toEqual(['/api/repo/diff?unified=3']);
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      expect(a.getAttribute('href')).not.toMatch(/NaN/);
    }
  });
});

describe('a held-over answer is never drawn as this file’s', () => {
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

  it('holds the file list across a change of PATH', async () => {
    server.reads['/api/repo/diff'] = withPatch('a.ts', 'diff --git a/a.ts b/a.ts\n');
    const { go } = mount('#/repo/changes');
    await screen.findAllByRole('button', { name: /a\.ts/ });
    server.reads['/api/repo/diff'] = () => new Promise<RepoDiff>(() => {});
    go('#/repo/changes?path=b.ts');
    expect(screen.getAllByRole('button', { name: /a\.ts/ }).length).toBeGreaterThan(0);
  });

  it('does NOT hold it across a change of range', async () => {
    server.reads['/api/repo/diff'] = withPatch('a.ts', 'diff --git a/a.ts b/a.ts\n');
    const { go } = mount('#/repo/changes?base=v1&tip=v2');
    await screen.findAllByRole('button', { name: /a\.ts/ });
    server.reads['/api/repo/diff'] = () => new Promise<RepoDiff>(() => {});
    go('#/repo/changes?base=v8&tip=v9');
    expect(screen.queryByRole('button', { name: /a\.ts/ })).toBeNull();
  });

  it('does not draw the held-over patch at the previous context width', async () => {
    server.reads['/api/repo/diff'] = withPatch('a.ts', PATCH_A);
    const { go } = mount('#/repo/changes?path=a.ts');
    await screen.findByText('nine');
    server.reads['/api/repo/diff'] = () => new Promise<RepoDiff>(() => {});
    go('#/repo/changes?path=a.ts&unified=12');
    expect(screen.getAllByRole('button', { name: /a\.ts/ }).length).toBeGreaterThan(0);
    expect(screen.getByTestId('patch-loading')).toBeTruthy();
    expect(screen.queryByText('nine')).toBeNull();
  });

  it('holds it across a change of `unified`, which cannot move the file list', () => {
    const base = { repo: 'r', base: 'v1', tip: 'v2' };
    expect(sameFileList({ ...base, unified: 3 }, { ...base, unified: 0 })).toBe(true);
    expect(sameFileList({ ...base, bytes: 1 }, { ...base, bytes: 2 })).toBe(true);
    expect(sameFileList({ ...base, path: 'a' }, { ...base, path: 'b' })).toBe(true);
    expect(sameFileList(base, { ...base, repo: 'other' })).toBe(false);
    expect(sameFileList(base, { ...base, base: 'v8' })).toBe(false);
    expect(sameFileList(base, { ...base, tip: 'v9' })).toBe(false);
  });
});

describe('a file list row is not a parsed patch', () => {
  it('does not guess `added` from a file that only gained lines', () => {
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
 * The repository picker
 * ------------------------------------------------------------------ */

describe('the repository picker sits in the toolbar', () => {
  it('offers every target in the Filter slot and keeps the section when one is chosen', async () => {
    server.reads['/api/repo/targets'] = {
      targets: [
        { key: 'root', dir: '/repo', label: 'repo', kind: 'root' },
        { key: 'sub', dir: '/repo/sub', label: 'sub', kind: 'submodule' },
      ],
    };
    mount('#/repo/branches?branch=main');
    await screen.findAllByRole('navigation', { name: 'Repo sections' });
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const picker = await screen.findByTestId('repo-target');
    fireEvent.click(within(picker).getByRole('radio', { name: /sub/ }));
    // What belonged to the old repository — the branch — is not carried.
    expect(window.location.hash).toBe('#/repo/branches?repo=sub');
  });

  it('offers no choice where there is one repository', async () => {
    mount('#/repo/changes');
    await screen.findByText(/nothing changed in this range/i);
    expect(screen.queryByRole('button', { name: /^Filter/ })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Accessibility
 * ------------------------------------------------------------------ */

describe('the populated sections pass axe', () => {
  it('the commit graph', async () => {
    server.reads['/api/repo/graph'] = {
      ...EMPTY_GRAPH,
      commits: [commit('a1', ['b2'], { refs: ['main', 'pe/demo-p4'] }), commit('b2', [])],
      tips: ['main'],
      trunk: 'main',
    };
    const { container } = mount('#/repo');
    await screen.findAllByTestId('commit-row');
    await expectNoAxeViolations(container);
  });

  it('the working trees, with every role drawn at once', async () => {
    server.reads['/api/repo/checkouts'] = {
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
    } satisfies RepoCheckouts;
    const { container } = mount('#/repo/trees');
    await screen.findAllByTestId('checkout-row');
    await expectNoAxeViolations(container);
  });

  it('the changes, a file open on its patch', async () => {
    server.reads['/api/repo/diff'] = {
      files: [{ path: 'a.ts', additions: 1, deletions: 1, binary: false }],
      filesTruncated: false,
      fileCount: 1,
      patch: {
        path: 'a.ts',
        truncated: false,
        failed: false,
        text: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n',
      },
    } satisfies RepoDiff;
    const { container } = mount('#/repo/changes?path=a.ts');
    await screen.findByRole('table', { name: 'Diff of a.ts' });
    await expectNoAxeViolations(container);
  });
});

/* ------------------------------------------------------------------ *
 * The source
 * ------------------------------------------------------------------ */

describe('the patch pane scrolls sideways only', () => {
  it('caps no height and nests no vertical scroller, at any width', () => {
    const source = readFileSync(join(here, 'diff.tsx'), 'utf8');
    expect(source).not.toMatch(/max-h-/);
    expect(source).not.toMatch(/overflow-y-auto|overflow-auto\b/);
    expect(source).toMatch(/overflow-x-auto/);
  });
});
