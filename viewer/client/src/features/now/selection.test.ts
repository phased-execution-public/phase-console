/**
 * Selecting many.
 *
 * What these tests hold: a selection is a set of IDS, so a refetch that
 * reorders the list cannot move it onto other rows; it prunes to what is on
 * screen, so a count can never disagree with the rows under it; a shift-press
 * adds a run and never removes one; and the bar offers only the verbs EVERY
 * picked item can do — a bulk button that works on nine of twelve reports
 * success while three asks stay open.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sharedVerbs, useSelection } from './selection';

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe('useSelection', () => {
  it('starts empty and reports "none"', () => {
    const { result } = renderHook(() => useSelection(rows('a', 'b', 'c')));
    expect(result.current.count).toBe(0);
    expect(result.current.state).toBe('none');
  });

  it('toggles one on and off', () => {
    const { result } = renderHook(() => useSelection(rows('a', 'b')));
    act(() => result.current.toggle('a'));
    expect(result.current.ids).toEqual(['a']);
    expect(result.current.state).toBe('some');
    act(() => result.current.toggle('a'));
    expect(result.current.count).toBe(0);
  });

  it('reports "all" only when everything shown is picked', () => {
    const { result } = renderHook(() => useSelection(rows('a', 'b')));
    act(() => result.current.toggle('a'));
    expect(result.current.state).toBe('some');
    act(() => result.current.toggle('b'));
    expect(result.current.state).toBe('all');
  });

  it('shift-extends the run between the anchor and the press', () => {
    const { result } = renderHook(() => useSelection(rows('a', 'b', 'c', 'd', 'e')));
    act(() => result.current.toggle('b'));
    act(() => result.current.toggle('d', true));
    expect(result.current.ids).toEqual(['b', 'c', 'd']);
  });

  it('extends in either direction', () => {
    const { result } = renderHook(() => useSelection(rows('a', 'b', 'c', 'd')));
    act(() => result.current.toggle('d'));
    act(() => result.current.toggle('b', true));
    expect(result.current.ids).toEqual(['b', 'c', 'd']);
  });

  it('a range press only ever adds — dragging back does not unpick', () => {
    const { result } = renderHook(() => useSelection(rows('a', 'b', 'c')));
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('c', true));
    // Same range again: still all three, not zero.
    act(() => result.current.toggle('c', true));
    expect(result.current.ids).toEqual(['a', 'b', 'c']);
  });

  it('toggleAll picks everything, then clears it', () => {
    const { result } = renderHook(() => useSelection(rows('a', 'b', 'c')));
    act(() => result.current.toggleAll());
    expect(result.current.state).toBe('all');
    act(() => result.current.toggleAll());
    expect(result.current.state).toBe('none');
  });

  it('prunes to what is on screen when the list changes under it', () => {
    // The whole reason this is keyed on ids: the inbox refetches constantly
    // and an answered item leaves the list.
    const { result, rerender } = renderHook(({ list }) => useSelection(list), {
      initialProps: { list: rows('a', 'b', 'c') },
    });
    act(() => result.current.toggleAll());
    expect(result.current.count).toBe(3);
    rerender({ list: rows('a', 'c') });
    expect(result.current.ids).toEqual(['a', 'c']);
    expect(result.current.state).toBe('all');
  });

  it('follows a reorder rather than an index', () => {
    const { result, rerender } = renderHook(({ list }) => useSelection(list), {
      initialProps: { list: rows('a', 'b', 'c') },
    });
    act(() => result.current.toggle('c'));
    rerender({ list: rows('c', 'b', 'a') });
    expect(result.current.ids).toEqual(['c']);
  });

  it('restore puts a set back — what Undo presses', () => {
    const { result } = renderHook(() => useSelection(rows('a', 'b', 'c')));
    act(() => result.current.restore(['a', 'c']));
    expect(result.current.ids).toEqual(['a', 'c']);
  });
});

describe('sharedVerbs', () => {
  const item = (...verbs: string[]) => ({
    actions: verbs.map((verb) => ({ verb, label: verb.toUpperCase() })),
  });

  it('is empty for an empty selection', () => {
    expect(sharedVerbs([])).toEqual([]);
  });

  it('is everything one item offers', () => {
    expect(sharedVerbs([item('recover', 'dismiss')]).map((a) => a.verb)).toEqual(['recover', 'dismiss']);
  });

  it('is the intersection, not the union', () => {
    const verbs = sharedVerbs([item('recover', 'dismiss'), item('dismiss', 'approve')]);
    expect(verbs.map((a) => a.verb)).toEqual(['dismiss']);
  });

  it('offers nothing when the selection has nothing in common', () => {
    expect(sharedVerbs([item('recover'), item('approve')])).toEqual([]);
  });

  it('a flagged action is not offered — its capability is off', () => {
    const flagged = { actions: [{ verb: 'recover', label: 'Recover', flag: '--allow-run' }] };
    expect(sharedVerbs([item('recover'), flagged])).toEqual([]);
  });

  it('an item with no actions at all empties the set', () => {
    expect(sharedVerbs([item('dismiss'), {}])).toEqual([]);
  });
});
