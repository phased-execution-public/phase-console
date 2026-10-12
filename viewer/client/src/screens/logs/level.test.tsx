/**
 * The log level card (Logs ▸ Logs, quiet-console phase 20): how loud this
 * console's own log is, in one sentence, and turning it up for a while.
 *
 * What it holds: the sentence is the SERVER's state — the configured level and
 * channels, or a change made here with the moment it reverts; Revert now is
 * offered only while a change stands, and it is the `DELETE`; the form starts
 * from what the server says now and posts exactly the three fields the server
 * reads; the card then draws the server's answer, never what was asked; and a
 * refusal says so in the server's own words.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The server, by method and path: `'POST /api/debug/level'` answers a POST,
 * a bare path answers a GET; a function answers each ask itself, an `Error`
 * is thrown. Every request is logged with its method and body.
 */
const server = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  calls: [] as { method: string; path: string; body?: unknown }[],
}));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (method: string, path: string, body?: unknown) => {
    server.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const bare = path.split('?')[0]!;
    const read = server.reads[method === 'GET' ? bare : `${method} ${bare}`];
    if (read instanceof Error) throw read;
    if (typeof read === 'function') return (read as (body?: unknown) => unknown)(body);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${method} ${path}`, 404, path);
  };
  return {
    ...actual,
    request: (path: string, options: RequestInit = {}) => answer(options.method ?? 'GET', path),
    post: (path: string, body?: unknown) => answer('POST', path, body),
  };
});

import type { DebugLevelState } from '@/data/api';
import { ApiError } from '@/data/http';
import { queryClientConfig } from '@/data/keys';
import { LEVEL_TTLS, LevelCard, channelsWords, levelSentence } from './level';

const LEVELS = ['debug', 'info', 'warn', 'error'];
/** When a change made here reverts: an epoch, as the server sends it. */
const UNTIL = Date.parse('2026-10-10T14:30:00.000Z');

const ENV: DebugLevelState = { level: 'info', debug: '', source: 'env', levels: LEVELS };
const OVERRIDE: DebugLevelState = {
  level: 'debug',
  debug: '*',
  source: 'override',
  until: UNTIL,
  levels: LEVELS,
};

/** The clock the card draws a revert time in — the reader's own. */
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function mount() {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LevelCard />
    </QueryClientProvider>,
  );
}

const sentence = () => screen.findByTestId('log-level-state');
const writes = () => server.calls.filter((call) => call.method !== 'GET');

/** Unfold the form — the Disclosure unmounts it while folded. */
async function openForm() {
  fireEvent.click(await screen.findByRole('button', { name: 'Change the level' }));
  return {
    level: screen.getByLabelText('Level') as HTMLSelectElement,
    channels: screen.getByLabelText('Debug channels') as HTMLInputElement,
    ttl: screen.getByLabelText('For') as HTMLSelectElement,
  };
}

beforeEach(() => {
  server.calls = [];
  server.reads = { '/api/debug/level': ENV };
});

describe('the sentence is the server’s state', () => {
  it('the configured level says so, and offers nothing to revert', async () => {
    mount();
    expect(await sentence()).toHaveTextContent('Info, as configured.');
    expect(screen.queryByRole('button', { name: 'Revert now' })).toBeNull();
  });

  it('names the channels a configured debug spec turns on', async () => {
    server.reads['/api/debug/level'] = { ...ENV, level: 'warn', debug: 'git, runner' };
    mount();
    expect(await sentence()).toHaveTextContent('Warn, with the git, runner channels on, as configured.');
  });

  it('a change made here says so, says when it reverts, and offers Revert now', async () => {
    server.reads['/api/debug/level'] = OVERRIDE;
    mount();
    expect(await sentence()).toHaveTextContent(
      `Debug, with every debug channel on, changed here; it reverts at ${clock(UNTIL)}.`,
    );
    expect(screen.getByRole('button', { name: 'Revert now' })).toBeEnabled();
  });

  it('says so when the level could not be read, rather than drawing a level', async () => {
    server.reads['/api/debug/level'] = new ApiError('the log is not answering', 503, '/api/debug/level');
    mount();
    expect(await screen.findByTestId('log-level')).toHaveTextContent(
      'The log level could not be read: the log is not answering',
    );
    expect(screen.queryByTestId('log-level-state')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change the level' })).toBeNull();
  });

  it('words the channels: none, one, several, and * for every one', () => {
    expect(channelsWords(undefined)).toBeNull();
    expect(channelsWords(null)).toBeNull();
    expect(channelsWords(' , ')).toBeNull();
    expect(channelsWords('git')).toBe('the git channel on');
    expect(channelsWords('git,runner')).toBe('the git, runner channels on');
    expect(channelsWords('git runner')).toBe('the git, runner channels on');
    expect(channelsWords('*')).toBe('every debug channel on');
    expect(channelsWords('git, *')).toBe('every debug channel on');
    expect(levelSentence({ ...ENV, level: 'error', debug: 'git' })).toBe(
      'Error, with the git channel on, as configured.',
    );
  });
});

describe('Revert now', () => {
  it('is the DELETE, and the card then reads what the server answered', async () => {
    server.reads['/api/debug/level'] = OVERRIDE;
    server.reads['DELETE /api/debug/level'] = ENV;
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Revert now' }));
    await waitFor(() => expect(writes()).toEqual([{ method: 'DELETE', path: '/api/debug/level' }]));
    expect(await sentence()).toHaveTextContent('Info, as configured.');
    expect(screen.queryByRole('button', { name: 'Revert now' })).toBeNull();
  });
});

describe('Change the level', () => {
  it('is folded until asked, and opens on what the server says now', async () => {
    server.reads['/api/debug/level'] = { ...ENV, level: 'warn', debug: 'git' };
    mount();
    await sentence();
    expect(screen.queryByLabelText('Level')).toBeNull();
    const form = await openForm();
    expect(form.level.value).toBe('warn');
    expect([...form.level.options].map((o) => o.textContent)).toEqual(['Debug', 'Info', 'Warn', 'Error']);
    expect(form.channels.value).toBe('git');
    expect(Number(form.ttl.value)).toBe(30 * 60_000);
  });

  it('offers no change that outlives a day, which the server refuses', async () => {
    mount();
    const form = await openForm();
    expect([...form.ttl.options].map((o) => o.textContent)).toEqual(LEVEL_TTLS.map((ttl) => ttl.label));
    for (const ttl of LEVEL_TTLS) expect(ttl.ms).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it('posts exactly the level, the channels and the life — and then draws the answer, not the ask', async () => {
    // The server keeps only one of the two channels asked for: the card must
    // say what it did, not what it was asked.
    server.reads['POST /api/debug/level'] = { ...OVERRIDE, debug: 'git' };
    mount();
    const form = await openForm();
    fireEvent.change(form.level, { target: { value: 'debug' } });
    fireEvent.change(form.channels, { target: { value: '  git, runner  ' } });
    fireEvent.change(form.ttl, { target: { value: String(2 * 60 * 60_000) } });
    fireEvent.click(screen.getByRole('button', { name: 'Change the level' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'POST',
      path: '/api/debug/level',
      body: { level: 'debug', debug: 'git, runner', ttlMs: 2 * 60 * 60_000 },
    });
    await waitFor(() =>
      expect(screen.getByTestId('log-level-state')).toHaveTextContent(
        `Debug, with the git channel on, changed here; it reverts at ${clock(UNTIL)}.`,
      ),
    );
    // Done: the form folds, and Revert now is offered for the change that stands.
    expect(screen.getByRole('button', { name: 'Change the level' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Revert now' })).toBeInTheDocument();
  });

  it('sends the channels it opened on when only the level moves, and the default life', async () => {
    server.reads['/api/debug/level'] = { ...ENV, debug: 'runner' };
    server.reads['POST /api/debug/level'] = { ...OVERRIDE, debug: 'runner' };
    mount();
    const form = await openForm();
    fireEvent.change(form.level, { target: { value: 'warn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change the level' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({ level: 'warn', debug: 'runner', ttlMs: 30 * 60_000 });
  });

  it('a refusal says so in the server’s words, and the card keeps the state the server holds', async () => {
    server.reads['POST /api/debug/level'] = new ApiError(
      'unknown log level "loud" — one of debug, info, warn, error',
      400,
      '/api/debug/level',
    );
    mount();
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Change the level' }));
    expect(
      await screen.findByText(
        'The level did not change: unknown log level "loud" — one of debug, info, warn, error',
      ),
    ).toBeInTheDocument();
    expect(await sentence()).toHaveTextContent('Info, as configured.');
    // The form stays open on what was typed, so it can be put right.
    expect(screen.getByLabelText('Level')).toBeInTheDocument();
  });
});
