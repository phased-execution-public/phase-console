/**
 * The single-source guards — the assertions that keep the consolidation from
 * quietly coming apart.
 *
 * Phase 6's whole claim is that there is now ONE launch form and ONE way-
 * forward renderer. That claim is not expressible as a type: nothing stops a
 * future surface from importing `api` and rendering its own Retry beside the
 * shared one, which is exactly how the four dialogs and the nine parallel
 * remedy buttons appeared in the first place — one reasonable local decision
 * at a time.
 *
 * So the guard is a source walk. It is coarse on purpose: it asks who may
 * MENTION a door, not who calls it at runtime, because a mention is where the
 * drift starts and it is the thing a reviewer can act on.
 *
 * When one of these fails, the fix is almost never to widen the allow-list.
 * It is to render `<RunSetup>` or `<RecoveryActions>` instead.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');

/** Every `.ts`/`.tsx` under `client/src`, tests excluded — a test may say anything. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(path);
  }
  return out;
}

/**
 * Comments stripped before matching. A prose mention of `api.runStart(…)` in a
 * module header is documentation, not a second caller, and a guard that cannot
 * tell them apart gets silenced rather than obeyed.
 */
const decommented = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const FILES = sources(SRC).map((path) => ({
  path: relative(SRC, path),
  text: decommented(readFileSync(path, 'utf8')),
}));

/** Files matching a pattern, minus the ones allowed to. */
function offenders(pattern: RegExp, allowed: readonly string[]): string[] {
  return FILES.filter(({ path, text }) => pattern.test(text) && !allowed.includes(path)).map(
    ({ path }) => path,
  );
}

describe('the ways-forward renderer is the only one', () => {
  it('nothing but the shared performer touches retry, skip or recheck', () => {
    // `cards/recover.ts` IS the performer — it is where `RecoveryActions`
    // sends every run verb. Anything else calling these is a second Retry
    // button under a second set of rules, which is the defect being fixed.
    expect(offenders(/\bapi\.(runRetry|runSkip|runRecheck)\b/, ['cards/recover.ts'])).toEqual([]);
  });

  it('the shared renderer is what surfaces import for a remedy', () => {
    // A surface that offers a way forward imports `RecoveryActions`, the card.
    // This is the positive half of the rule: the guard above proves nobody
    // rolls their own; this proves the ones that offer remedies use the shared one.
    const users = FILES.filter(({ text }) => /from '@\/cards\/recovery-actions'/.test(text));
    expect(users.length).toBeGreaterThan(0);
  });
});

/**
 * A door is called as an object member — `api.runStart(`, `runsApi.runSettings(`
 * — whichever data object carries it, so each guard below matches the CALL
 * (`.name(`), never a prefix. The surface registry names the same doors as
 * strings (`api/runs#runsApi.runStart`), and naming a door is not pressing it.
 */
const call = (name: string): RegExp => new RegExp(`\\.${name}\\(`);

describe('RunSetup is the only launch form', () => {
  it('nothing but the one form starts a run', () => {
    // The hard half: a LAUNCH has exactly one caller, no exceptions.
    expect(offenders(call('runStart'), ['screens/launch/run-setup.tsx'])).toEqual([]);
  });

  it('every settings patch outside the form is a ONE-TAP verb, named field by field', () => {
    // A settings PATCH is not a launch. Two surfaces make them without being
    // a second form: the Run view's "clear the phase scope" and "back to
    // Guarded", which its notes press through `useRunPatch`
    // (`screens/plan/run/settings-sheet.tsx`), and the run row's expanded
    // detail (`screens/runs/run-detail.tsx`), carrying the queue-priority
    // select and the isolation drop, both through `runsApi`, the same door.
    // Allowed BY SHAPE, not by filename — every call's payload is written out
    // below, so a third surface, a new field, or one of these quietly growing
    // into a form fails this.
    const others = offenders(call('runSettings'), [
      'screens/launch/run-setup.tsx',
      'screens/runs/run-detail.tsx',
      'screens/plan/run/settings-sheet.tsx',
    ]);
    expect(others).toEqual([]);

    const patches = (path: string): string[] => {
      const file = FILES.find((candidate) => candidate.path === path)!;
      return [...file.text.matchAll(/\.runSettings\([^,]+, (\{[^}]*\})\)/g)].map((match) =>
        match[1]!.replace(/\s+/g, ' ').trim(),
      );
    };

    // The Run view's two, and nothing else in its verbs' file.
    expect(patches('screens/plan/run/settings-sheet.tsx')).toEqual([
      '{ onlyPhases: [] }',
      "{ permissionProfile: 'guarded' }",
    ]);
    // The run row's two, each one field.
    // ⚠️ `isolation: 'queue'` is a DROP: isolation is one-way mid-run (phase 5
    // — a raise is ignored by `applySettings` and 409s at the route), so a
    // patch here that ever reads `'worktree'` is a control that can only fail.
    expect(patches('screens/runs/run-detail.tsx')).toEqual(['{ priority: next }', "{ isolation: 'queue' }"]);
  });

  it('nothing outside the one session helper mints an agent ticket', () => {
    // Four callers, and what they have in common is that each owns a PTY,
    // not a form: the shared session helper (QA + recovery), the sessions
    // place's start door (`useSessionStart`, its launch page and its resume),
    // the plan wizard — whose ticket carries an `intent` and a `brief` no run
    // door has — and the issues board's launch, which is that same wizard
    // ticket plus the one thing a wizard cannot know, WHICH issues. All four
    // take their FIELDS from RunSetup (`mode="plan"` for the last two, the
    // same field set and the same `buildLaunch`); none of them declares one.
    // A caller that declared its own fields would be a fifth form, and that is
    // what this list is against — not the count.
    expect(
      offenders(call('agentTicket'), [
        'lib/start-session.ts',
        'data/sessions.ts',
        'screens/plans/wizard.tsx',
        'screens/repo/issues-launch.tsx',
      ]),
    ).toEqual([]);
  });

  it('every new surface reaches the form through its one door', () => {
    // The form is the heaviest thing the console has; a page that imports it
    // statically carries it whether or not anyone presses Launch. So outside
    // `screens/launch/` the client names `door` and nothing else of it.
    const DOOR = /from '@\/screens\/launch\/door'/;
    const FORM = /from '@\/screens\/launch\/(?!door'|model\/)[^']+'/;
    const strays = FILES.filter(
      ({ path, text }) => !path.startsWith('screens/launch/') && FORM.test(text),
    ).map(({ path }) => path);
    expect(strays).toEqual([]);
    expect(FILES.filter(({ text }) => DOOR.test(text)).length).toBeGreaterThan(5);
  });

  it('no surface renders its own model picker', () => {
    // The list itself comes from the server (`state.models`), with the build's
    // own copy as the fallback for an older server. Anything else mapping a
    // model vocabulary into options is a second picker that will disagree
    // with the door the morning the lineup changes.
    const allowed = [
      // The fallback list and its notes — data, not a picker.
      'screens/launch/model/defaults.ts',
      // The one form. (`per-phase.tsx` renders its rows from the list RunSetup
      // hands it, so it never names the vocabulary itself.) Settings ▸
      // Appearance's "Session plan model" row had its OWN hardcoded list of
      // full ids until Phase 6 — the fourth one, and the reason this assertion
      // exists; since quiet-console phase 21 it offers `offeredModelOptions`
      // and never names the vocabulary either.
      'screens/launch/run-setup.tsx',
    ];
    expect(offenders(/\bMODELS\b/, allowed)).toEqual([]);
  });

  it('the permission vocabulary is declared once', () => {
    // `PERMISSION_CHOICES` in the launch model's `modes.ts` is the vocabulary;
    // `screens/sessions/modes.ts` keeps `modeName` for the session's details,
    // which reads a mode back rather than offering one. Offering is what
    // must be single.
    expect(
      offenders(/\bPERMISSION_CHOICES\b/, ['screens/launch/model/modes.ts', 'screens/launch/run-setup.tsx']),
    ).toEqual([]);
  });
});
