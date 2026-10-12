/**
 * The owner door, answered once for every press.
 *
 * READING: a console with an owner key answers a press that a door may not make
 * with 202 — a 2xx — and the request it wrote down. A page that reads every 2xx
 * as done tells a person their press happened when it is waiting on the owner.
 * The other two answers are the same kind of quiet: a 401 that only needed the
 * key touched read as a failure, and a 403 or a 400 that named the door or the
 * rule read as a sentence and nothing more.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { signInAsOwner } = vi.hoisted(() => ({ signInAsOwner: vi.fn(async () => ({ fresh: true })) }));
vi.mock('./owner', () => ({ signInAsOwner }));

import { ApiError, request } from './http';
import { PressRefusal, press } from './press';

let answers: [number, unknown][] = [];
let calls = 0;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A press of one route, answered by the next scripted answer each time it is made. */
const pause = () => request<unknown>('/api/run/demo/pause', { method: 'POST', body: '{}' });

const REQUEST = {
  id: 'req-1',
  press: 'pause',
  method: 'POST',
  path: '/api/run/demo/pause',
  body: {},
  ask: 'asked by the phone through device — pause demo — confirm?',
};

beforeEach(() => {
  answers = [];
  calls = 0;
  signInAsOwner.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const [status, body] = answers[Math.min(calls++, answers.length - 1)]!;
      return json(status, body);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('press()', () => {
  it('a press the route made is done, with its answer', async () => {
    answers = [[200, { ok: true, status: 'paused' }]];
    await expect(press(pause)).resolves.toEqual({ state: 'done', result: { ok: true, status: 'paused' } });
    expect(calls).toBe(1);
  });

  it('a 202 the owner must confirm is asked — never done — with the request the owner will see', async () => {
    const words = "This console has an owner key, so this press — pause — is the owner's.";
    answers = [[202, { requested: true, request: REQUEST, error: words }]];
    await expect(press(pause)).resolves.toEqual({ state: 'asked', request: REQUEST, words });
    // Asked once: a request is not a failure to retry.
    expect(calls).toBe(1);
  });

  it('a 401 {reassert} touches the owner key, then presses once more', async () => {
    answers = [
      [401, { error: 'Pause carries high risk: touch your owner key again.', reassert: true }],
      [200, { ok: true }],
    ];
    const touch = vi.fn(async () => undefined);
    await expect(press(pause, { touch })).resolves.toEqual({ state: 'done', result: { ok: true } });
    expect(touch).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it('the touch is the passkey ceremony unless a caller says otherwise — fetched only when a press asks for it', async () => {
    answers = [
      [401, { error: 'touch your owner key again', reassert: true }],
      [200, { ok: true }],
    ];
    await press(pause);
    expect(signInAsOwner).toHaveBeenCalledTimes(1);
  });

  it('a second 401 is the server’s answer: one touch, two presses, then the refusal', async () => {
    answers = [[401, { error: 'touch your owner key again', reassert: true }]];
    const touch = vi.fn(async () => undefined);
    const pressed = press(pause, { touch });
    await expect(pressed).rejects.toBeInstanceOf(ApiError);
    await expect(pressed).rejects.toMatchObject({ status: 401 });
    expect(touch).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it('a 401 that does not ask for a touch is not retried', async () => {
    answers = [[401, { error: 'Sign in through the proxy.' }]];
    const touch = vi.fn(async () => undefined);
    await expect(press(pause, { touch })).rejects.toMatchObject({ status: 401 });
    expect(touch).not.toHaveBeenCalled();
    expect(calls).toBe(1);
  });

  it('a 403 names the door that pressed', async () => {
    answers = [[403, { error: 'the device door presses nothing here', door: 'device', press: 'pause' }]];
    const refused = await press(pause).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(PressRefusal);
    expect(refused).toMatchObject({
      status: 403,
      door: 'device',
      message: 'the device door presses nothing here',
    });
  });

  it('a 400 names the rules a policy write broke, in either of the server’s two spellings', async () => {
    answers = [[400, { error: 'A rule would never match.', rules: ['Bash(gti push:*)'] }]];
    await expect(press(pause)).rejects.toMatchObject({
      status: 400,
      rules: ['Bash(gti push:*)'],
      door: null,
    });
    answers = [[400, { error: 'A rule would never match.', rule: 'Bash(gti push:*)' }]];
    calls = 0;
    await expect(press(pause)).rejects.toMatchObject({ rules: ['Bash(gti push:*)'] });
  });

  it('any other refusal is the request’s own error, unwrapped', async () => {
    answers = [[409, { error: 'A session is already working on that phase.', session: 's-1' }]];
    const refused = await press(pause).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).not.toBeInstanceOf(PressRefusal);
    expect(refused).toMatchObject({ status: 409, body: { session: 's-1' } });
  });
});
