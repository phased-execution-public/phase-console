/**
 * This week (quiet-console phase 26): the question asks `GET /api/report`
 * itself, so its two controls are the request — the window a week at a time
 * (`until`; the server takes the week before it) and the replay (`replay=1`)
 * — and they stay on screen while a new answer is read. A console with no
 * plan directory says so in one line; a window the server refuses says the
 * server's words and offers the last seven days again.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`); every request is logged whole. */
const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as string[] }));
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

import { ApiError } from '@/data/http';
import { queryClientConfig } from '@/data/keys';
import { weekAnswer } from './test-answers';
import { WeekReportPanel } from './week-report';

function mount(everything = false) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WeekReportPanel everything={everything} />
    </QueryClientProvider>,
  );
}

/** The report requests made, each as its query. */
const asked = () =>
  server.calls.filter((path) => path.startsWith('/api/report')).map((path) => path.split('?')[1] ?? '');

const targets = () => screen.findByRole('list', { name: 'The targets, judged on this week' });

beforeEach(() => {
  server.calls = [];
  server.reads = { '/api/report': weekAnswer() };
});

describe('the answer', () => {
  it('names the window it covers, and when the journals were read', async () => {
    mount();
    await targets();
    const times = [...screen.getByTestId('insights-week').querySelectorAll('time')].map((t) =>
      t.getAttribute('dateTime'),
    );
    expect(times.slice(0, 2)).toEqual(['2026-10-04T09:00:00.000Z', '2026-10-11T09:00:00.000Z']);
    expect(screen.getByTestId('week-read')).not.toHaveTextContent('remembered');
    // The page asks for the week before now, and nothing else.
    expect(asked()).toEqual(['']);
  });

  it('a replayed answer says which models it re-derived; a remembered one says so', async () => {
    server.reads['/api/report'] = weekAnswer({ replay: ['streak', 'spend', 'eta', 'holder'], cached: true });
    mount();
    await targets();
    expect(screen.getByTestId('insights-week')).toHaveTextContent(
      'replayed with today’s streak, spend, eta, holder models.',
    );
    expect(screen.getByTestId('week-read')).toHaveTextContent('remembered from the same question');
  });
});

describe('the controls are the request', () => {
  it('Replay asks again with replay=1, and the window stays where it was', async () => {
    mount();
    await targets();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Replay with today’s models' }));
    await waitFor(() => expect(asked()).toEqual(['', 'replay=1']));
    expect(screen.getByRole('combobox', { name: 'The week to report on' })).toHaveValue('0');
  });

  it('an earlier week asks with an until a week back, and its own answer is read', async () => {
    const before = Date.now();
    mount();
    await targets();
    fireEvent.change(screen.getByRole('combobox', { name: 'The week to report on' }), {
      target: { value: '1' },
    });
    await waitFor(() => expect(asked()).toHaveLength(2));
    const until = new URLSearchParams(asked()[1]).get('until');
    const back = before - Date.parse(until!);
    expect(back).toBeGreaterThanOrEqual(7 * 86_400_000 - 60_000);
    expect(back).toBeLessThanOrEqual(7 * 86_400_000 + 60_000);
    // No since: the server takes the week before until.
    expect(new URLSearchParams(asked()[1]).has('since')).toBe(false);
  });

  it('holds the answer busy while a new one is read, and never the controls', async () => {
    mount();
    await targets();
    server.reads['/api/report'] = () => new Promise(() => {});
    fireEvent.click(screen.getByRole('checkbox', { name: 'Replay with today’s models' }));
    const week = screen.getByTestId('insights-week');
    await waitFor(() => expect(week.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(within(week).getByRole('checkbox', { name: 'Replay with today’s models' })).toBeChecked();
    expect(within(week).queryByRole('list', { name: 'The targets, judged on this week' })).toBeNull();
  });
});

describe('refusals', () => {
  it('no plan directory is one line and the way to open one', async () => {
    server.reads['/api/report'] = new ApiError('No source directory is open.', 409, '/api/report');
    mount();
    expect(
      await screen.findByText('No plan directory is open, so there are no runs to report on.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a source directory' })).toHaveAttribute(
      'href',
      '#/source',
    );
  });

  it('a window the server refuses is its words, and the last seven days are one press away', async () => {
    mount();
    await targets();
    server.reads['/api/report'] = new ApiError('since must come before until', 400, '/api/report');
    fireEvent.change(screen.getByRole('combobox', { name: 'The week to report on' }), {
      target: { value: '2' },
    });
    expect(
      await screen.findByText('The week could not be read: since must come before until'),
    ).toBeInTheDocument();
    server.reads['/api/report'] = weekAnswer();
    fireEvent.click(screen.getByRole('button', { name: 'Show the last seven days' }));
    await targets();
    expect(screen.getByRole('combobox', { name: 'The week to report on' })).toHaveValue('0');
  });

  it('any other failure is the server’s words and Try again', async () => {
    server.reads['/api/report'] = new ApiError('the journals could not be read', 500, '/api/report');
    mount();
    expect(
      await screen.findByText('The week could not be read: the journals could not be read'),
    ).toBeInTheDocument();
    server.reads['/api/report'] = weekAnswer();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await targets()).toBeInTheDocument();
  });
});

describe('Everything', () => {
  it('names the CLI line the same fold prints through', async () => {
    mount(true);
    await targets();
    expect(screen.getByTestId('insights-week')).toHaveTextContent(
      'phase-console report --since <iso> --until <iso> --replay',
    );
  });
});
