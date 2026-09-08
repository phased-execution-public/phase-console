/**
 * The landing card, as an operator meets it.
 *
 * Four claims, each of which the card could get wrong in a way that reads fine
 * on screen:
 *
 *   1. **nothing is fetched until it is opened.** The read behind it is a
 *      `git status` over the whole tree and a `git log` over the plan's range.
 *      A card that fetched on mount would put that on every plan page load;
 *   2. **the never-push sentence is on the card**, where somebody looking for a
 *      Push button will read it — not only in a doc they are not reading;
 *   3. **the notes are shown.** A packet composed over a dirty tree silently
 *      omits the uncommitted work, and the manifest's note is the only thing
 *      that says so;
 *   4. **a read-only console still reads.** Composing is the gated act; the
 *      branch state is display, and a console with no flags is exactly where
 *      somebody checks whether the work is anywhere but this laptop.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { expectNoAxeViolations } from '@/test/axe';
import type { LandingView, PlanDetail } from '@/lib/api';
import { LandingCard, branchLine, fileSize } from './landing-card';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, landing: vi.fn(), composeLanding: vi.fn() },
  };
});

const { api } = await import('@/lib/api');

const detail = (): PlanDetail =>
  ({ summary: { slug: 'demo', ready: [] }, phases: [], route: [], batches: [] }) as unknown as PlanDetail;

const VIEW: LandingView = {
  slug: 'demo',
  repo: {
    available: true,
    branch: 'pe/demo',
    head: '1111111111111111111111111111111111111111',
    dirty: [],
    dirtyTruncated: false,
  },
  window: { kind: 'plan-window', base: 'aaaaaaa', tip: 'HEAD', note: 'From aaaaaaa to HEAD.' },
  commitCount: 12,
  finished: true,
  packet: null,
  writable: true,
};

const PACKET = {
  version: 1,
  slug: 'demo',
  at: '2026-08-24T10:00:00.000Z',
  repo: VIEW.repo,
  window: VIEW.window,
  commits: [{ sha: 'bbbbbbb', subject: 'feat: the work' }],
  commitCount: 12,
  commitsTruncated: false,
  bundle: { name: 'demo.bundle', bytes: 20_480, ref: 'pe/demo', prerequisites: ['aaaaaaa'] },
  patches: { dir: 'patches', files: ['0001-feat-the-work.patch'] },
  files: [
    { name: 'landing.json', kind: 'manifest' as const, bytes: 900 },
    { name: 'demo.bundle', kind: 'bundle' as const, bytes: 20_480 },
    { name: 'patches/0001-feat-the-work.patch', kind: 'patch' as const, bytes: 512 },
  ],
  apply: ['git bundle verify <packet>/demo.bundle', 'git fetch <packet>/demo.bundle pe/demo:pe/demo'],
  notes: ['3 uncommitted paths in the working tree are NOT in this packet — a bundle carries commits.'],
};

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <LandingCard detail={detail()} />
    </QueryClientProvider>,
  );
}

const show = () => fireEvent.click(screen.getByRole('button', { name: 'Show' }));

describe('the landing card', () => {
  beforeEach(() => {
    vi.mocked(api.landing).mockReset().mockResolvedValue(VIEW);
    vi.mocked(api.composeLanding).mockReset().mockResolvedValue({ ok: true, packet: PACKET, detail: 'done' });
  });

  it('fetches nothing until it is opened', async () => {
    renderCard();
    expect(api.landing).not.toHaveBeenCalled();

    show();
    await waitFor(() => expect(api.landing).toHaveBeenCalledWith('demo'));
  });

  it('says where the work is, and that this console will not push it', async () => {
    renderCard();
    show();

    await screen.findByText(/12 commits on pe\/demo/);
    expect(screen.getByText(/no upstream — it exists only here/)).toBeTruthy();
    expect(screen.getByText(/never pushes/)).toBeTruthy();
  });

  it('composes on demand, then lists every file with a download link', async () => {
    // First read has no packet; the mutation invalidates and the SECOND read is
    // where the packet appears. Staging it the other way round races the
    // invalidation and the card refetches the empty view it started with.
    vi.mocked(api.landing)
      .mockReset()
      .mockResolvedValueOnce(VIEW)
      .mockResolvedValue({ ...VIEW, packet: PACKET });
    renderCard();
    show();

    const button = await screen.findByRole('button', { name: 'Compose landing packet' });
    fireEvent.click(button);
    await waitFor(() => expect(api.composeLanding).toHaveBeenCalledWith('demo'));

    const bundle = await screen.findByText('demo.bundle');
    expect(bundle.getAttribute('href')).toBe('/api/plans/demo/landing/demo.bundle');
    // A patch keeps its slash: the route reads everything after `landing/` as
    // the name, and an encoded `%2F` would not resolve.
    expect(screen.getByText('patches/0001-feat-the-work.patch').getAttribute('href')).toBe(
      '/api/plans/demo/landing/patches/0001-feat-the-work.patch',
    );

    expect(screen.getByText(/uncommitted paths/)).toBeTruthy();
    expect(screen.getByText(/git bundle verify/)).toBeTruthy();
  });

  it('a read-only console still reads, and says why it cannot compose', async () => {
    vi.mocked(api.landing).mockResolvedValue({ ...VIEW, writable: false });
    renderCard();
    show();

    await screen.findByText(/12 commits on pe\/demo/);
    expect(screen.getByText(/--allow-writes/)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Compose landing packet' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('a refusal is shown, not swallowed', async () => {
    vi.mocked(api.composeLanding).mockResolvedValue({
      ok: false,
      packet: null,
      detail: 'There are no commits in aaaaaaa..pe/demo, so there is nothing to land.',
    });
    renderCard();
    show();

    fireEvent.click(await screen.findByRole('button', { name: 'Compose landing packet' }));
    await screen.findByText(/nothing to land/);
  });

  it('is accessible with a packet on screen', async () => {
    vi.mocked(api.landing).mockResolvedValue({ ...VIEW, packet: PACKET });
    const { container } = renderCard();
    show();
    await screen.findByText('demo.bundle');
    await expectNoAxeViolations(container);
  });
});

describe('the small formatters', () => {
  it('reads bytes the way an operator does', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(20_480)).toBe('20 KB');
    expect(fileSize(3_500_000)).toBe('3.3 MB');
  });

  it('branchLine names the state that decides whether the packet matters', () => {
    expect(branchLine(VIEW)).toContain('no upstream');
    expect(
      branchLine({ ...VIEW, repo: { ...VIEW.repo, upstream: 'origin/pe/demo', ahead: 3, behind: 1 } }),
    ).toContain('tracking origin/pe/demo, 3 ahead, 1 behind');
    expect(branchLine({ ...VIEW, repo: { ...VIEW.repo, branch: undefined } })).toContain('detached HEAD');
    expect(branchLine({ ...VIEW, repo: { available: false, dirty: [], dirtyTruncated: false } })).toContain(
      'not a git repository',
    );
    expect(branchLine({ ...VIEW, commitCount: 1 })).toContain('1 commit on');
  });
});
