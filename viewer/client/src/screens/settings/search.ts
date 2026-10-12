/**
 * The search over every section and every key (quiet-console phase 21).
 *
 * A section matches by its title, its question and the words of what it holds
 * (`SECTION_TERMS`); a key by its name — `ladderPerRunUsd` read as "ladder per
 * run usd" too — its description, its words, its unit, its section and its
 * command line. Every word typed must match somewhere (AND, any order), so
 * "quiet hours" finds the schedule and the notifications, and "run usd" finds
 * the one cap. A typed word matches the START of a word, so "rung" finds
 * "rungs" and "run" does not find "trunk".
 *
 * Pure: the schema is handed in, so the page can search before it answers
 * (sections only) and a test can search a fixture.
 */

import type { PrefSchemaRow } from '@/data/console';
import { SECTION_TERMS, SETTINGS_SECTIONS, sectionOfGroup, sectionTitle, type SettingsSection } from './nav';

export interface SettingsSearch {
  sections: SettingsSection[];
  keys: PrefSchemaRow[];
}

/** A key's name as words: `ladderPerRunUsd` → `ladder per run usd`, `notify.needs-you` → `notify needs you`. */
export function keyWords(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** The words typed, lower-cased; quotes and punctuation are separators. */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9$%-]+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
}

/** Every word typed starts a word of the haystack. */
function matches(haystack: string, words: readonly string[]): boolean {
  const hay = ` ${haystack.toLowerCase().replace(/[^a-z0-9$%]+/g, ' ')} `;
  return words.every((word) => hay.includes(` ${word.replace(/[^a-z0-9$%]+/g, ' ').trim()}`));
}

function sectionHaystack(section: SettingsSection): string {
  return `${section.id} ${section.title} ${section.blurb} ${SECTION_TERMS[section.id] ?? ''}`;
}

function keyHaystack(row: PrefSchemaRow): string {
  const section = sectionOfGroup(row.group);
  return [
    row.key,
    keyWords(row.key),
    row.description,
    row.group,
    sectionTitle(section),
    ...(row.words ?? []),
    row.unit ?? '',
    row.cli ?? '',
  ].join(' ');
}

/** The sections, then the keys, each in the order the page draws them. */
export function searchSettings(query: string, rows: readonly PrefSchemaRow[] = []): SettingsSearch {
  const words = queryWords(query);
  if (!words.length) return { sections: [], keys: [] };
  const order = new Map(SETTINGS_SECTIONS.map((section, index) => [section.id, index]));
  return {
    sections: SETTINGS_SECTIONS.filter((section) => matches(sectionHaystack(section), words)),
    keys: rows
      .filter((row) => matches(keyHaystack(row), words))
      .map((row, index) => ({ row, index, at: order.get(sectionOfGroup(row.group)) ?? order.size }))
      .sort((a, b) => a.at - b.at || a.index - b.index)
      .map(({ row }) => row),
  };
}
