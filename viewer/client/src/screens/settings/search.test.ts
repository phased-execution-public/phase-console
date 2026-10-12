/**
 * The search over every section and every key (quiet-console phase 21, exit
 * criterion 4): it filters ACROSS sections and keys, every typed word must
 * match, a word matches the start of a word, and the answer keeps the order
 * the page draws.
 */

import { describe, expect, it } from 'vitest';
import { PREF_META } from '@shared/prefs-model.js';
import { SECTION_TERMS, SETTINGS_SECTIONS, sectionOfGroup } from './nav';
import { keyWords, queryWords, searchSettings } from './search';
import { schemaAnswer } from './test-kit';

const rows = schemaAnswer().rows;
const keysOf = (query: string) => searchSettings(query, rows).keys.map((row) => row.key);
const sectionsOf = (query: string) => searchSettings(query, rows).sections.map((section) => section.id);

describe('searchSettings', () => {
  it('answers nothing for nothing typed', () => {
    expect(searchSettings('', rows)).toEqual({ sections: [], keys: [] });
    expect(searchSettings('   ', rows)).toEqual({ sections: [], keys: [] });
  });

  it('finds sections and keys at once — "quiet hours" is the schedule, the devices and the profile', () => {
    expect(sectionsOf('quiet hours')).toEqual(expect.arrayContaining(['automation', 'notifications']));
    expect(keysOf('quiet hours')).toContain('profile.quietHours');
  });

  it('reads a key by its own name as words: "run usd" is the one cap', () => {
    expect(keyWords('ladderPerRunUsd')).toBe('ladder per run usd');
    expect(keyWords('notify.needs-you')).toBe('notify needs you');
    expect(keysOf('run usd')).toEqual(['ladderPerRunUsd']);
  });

  it('demands every word, in any order', () => {
    expect(keysOf('usd run')).toEqual(['ladderPerRunUsd']);
    expect(keysOf('ladder rungs phase')).toEqual(['ladderPerPhaseRungs']);
    expect(keysOf('ladder zebra')).toEqual([]);
  });

  it('matches the start of a word — "rung" finds the rungs, "run" never finds "trunk"', () => {
    expect(keysOf('rung')).toEqual(expect.arrayContaining(['ladderPerPhaseRungs', 'ladderPerRunRungs']));
    const trunk = rows.filter((row) => /\btrunk\b/i.test(row.description)).map((row) => row.key);
    for (const key of trunk) {
      if (!/\brun/i.test(`${keyWords(key)} ${rows.find((row) => row.key === key)!.description}`)) {
        expect(keysOf('run')).not.toContain(key);
      }
    }
  });

  it('finds a key by its description, its words and its command line', () => {
    expect(keysOf('colour scheme')).toEqual(['theme']);
    expect(keysOf('seniority')).toContain('schedulingPolicy');
    expect(keysOf('queue-policy')).toEqual(
      expect.arrayContaining(['schedulingPolicy', 'schedulingPolicies', 'loadGuardFactor']),
    );
  });

  it('keeps the order the page draws: sections in their order, keys by their section', () => {
    const order = SETTINGS_SECTIONS.map((section) => section.id);
    const sections = sectionsOf('a');
    expect(sections).toEqual([...sections].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    const keys = searchSettings('the', rows).keys;
    const at = keys.map((row) => order.indexOf(sectionOfGroup(row.group)));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('can search the sections before the schema has answered', () => {
    expect(searchSettings('passkey').sections.map((section) => section.id)).toEqual(['permissions']);
    expect(searchSettings('passkey').keys).toEqual([]);
  });

  it('splits what was typed into words, punctuation and quotes aside', () => {
    expect(queryWords('  "Quiet  hours", please ')).toEqual(['quiet', 'hours', 'please']);
    expect(queryWords('--allow-run')).toEqual(['allow-run']);
  });

  it('names a control for every search term of a rebuilt section (a term with no control sends a reader nowhere)', () => {
    // The terms are words, not documentation: each rebuilt section's terms
    // must find that section, and every key of the shared table reaches a
    // section the search can name.
    for (const id of ['essentials', 'appearance', 'automation', 'everything']) {
      expect(SECTION_TERMS[id], id).toBeTruthy();
      expect(sectionsOf(SECTION_TERMS[id]!.split(' ')[0]!), id).toContain(id);
    }
    for (const key of Object.keys(PREF_META)) {
      const section = sectionOfGroup(PREF_META[key]!.group);
      expect(
        SETTINGS_SECTIONS.some((one) => one.id === section),
        key,
      ).toBe(true);
    }
  });
});
