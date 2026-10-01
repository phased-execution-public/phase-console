/**
 * Two things the quick view says about WHO and HOW (control-tower phase 22):
 *
 * - the start and resume screens show which login each account id answers
 *   as NOW (phase 91's binding), so a `default` that is the same login as a
 *   named profile is never offered as a second account (fifth amendment);
 * - a phase's permission mode is shown with the level that decided it (#34),
 *   in the runner's own order.
 */

import { describe, expect, it } from 'vitest';
import type { AccountView, PhaseView } from '@/lib/api';
import { phaseModeSource } from './per-phase';
import { accountOption, offeredAccounts, sameLogin } from './sections';

const machine = {
  id: 'default',
  kind: 'default',
  builtIn: true,
  email: 'me@example.com',
  credential: 'fp-me',
} as AccountView;
const work = {
  id: 'work',
  kind: 'profile',
  builtIn: false,
  name: 'work',
  email: 'me@example.com',
  credential: 'fp-me',
} as AccountView;
const other = {
  id: 'other',
  kind: 'token',
  builtIn: false,
  email: 'them@example.com',
  credential: 'fp-them',
} as AccountView;

describe('one entry per login', () => {
  it('knows two ids that answer as one login — by fingerprint, else by email in one organisation', () => {
    expect(sameLogin(machine, work)).toBe(true);
    expect(sameLogin(machine, other)).toBe(false);
    const a = { ...machine, credential: undefined, orgId: 'o1' } as AccountView;
    const b = { ...work, credential: undefined, orgId: 'o1' } as AccountView;
    expect(sameLogin(a, b)).toBe(true);
    expect(sameLogin(a, { ...b, orgId: 'o2' } as AccountView)).toBe(false);
  });

  it('never offers the machine login beside the profile it is', () => {
    expect(offeredAccounts([machine, work, other], 'auto').map((a) => a.id)).toEqual(['work', 'other']);
    // The chosen id of the two stays, so the select still shows what the run is on…
    expect(offeredAccounts([machine, work, other], 'default').map((a) => a.id)).toEqual(['default', 'other']);
    // …named as the profile it is.
    expect(accountOption(machine, [machine, work, other])).toBe('work — the machine login');
    // A login nobody else answers as keeps its own entry, with who it is now.
    expect(accountOption(other, [machine, work, other])).toBe('them@example.com');
    expect(accountOption(work, [machine, work, other])).toBe('work — me@example.com');
    expect(offeredAccounts([machine, other], 'default').map((a) => a.id)).toEqual(['default', 'other']);
  });
});

describe("a phase's permission mode and its source", () => {
  const phase = (bullets: { label: string; body: string }[] = []) =>
    ({ phase: 3, title: 'x', bullets }) as PhaseView;

  it("says this phase's own choice first", () => {
    expect(phaseModeSource(phase(), { permissionMode: 'plan' }, 'acceptEdits')).toMatch(
      /chosen here for this phase/,
    );
  });

  it("then the plan's bullet on the phase", () => {
    expect(
      phaseModeSource(phase([{ label: 'Permission mode', body: 'plan — read first' }]), {}, 'acceptEdits'),
    ).toMatch(/the plan asks for it on this phase/);
  });

  it("then the plan's line, else the run's default, else accept edits", () => {
    expect(phaseModeSource(phase(), {}, 'dontAsk')).toMatch(/this run’s default/);
    expect(phaseModeSource(phase(), {}, '')).toMatch(/else accept edits/);
  });
});
