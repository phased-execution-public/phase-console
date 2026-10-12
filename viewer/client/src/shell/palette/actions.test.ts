/**
 * The palette's *do* (quiet-console phase 26, exit criterion 2): every act the
 * operator-verb table holds has a row from anywhere.
 *
 * Where the address names the act's record — a plan's slug, a phase, a lane, a
 * run of the plan's history — the row presses it, confirmed by a second press,
 * with the record's identity where the CLI would send it; an act that takes
 * more than a press is a row to where it is drawn. Where the address cannot
 * name the record, the row is the line a terminal presses it with (Pro's CLI
 * presses acts; the free build's reads only), else its door. A verb whose flag
 * the console lacks names the flag and does nothing. The acts no route answers
 * close the section as their lines. These are the builders, called directly;
 * `palette.test.tsx` is the dialog around them.
 */

import { describe, expect, it, vi } from 'vitest';
import { OPERATOR_VERBS } from '@shared/verb-model.js';
import type { ConsoleState } from '@/data/api';
import { SURFACE } from '@/data/surface';
import { verbArgsOf, verbIdentity } from '../panel/verbs';
import { parseHash } from '../routes';
import {
  paletteActions,
  registryActions,
  terminalActions,
  type CommandAction,
  type CommandContext,
} from './actions';

/** Every act the table holds and the registry draws. */
const ACTS = (OPERATOR_VERBS as readonly { name: string; kind: string }[])
  .filter((verb) => verb.kind === 'act')
  .map((verb) => verb.name)
  .filter((name) => SURFACE.some((row) => row.kind === 'verb' && row.verb === name));

/** The acts that take more than their record's identity — never pressed with an empty body. */
const TAKES_MORE = new Set([
  'steer',
  'ask',
  'answer',
  'identity',
  'note',
  'switch-account',
  'trigger',
  'queue-policy',
  'raise-budget',
  'plan-approval',
  'verify-command',
  'delegate',
  'settings',
]);

/** The palette opened at `hash`, on a console with these facts. */
function at(hash: string, state: Partial<ConsoleState> = {}) {
  const context = {
    state: { autopilot: true, allowRun: true, allowWrites: true, ...state } as ConsoleState,
    route: parseHash(hash),
    plans: [],
    runs: [],
    go: vi.fn(),
    setTheme: vi.fn(),
    setDensity: vi.fn(),
    pressVerb: vi.fn(),
    copyLine: vi.fn(),
  } satisfies CommandContext;
  return context;
}

const rowOf = (actions: CommandAction[], verb: string) => {
  const row = actions.find((action) => action.id === `verb:${verb}`);
  expect(row, verb).toBeDefined();
  return row!;
};

describe('every act has a row', () => {
  it('from anywhere — the Runs page names no record at all', () => {
    const context = at('#/runs');
    const actions = registryActions(context);
    expect(ACTS.length).toBeGreaterThan(40);
    for (const verb of ACTS) {
      const row = rowOf(actions, verb);
      row.run(context);
      // Its line, copied, or its door — never a press with nothing to name.
      expect(context.pressVerb, verb).not.toHaveBeenCalled();
      if (row.label.startsWith('phase-console run ')) {
        expect(row.label.startsWith(`phase-console run ${verb}`), verb).toBe(true);
        expect(context.copyLine, verb).toHaveBeenLastCalledWith(row.label);
      } else {
        expect(row.label, verb).toBe(verb);
        expect(context.go, verb).toHaveBeenLastCalledWith(expect.stringMatching(/^#\//));
      }
    }
  });

  it('pressable where the address names its record, carrying the identity where the CLI sends it', () => {
    const context = at('#/plan/demo/phase/3?run=r1');
    const actions = registryActions(context);
    for (const verb of ACTS) {
      const { record, fields } = verbIdentity(verb);
      // A card's id and a trigger's id are no address's to name.
      if (record === 'approval' || record === 'trigger') continue;
      const row = rowOf(actions, verb);
      context.pressVerb.mockClear();
      context.go.mockClear();
      row.run(context);
      if (TAKES_MORE.has(verb)) {
        expect(row.confirm, verb).toBeFalsy();
        expect(context.pressVerb, verb).not.toHaveBeenCalled();
        expect(context.go, verb).toHaveBeenCalledTimes(1);
        continue;
      }
      expect(row.confirm, verb).toBe(true);
      expect(row.label, verb).toBe(verb);
      expect(context.pressVerb, verb).toHaveBeenCalledTimes(1);
      const [name, args, body] = context.pressVerb.mock.calls[0] as [
        string,
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(name).toBe(verb);
      const sent = { ...args, ...body };
      if (fields.includes('slug')) expect(sent.slug, verb).toBe('demo');
      if (fields.includes('phase')) expect(sent.phase ?? sent.n, verb).toBe(3);
      if (fields.includes('runId')) expect(sent.runId, verb).toBe('r1');
    }
  });

  it('puts a phase in the body where the route has no place for it, and nothing it was not asked for', () => {
    const context = at('#/plan/demo/run?lane=p4');
    const actions = registryActions(context);
    const press = (verb: string) => {
      context.pressVerb.mockClear();
      rowOf(actions, verb).run(context);
      return context.pressVerb.mock.calls[0];
    };
    expect(press('pin')).toEqual(['pin', {}, { slug: 'demo', phase: 4 }]);
    expect(press('bump')).toEqual(['bump', {}, { slug: 'demo', phase: 4 }]);
    expect(press('retry')).toEqual(['retry', { slug: 'demo' }, { phase: 4 }]);
    expect(press('skip')).toEqual(['skip', { slug: 'demo' }, { phase: 4 }]);
    expect(press('errand-answered')).toEqual(['errand-answered', { slug: 'demo', n: 4 }, {}]);
    expect(press('pause')).toEqual(['pause', { slug: 'demo' }, {}]);
    expect(press('start')).toEqual(['start', { slug: 'demo' }, {}]);
  });

  it('sends an act that takes more to where it is drawn — the plan’s own page, not a plan called "run"', () => {
    const context = at('#/plan/demo/run?lane=p4');
    const actions = registryActions(context);
    const steer = rowOf(actions, 'steer');
    expect(steer.hint).toBe('On the plan’s run — it takes the words to send');
    steer.run(context);
    expect(context.go).toHaveBeenLastCalledWith('#/plan/demo/run');
    rowOf(actions, 'queue-policy').run(context);
    expect(context.go).toHaveBeenLastCalledWith('#/settings/automation');
  });

  it('offers a run’s card dismissal only once the address names the run — else at its door', () => {
    const named = at('#/plan/demo/run?view=history&run=r9');
    rowOf(registryActions(named), 'resolve').run(named);
    expect(named.pressVerb).toHaveBeenCalledWith('resolve', { slug: 'demo' }, { runId: 'r9' });

    const unnamed = at('#/plan/demo/run');
    const resolve = rowOf(registryActions(unnamed), 'resolve');
    expect(resolve.confirm).toBeFalsy();
    resolve.run(unnamed);
    expect(unnamed.pressVerb).not.toHaveBeenCalled();
    expect(unnamed.go).toHaveBeenCalledTimes(1);
  });

  it('offers a verb this console cannot press disabled, naming the flag — wherever it is, however it is offered', () => {
    for (const hash of ['#/runs', '#/plan/demo/phase/3']) {
      const actions = registryActions(at(hash, { allowRun: false }));
      for (const verb of ACTS) {
        const row = rowOf(actions, verb);
        expect(row.disabled, `${hash} ${verb}`).toBe(true);
        expect(row.hint, `${hash} ${verb}`).toBe('Needs --allow-run');
      }
      // A read needs no flag.
      expect(rowOf(actions, 'accounts').disabled).toBe(false);
    }
  });
});

describe('the address names the record', () => {
  it('reads a plan’s slug, a phase from its page, a lane or ?phase=, and a run from the history', () => {
    expect(verbArgsOf(parseHash('#/runs'))).toEqual({});
    expect(verbArgsOf(parseHash('#/plan/demo/run'))).toEqual({ slug: 'demo' });
    expect(verbArgsOf(parseHash('#/plan/demo/phase/3'))).toEqual({ slug: 'demo', phase: 3 });
    expect(verbArgsOf(parseHash('#/plan/demo/run?lane=p12'))).toEqual({ slug: 'demo', phase: 12 });
    expect(verbArgsOf(parseHash('#/plan/demo/phases?phase=2'))).toEqual({ slug: 'demo', phase: 2 });
    expect(verbArgsOf(parseHash('#/plan/demo/run?view=history&run=r9'))).toEqual({
      slug: 'demo',
      runId: 'r9',
    });
    // An address is user input: a lane that is not a phase selects nothing.
    expect(verbArgsOf(parseHash('#/plan/demo/run?lane=waiting'))).toEqual({ slug: 'demo' });
    expect(verbArgsOf(parseHash('#/plan/demo/phase/0'))).toEqual({ slug: 'demo' });
  });
});

describe('the lines a terminal runs', () => {
  it('closes *do* with the acts no route answers, each copied — never pressed', () => {
    const context = at('#/runs');
    const lines = terminalActions();
    const strays = lines.find((row) => row.label === 'phase-console doctor --stop-strays');
    expect(strays?.hint).toMatch(/^Stop the stray consoles/);
    strays!.run(context);
    expect(context.copyLine).toHaveBeenCalledWith('phase-console doctor --stop-strays');
    expect(context.pressVerb).not.toHaveBeenCalled();
    // Last in *do*, after every verb.
    const all = paletteActions(context);
    const first = all.findIndex((row) => row.id.startsWith('line:'));
    expect(all[first - 1]?.id).toMatch(/^verb:/);
    expect(all.slice(first).every((row) => row.id.startsWith('line:') && row.group === 'Do')).toBe(true);
  });

});
