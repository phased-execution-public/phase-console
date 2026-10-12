/**
 * The record band on a phone (control-tower phase 26, exit criterion 4): Repo
 * — every section — and Insights stay inside `main` at 360, with every fold
 * open as well as shut, and the issues board's compose sheet keeps its submit
 * winning its tap once the keyboard is up.
 *
 * Repo's five git sections (7.0's, quiet-console phase 17) and its Issues
 * desk (phase 18) are measured on ROWS: the fixture's library root is not a
 * git repository and has never asked GitHub, so its own answers are refusals
 * and not-asked-yet repositories, and those at 360 prove nothing about a
 * commit row, a tree's directory, a patch or an issue. `populate` answers
 * `/api/repo/*` and `/api/issues` with a repository's worth of long names
 * instead — merges, run branches, a debris tree, a patch line wider than any
 * phone, issues in every reading and a repository that could not be asked —
 * and the same legs are pictured at 1280, with one commit and one issue open
 * in the panel at both widths, for the session that changed them to READ.
 * Pro's Landscape is drawn the same way: a mid-run map of the root, at both
 * widths, and one of its nodes open in the panel.
 *
 * The keyboard is the visual viewport shrinking under a focused field, as in
 * `launch.spec.ts`: `--app-height` follows it, and a full sheet is exactly
 * that tall, so the footer rides the keyboard's upper edge. The submit is
 * pressable whether or not this console could start the session — the sheet
 * says why it cannot, beside the button — so its hit test is the layout's
 * question, not the fixture's flags.
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { layoutFindings, still } from './lib/probes.ts';
import { fixture, shoot, visit } from './lib/shots.ts';

const PHONE = 'phone-360';
const DESK = 'desk-1280';

/** Repo's five git sections, each with the row it exists to draw. */
const REPO_LEGS = [
  { name: 'band-repo-history', hash: '#/repo', row: 'commit-row' },
  { name: 'band-repo-branches', hash: '#/repo/branches', row: 'branch-row' },
  { name: 'band-repo-trees', hash: '#/repo/trees', row: 'checkout-row' },
  { name: 'band-repo-changes', hash: '#/repo/changes', row: 'diff-file' },
  { name: 'band-repo-settles', hash: '#/repo/settles', row: 'settle-row' },
  { name: 'band-repo-issues', hash: '#/repo/issues', row: 'issue-row' },
] as const;

/** The rest of the band, as the fixture console answers it. */
const RECORD_BAND = [
  { name: 'band-insights', hash: '#/insights' },
] as const;

/* ---------------- a repository's worth of answers ---------------- */

const AT = Date.UTC(2026, 9, 10, 9, 0, 0);
const ago = (hours: number) => new Date(AT - hours * 3_600_000).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);

const TARGETS = {
  targets: [
    { key: 'root', dir: '/home/op/work/pe-hub', label: 'pe-hub', kind: 'root' },
    {
      key: 'phased-execution',
      dir: '/home/op/work/pe-hub/phased-execution',
      label: 'phased-execution',
      kind: 'submodule',
    },
  ],
};

const commit = (seed: string, parents: string[], subject: string, extra: Record<string, unknown> = {}) => ({
  sha: sha(seed),
  short: sha(seed).slice(0, 7),
  parents: parents.map(sha),
  refs: [] as string[],
  subject,
  author: 'quiet-console session',
  at: ago(Number.parseInt(seed, 16) % 40),
  ...extra,
});

/** A merge of a lane into its run branch, the run branch beside the trunk, and history past the walk. */
const GRAPH = {
  trunk: 'main',
  tips: ['main', 'pe/quiet-console', 'pe/quiet-console-p17'],
  tipsTruncated: false,
  truncated: true,
  commits: [
    commit(
      'a1',
      ['b2', 'c3'],
      'merge: pe/quiet-console-p17 into pe/quiet-console — the Repo screen, five sections under one nav',
      {
        refs: ['HEAD -> pe/quiet-console', 'origin/pe/quiet-console'],
      },
    ),
    commit(
      'c3',
      ['d4'],
      'feat(repo): every record of Repo is inspectable in the panel, and its address opens it',
      {
        refs: ['pe/quiet-console-p17'],
      },
    ),
    commit('b2', ['e5'], 'fix(supervisor): on a phone the keyboard gets the thread and the composer'),
    commit(
      'd4',
      ['e5'],
      'feat(repo): History is real table rows beside a 128 px lane gutter that a reader skips',
    ),
    commit(
      'e5',
      ['f6'],
      'docs(plans): quiet-console — Phase Console 7.0, the whole web client redesigned from zero',
      {
        refs: ['main', 'origin/main', 'tag: v6.2.1'],
      },
    ),
    commit('f6', ['17'], 'merge: pe/control-tower into main — CLAUDE.md true at 6.2.1 and at the close'),
    commit(
      '17',
      ['28'],
      'chore: a subject long enough to need every pixel the subject column has, and then some more words',
    ),
    commit(
      '28',
      ['39'],
      'feat(launch): the whole launch form stands in screens/launch in the kit’s controls',
    ),
  ],
};

const BRANCHES = {
  trunk: 'main',
  truncated: false,
  divergenceTruncated: true,
  branches: [
    {
      name: 'main',
      head: sha('e5'),
      short: 'e5e5e5e',
      current: false,
      trunk: true,
      subject: GRAPH.commits[4]!.subject,
      upstream: 'origin/main',
      author: 'the operator',
      at: ago(30),
    },
    {
      name: 'pe/quiet-console',
      head: sha('a1'),
      short: 'a1a1a1a',
      current: true,
      trunk: false,
      subject: GRAPH.commits[0]!.subject,
      run: { slug: 'quiet-console' },
      ahead: 17,
      behind: 0,
      heldBy: [
        '/home/op/work/pe-hub/.worktrees/runs/quiet-console/a0de94f27bb4/integration/phased-execution',
      ],
      upstream: 'origin/pe/quiet-console',
      author: 'quiet-console session',
      at: ago(1),
    },
    {
      name: 'pe/quiet-console-p17',
      head: sha('c3'),
      short: 'c3c3c3c',
      current: false,
      trunk: false,
      subject: GRAPH.commits[1]!.subject,
      run: { slug: 'quiet-console', phase: 17 },
      ahead: 2,
      behind: 1,
      author: 'quiet-console session',
      at: ago(2),
    },
    {
      name: 'pe/phase-console-commerce-p23-a-branch-name-nobody-would-type-twice',
      head: sha('9a'),
      short: '9a9a9a9',
      current: false,
      trunk: false,
      subject: 'feat(site): the till, the key and the receipt in one page',
      run: { slug: 'phase-console-commerce', phase: 23 },
      at: ago(400),
    },
    {
      name: 'operator/scratch',
      head: sha('8b'),
      short: '8b8b8b8',
      current: false,
      trunk: false,
      subject: 'wip',
      ahead: 1,
      behind: 40,
      at: ago(90),
    },
  ],
};

const RUN_TREE = '/home/op/work/pe-hub/.worktrees/runs/quiet-console/a0de94f27bb4/integration';
const CHECKOUTS = {
  truncated: false,
  checkouts: [
    {
      dir: '/home/op/work/pe-hub',
      repo: 'root',
      role: 'root',
      root: true,
      managed: false,
      prunable: false,
      via: 'none',
      branch: 'main',
    },
    {
      dir: RUN_TREE,
      repo: 'root',
      role: 'run',
      root: false,
      managed: true,
      prunable: false,
      via: 'record',
      run: { slug: 'quiet-console', runId: 'a0de94f27bb4', status: 'running', live: true },
      branch: 'pe/quiet-console',
    },
    {
      dir: `${RUN_TREE}/phased-execution`,
      repo: 'phased-execution',
      role: 'lane',
      root: false,
      managed: true,
      prunable: false,
      via: 'record',
      run: { slug: 'quiet-console', phase: 17, runId: 'a0de94f27bb4', status: 'running', live: true },
      branch: 'pe/quiet-console',
    },
    {
      dir: '/home/op/work/pe-hub/.worktrees/staging/phased-execution',
      repo: 'phased-execution',
      role: 'staging',
      root: false,
      managed: true,
      prunable: false,
      via: 'none',
      branch: 'pe/integration',
    },
    {
      dir: '/home/op/elsewhere/pe-p7',
      repo: 'phased-execution',
      role: 'operator',
      root: false,
      managed: false,
      prunable: false,
      via: 'none',
      branch: 'operator/scratch',
    },
    {
      dir: '/home/op/work/pe-hub/.worktrees/runs/control-tower/9c66853e1db3/integration',
      repo: 'root',
      role: 'debris',
      root: false,
      managed: true,
      prunable: true,
      via: 'branch',
      run: { slug: 'control-tower' },
      detached: 'detached@7c24dff0e1a2',
    },
  ],
};

const FILES = [
  { path: 'viewer/client/src/screens/repo/graph-section.tsx', additions: 357, deletions: 0, binary: false },
  {
    path: 'viewer/client/src/screens/repo/trees.tsx',
    oldPath: 'viewer/client/src/features/repo/checkouts.tsx',
    additions: 120,
    deletions: 88,
    binary: false,
  },
  { path: 'viewer/client/src/styles/touch.test.ts', additions: 61, deletions: 47, binary: false },
  {
    path: 'viewer/client/public/icons/a-picture-of-the-gutter.png',
    additions: 0,
    deletions: 0,
    binary: true,
  },
];

const PATCH = [
  'diff --git a/viewer/client/src/screens/repo/graph-section.tsx b/viewer/client/src/screens/repo/graph-section.tsx',
  '--- a/viewer/client/src/screens/repo/graph-section.tsx',
  '+++ b/viewer/client/src/screens/repo/graph-section.tsx',
  '@@ -1,6 +1,7 @@',
  ' /**',
  '- * History — the commit graph.',
  '+ * History — the commit graph, its walk, and a commit in the panel (7.0, quiet-console phase 17), with a line long enough that no phone could ever hold it whole.',
  '  *',
  '  * ```',
  '+ * [Find a commit…]  Filter                                        Everything',
  '  */',
  '',
].join('\n');

const diffAnswer = (url: URL) => ({
  files: FILES,
  filesTruncated: false,
  fileCount: FILES.length,
  ...(url.searchParams.get('path') === FILES[0]!.path
    ? { patch: { path: FILES[0]!.path, text: PATCH, truncated: false, failed: false } }
    : {}),
});

const SETTLES = {
  truncated: false,
  scanned: { runs: 25, entriesPerRun: 500 },
  events: [
    {
      slug: 'quiet-console',
      runId: 'a0de94f27bb4',
      at: ago(1),
      kind: 'settled',
      phase: 16,
      branch: 'pe/quiet-console-p16',
      strategy: 'fast-forward',
      via: 'record',
    },
    {
      slug: 'quiet-console',
      runId: 'a0de94f27bb4',
      at: ago(1),
      kind: 'settled',
      phase: 16,
      detail: 'lane folded back with 2 commits',
      via: 'journal',
    },
    {
      slug: 'control-tower',
      runId: '9c66853e1db3',
      at: ago(40),
      kind: 'landed',
      branch: 'pe/control-tower',
      strategy: 'merge',
      via: 'record',
    },
    {
      slug: 'control-tower',
      runId: '9c66853e1db3',
      at: ago(41),
      kind: 'unsupported',
      phase: 26,
      detail: 'a mirror run settles in its one tree, so there is no lane to fold',
      via: 'journal',
    },
    {
      slug: 'phase-console-commerce',
      runId: '5b2e01aa77c1',
      at: ago(300),
      kind: 'failed',
      phase: 23,
      branch: 'pe/phase-console-commerce-p23',
      detail: 'not a fast-forward: the run branch moved under the lane while it ran',
      via: 'journal',
    },
    {
      slug: 'zero-touch-console',
      runId: '1f44624ab0c9',
      at: ago(500),
      kind: 'pushed',
      branch: 'pe/zero-touch-console',
      via: 'record',
    },
  ],
};

/** An issue with its readings, as the server joins them on. */
const issue = (
  number: number,
  title: string,
  triage: { category: string; severity: string; plan: { state: string; slug?: string; phases?: number[] } },
  extra: Record<string, unknown> = {},
) => ({
  number,
  title,
  state: 'OPEN',
  labels: [triage.category, `severity:${triage.severity}`],
  assignees: [] as string[],
  author: 'the-operator',
  createdAt: ago(200),
  updatedAt: ago(number % 30),
  url: `https://github.com/phased-console-pro/phased-execution/issues/${number}`,
  triage,
  ...extra,
});

/** The issue estate: a repository in every reading, one stale, one that could not be asked. */
const ISSUES = {
  at: AT,
  refreshing: false,
  repos: [
    {
      key: 'phased-execution',
      label: 'phased-execution',
      scopeToken: 'phased-execution',
      kind: 'submodule',
      remote: 'git@github.com:phased-console-pro/phased-execution.git',
      nameWithOwner: 'phased-console-pro/phased-execution',
      state: 'fresh',
      fetchedAt: AT - 180_000,
      ageMs: 180_000,
      issues: [
        issue(
          293,
          'npm test carries two reds no phase verification runs: the vocab-owners toast reader and the free-tree shape of capability-model.js',
          { category: 'bug', severity: 'medium', plan: { state: 'needs-plan' } },
          {
            labels: ['bug', 'severity:medium', 'awaiting-plan', 'from-session'],
            provenance: { slug: 'quiet-console', phase: 5, runId: 'a0de94f27bb4', draftId: 'a1b2c3d4e5f6' },
            body: 'Two tests have been red since phase 2.\nNeither is run by a phase.\nThe fix is to re-point both readers.\nA fourth line the preview leaves out.',
          },
        ),
        issue(289, 'The e2e still probe is red under load average 15 and above, six workers deep', {
          category: 'bug',
          severity: 'low',
          plan: { state: 'planned', slug: 'quiet-console', phases: [27, 30] },
        }),
        issue(
          282,
          'The free tree names no Pro package',
          {
            category: 'bug',
            severity: 'high',
            plan: { state: 'fixed', slug: 'control-tower', phases: [150] },
          },
          { state: 'CLOSED', closedAt: ago(48) },
        ),
        issue(251, 'publish-pro.sh stages by itself instead of stopping at E_STAGE_REQUIRED', {
          category: 'enhancement',
          severity: 'none',
          plan: { state: 'deferred', slug: 'quiet-console' },
        }),
        issue(
          247,
          'write-menu and the help sheet go red only under the full gate’s load',
          {
            category: 'documentation',
            severity: 'critical',
            plan: { state: 'none' },
          },
          { assignees: ['the-operator', 'a-second-maintainer-with-a-long-login'] },
        ),
      ],
    },
    {
      key: 'root',
      label: 'pe-hub',
      scopeToken: 'pe-hub',
      kind: 'root',
      remote: 'git@github.com:acme-studio/pe-hub.git',
      nameWithOwner: 'acme-studio/pe-hub',
      state: 'stale',
      fetchedAt: AT - 26 * 3_600_000,
      ageMs: 26 * 3_600_000,
      issues: [
        issue(6, 'A question about the docs root’s pointer bumps after a release', {
          category: 'question',
          severity: 'none',
          plan: { state: 'needs-plan' },
        }),
      ],
    },
    {
      key: 'phase-console-site',
      label: 'phase-console-site',
      scopeToken: 'phase-console-site',
      kind: 'submodule',
      remote: 'git@github.com:acme-studio/phase-console-site.git',
      nameWithOwner: 'acme-studio/phase-console-site',
      state: 'unknown',
      reason: 'no-auth',
      detail: 'gh: To get started with GitHub CLI, please run: gh auth login',
      issues: [],
    },
  ],
};

const REPO: Record<string, unknown> = {
  targets: TARGETS,
  graph: GRAPH,
  branches: BRANCHES,
  checkouts: CHECKOUTS,
  settles: SETTLES,
};

/** Answer Repo's git reads and the issue estate with the repository above, for this page only. */
async function populate(page: Page): Promise<void> {
  await page.route(/\/api\/repo\/(targets|graph|branches|checkouts|diff|settles)(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    const which = url.pathname.split('/').pop() ?? '';
    const body = which === 'diff' ? diffAnswer(url) : REPO[which];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(/\/api\/issues(\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ISSUES) }),
  );
}

/* ---------------- the probes ---------------- */

async function escapes(page: Page, touch = true) {
  return (await layoutFindings(page, { touch })).filter((f) => f.cls === 'overflow' || f.cls === 'escape');
}

/** Open every fold the page draws: a table's numbers and a card's rows must fit as well as the fold's own row did. */
async function unfold(page: Page): Promise<void> {
  // A fold, not a menu: a select's combobox and a popup trigger also say
  // `aria-expanded`, and an open listbox holds the pointer.
  const folds = page.locator(
    'main button[aria-expanded="false"]:not([role="combobox"]):not([aria-haspopup])',
  );
  for (let i = (await folds.count()) - 1; i >= 0; i -= 1) {
    const fold = folds.nth(i);
    if (await fold.isVisible()) await fold.click();
  }
  await still(page);
}

const only = (info: TestInfo, project: string) =>
  test.skip(info.project.name !== project, `this picture is ${project}'s`);


/* ---------------- Repo's five sections, on rows ---------------- */

for (const leg of REPO_LEGS) {
  test(`${leg.hash} draws its rows inside main at 360, folded and unfolded`, async ({ page }, info) => {
    only(info, PHONE);
    const fx = await fixture();
    await populate(page);
    await visit(page, leg, fx.anchor);
    await expect(page.locator(`main [data-testid="${leg.row}"]`).first()).toBeVisible();
    expect(await escapes(page), 'folded').toEqual([]);
    await shoot(page, info.project.name, leg.name);

    await unfold(page);
    expect(await escapes(page), 'unfolded').toEqual([]);
    await shoot(page, info.project.name, `${leg.name}-open`);
  });

  test(`${leg.hash} draws its rows inside main at 1280`, async ({ page }, info) => {
    only(info, DESK);
    const fx = await fixture();
    await populate(page);
    await visit(page, leg, fx.anchor);
    await expect(page.locator(`main [data-testid="${leg.row}"]`).first()).toBeVisible();
    expect(await escapes(page, false)).toEqual([]);
    await shoot(page, info.project.name, leg.name);
  });
}

test('a file opens in place, and its patch scrolls sideways inside the page at 360', async ({
  page,
}, info) => {
  only(info, PHONE);
  const fx = await fixture();
  await populate(page);
  const name = 'band-repo-changes-patch';
  await visit(page, { name, hash: `#/repo/changes?path=${encodeURIComponent(FILES[0]!.path)}` }, fx.anchor);
  const pane = page.getByTestId('patch-pane');
  await expect(pane).toBeVisible();
  // The pane is wider inside than out — the long line — and the page is not.
  const widths = await pane.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(widths.scroll, 'the long line is inside the pane').toBeGreaterThan(widths.client);
  expect(await escapes(page), 'the page holds the pane').toEqual([]);
  await shoot(page, info.project.name, name);
});

for (const project of [PHONE, DESK]) {
  test(`a commit the address names is open in the panel at ${project}`, async ({ page }, info) => {
    only(info, project);
    const fx = await fixture();
    await populate(page);
    await visit(page, { name: 'band-repo-commit', hash: `#/repo?commit=${sha('c3')}` }, fx.anchor);
    await expect(page.locator('[data-inspector]').getByText(GRAPH.commits[1]!.subject).first()).toBeVisible();
    await still(page);
    await shoot(page, info.project.name, 'band-repo-commit');
  });
}

for (const project of [PHONE, DESK]) {
  test(`an issue the address names is open in the panel at ${project}`, async ({ page }, info) => {
    only(info, project);
    const fx = await fixture();
    await populate(page);
    const ref = 'phased-console-pro/phased-execution#293';
    await visit(
      page,
      { name: 'band-repo-issue', hash: `#/repo/issues?issue=${encodeURIComponent(ref)}` },
      fx.anchor,
    );
    await expect(page.locator('[data-inspector]').getByTestId('issue-body')).toBeVisible();
    await still(page);
    await shoot(page, info.project.name, 'band-repo-issue');
  });
}

test('picking an issue raises the pick band, and it stays inside main at 360', async ({ page }, info) => {
  only(info, PHONE);
  const fx = await fixture();
  await populate(page);
  await visit(page, { name: 'band-repo-issues-picked', hash: '#/repo/issues' }, fx.anchor);
  await page.getByTestId('issue-pick').first().click();
  await expect(page.getByTestId('issue-selection')).toBeVisible();
  // The console runs without --allow-agent: the launch says why, beside it.
  await expect(page.getByTestId('launch-why')).toBeVisible();
  expect(await escapes(page)).toEqual([]);
  await shoot(page, info.project.name, 'band-repo-issues-picked');
});

/* ---------------- the rest of the band ---------------- */

for (const stop of RECORD_BAND) {
  test(`${stop.hash} stays inside main at 360, folded and unfolded`, async ({ page }, info) => {
    only(info, PHONE);
    const fx = await fixture();
    await visit(page, stop, fx.anchor);
    expect(await escapes(page), 'folded').toEqual([]);
    await shoot(page, info.project.name, stop.name);
    await unfold(page);
    expect(await escapes(page), 'unfolded').toEqual([]);
  });
}

