/**
 * The quick view's map (control-tower phase 22): nine categories, every field
 * in exactly one, and every category nested inside exactly one old stage — so
 * "which stage is this on" still has one answer while no stage bar draws it.
 */

import { describe, expect, it } from 'vitest';
import { CATEGORIES, CATEGORY_OF, dominantSource, fieldsIn, tileShown } from './categories';
import { MODES, shows, type RunSetupMode } from './modes';
import type { RunSetupField } from './schema';
import { FIELD_LABELS, LAUNCH_SURFACE, STAGE_OF } from './stages';

describe('the categories', () => {
  it('are the nine of the START wireframe, in its order', () => {
    expect(CATEGORIES.map((c) => c.label)).toEqual([
      'Scope',
      'Engine',
      'Safety',
      'Git',
      'Money and stops',
      'Review and QA',
      'Tools',
      'Accounts',
      'Decisions',
    ]);
  });

  it('cover every field exactly once, and nothing that is not a field', () => {
    expect(Object.keys(CATEGORY_OF).sort()).toEqual(Object.keys(FIELD_LABELS).sort());
    const all = CATEGORIES.flatMap((c) => fieldsIn(c.id));
    expect(all.length).toBe(new Set(all).size);
  });

  it('each nest inside exactly one old stage', () => {
    for (const category of CATEGORIES) {
      for (const field of fieldsIn(category.id)) {
        expect(STAGE_OF[field], `${field} is in ${category.id}, which nests in ${category.stage}`).toBe(
          category.stage,
        );
      }
    }
  });

  it('draw a tile in every staged mode for every field that mode shows', () => {
    const staged = (Object.keys(LAUNCH_SURFACE) as RunSetupMode[]).filter(
      (m) => LAUNCH_SURFACE[m] === 'staged',
    );
    for (const mode of staged) {
      for (const field of MODES[mode].fields as readonly RunSetupField[]) {
        expect(
          tileShown(CATEGORY_OF[field], (f) => shows(mode, f)),
          `${mode}: ${field}`,
        ).toBe(true);
      }
    }
  });
});

describe("a tile's provenance word", () => {
  it('is the source most of its untouched values share, edits aside', () => {
    expect(dominantSource(['defaults', 'defaults', 'prefs'])).toBe('defaults');
    expect(dominantSource(['changed', 'changed', 'run'])).toBe('run');
    expect(dominantSource(['changed'])).toBeUndefined();
    // A tie goes to the more deliberate source.
    expect(dominantSource(['defaults', 'preset'])).toBe('preset');
  });
});
