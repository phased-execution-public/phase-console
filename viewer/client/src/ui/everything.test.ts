/**
 * Everything — the third door's switch (quiet-console phase 6, exit criterion
 * 4): it persists per page id, and it is announced to assistive technology.
 *
 * Persisted: `prefs.everything` (`EVERYTHING_PREF`) is page id → on, only a
 * `true` is ever stored, two pages never share an answer, and the answer
 * survives a remount. Announced: the switch is a real switch (`role="switch"`,
 * its state in `aria-checked`), and once pressed a polite status sentence says
 * what the page now shows — from a live region drawn empty beforehand, because
 * a region that appears with its words in it is not announced.
 *
 * No JSX here (a `.ts` file): the switch is created with `createElement`.
 */

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PREF_DEFAULTS, getPrefs, setPrefs } from '@/lib/prefs';
import { expectNoAxeViolations } from '@/test/axe';
import { EVERYTHING_PREF, everythingSaid, useEverything } from './everything';
import { EverythingSwitch } from './toolbar';

beforeEach(() => {
  setPrefs({ [EVERYTHING_PREF]: {} });
});

describe('the preference', () => {
  it('is one key, everything, holding nothing until a page is switched', () => {
    expect(EVERYTHING_PREF).toBe('everything');
    expect(PREF_DEFAULTS[EVERYTHING_PREF]).toEqual({});
  });
});

describe('useEverything — per page id, across visits', () => {
  it('starts off, and on is stored under the page id alone', () => {
    const { result } = renderHook(() => useEverything('runs'));
    expect(result.current.on).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.on).toBe(true);
    expect(getPrefs()[EVERYTHING_PREF]).toEqual({ runs: true });
  });

  it('never lends one page’s answer to another', () => {
    const runs = renderHook(() => useEverything('runs'));
    const plans = renderHook(() => useEverything('plans'));
    act(() => runs.result.current.toggle());
    expect(runs.result.current.on).toBe(true);
    expect(plans.result.current.on).toBe(false);
  });

  it('survives a remount — the next visit opens as the last one left it', () => {
    const first = renderHook(() => useEverything('sessions'));
    act(() => first.result.current.toggle());
    first.unmount();
    expect(renderHook(() => useEverything('sessions')).result.current.on).toBe(true);
  });

  it('switched back, leaves nothing behind', () => {
    const { result } = renderHook(() => useEverything('repo'));
    act(() => result.current.toggle());
    act(() => result.current.toggle());
    expect(result.current.on).toBe(false);
    expect(getPrefs()[EVERYTHING_PREF]).toEqual({});
  });

  it('two switches in one tick do not undo each other', () => {
    const runs = renderHook(() => useEverything('runs'));
    const logs = renderHook(() => useEverything('logs'));
    act(() => {
      runs.result.current.toggle();
      logs.result.current.toggle();
    });
    expect(getPrefs()[EVERYTHING_PREF]).toEqual({ runs: true, logs: true });
  });
});

describe('EverythingSwitch — announced', () => {
  function Harness({ page, hint }: { page: string; hint?: boolean }) {
    const everything = useEverything(page);
    return createElement(EverythingSwitch, { everything, ...(hint ? { hint } : {}) });
  }

  it('is a real switch whose state is its aria-checked', () => {
    render(createElement(Harness, { page: 'runs' }));
    const control = screen.getByRole('switch', { name: 'Everything' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(control);
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(getPrefs()[EVERYTHING_PREF]).toEqual({ runs: true });
  });

  it('says what the page now shows, from a live region that was there before it spoke', () => {
    render(createElement(Harness, { page: 'runs' }));
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    expect(status).toHaveTextContent(everythingSaid(true));
    expect(status).toHaveTextContent('Showing everything: every column, fact and section.');
    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    expect(status).toHaveTextContent('Showing the essentials.');
  });

  it('opens on the stored answer, and says nothing until it is pressed', () => {
    setPrefs({ [EVERYTHING_PREF]: { plans: true } });
    render(createElement(Harness, { page: 'plans' }));
    expect(screen.getByRole('switch', { name: 'Everything' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('with a hint, is described by it — and has no axe violation', async () => {
    const { container } = render(createElement(Harness, { page: 'runs', hint: true }));
    expect(screen.getByRole('switch', { name: 'Everything' })).toHaveAccessibleDescription(
      'Every column, fact and section, not only the essentials.',
    );
    await expectNoAxeViolations(container);
  });
});
