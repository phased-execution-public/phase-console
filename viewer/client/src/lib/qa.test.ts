/**
 * The per-phase regime and the report sheet's address — pure, so the three
 * surfaces that judge "is this phase held?" and the two that link a report
 * cannot disagree with each other.
 */

import { describe, expect, it } from 'vitest';
import { parseReportParam, phaseQaMode, qaReportHref, qaReportRound } from './qa';

describe('phaseQaMode', () => {
  it("prefers the phase's own resolved regime, and falls back to the plan's word", () => {
    expect(phaseQaMode({ qaMode: { mode: 'off', source: 'phase' } }, 'on')).toBe('off');
    expect(phaseQaMode({ qaMode: { mode: 'on', source: 'plan' } }, 'waived')).toBe('on');
    // An older server sends no per-phase word: the plan's is the honest fallback.
    expect(phaseQaMode({}, 'on')).toBe('on');
    expect(phaseQaMode(undefined, 'waived')).toBe('waived');
    expect(phaseQaMode(undefined, undefined)).toBeUndefined();
  });
});

describe('the report address', () => {
  it('numbers a report by its path — the plain name is round 1', () => {
    expect(qaReportRound('reports/phase-07-qa.md')).toBe(1);
    expect(qaReportRound('reports/phase-07-qa-round3.md')).toBe(3);
    expect(qaReportRound('reports/phase-07-qa-round12.md')).toBe(12);
  });

  it('is a query on the QA tab, carrying the round only when it is not the first', () => {
    expect(qaReportHref('alpha', 7)).toBe('#/plan/alpha/qa?report=7');
    expect(qaReportHref('alpha', 7, 1)).toBe('#/plan/alpha/qa?report=7');
    expect(qaReportHref('alpha', 7, 3)).toBe('#/plan/alpha/qa?report=7:3');
    expect(parseReportParam('7')).toEqual({ phase: 7 });
    expect(parseReportParam('7:3')).toEqual({ phase: 7, round: 3 });
    for (const bad of ['', 'x', '0', '7:0', '7:x', undefined, null]) expect(parseReportParam(bad)).toBeNull();
  });
});
