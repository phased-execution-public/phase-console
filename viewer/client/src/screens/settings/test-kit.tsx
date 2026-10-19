/**
 * The Settings tests' one harness (quiet-console phase 21): a fixture server
 * behind `@/data/http`, a schema built from the shared table, and a render
 * with a query client of its own.
 *
 * A test file declares the server and the mock itself — `vi.mock` is hoisted
 * above the file's imports, so the factory must name a hoisted value:
 *
 * ```ts
 * const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
 * vi.mock('@/data/http', async (importOriginal) =>
 *   (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
 * );
 * ```
 *
 * The factory imports this file, so this file imports nothing under `@/data/`
 * but types: a value import from there reaches `@/data/http`, whose mock is
 * the one being built, and the test waits on itself with no output.
 *
 * `server.reads` answers by `GET` path (`/api/state`) or `METHOD path`
 * (`POST /api/prefs`): a value, a function of the body (and the full path, its
 * query included), or an Error to throw.
 * `server.calls` records every request, so a test asserts what was SENT — the
 * wire is the contract a setting keeps with the server.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { PREF_META, PROFILE_META } from '@shared/prefs-model.js';
import type { PrefSchemaRow, PrefsSchemaAnswer } from '@/data/console';
import type * as Http from '@/data/http';

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

export interface FixtureServer {
  reads: Record<string, unknown>;
  calls: Call[];
}

/** The module `vi.mock('@/data/http', …)` returns: the real one, with `request` and `post` answered from `server`. */
export function fixtureHttp(actual: typeof Http, server: FixtureServer): typeof Http {
  const answer = async (method: string, path: string, body?: unknown) => {
    server.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const bare = path.split('?')[0]!;
    const read = server.reads[method === 'GET' ? bare : `${method} ${bare}`];
    if (read instanceof Error) throw read;
    if (typeof read === 'function') return (read as (body?: unknown, path?: string) => unknown)(body, path);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${method} ${path}`, 404, path);
  };
  return {
    ...actual,
    request: ((path: string, options: RequestInit = {}) =>
      answer(
        options.method ?? 'GET',
        path,
        typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
      )) as typeof actual.request,
    post: ((path: string, body?: unknown) => answer('POST', path, body)) as typeof actual.post,
  };
}

/** The calls a test made to one route, bodies only. */
export const sent = (server: FixtureServer, method: string, path: string): unknown[] =>
  server.calls
    .filter((call) => call.method === method && call.path.split('?')[0] === path)
    .map((call) => call.body);

/**
 * The schema as the server would answer it with nothing stored: every key of
 * the shared table at its default, then `overrides` per key — a value, a
 * default, a source. The shipped defaults live on the server, so a test that
 * cares about one names it.
 */
export function schemaAnswer(overrides: Record<string, Partial<PrefSchemaRow>> = {}): PrefsSchemaAnswer {
  const rows: PrefSchemaRow[] = [
    ...Object.entries(PREF_META).map(([key, meta]) => ({
      key,
      group: meta.group,
      type: meta.type,
      ...(meta.words ? { words: meta.words } : {}),
      ...(meta.unit ? { unit: meta.unit } : {}),
      description: meta.description,
      writable: meta.writable,
      ...(meta.secret ? { secret: true } : {}),
      value: null,
      source: 'default' as const,
      cli: meta.cli ?? null,
    })),
    ...Object.entries(PROFILE_META).map(([key, meta]) => ({
      key: `profile.${key}`,
      group: meta.group,
      type: meta.type,
      ...(meta.words ? { words: meta.words } : {}),
      ...(meta.unit ? { unit: meta.unit } : {}),
      description: meta.description,
      writable: false,
      ...(meta.secret ? { secret: true } : {}),
      value: null,
      source: 'default' as const,
      cli: `phase-console profile set ${key} <json>`,
    })),
  ].map((row) => ({ ...row, ...(overrides[row.key] ?? {}) }));
  const unknown = Object.keys(overrides).filter((key) => !rows.some((one) => one.key === key));
  if (unknown.length) throw new Error(`schemaAnswer: the shared table has no ${unknown.join(', ')}`);
  return {
    files: {
      instance: '/home/x/.local/state/phase-console/instances/abc-repo.json',
      config: '/home/x/.config/phase-console/config.json',
      profile: '/home/x/.config/phase-console/fleet.json',
    },
    rows,
  };
}

/**
 * A query client on the console's own contract (`data/keys.ts`
 * `queryClientConfig`: nothing refetches on a timer or a focus — the stream
 * invalidates), except that it never retries, so a failed read fails the test
 * at once. Spelled here rather than imported: this module must reach nothing
 * under `@/data/` at its top, or the mock factory that imports it waits on the
 * very module it is building — a test that hangs with no output.
 */
export function testClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchInterval: false,
        retry: false,
      },
    },
  });
}

/** Render with a client of its own; the client is returned for a test that reads the cache. */
export function renderWithClient(ui: ReactElement, client: QueryClient = testClient()) {
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}
