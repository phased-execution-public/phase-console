/**
 * No datum removed from the Repo destination — every fact its tables showed is
 * within TWO interactions (control-tower phase 26, exit criterion 3;
 * `docs/design.md` §5: "No datum removed · every datum within 2 interactions").
 *
 * Phase 26 redrew three of the record band's tables: the branches, the working
 * trees and the settle history now draw their status words — a checkout's
 * role and whether its run lives, a settle's kind — through the badge family,
 * with an icon and a word, where they were a raw word on a hue. This walks
 * every fact each table showed before, and counts the presses it takes to
 * reach it: a row's folded columns are one. A fact that needs a third press,
 * or that is not on the page at all, fails here by name.
 *
 * The status words are read twice: as the label a person sees, and as the raw
 * word on `data-status`, which is what the badge family promises a test.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RepoBranches, RepoCheckouts, RepoSettles } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { setPrefs } from '@/lib/prefs';
import { BranchTable } from './branches';
import { CheckoutTable } from './checkouts';
import { SettleTable } from './settles';

const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

const BRANCHES = {
  trunk: 'main',
  truncated: true,
  divergenceTruncated: true,
  branches: [
    { name: 'main', current: true, trunk: true, subject: 'the trunk as it stands', at: at(2) },
    {
      name: 'pe/control-tower-p26',
      subject: 'repo, issues and insights',
      run: { slug: 'control-tower', phase: 26 },
      ahead: 3,
      behind: 1,
      heldBy: ['/home/op/.state/lanes/p26'],
      at: at(5),
    },
  ],
} as unknown as RepoBranches;

const CHECKOUTS = {
  truncated: false,
  checkouts: [
    { dir: '/repo', repo: 'root', role: 'root', via: 'none', branch: 'main' },
    {
      dir: '/state/runs/abc/integration',
      repo: 'root',
      role: 'run',
      via: 'record',
      run: { slug: 'control-tower', runId: 'abc123', status: 'running', live: true },
      branch: 'pe/control-tower',
      managed: true,
    },
    {
      dir: '/state/runs/old/integration',
      repo: 'phased-execution',
      role: 'debris',
      via: 'branch',
      detached: 'detached@1f44624',
      prunable: true,
    },
  ],
} as unknown as RepoCheckouts;

const SETTLES = {
  truncated: false,
  scanned: { runs: 25, entriesPerRun: 500 },
  events: [
    {
      slug: 'control-tower',
      runId: 'abc123',
      at: at(1),
      kind: 'unsupported',
      phase: 26,
      detail: 'a mirror run settles in its one tree',
      branch: 'pe/control-tower',
      strategy: 'fast-forward',
      via: 'record',
    },
    { slug: 'demo', runId: 'def456', at: at(3), kind: 'failed', via: 'journal' },
  ],
} as unknown as RepoSettles;

/** Every press is counted; a datum's budget is two. */
let presses = 0;
const press = (el: Element) => {
  presses += 1;
  fireEvent.click(el);
};
const onPage = (text: string) => (document.body.textContent ?? '').includes(text);

/** Open one row's folded columns — one press, when the grid folded any. */
function openRow(row: HTMLElement) {
  const more = within(row).queryByRole('button', { name: /Show the rest of this row/ });
  if (more) press(more);
}

async function expectWithinTwo(facts: readonly string[]) {
  for (const fact of facts) {
    await waitFor(() => expect(onPage(fact), `"${fact}" is not on the page`).toBe(true));
  }
  expect(presses, `reached in ${presses} presses`).toBeLessThanOrEqual(2);
}

/** A status badge of the family: its label, and the raw word it was given. */
function badge(vocab: string, word: string) {
  const found = document.querySelector(`[data-vocab="${vocab}"][data-status="${word}"]`);
  expect(found, `no ${vocab} badge for "${word}"`).toBeTruthy();
  expect(found!.querySelector('svg'), `the ${vocab} badge for "${word}" draws its icon`).toBeTruthy();
  return found!.textContent ?? '';
}

beforeEach(() => {
  presses = 0;
  setPrefs({ tables: {} });
});

describe('every datum of the Repo tables is within two interactions', () => {
  it('Branches: name, checked out, trunk, subject, the run read from the name, divergence, holders, last commit', async () => {
    render(<BranchTable view={BRANCHES} onPick={() => {}} />);
    await expectWithinTwo(['main', 'checked out', 'trunk', 'the trunk as it stands', 'pe/control-tower-p26']);
    openRow(
      screen
        .getByRole('button', { name: 'Branch pe/control-tower-p26' })
        .closest('[data-testid="branch-row"]')!,
    );
    await expectWithinTwo([
      'repo, issues and insights',
      'control-tower · p26',
      '3 ahead · 1 behind',
      '1 checkout',
      relativeTime(Date.parse(BRANCHES.branches[1]!.at!)),
    ]);
    // The two windows the list was read through are said, never implied.
    expect(screen.getByTestId('branches-truncated')).toBeInTheDocument();
    expect(screen.getByTestId('divergence-truncated')).toBeInTheDocument();
  });

  it('Working trees: directory, repository, role, attribution, branch or detached head, liveness and the flags', async () => {
    render(<CheckoutTable view={CHECKOUTS} onPick={() => {}} />);
    await expectWithinTwo(['/state/runs/old/integration', 'by name', 'record']);
    // The role is a family badge: its word and icon, the raw role on data-status.
    expect(badge('checkout-role', 'debris')).toBe('Debris');
    expect(badge('checkout-role', 'run')).toBe('Run');
    expect(badge('checkout-role', 'root')).toBe('Root');
    const debris = screen.getByRole('button', { name: 'Checkout /state/runs/old/integration' });
    openRow(debris.closest('[data-testid="checkout-row"]')!);
    await expectWithinTwo(['phased-execution', 'detached@1f44624', 'prunable']);
    presses = 0;
    const run = screen.getByRole('button', { name: 'Checkout /state/runs/abc/integration' });
    openRow(run.closest('[data-testid="checkout-row"]')!);
    await expectWithinTwo(['pe/control-tower', 'managed']);
    // Whether its run lives is the presence word, never a hue alone.
    expect(badge('presence', 'live')).toBe('Live');
    // And the note that asks for the Attributed column before reclaiming.
    expect(screen.getByTestId('debris-note').textContent).toMatch(/One tree is/);
  });

  it('Settle history: run, phase, detail, the event, branch, strategy, source, when — and the window read', async () => {
    render(<SettleTable view={SETTLES} />);
    await expectWithinTwo(['control-tower', 'p26', 'a mirror run settles in its one tree', 'demo']);
    expect(badge('settle', 'unsupported')).toBe('Not supported here');
    expect(badge('settle', 'failed')).toBe('Failed');
    const row = screen
      .getAllByTestId('settle-row')
      .find((r) => r.getAttribute('data-kind') === 'unsupported')!;
    openRow(row);
    await expectWithinTwo([
      'pe/control-tower',
      'fast-forward',
      'record',
      relativeTime(Date.parse(SETTLES.events[0]!.at)),
    ]);
    expect(screen.getByTestId('settles-scanned').textContent).toMatch(/25 run journals, at most 500 entries/);
  });
});

describe('a status column of the Repo tables is never colour alone', () => {
  it('every role, liveness and settle cell wears an icon and a word', () => {
    render(
      <>
        <CheckoutTable view={CHECKOUTS} onPick={() => {}} />
        <SettleTable view={SETTLES} />
      </>,
    );
    const statuses = [...document.querySelectorAll('[data-vocab][data-status]')];
    expect(statuses.length).toBeGreaterThanOrEqual(6);
    for (const el of statuses) {
      expect(el.querySelector('svg'), el.outerHTML.slice(0, 80)).toBeTruthy();
      expect((el.textContent ?? '').trim().length, el.outerHTML.slice(0, 80)).toBeGreaterThan(2);
    }
  });
});
