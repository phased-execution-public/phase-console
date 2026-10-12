/**
 * The operator's verbs, as the page presses them.
 *
 * READING: the CLI, the routes and the stored triggers read one table of verbs
 * (`shared/verb-model.js`); a page that spelled a verb's route itself would be
 * a fourth reader that drifts. These cases hold the page to the table: every
 * row fills, a missing placeholder is refused before anything is sent, a press
 * carries exactly the body it was given, and the line a page hands a person to
 * paste is the CLI's own spelling of the row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_VERBS } from '@shared/verb-model.js';
import { pressVerb, verbLine, verbRoute } from './verbs';

let sent: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verbRoute', () => {
  it('fills every placeholder of every verb in the table', () => {
    for (const row of OPERATOR_VERBS) {
      const { method, path } = verbRoute(row.name, { slug: 'a plan', phase: 4, id: 'x/1', n: 4 });
      expect(row.route.startsWith(`${method} `), row.name).toBe(true);
      expect(path, row.name).not.toMatch(/:[a-z]/);
    }
  });

  it('escapes what it fills', () => {
    expect(verbRoute('pause', { slug: 'a plan' })).toEqual({
      method: 'POST',
      path: '/api/run/a%20plan/pause',
    });
    expect(verbRoute('cancel-trigger', { slug: 'cart', id: 't/1' }).path).toBe(
      '/api/run/cart/triggers/t%2F1/cancel',
    );
    expect(verbRoute('errand-answered', { slug: 'cart', n: 3 }).path).toBe(
      '/api/run/cart/phase/3/errand-answered',
    );
  });

  it('refuses a verb the table does not hold, and a placeholder with no value', () => {
    expect(() => verbRoute('detonate', { slug: 'cart' })).toThrow('No operator verb is called detonate.');
    expect(() => verbRoute('pause')).toThrow('The pause verb needs its slug.');
    expect(() => verbRoute('tail', { slug: 'cart' })).toThrow('The tail verb needs its phase.');
  });
});

describe('pressVerb', () => {
  it('presses an act with its body, as JSON', async () => {
    await expect(pressVerb('pause', { slug: 'cart' }, { reason: 'lunch' })).resolves.toEqual({
      state: 'done',
      result: { ok: true },
    });
    expect(sent).toEqual([{ url: '/api/run/cart/pause', method: 'POST', body: { reason: 'lunch' } }]);
  });

  it('asks a read with its arguments in the query, and leaves out what is not given', async () => {
    await pressVerb('journal', { slug: 'cart' }, { limit: 20, since: undefined });
    expect(sent).toEqual([{ url: '/api/run/cart/journal?limit=20', method: 'GET', body: undefined }]);
    await pressVerb('queue');
    expect(sent[1]).toEqual({ url: '/api/queue', method: 'GET', body: undefined });
  });
});

describe('verbLine', () => {
  it('spells every row the CLI has a shape for, and none it has not', () => {
    for (const row of OPERATOR_VERBS) {
      const line = verbLine(row.name);
      if (!row.cli) {
        expect(line, row.name).toBeNull();
        continue;
      }
      expect(line, row.name).toBe(
        ['phase-console', 'run', row.name, ...row.cli.args.map((arg) => `<${arg}>`)].join(' '),
      );
    }
  });

  it('writes what it is given: the positionals in order, a flag by its body field', () => {
    expect(verbLine('retry', { slug: 'cart', phase: 4 })).toBe('phase-console run retry cart 4');
    expect(verbLine('steer', { slug: 'cart', phase: 4, instruction: 'stop at the API' })).toBe(
      "phase-console run steer cart 4 --text 'stop at the API'",
    );
    expect(verbLine('switch-account', { slug: 'cart' })).toBe(
      'phase-console run switch-account cart <accountId>',
    );
  });

  it('spells a flag it is not given as its placeholder only when asked to', () => {
    expect(verbLine('wait', { slug: 'cart' }, { '--for': 'predicate' })).toBe(
      'phase-console run wait cart --for <predicate>',
    );
    expect(verbLine('wait', { slug: 'cart' })).toBe('phase-console run wait cart');
  });

  it('quotes a word a shell would split or expand, and nothing else', () => {
    expect(verbLine('note', { slug: 'cart', text: "it's $HOME" })).toBe(
      `phase-console run note cart --text 'it'\\''s $HOME'`,
    );
    expect(verbLine('cancel-trigger', { slug: 'cart', id: 'trg_1.2-x' })).toBe(
      'phase-console run cancel-trigger cart trg_1.2-x',
    );
  });
});
