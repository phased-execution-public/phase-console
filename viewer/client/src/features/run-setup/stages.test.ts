/**
 * The stage → field map, held total — and the extension point Phase 9 uses.
 *
 * Every field the value shape has is on exactly one control stage; every mode
 * says whether it is staged; every mode has a heading. A new mode (`qa-fix`)
 * that forgets one of the three fails here, before it renders a control
 * nobody can reach or a dialog with no title.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUN_SETTINGS_FIELDS, RUN_START_FIELDS } from '@shared/run-settings.js';
import { MODES, buildRunPayload, shows, type RunSetupMode } from './modes';
import { EMPTY, WIRE, type RunSetupField, type RunSetupValues } from './schema';
import {
  FIELD_LABELS,
  HEADINGS,
  LAUNCH_SURFACE,
  LIVE_WHEN,
  STAGES,
  STAGE_OF,
  fieldsOnStage,
  headingFor,
  isLive,
  isStaged,
  stageHasControls,
  stagesFor,
} from './stages';

const FIELDS = Object.keys(EMPTY) as RunSetupField[];
const MODE_NAMES = Object.keys(MODES) as RunSetupMode[];

describe('the five stages', () => {
  it('are Decisions, What runs, How it runs, Money and stops, Review — in that order', () => {
    // Decisions first since 5.0.0 (phase 11): the prelude's questions are
    // answered before anything about the run's shape is.
    expect(STAGES.map((s) => s.id)).toEqual(['decisions', 'what', 'how', 'money', 'review']);
    expect(STAGES.map((s) => s.label)).toEqual([
      'Decisions',
      'What runs',
      'How it runs',
      'Money and stops',
      'Review',
    ]);
    // The phone reads a shorter word, and each one is a word a quarter of 360px can hold.
    for (const stage of STAGES) expect(stage.short.length).toBeLessThanOrEqual(8);
  });
});

describe('every field has a stage', () => {
  it('maps every member of the value shape onto a control stage', () => {
    expect(Object.keys(STAGE_OF).sort()).toEqual(FIELDS.sort());
    for (const field of FIELDS) expect(['decisions', 'what', 'how', 'money']).toContain(STAGE_OF[field]);
  });

  it('and a label, spelled once for the control and the review', () => {
    expect(Object.keys(FIELD_LABELS).sort()).toEqual(FIELDS.sort());
  });

  it('so every canonical run field is reachable through some stage of some staged mode', () => {
    const canonical = [...new Set<string>([...RUN_START_FIELDS, ...RUN_SETTINGS_FIELDS])];
    const staged = MODE_NAMES.filter((mode) => LAUNCH_SURFACE[mode] === 'staged');
    for (const name of canonical) {
      if (name === 'resumeRunId') continue; // context, never a control
      const field = (Object.keys(WIRE) as RunSetupField[]).find((key) => WIRE[key] === name);
      expect(field, `${name} maps onto no form field`).toBeTruthy();
      // `openPr` is owned by `settle` (reachability.test.tsx OWNED_BY); it is
      // on a stage all the same, because the stage is the settle control's.
      const onSomeStage = staged.some((mode) =>
        (['decisions', 'what', 'how', 'money'] as const).some((stage) =>
          fieldsOnStage(mode, stage).includes(field!),
        ),
      );
      expect(onSomeStage, `${field} is on no stage of any staged mode`).toBe(true);
    }
  });

  it('puts the scope on What runs, the money and the stops on Money and stops, the rest on How', () => {
    // The prelude's answers on Decisions (phase 11) — the three the door
    // requires, the waivers a person acknowledges, the recorded override, and
    // (2026-09-18) the verification probe's approvals and waivers.
    expect([...fieldsOnStage('start', 'decisions')].sort()).toEqual(
      [
        'accounts',
        'acknowledgedWaivers',
        'manifestOverride',
        'relay',
        'resumeOnRestart',
        'verifyAnswers',
      ].sort(),
    );
    // A phase launch asks them too: on a finished run it is a fresh start.
    expect(stageHasControls('phase', 'decisions')).toBe(true);
    expect(stageHasControls('live', 'decisions')).toBe(false);
    expect([...fieldsOnStage('start', 'what')].sort()).toEqual(['onlyPhases', 'startAfter']);
    expect(fieldsOnStage('start', 'money').sort()).toEqual(
      [
        'autonomy',
        'phaseBudgetUsd',
        'runBudgetUsd',
        'autoRecover',
        'maxParallel',
        'maxConsecutiveFailures',
        'priority',
        'onLimit',
      ].sort(),
    );
    // A `phase` launch narrows nothing and chains nothing: its What-runs stage has facts and no controls.
    expect(stageHasControls('phase', 'what')).toBe(false);
    expect(stageHasControls('phase', 'how')).toBe(true);
  });
});

describe('every mode says how it is shown', () => {
  it('is staged or flat, by the door it knocks on', () => {
    expect(Object.keys(LAUNCH_SURFACE).sort()).toEqual([...MODE_NAMES].sort());
    for (const mode of MODE_NAMES) {
      const door = MODES[mode].door;
      // `qaRecover` joins the two run doors: a recovery is a run-shaped launch
      // with its own settings, its own money and its own stop — `phase`'s shape,
      // not the flat `qa` review's.
      const RUN_SHAPED = ['runStart', 'runSettings', 'qaRecover'];
      const expected = RUN_SHAPED.includes(door) ? 'staged' : 'flat';
      expect(LAUNCH_SURFACE[mode], `${mode} knocks on ${door}`).toBe(expected);
    }
  });

  it('is flat inline whatever its mode — staging is the overlay’s', () => {
    for (const mode of MODE_NAMES) {
      expect(isStaged(mode, false)).toBe(false);
      expect(stagesFor(mode, false)).toEqual([]);
    }
    expect(stagesFor('start', true)).toBe(STAGES);
    expect(stagesFor('qa', true)).toEqual([]);
  });

  it('has a heading, and the ones about one phase name it', () => {
    expect(Object.keys(HEADINGS).sort()).toEqual([...MODE_NAMES].sort());
    for (const mode of MODE_NAMES) {
      const heading = headingFor(mode, { phase: 7 });
      expect(heading.title.length, `${mode} has no title`).toBeGreaterThan(0);
      expect(heading.description.length, `${mode} has no description`).toBeGreaterThan(0);
    }
    expect(headingFor('phase', { phase: 7 }).title).toBe('Run only phase 7');
    expect(headingFor('qa', { phase: 7 }).title).toBe('QA phase 7');
  });

  it('shows a field only on the stage that owns it', () => {
    // A field shown by a mode is on exactly one of that mode's stages.
    for (const mode of MODE_NAMES) {
      const seen = new Map<RunSetupField, number>();
      for (const stage of ['decisions', 'what', 'how', 'money'] as const) {
        for (const field of fieldsOnStage(mode, stage)) seen.set(field, (seen.get(field) ?? 0) + 1);
      }
      for (const field of FIELDS) {
        expect(seen.get(field) ?? 0, `${mode}: ${field}`).toBe(shows(mode, field) ? 1 : 0);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * `LIVE_WHEN` — the condition beyond `shows()`, and the two guards that
 * keep it honest (QA round 1, H1).
 * ------------------------------------------------------------------ */

describe('a control that a VALUE can hide', () => {
  /**
   * How to make each member's condition false and true.
   *
   * Asserted against `LIVE_WHEN` in BOTH directions, so a fifth member cannot
   * be added without saying how to flip it — and therefore cannot be added
   * without the payload assertion below running over it.
   */
  const FLIP: Readonly<Record<string, { off: Partial<RunSetupValues>; on: Partial<RunSetupValues> }>> = {
    settle: { off: { gitMode: 'default-branch' }, on: { gitMode: 'new-branch' } },
    openPr: { off: { gitMode: 'default-branch' }, on: { gitMode: 'new-branch' } },
    isolation: { off: { gitMode: 'default-branch' }, on: { gitMode: 'new-branch' } },
    reviewerPolicy: {
      off: { reviewEachPhase: false },
      // `may-hold` is the half the payload writes; `comment-only` is its
      // absence, so the "on" case has to be the one that produces a key.
      on: { reviewEachPhase: true, reviewerPolicy: 'may-hold' },
    },
  };

  it('names a flip for every member, and a member for every flip', () => {
    expect(Object.keys(FLIP).sort()).toEqual(Object.keys(LIVE_WHEN).sort());
  });

  it('is dark exactly when the payload drops the field — the equality the review rests on', () => {
    // The membership rule for `LIVE_WHEN`: the control's condition IS the
    // payload's condition. Where the two disagree the field does not belong
    // here, because the review would then hide a value the run carries.
    for (const [field, flip] of Object.entries(FLIP)) {
      const key = field as RunSetupField;
      const wire = WIRE[key]!;
      const off: RunSetupValues = { ...EMPTY, ...flip.off };
      const on: RunSetupValues = { ...EMPTY, ...flip.on };

      expect(isLive('start', key, off), `${field}: should be dark`).toBe(false);
      expect(isLive('start', key, on), `${field}: should be live`).toBe(true);

      expect(wire in buildRunPayload('start', off, {}), `${field}: dark but still posted`).toBe(false);
      expect(wire in buildRunPayload('start', on, {}), `${field}: live but never posted`).toBe(true);
    }
  });

  it('never overrules the mode — a field the mode withholds stays dark either way', () => {
    // `phase` shows no `settle`… it does show `gitMode`, so the flip alone
    // must not be enough to light a control the field set does not offer.
    for (const [field, flip] of Object.entries(FLIP)) {
      const key = field as RunSetupField;
      if (shows('phase', key)) continue;
      expect(isLive('phase', key, { ...EMPTY, ...flip.on })).toBe(false);
    }
  });

  it('leaves `reviewerPolicy` posted by the CLOUD reviewer, which is why the review asks the payload too', () => {
    // The one asymmetry in the table: the hold policy reaches the payload
    // through `ultraReview` as well as through the per-phase reviewer, while
    // its control is drawn only for the latter. `isLive` answers for the
    // CONTROL — so a review that listed rows by `isLive` alone would drop a
    // value this run really carries. `summary.test.ts` holds the other half.
    const cloudOnly: RunSetupValues = {
      ...EMPTY,
      reviewEachPhase: false,
      reviewerPolicy: 'may-hold',
      ultraReview: 'each-phase',
    };
    expect(isLive('start', 'reviewerPolicy', cloudOnly)).toBe(false);
    expect(buildRunPayload('start', cloudOnly, {}).reviewerPolicy).toBe('may-hold');
  });
});

describe('the sections spell a value-dependent control as `f.live`', () => {
  /**
   * The mechanism QA round 1 said was missing: something that notices a FOURTH.
   *
   * `LIVE_WHEN` is only the truth while every section that hides a control
   * behind a value routes through it. So this reads `sections.tsx` and refuses
   * the shape that produced H1 — a render condition gated on `f.on('X')` that
   * also reads a value, which is a condition `summaryRows()` cannot see.
   * Write `f.live('X')` instead, and add the row to `LIVE_WHEN`.
   *
   * Conditions in that file are one line each (they end `&& (`), so the scan is
   * line-based; a future multi-line condition would be read in fragments and is
   * the known limit of this guard.
   */
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SECTIONS = readFileSync(join(HERE, 'sections.tsx'), 'utf8')
    .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?/gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  /**
   * Fields whose control is value-dependent and which are deliberately NOT in
   * `LIVE_WHEN`, with the reason. Both directions, so a reason cannot rot.
   *
   * `mcpPolicy` is posted whenever the mode shows it (`buildRunPayload`), and
   * has a SECOND render site for the mode that offers no server picker — so it
   * is never a value the run drops, and hiding its row would be the opposite
   * of H1's defect. Its Change link is suppressed by `SummaryRow.live` instead.
   */
  const POSTED_REGARDLESS: Readonly<Record<string, string>> = {
    mcpPolicy: 'always in the payload; a second render site covers the other mode',
  };

  /** Locals derived from the values — `const branch = values.gitMode === …`. */
  const derived = [...SECTIONS.matchAll(/const (\w+) = [^;\n]*\bvalues\./g)].map((m) => m[1]!);

  it('has locals derived from values, so the scan below has something to look for', () => {
    // A guard on the guard: if this file stops deriving any local the scan is
    // still correct, but the `derived` half of it has silently stopped working.
    expect(derived).toContain('branch');
  });

  it('gates no control on `f.on(field)` plus a value — that is the H1 shape', () => {
    const valueRef = new RegExp(`\\bvalues\\.|\\b(?:${derived.join('|')})\\b`);
    const offenders: string[] = [];
    for (const raw of SECTIONS.split('\n')) {
      const line = raw.trim();
      if (!line.includes('f.on(') || !line.includes('&&')) continue;
      if (!valueRef.test(line)) continue;
      for (const [, field] of line.matchAll(/f\.on\('(\w+)'\)/g)) {
        if (field in LIVE_WHEN || field in POSTED_REGARDLESS) continue;
        offenders.push(`${field}: ${line.slice(0, 110)}`);
      }
    }
    expect(
      offenders,
      'write `f.live(field)` and add the condition to LIVE_WHEN — `summaryRows()` cannot see an inline one',
    ).toEqual([]);
  });

  it('names an exception only for a field the payload really does carry regardless', () => {
    for (const field of Object.keys(POSTED_REGARDLESS)) {
      const key = field as RunSetupField;
      expect(field in LIVE_WHEN, `${field} is both an exception and a member`).toBe(false);
      // The claim the exception rests on: shown by the mode ⇒ in the payload.
      expect(shows('start', key)).toBe(true);
      expect(WIRE[key]! in buildRunPayload('start', EMPTY, {}), `${field}: not posted after all`).toBe(true);
    }
  });
});
