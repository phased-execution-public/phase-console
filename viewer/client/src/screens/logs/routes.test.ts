/**
 * Logs' addresses (quiet-console phase 20): which section a segment names, how
 * a section's address is written, and how a list and a phase are read back
 * out of one.
 *
 * Every filter on this place is in the address because what it shows is
 * evidence, and evidence has to be quotable — so the writer and the readers
 * are pinned together: what one writes, the others read back as it was, and
 * what no vocabulary knows is never read as a filter.
 */

import { describe, expect, it } from 'vitest';
import { DEBUG_LEVELS, DEBUG_SOURCES } from '@/data/api';
import { parseHash } from '@/shell/routes';
import { LOGS_SECTIONS, listOf, logsSectionHref, logsSectionOf, phaseOf } from './routes';

describe('the sections', () => {
  it('are in the nav’s order, the explorer first', () => {
    expect(LOGS_SECTIONS.map((s) => s.label)).toEqual([
      'Logs',
      'Journal',
      'Delivery',
      'Health',
      'Access',
    ]);
  });
});

describe('logsSectionOf', () => {
  it('reads each section’s segment as that section, and no segment as the explorer', () => {
    for (const { id } of LOGS_SECTIONS) {
      expect(logsSectionOf(id === 'logs' ? undefined : id)).toBe(id);
    }
  });

  it('reads an empty segment, and one nobody knows, as the explorer rather than a dead link', () => {
    expect(logsSectionOf('')).toBe('logs');
    expect(logsSectionOf('nonsense')).toBe('logs');
    expect(logsSectionOf('logs')).toBe('logs');
  });
});

describe('logsSectionHref', () => {
  it('gives the explorer no segment of its own, and every other section its own', () => {
    expect(logsSectionHref('logs')).toBe('#/logs');
    expect(logsSectionHref('journal')).toBe('#/logs/journal');
    expect(logsSectionHref('health')).toBe('#/logs/health');
    expect(logsSectionHref('access')).toBe('#/logs/access');
  });

  it('writes each section an address the reader takes back to that section', () => {
    for (const { id } of LOGS_SECTIONS) {
      const route = parseHash(logsSectionHref(id));
      expect(route.segments[0]).toBe('logs');
      expect(logsSectionOf(route.segments[1])).toBe(id);
    }
  });

  it('drops an empty value as well as an absent one', () => {
    // The server reads `?slug=` and no slug alike, so a link that sent one
    // would say something its reader did not.
    expect(logsSectionHref('logs', { slug: '', q: undefined, trace: null, run: 'r1' })).toBe('#/logs?run=r1');
    expect(logsSectionHref('journal', { slug: '', run: undefined })).toBe('#/logs/journal');
  });

  it('keeps a zero, because phase 0 is a phase', () => {
    expect(logsSectionHref('journal', { slug: 'demo', phase: 0 })).toBe('#/logs/journal?slug=demo&phase=0');
  });

  it('comma-joins a list rather than repeating the key, and drops a list with nothing in it', () => {
    // The hash's query is flat and the last of a repeated key wins, so
    // `?source=a&source=b` would read back as one source.
    expect(logsSectionHref('logs', { source: ['console', 'journal'] })).toBe(
      '#/logs?source=console%2Cjournal',
    );
    expect(logsSectionHref('logs', { source: [] })).toBe('#/logs');
    expect(logsSectionHref('logs', { source: ['', 'journal'] })).toBe('#/logs?source=journal');
  });

  it('writes what the readers read back as it was', () => {
    const { query } = parseHash(
      logsSectionHref('logs', {
        q: 'verify failed, again',
        source: ['console', 'journal'],
        level: ['warn', 'error'],
        since: '2026-09-01T09:00:00.000Z',
        phase: 7,
      }),
    );
    expect(query.q).toBe('verify failed, again');
    expect(query.since).toBe('2026-09-01T09:00:00.000Z');
    expect(listOf(query.source, DEBUG_SOURCES)).toEqual(['console', 'journal']);
    expect(listOf(query.level, DEBUG_LEVELS)).toEqual(['warn', 'error']);
    expect(phaseOf(query.phase)).toBe(7);
  });
});

describe('listOf', () => {
  it('reads a comma-joined list back into the vocabulary’s words, in the address’s order', () => {
    expect(listOf('journal,console', DEBUG_SOURCES)).toEqual(['journal', 'console']);
    expect(listOf(' journal , console ', DEBUG_SOURCES)).toEqual(['journal', 'console']);
    expect(listOf('warn', DEBUG_LEVELS)).toEqual(['warn']);
  });

  it('a typo selects nothing — never every word, and never the typo', () => {
    // A filter that narrowed to a word nobody writes would read as an empty
    // log, and one that widened to the whole vocabulary would tick every box:
    // the typo is dropped, and only it.
    expect(listOf('journals', DEBUG_SOURCES)).toEqual([]);
    expect(listOf('journal,journals', DEBUG_SOURCES)).toEqual(['journal']);
    expect(listOf('loud', DEBUG_LEVELS)).toEqual([]);
  });

  it('reads nothing out of nothing', () => {
    expect(listOf(undefined, DEBUG_SOURCES)).toEqual([]);
    expect(listOf('', DEBUG_SOURCES)).toEqual([]);
    expect(listOf(',,', DEBUG_SOURCES)).toEqual([]);
  });
});

describe('phaseOf', () => {
  it('reads a whole, non-negative number, zero included', () => {
    expect(phaseOf('3')).toBe(3);
    expect(phaseOf('0')).toBe(0);
    expect(phaseOf('150')).toBe(150);
  });

  it('drops anything else rather than sending NaN', () => {
    for (const raw of [undefined, '', 'soon', '-1', '2.5', 'NaN', 'Infinity']) {
      expect(phaseOf(raw), String(raw)).toBeUndefined();
    }
  });
});
