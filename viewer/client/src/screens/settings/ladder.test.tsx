/**
 * Settings ▸ Automation, what happens when a phase stops (quiet-console phase
 * 21).
 *
 * What it holds: twenty-six keys, each drawn once, read from the server's
 * settings schema — the ladder's limits in attempts and dollars, what the
 * console does by itself, what it does at a usage wall, the stall thresholds —
 * each saving exactly its own key (the wire is the contract); a clock is typed
 * in minutes and sent in milliseconds; a threshold the server keeps only above
 * zero refuses a zero rather than having its save dropped, and a clock whose
 * zero means something takes it; resume-at-boot is three words and sends one,
 * reading a stored boolean through its owner; a key set here says so, and
 * Reset takes it out of the file; the start ceiling is another group's.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrefSchemaRow } from '@/data/console';
import { keys } from '@/data/keys';
import { renderWithClient, schemaAnswer, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import { LadderGroups } from './ladder';

type Over = Record<string, Partial<PrefSchemaRow>>;

/** What the server answers for a console that stored nothing (`server/config.ts` `DEFAULT_PREFS`). */
const SHIPPED: Readonly<Record<string, unknown>> = {
  ladderPerPhaseRungs: 3,
  ladderPerPhaseUsd: 100,
  ladderPerRunRungs: 10,
  ladderPerRunUsd: 400,
  ladderPerDayUsd: 600,
  budgetAutoRaisePct: 25,
  ladderExtendOnProgress: false,
  unblockAttempts: true,
  staleClaimTakeover: true,
  resumeAtBoot: 'ask',
  delegateHumanGates: true,
  allowUnverifiedPhases: false,
  convergeEveryMs: 300_000,
  mcpRequireTimeoutMs: 1_800_000,
  autoAccountSwitch: true,
  usageForecastLeadHours: 2,
  usageForecastHold: false,
  stallSilentMs: 600_000,
  stallRetryBurst: 5,
  stallExternalWaitMs: 300_000,
  stallAutomaticPark: true,
  stallLocalJobMs: 2_700_000,
  stallSpinTurns: 6,
  stallLoopRun: 3,
  stallStalemateAttempts: 3,
  stallEscalateMs: 2_700_000,
};

const BOXES = [
  'ladderExtendOnProgress',
  'unblockAttempts',
  'staleClaimTakeover',
  'delegateHumanGates',
  'allowUnverifiedPhases',
  'autoAccountSwitch',
  'usageForecastHold',
  'stallAutomaticPark',
];

function schema(over: Over = {}) {
  const rows: Over = {};
  for (const [key, value] of Object.entries(SHIPPED)) rows[key] = { value, default: value };
  for (const [key, row] of Object.entries(over)) rows[key] = { ...rows[key], ...row };
  return schemaAnswer(rows);
}

async function mount(over: Over = {}) {
  server.reads['/api/prefs/schema'] = schema(over);
  const view = renderWithClient(<LadderGroups />);
  await waitFor(() => expect(view.client.getQueryState(keys.prefsSchema())?.status).toBe('success'));
  return view;
}

function row(key: string): HTMLElement {
  const found = document.querySelectorAll<HTMLElement>(`[data-pref="${key}"]`);
  expect(found, `${key} has exactly one control`).toHaveLength(1);
  return found[0]!;
}
const box = (key: string) => within(row(key)).getByRole('checkbox');
const drawn = () => [...document.querySelectorAll('[data-pref]')].map((el) => el.getAttribute('data-pref'));
const saves = () => sent(server, 'POST', '/api/prefs');
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const resume = () => screen.getByLabelText('Resume killed lanes at boot') as HTMLSelectElement;

/** Type into a number and leave it. */
function enter(label: string, typed: string) {
  const input = field(label);
  fireEvent.change(input, { target: { value: typed } });
  fireEvent.blur(input);
}

beforeEach(() => {
  server.calls = [];
  server.reads = { 'POST /api/prefs': {} };
});

describe('what happens when a phase stops', () => {
  it('a console that stored nothing reads as the shipped defaults, each key drawn once', async () => {
    await mount();
    expect(drawn().sort()).toEqual(Object.keys(SHIPPED).sort());
    // The start ceiling is the next group's, never a second control here.
    expect(drawn()).not.toContain('ceilingStartsPerHour');
    expect(drawn()).not.toContain('ceilingUsdPerHour');
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'The ladder',
      'What it does by itself',
      'At a usage wall',
      'When a lane stops being work',
    ]);

    const numbers = {
      'Repair attempts per phase': '3',
      'Repair spend per phase': '100',
      'Repair attempts per run': '10',
      'Repair spend per run': '400',
      'Repair spend per day': '600',
      'Raise a spent run budget once by': '25',
      // The clocks in minutes, never milliseconds.
      'Sweep every': '5',
      'Park on a required MCP server for': '30',
      'Warn before an account walls': '2',
      'Call a lane silent after': '10',
      'Call it retrying after': '5',
      'Park a lane waiting on an external clock after': '5',
      'Park a lane waiting on its own background job after': '45',
      'Call it spinning after': '6',
      'Call it looping after': '3',
      'Call it a stalemate after': '3',
      'Say it again, urgently, after': '45',
    };
    for (const [label, value] of Object.entries(numbers)) expect(field(label).value, label).toBe(value);

    // Five on: the four the console always did, and delegated gates since
    // 5.0.0. Three off, each deliberately: a phase with no verification, one
    // more attempt's money, and holding work on a forecast.
    expect(Object.fromEntries(BOXES.map((key) => [key, box(key).getAttribute('aria-checked')]))).toEqual({
      ladderExtendOnProgress: 'false',
      unblockAttempts: 'true',
      staleClaimTakeover: 'true',
      delegateHumanGates: 'true',
      allowUnverifiedPhases: 'false',
      autoAccountSwitch: 'true',
      usageForecastHold: 'false',
      stallAutomaticPark: 'true',
    });
    expect(resume().value).toBe('ask');
    expect([...resume().options].map((o) => o.textContent)).toEqual(['Ask', 'Always', 'Never']);

    // The shipped numbers are said where a person decides, in a person's units.
    expect(row('ladderPerPhaseRungs')).toHaveTextContent('(shipped: 3)');
    expect(row('ladderPerRunUsd')).toHaveTextContent('(shipped: $400)');
    expect(row('budgetAutoRaisePct')).toHaveTextContent('(shipped: 25%)');
    expect(row('convergeEveryMs')).toHaveTextContent('(shipped: 5 minutes)');
    expect(row('mcpRequireTimeoutMs')).toHaveTextContent('(shipped: 30 minutes)');
    expect(row('usageForecastLeadHours')).toHaveTextContent('(shipped: 2 hours)');
    expect(row('stallSilentMs')).toHaveTextContent('(shipped: 10 minutes)');
    expect(row('stallLocalJobMs')).toHaveTextContent('(shipped: 45 minutes)');
    expect(row('stallEscalateMs')).toHaveTextContent('(shipped: 45 minutes)');
    expect(row('stallRetryBurst')).toHaveTextContent('(shipped: 5)');
    expect(screen.queryByText('Set here')).toBeNull();
  });

  it('renders the stored choices, not the defaults', async () => {
    await mount({
      ladderPerDayUsd: { value: 900, source: 'instance' },
      convergeEveryMs: { value: 0, source: 'instance' },
      mcpRequireTimeoutMs: { value: 0, source: 'instance' },
      resumeAtBoot: { value: 'off', source: 'instance' },
      usageForecastHold: { value: true, source: 'instance' },
    });
    expect(field('Repair spend per day').value).toBe('900');
    expect(field('Sweep every').value).toBe('0');
    expect(field('Park on a required MCP server for').value).toBe('0');
    expect(resume().value).toBe('off');
    expect(box('usageForecastHold')).toHaveAttribute('aria-checked', 'true');
  });

  it('each box sends exactly its own key, as the boolean it flips to', async () => {
    await mount();
    for (const [i, key] of BOXES.entries()) {
      fireEvent.click(box(key));
      await waitFor(() => expect(saves()).toHaveLength(i + 1));
    }
    expect(saves()).toEqual(BOXES.map((key) => ({ [key]: !SHIPPED[key] })));
  });

  it('the two posture opt-ins are off, and each sends exactly its own key when ticked', async () => {
    // Fully plumbed server preferences the moment they existed; a preference
    // with no control is the hand-edit-config.json trap again.
    await mount();
    for (const key of ['allowUnverifiedPhases', 'ladderExtendOnProgress']) {
      expect(box(key)).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(box(key));
    }
    await waitFor(() =>
      expect(saves()).toEqual([{ allowUnverifiedPhases: true }, { ladderExtendOnProgress: true }]),
    );
  });

  it('the watchdog’s own park is on, and unticking it sends only its own key', async () => {
    await mount();
    expect(box('stallAutomaticPark')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box('stallAutomaticPark'));
    await waitFor(() => expect(saves()).toEqual([{ stallAutomaticPark: false }]));
  });

  it('a session may clear an overdue gate, on since 5.0.0, and a manual gate stays a person’s', async () => {
    await mount();
    expect(row('delegateHumanGates')).toHaveTextContent(
      'A gate the plan marks manual is yours whatever this says.',
    );
    expect(box('delegateHumanGates')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box('delegateHumanGates'));
    await waitFor(() => expect(saves()).toEqual([{ delegateHumanGates: false }]));
  });

  it('saves a limit as its own key when the field is left', async () => {
    await mount();
    enter('Repair spend per run', '12');
    await waitFor(() => expect(saves()).toEqual([{ ladderPerRunUsd: 12 }]));
  });

  it('a clock is typed in minutes and sent in milliseconds', async () => {
    await mount();
    const sweep = field('Sweep every');
    fireEvent.change(sweep, { target: { value: '2' } });
    fireEvent.keyDown(sweep, { key: 'Enter' });
    await waitFor(() => expect(saves()).toEqual([{ convergeEveryMs: 120_000 }]));
    enter('Say it again, urgently, after', '1.5');
    await waitFor(() => expect(saves()).toEqual([{ convergeEveryMs: 120_000 }, { stallEscalateMs: 90_000 }]));
  });

  it('saves nothing for an unchanged or unusable value, and Escape puts the held value back', async () => {
    await mount();
    enter('Repair attempts per run', '10');
    enter('Repair attempts per run', '-4');
    expect(within(row('ladderPerRunRungs')).getByText('Type 0 or more.')).toBeInTheDocument();
    enter('Repair attempts per run', '2.5');
    expect(within(row('ladderPerRunRungs')).getByText('Type a whole number.')).toBeInTheDocument();
    fireEvent.keyDown(field('Repair attempts per run'), { key: 'Escape' });
    expect(field('Repair attempts per run').value).toBe('10');
    expect(within(row('ladderPerRunRungs')).queryByText('Type a whole number.')).toBeNull();
    expect(saves()).toEqual([]);
  });

  it('a threshold the server keeps only above zero refuses a zero; a clock whose zero means something takes it', async () => {
    await mount();
    // `positive` on the server: a zero would be dropped in silence, so the row says so first.
    for (const [label, key] of [
      ['Call a lane silent after', 'stallSilentMs'],
      ['Call it spinning after', 'stallSpinTurns'],
      ['Call it retrying after', 'stallRetryBurst'],
      ['Call it looping after', 'stallLoopRun'],
      ['Call it a stalemate after', 'stallStalemateAttempts'],
      ['Park a lane waiting on its own background job after', 'stallLocalJobMs'],
    ] as const) {
      enter(label, '0');
      expect(within(row(key)).getByText('Type 1 or more.')).toBeInTheDocument();
    }
    expect(saves()).toEqual([]);
    expect(row('stallLocalJobMs')).toHaveTextContent('This clock has no off.');
    // `cap` on the server: zero is an answer, and the hint says which.
    expect(row('stallExternalWaitMs')).toHaveTextContent('0 never parks a lane for waiting.');
    expect(row('stallEscalateMs')).toHaveTextContent('0 never escalates a stall.');
    enter('Park a lane waiting on an external clock after', '0');
    await waitFor(() => expect(saves()).toEqual([{ stallExternalWaitMs: 0 }]));
  });

  it('resume-at-boot is three words, and sends the one chosen', async () => {
    await mount();
    fireEvent.change(resume(), { target: { value: 'auto' } });
    await waitFor(() => expect(saves()).toEqual([{ resumeAtBoot: 'auto' }]));
  });

  it('a stored boolean reads through its owner: true was the only value that resumed at all, so it is Ask', async () => {
    const view = await mount({ resumeAtBoot: { value: true, source: 'migrated' } });
    expect(resume().value).toBe('ask');
    expect(within(row('resumeAtBoot')).getByText('Read from an older setting')).toBeInTheDocument();
    view.unmount();
    await mount({ resumeAtBoot: { value: false, source: 'migrated' } });
    expect(resume().value).toBe('off');
  });

  it('a key set here says so, and Reset takes it out of the file', async () => {
    await mount({ ladderPerRunUsd: { value: 12, source: 'instance' } });
    expect(field('Repair spend per run').value).toBe('12');
    expect(within(row('ladderPerRunUsd')).getByText('Set here')).toBeInTheDocument();
    fireEvent.click(
      within(row('ladderPerRunUsd')).getByRole('button', { name: 'Reset ladderPerRunUsd to its default' }),
    );
    await waitFor(() => expect(saves()).toEqual([{ ladderPerRunUsd: null }]));
  });
});
