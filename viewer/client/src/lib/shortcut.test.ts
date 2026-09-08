/**
 * The two guards every window-level chord needs, and the hook that applies them.
 *
 * What these hold: a bare key never fires while a person is typing and never
 * fires with a modifier held; `mod` means ⌘ OR Ctrl, except that Ctrl inside a
 * pty belongs to the pty (Ctrl-K is kill-to-end-of-line in every shell, and a
 * window listener that swallows it makes the console's own terminal the one
 * place its own shortcut is unusable); a chord marked `whileTyping` is the way
 * OUT of a field and fires there; and the listener is removed on unmount, so a
 * closed overlay does not keep claiming the key.
 */

import { act, render } from '@testing-library/react';
import { createElement, useCallback } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { inTerminal, isTypingTarget, useShortcut, type Chord } from './shortcut';

/** A host that claims the chords and records every fire. */
function harness(chords: Chord | readonly Chord[], onFire: () => void, enabled = true) {
  function Host() {
    const handler = useCallback(() => onFire(), []);
    useShortcut(chords, handler, { enabled });
    return null;
  }
  return render(createElement(Host));
}

/** Dispatch on `window`, from a target of the caller's choosing. */
const press = (init: KeyboardEventInit & { target?: Element }) => {
  const { target, ...rest } = init;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...rest });
  act(() => {
    (target ?? window).dispatchEvent(event);
  });
  return event;
};

describe('isTypingTarget', () => {
  it('names the three fields that own their keys', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTypingTarget(document.createElement(tag)), tag).toBe(true);
    }
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('reads contentEditable as a boolean, never as jsdom’s undefined', () => {
    const div = document.createElement('div');
    // jsdom leaves `isContentEditable` undefined; the guard must answer false
    // rather than pass an undefined on to a caller expecting a boolean.
    expect(isTypingTarget(div)).toBe(false);
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isTypingTarget(div)).toBe(true);
  });
});

describe('inTerminal', () => {
  it('is true anywhere inside a pty, false outside one', () => {
    const term = document.createElement('div');
    term.className = 'phase-term';
    const inner = document.createElement('span');
    term.append(inner);
    document.body.append(term);
    expect(inTerminal(inner)).toBe(true);
    expect(inTerminal(document.body)).toBe(false);
    term.remove();
  });
});

describe('useShortcut', () => {
  it('fires a bare key, and prevents the browser’s own default', () => {
    const fire = vi.fn();
    harness({ key: '/' }, fire);
    const event = press({ key: '/' });
    expect(fire).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('a bare key stays out of a field, and out of a modified keystroke', () => {
    const fire = vi.fn();
    harness({ key: '/' }, fire);
    const input = document.createElement('input');
    document.body.append(input);
    press({ key: '/', target: input });
    press({ key: '/', metaKey: true });
    press({ key: '/', ctrlKey: true });
    press({ key: '/', altKey: true });
    expect(fire).not.toHaveBeenCalled();
    input.remove();
  });

  it('`mod` accepts ⌘ or Ctrl, and is case-insensitive on the key', () => {
    const fire = vi.fn();
    harness({ key: 'k', mod: true, whileTyping: true }, fire);
    press({ key: 'k', metaKey: true });
    press({ key: 'K', ctrlKey: true });
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('`whileTyping` is what lets a chord be the way OUT of a field', () => {
    const out = vi.fn();
    const stuck = vi.fn();
    harness({ key: 'k', mod: true, whileTyping: true }, out);
    harness({ key: 'k', mod: true }, stuck);
    const input = document.createElement('input');
    document.body.append(input);
    press({ key: 'k', metaKey: true, target: input });
    expect(out).toHaveBeenCalledTimes(1);
    expect(stuck).not.toHaveBeenCalled();
    input.remove();
  });

  it('leaves Ctrl to the pty, and keeps ⌘ working inside one', () => {
    const fire = vi.fn();
    harness({ key: 'k', mod: true, whileTyping: true }, fire);
    const term = document.createElement('div');
    term.className = 'phase-term';
    document.body.append(term);
    press({ key: 'k', ctrlKey: true, target: term });
    expect(fire, 'Ctrl-K belongs to the shell').not.toHaveBeenCalled();
    press({ key: 'k', metaKey: true, target: term });
    expect(fire, '⌘K is not a terminal chord on any platform').toHaveBeenCalledTimes(1);
    term.remove();
  });

  it('claims several chords at once', () => {
    const fire = vi.fn();
    harness([{ key: 'k', mod: true, whileTyping: true }, { key: '/' }], fire);
    press({ key: 'k', metaKey: true });
    press({ key: '/' });
    press({ key: 'j' });
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('claims nothing while disabled, and gives the key back on unmount', () => {
    const off = vi.fn();
    harness({ key: '/' }, off, false);
    press({ key: '/' });
    expect(off).not.toHaveBeenCalled();

    const on = vi.fn();
    const view = harness({ key: '/' }, on);
    press({ key: '/' });
    expect(on).toHaveBeenCalledTimes(1);
    view.unmount();
    press({ key: '/' });
    expect(on).toHaveBeenCalledTimes(1);
  });
});
