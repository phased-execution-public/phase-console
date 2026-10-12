/**
 * The source picker (`#/source`, quiet-console phase 21): the page drawn
 * instead of the shell until a source is open, and where Change source leads.
 *
 * What it holds: it lists the directory it stands in and walks into a folder,
 * up to the parent and to home — the box showing where the SERVER walked to,
 * never the previous directory's answer; the verdict is the root check's own
 * (counts when it is a source, the reason when it is not), and Open is enabled
 * by that fact alone; opening sends the path, and lands on the plans; a
 * refusal is the server's words beside the button; a pinned console still
 * draws the picker with Open off and says what to run instead; a recent source
 * opens in one press.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import type { ConsoleState, DirListing, RootCheck } from '@/data/api';
import { ApiError } from '@/data/http';
import { plansHref, runsHref } from '@/shell/routes';
import { expectNoAxeViolations } from '@/test/axe';
import SourcePage from './source';
import { renderWithClient, sent } from './test-kit';

const HOME = '/home/x';
const CODE = `${HOME}/code`;
const REPO = `${CODE}/repo`;

const STATE: ConsoleState = {
  home: HOME,
  root: { path: CODE, ok: false, label: 'code' },
  instance: { id: 'abc-code', name: 'code', pinned: false },
  recentRoots: [{ path: `${HOME}/work/old`, label: 'old' }],
};

/** What `GET /api/fs?path=` answers, by the path asked — `~` resolves to home, as the server does. */
const LISTINGS: Record<string, DirListing> = {
  [CODE]: {
    path: CODE,
    parent: HOME,
    entries: [
      { name: 'repo', path: REPO, hasDocs: true },
      { name: 'scratch', path: `${CODE}/scratch`, hasDocs: false },
    ],
  },
  [HOME]: { path: HOME, parent: '/home', entries: [{ name: 'code', path: CODE, hasDocs: false }] },
  '~': { path: HOME, parent: '/home', entries: [{ name: 'code', path: CODE, hasDocs: false }] },
  [REPO]: { path: REPO, parent: CODE, entries: [] },
};

/** What `GET /api/root?path=` answers, by the path asked. */
function checkOf(path: string): RootCheck {
  return path === REPO
    ? { path, ok: true, label: 'repo', planCount: 3, handoffCount: 2, docsDir: `${REPO}/docs` }
    : { path, ok: false, label: path, planCount: 0, handoffCount: 0, reason: `No docs/plans in ${path}` };
}

/** The `path` query a call carried. */
const pathOf = (call: Call): string => new URLSearchParams(call.path.split('?')[1] ?? '').get('path') ?? '';

/** The `path` query of the newest call to a route — the fixture answers by it. */
const askedPath = (route: string): string =>
  pathOf([...server.calls].reverse().find((call) => call.path.split('?')[0] === route)!);

/** Every directory the page asked to list, in order. */
const listingAsked = () => server.calls.filter((call) => call.path.startsWith('/api/fs?')).map(pathOf);

const box = () => screen.getByLabelText('Path') as HTMLInputElement;
const openButton = () => screen.getByRole('button', { name: 'Open this directory' });

beforeEach(() => {
  server.calls = [];
  server.reads = {
    '/api/state': STATE,
    '/api/fs': () => {
      const listing = LISTINGS[askedPath('/api/fs')];
      if (!listing) throw new ApiError('no such directory', 404, '/api/fs');
      return listing;
    },
    '/api/root': () => checkOf(askedPath('/api/root')),
    'POST /api/root': (body: unknown) => {
      const path = (body as { path: string }).path;
      return { check: checkOf(path), state: { ...STATE, root: { path, ok: true } } };
    },
  };
  window.location.hash = '#/source';
});

const mount = () => renderWithClient(<SourcePage />);

describe('the frame', () => {
  it('draws its own title and what it reads, with no shell around it', async () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'Choose a source directory' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^repo/ })).toBeInTheDocument();
  });

  it('has no axe violation', async () => {
    const { container } = mount();
    await screen.findByRole('button', { name: /^repo/ });
    await expectNoAxeViolations(container);
  });
});

describe('browsing', () => {
  it('lists the directory it stands in, and marks the one that holds plans', async () => {
    mount();
    const listing = await screen.findByRole('list', { name: `Directories in ${CODE}` });
    const rows = within(listing).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual(['repo Has plans', 'scratch']);
    expect(within(listing).getByRole('button', { name: 'repo Has plans' })).toBeInTheDocument();
    expect(box().value).toBe(CODE);
  });

  it('walks into a folder: the box follows, and the root check reads it', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^repo/ }));
    await waitFor(() => expect(box().value).toBe(REPO));
    expect(await screen.findByText(/3 plans and 2 handoff folders found in/)).toBeInTheDocument();
    expect(
      await screen.findByText('Nothing to browse here: this directory has no sub-directories.'),
    ).toBeInTheDocument();
    expect(openButton()).toBeEnabled();
  });

  it('goes up to the parent, and the box keeps the parent rather than the folder it left', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Parent directory/ }));
    await screen.findByRole('list', { name: `Directories in ${HOME}` });
    expect(box().value).toBe(HOME);
    expect(listingAsked()).toContain(HOME);
  });

  it('goes home: the box shows where the server walked to, not the tilde', async () => {
    mount();
    await screen.findByRole('list', { name: `Directories in ${CODE}` });
    fireEvent.click(screen.getByRole('button', { name: /Home directory/ }));
    await waitFor(() => expect(box().value).toBe(HOME));
    expect(listingAsked()).toContain('~');
  });

  it('says so when a directory cannot be read, and keeps a way home', async () => {
    server.reads['/api/state'] = { ...STATE, root: { path: '/gone', ok: false } };
    mount();
    expect(
      await screen.findByText('This directory could not be read: no such directory'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Home directory/ })).toBeEnabled();
  });
});

describe('the verdict and Open', () => {
  it('a directory that is no source says why, and Open stays off', async () => {
    mount();
    expect(await screen.findByText(`No docs/plans in ${CODE}`)).toBeInTheDocument();
    expect(openButton()).toBeDisabled();
  });

  it('an empty box asks for a directory that holds docs/plans', async () => {
    mount();
    await screen.findByRole('list', { name: `Directories in ${CODE}` });
    fireEvent.change(box(), { target: { value: '' } });
    expect(
      within(screen.getByTestId('source-verdict')).getByText(/Pick a directory that contains/),
    ).toHaveTextContent('Pick a directory that contains docs/plans.');
    expect(openButton()).toBeDisabled();
  });

  it('opens a source: sends its path, and lands on the plans', async () => {
    mount();
    fireEvent.change(box(), { target: { value: REPO } });
    await waitFor(() => expect(openButton()).toBeEnabled());
    fireEvent.click(openButton());
    await waitFor(() => expect(sent(server, 'POST', '/api/root')).toEqual([{ path: REPO }]));
    await waitFor(() => expect(window.location.hash).toBe(plansHref()));
  });

  it('opens on Enter in the box once the verdict allows it', async () => {
    mount();
    fireEvent.change(box(), { target: { value: REPO } });
    await waitFor(() => expect(openButton()).toBeEnabled());
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(sent(server, 'POST', '/api/root')).toEqual([{ path: REPO }]));
  });

  it('shows a refusal in the server’s words — the check’s reason, not a status code', async () => {
    server.reads['POST /api/root'] = new ApiError('Request failed (400)', 400, '/api/root', {
      check: { ok: false, reason: 'docs/plans is not readable' },
    });
    mount();
    fireEvent.change(box(), { target: { value: REPO } });
    await waitFor(() => expect(openButton()).toBeEnabled());
    fireEvent.click(openButton());
    expect(await screen.findByTestId('source-refusal')).toHaveTextContent('docs/plans is not readable');
    expect(window.location.hash).toBe('#/source');
  });
});

describe('the console this is', () => {
  it('a console reading a source says which, and offers the way back', async () => {
    server.reads['/api/state'] = { ...STATE, root: { path: REPO, ok: true, label: 'repo' } };
    mount();
    expect(await screen.findByText('~/code/repo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the console' })).toHaveAttribute('href', runsHref());
  });

  it('a pinned console draws the picker with Open off, and says what to run instead', async () => {
    server.reads['/api/state'] = {
      ...STATE,
      root: { path: REPO, ok: true, label: 'repo' },
      instance: { id: 'abc-repo', name: 'repo', pinned: true },
    };
    mount();
    const pinned = await screen.findByTestId('source-pinned');
    expect(pinned).toHaveTextContent(`This console is pinned to repo (${REPO}).`);
    expect(pinned).toHaveTextContent('run phase-console start in that project');
    await screen.findByText(/3 plans and 2 handoff folders found in/);
    expect(openButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open old' })).toBeDisabled();
  });

  it('opens a recent source in one press', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open old' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/root')).toEqual([{ path: `${HOME}/work/old` }]));
  });
});
