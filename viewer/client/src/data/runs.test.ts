/**
 * What a run's readers ask the server for.
 *
 * READING: `/api/runs` is every run's WHOLE record — megabytes on a console
 * with history (#234), re-read on every phase event. A list needs one word per
 * phase and a strip needs one plan's newest run, so each has a projection of
 * its own; only the open run is read whole. The failure this prevents is
 * quiet: a list built on the whole record works, and slows every tab a little
 * more with each run the console keeps.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_LIST, useRun, useRunList, useRunStrip, useRuns } from './runs';
import { keys } from './keys';

let asked: string[] = [];

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(url.includes('/api/run/') ? '{"run":null}' : '[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a run is read through the projection its reader needs (#234)', () => {
  it('a list reads the slim projection — one word per phase, never the whole record', async () => {
    const { result } = renderHook(() => useRunList(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(asked).toEqual(['/api/runs?view=slim']);
  });

  it("a strip reads one plan's newest run, slim", async () => {
    const { result } = renderHook(() => useRunStrip('demo plan'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(asked).toEqual(['/api/runs?latest=1&slug=demo%20plan']);
    // A plan that never ran is null, not an empty list.
    expect(result.current.data).toBeNull();
  });

  it('only the open run is read whole', async () => {
    const { result } = renderHook(() => useRun('demo'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(asked).toEqual(['/api/run/demo']);
  });

  it('a strip with no plan asks nothing', () => {
    renderHook(() => useRunStrip(undefined), { wrapper });
    expect(asked).toEqual([]);
  });

  it('the whole list is still read whole by the 6.2 pages, until their phases rebuild them', async () => {
    const { result } = renderHook(() => useRuns(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(asked).toEqual(['/api/runs']);
  });

  it('has one reader left — the quota plan of a plan and a run (phase 22, Pro) — and neither the home nor the library is among them', () => {
    // The home read the whole list until 7.0's own (quiet-console phase 7),
    // which folds its groups from the slim list, and the plans library until
    // phase 9, which joins each plan's newest run from it. Counted from the source, so
    // a new reader of the whole record cannot arrive quietly — comments
    // stripped, because a module header may name the hook it does not call.
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
      }
      return out;
    };
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const readers = walk(SRC)
      .filter((path) => /\buseRuns\(/.test(code(readFileSync(path, 'utf8'))))
      .map((path) => relative(SRC, path))
      .sort();
    expect(readers).toEqual([
      'data/runs.ts',
    ]);
  });

  it('keeps both projections under the runs prefix, so every event that re-reads the list re-reads them', () => {
    expect(RUN_LIST.slice(0, 1)).toEqual(keys.runs());
  });
});
