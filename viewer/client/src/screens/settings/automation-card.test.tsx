/**
 * Settings ▸ Automation, what every launch opens on (quiet-console phase 21).
 *
 * What it holds: the launch form is drawn inline in its `defaults` mode — the
 * one door, never a second form, and none of its keys drawn again — and the
 * console's own keys around it read the server's settings schema, each saving
 * exactly its own key (the wire is the contract a setting keeps); a key set
 * here says so, and Reset takes it out of the file; the four worktree knobs
 * are drawn only while new runs are isolated, read where the launch form
 * writes it, and a sentence says why otherwise; the two keys whose values are
 * words send words, never a boolean the door would drop; the start flag is
 * said, never offered; and the freeze is an act pressed through the fleet
 * door.
 *
 * The launch form itself is the launch screen's to test (`screens/launch/`).
 */

import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrefSchemaRow } from '@/data/console';
import { keys } from '@/data/keys';
import { settingsHref } from '@/shell/routes';
import { Toaster, dismissToast, useToasts } from '@/ui';
import { renderWithClient, schemaAnswer, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

/** The form, stood in for: what it was asked to draw is what this file decides. */
const launch = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('@/screens/launch/door', async () => {
  const { createElement } = await import('react');
  return {
    LaunchForm: (props: Record<string, unknown>) => {
      launch.props.push(props);
      return createElement('div', { 'data-testid': 'launch-form' });
    },
  };
});

import { AutomationDefaults } from './automation-card';

type Over = Record<string, Partial<PrefSchemaRow>>;

/** What the server answers for a console that stored nothing: each key at its shipped default. */
const SHIPPED: Readonly<Record<string, unknown>> = {
  autoContinueRecovery: true,
  watchCmdRefs: true,
  watchMintedCmdRefs: false,
  checkJudgement: true,
  checkModel: 'sonnet',
  checkEffort: 'low',
  turnEscalateAfter: 3,
  repoGuard: true,
  radarSerialize: false,
  deleteMergedRunBranches: true,
  worktreeRoot: 'project',
  worktreeMaxConcurrent: 3,
  worktreeSetup: '',
  worktreeCopyEnv: false,
  isolationReclaim: 'clean-only',
  isolation: 'queue',
};

/** The keys this file draws whatever isolation says, and the four it draws only under it. */
const ALWAYS = [
  'autoContinueRecovery',
  'watchCmdRefs',
  'watchMintedCmdRefs',
  'checkJudgement',
  'checkModel',
  'checkEffort',
  'turnEscalateAfter',
  'repoGuard',
  'radarSerialize',
  'deleteMergedRunBranches',
  'worktreeRoot',
];
const ISOLATED_ONLY = ['worktreeMaxConcurrent', 'worktreeSetup', 'worktreeCopyEnv', 'isolationReclaim'];

/** The launch form's keys: it edits them, so none may have a control of this file's. */
const FORM_KEYS = [
  'attachDefaultSkills',
  'qaByDefault',
  'gitMode',
  'settle',
  'openPrOnComplete',
  'isolation',
  'reviewEachPhaseByDefault',
  'reviewerPolicy',
  'autoRecoverByDefault',
  'maxConcurrentPerRepo',
  'worktreeRetention',
  'baseBranch',
  'landing',
  'conflictPolicy',
  'messaging',
  'issuesMode',
];

/** The schema with every key above at its shipped default, then `over`, merged per key. */
function schema(over: Over = {}) {
  const rows: Over = {};
  for (const [key, value] of Object.entries(SHIPPED)) rows[key] = { value, default: value };
  for (const [key, row] of Object.entries(over)) rows[key] = { ...rows[key], ...row };
  return schemaAnswer(rows);
}

/** The console's state: it may run, it pushes nothing, it is not frozen. */
const STATE = {
  prefs: {},
  allowRun: true,
  allowPublish: false,
  fleet: { frozen: false, at: null, by: null },
};

async function mount(over: Over = {}, state: Record<string, unknown> = {}) {
  server.reads['/api/prefs/schema'] = schema(over);
  server.reads['/api/state'] = { ...STATE, ...state };
  const view = renderWithClient(
    <>
      <AutomationDefaults />
      <Toaster />
    </>,
  );
  await waitFor(() => {
    for (const key of [keys.prefsSchema(), keys.state()]) {
      expect(view.client.getQueryState(key)?.status).toBe('success');
    }
  });
  return view;
}

/** The one element carrying a key — one, or the coverage rule is broken. */
function row(key: string): HTMLElement {
  const found = document.querySelectorAll<HTMLElement>(`[data-pref="${key}"]`);
  expect(found, `${key} has exactly one control`).toHaveLength(1);
  return found[0]!;
}
const box = (key: string) => within(row(key)).getByRole('checkbox');
const drawn = () => [...document.querySelectorAll('[data-pref]')].map((el) => el.getAttribute('data-pref'));
const saves = () => sent(server, 'POST', '/api/prefs');
const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
  server.calls = [];
  server.reads = {
    'POST /api/prefs': {},
    'POST /api/fleet/freeze': { fleet: { frozen: true, at: null, by: 'operator' }, runs: 2 },
    'POST /api/fleet/thaw': { fleet: { frozen: false, at: null, by: null }, runs: 2 },
  };
  launch.props = [];
});

afterEach(() => {
  // The tray's store is the module's own and outlives a render.
  const { result, unmount } = renderHook(() => useToasts());
  act(() => {
    for (const one of result.current) dismissToast(one.id);
  });
  unmount();
});

describe('the launch form', () => {
  it('is drawn inline in its defaults mode, first, under Launch defaults — and none of its keys again', async () => {
    await mount();
    const group = document.querySelector<HTMLElement>('[data-settings-group="automation-launch"]')!;
    expect(within(group).getByRole('heading', { name: 'Launch defaults' })).toBeInTheDocument();
    expect(within(group).getByTestId('launch-form')).toBeInTheDocument();
    expect(launch.props.at(-1)).toMatchObject({ mode: 'defaults' });
    // Its host knows what stands in its place while its chunk arrives.
    expect(launch.props.at(-1)!.fallback).toBeTruthy();
    for (const key of FORM_KEYS) expect(drawn(), `${key} is the form's`).not.toContain(key);
  });
});

describe('the keys around it', () => {
  it('a console that stored nothing reads as the shipped defaults, each key drawn once', async () => {
    await mount();
    expect(drawn().sort()).toEqual([...ALWAYS].sort());
    const boxes = Object.fromEntries(
      [
        'autoContinueRecovery',
        'watchCmdRefs',
        'watchMintedCmdRefs',
        'checkJudgement',
        'repoGuard',
        'radarSerialize',
        'deleteMergedRunBranches',
      ].map((key) => [key, box(key).getAttribute('aria-checked')]),
    );
    expect(boxes).toEqual({
      autoContinueRecovery: 'true',
      watchCmdRefs: 'true',
      watchMintedCmdRefs: 'false',
      checkJudgement: 'true',
      repoGuard: 'true',
      radarSerialize: 'false',
      deleteMergedRunBranches: 'true',
    });
    expect(select('Checking model').value).toBe('sonnet');
    expect(select('Checking effort').value).toBe('low');
    expect(select('Worktree root').value).toBe('project');
    expect(field('Send to the owner after').value).toBe('3');
    // The shipped numbers are said where a person decides.
    expect(row('checkModel')).toHaveTextContent('(shipped: sonnet)');
    expect(row('checkEffort')).toHaveTextContent('(shipped: low)');
    expect(row('turnEscalateAfter')).toHaveTextContent('(shipped: 3)');
    // A shipped default is silent: no origin words, no Reset.
    expect(screen.queryByText('Set here')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reset / })).toBeNull();
  });

  it('renders the stored choices, not the defaults', async () => {
    await mount({
      repoGuard: { value: false, source: 'instance' },
      radarSerialize: { value: true, source: 'instance' },
      worktreeRoot: { value: 'state', source: 'instance' },
      checkModel: { value: 'opus', source: 'instance' },
      checkEffort: { value: 'high', source: 'instance' },
      turnEscalateAfter: { value: 5, source: 'instance' },
    });
    expect(box('repoGuard')).toHaveAttribute('aria-checked', 'false');
    expect(box('radarSerialize')).toHaveAttribute('aria-checked', 'true');
    expect(select('Worktree root').value).toBe('state');
    expect(select('Checking model').value).toBe('opus');
    expect(select('Checking effort').value).toBe('high');
    expect(field('Send to the owner after').value).toBe('5');
  });

  it('each box sends exactly its own key, as the boolean it flips to', async () => {
    await mount();
    const keys = [
      'autoContinueRecovery',
      'watchCmdRefs',
      'watchMintedCmdRefs',
      'checkJudgement',
      'repoGuard',
      'radarSerialize',
      'deleteMergedRunBranches',
    ];
    for (const [i, key] of keys.entries()) {
      fireEvent.click(box(key));
      await waitFor(() => expect(saves()).toHaveLength(i + 1));
    }
    expect(saves()).toEqual(keys.map((key) => ({ [key]: !SHIPPED[key] })));
  });

  it('the worktree root and the check’s model and effort send their words', async () => {
    await mount();
    fireEvent.change(select('Worktree root'), { target: { value: 'state' } });
    await waitFor(() => expect(saves()).toHaveLength(1));
    fireEvent.change(select('Checking model'), { target: { value: 'opus' } });
    await waitFor(() => expect(saves()).toHaveLength(2));
    fireEvent.change(select('Checking effort'), { target: { value: 'high' } });
    await waitFor(() => expect(saves()).toHaveLength(3));
    expect(saves()).toEqual([{ worktreeRoot: 'state' }, { checkModel: 'opus' }, { checkEffort: 'high' }]);
    expect([...select('Worktree root').options].map((o) => o.textContent)).toEqual([
      'Inside the project folder',
      'In the state directory',
    ]);
  });

  it('offers the server’s model lineup and a stored model it does not know, never the machine default', async () => {
    await mount(
      { checkModel: { value: 'house-model', source: 'instance' } },
      { models: ['opus', 'sonnet', 'haiku'] },
    );
    expect([...select('Checking model').options].map((o) => o.value)).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'house-model',
    ]);
    expect(select('Checking model').value).toBe('house-model');
    expect([...select('Checking effort').options].map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('the escalation count is a whole number from 1 to 20, the server’s own bounds, sent as one', async () => {
    await mount();
    const input = field('Send to the owner after');
    for (const [typed, words] of [
      ['0', 'Type 1 or more.'],
      ['21', 'Type 20 or less.'],
      ['2.5', 'Type a whole number.'],
    ] as const) {
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.blur(input);
      expect(within(row('turnEscalateAfter')).getByText(words)).toBeInTheDocument();
    }
    expect(saves()).toEqual([]);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(saves()).toEqual([{ turnEscalateAfter: 5 }]));
  });

  it('a key set here says so, and Reset takes it out of the file', async () => {
    await mount({ repoGuard: { value: false, source: 'instance' } });
    expect(within(row('repoGuard')).getByText('Set here')).toBeInTheDocument();
    fireEvent.click(within(row('repoGuard')).getByRole('button', { name: 'Reset repoGuard to its default' }));
    await waitFor(() => expect(saves()).toEqual([{ repoGuard: null }]));
  });

  it('a save the owner must confirm is said in the server’s words, and the box keeps what the console runs with', async () => {
    server.reads['POST /api/prefs'] = {
      requested: true,
      request: { ask: 'asked through the device door — confirm?' },
      error: 'The owner confirms this change before it is made.',
    };
    await mount();
    fireEvent.click(box('repoGuard'));
    expect(await screen.findByText('The owner confirms this change before it is made.')).toBeInTheDocument();
    await waitFor(() => expect(box('repoGuard')).toHaveAttribute('aria-checked', 'true'));
    expect(saves()).toEqual([{ repoGuard: false }]);
  });
});

describe('the worktree knobs', () => {
  it('are not drawn while new runs share the checkout, and a sentence says why', async () => {
    await mount({}, { prefs: { isolation: 'queue' } });
    for (const key of ISOLATED_ONLY) expect(drawn()).not.toContain(key);
    expect(screen.getByTestId('worktree-knobs-off')).toHaveTextContent(/apply to isolated runs only/);
  });

  it('are drawn while new runs are isolated, read where the launch form writes it', async () => {
    // The form's save re-reads the state, not the schema — so the state's word
    // stands even while the schema still says the old one.
    await mount({ isolation: { value: 'queue' } }, { prefs: { isolation: 'worktree' } });
    expect(drawn().sort()).toEqual([...ALWAYS, ...ISOLATED_ONLY].sort());
    expect(screen.queryByTestId('worktree-knobs-off')).toBeNull();
    expect(row('worktreeMaxConcurrent')).toHaveTextContent('(shipped: 3)');
    expect(field('Worktrees at once').value).toBe('3');
    expect(box('worktreeCopyEnv')).toHaveAttribute('aria-checked', 'false');
    expect(box('isolationReclaim')).toHaveAttribute('aria-checked', 'true');
  });

  it('follow the schema while the state names no isolation', async () => {
    await mount({ isolation: { value: 'worktree', source: 'instance' } }, { prefs: {} });
    for (const key of ISOLATED_ONLY) expect(drawn()).toContain(key);
  });

  it('taking the branch back sends a word of the owner’s list, never a boolean', async () => {
    await mount({}, { prefs: { isolation: 'worktree' } });
    fireEvent.click(box('isolationReclaim'));
    await waitFor(() => expect(saves()).toEqual([{ isolationReclaim: 'never' }]));
  });

  it('a stored never reads unticked, and ticking it sends clean-only', async () => {
    await mount(
      { isolationReclaim: { value: 'never', source: 'instance' } },
      { prefs: { isolation: 'worktree' } },
    );
    expect(box('isolationReclaim')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(box('isolationReclaim'));
    await waitFor(() => expect(saves()).toEqual([{ isolationReclaim: 'clean-only' }]));
  });

  it('the setup command is sent trimmed, and an emptied field sends empty', async () => {
    await mount(
      { worktreeSetup: { value: 'make', source: 'instance' } },
      { prefs: { isolation: 'worktree' } },
    );
    const input = field('Setup command');
    expect(input.value).toBe('make');
    fireEvent.change(input, { target: { value: '  npm ci  ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(saves()).toEqual([{ worktreeSetup: 'npm ci' }]));
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(saves()).toEqual([{ worktreeSetup: 'npm ci' }, { worktreeSetup: '' }]));
  });

  it('the cap is a whole number of one or more', async () => {
    await mount({}, { prefs: { isolation: 'worktree' } });
    const input = field('Worktrees at once');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(within(row('worktreeMaxConcurrent')).getByText('Type 1 or more.')).toBeInTheDocument();
    expect(saves()).toEqual([]);
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.blur(input);
    await waitFor(() => expect(saves()).toEqual([{ worktreeMaxConcurrent: 4 }]));
  });
});

describe('outward writes', () => {
  it('says whether --allow-publish is on — a start flag, never a control', async () => {
    await mount({}, { allowPublish: false });
    const line = screen.getByTestId('publish-flag');
    expect(line).toHaveTextContent('Outward writes');
    expect(within(line).getByText('Off')).toBeInTheDocument();
    expect(line).toHaveTextContent('--allow-publish is a start flag, not a preference.');
    expect(line).toHaveTextContent('Nothing is pushed: a pr or trunk landing is held and says so.');
    // There is no control: a start flag is changed at the start command.
    expect(within(line).queryByRole('button')).toBeNull();
    expect(within(line).queryByRole('checkbox')).toBeNull();
    expect(within(line).queryByRole('combobox')).toBeNull();
    expect(line.querySelector('[data-pref]')).toBeNull();
    expect(within(line).getByRole('link', { name: 'Essentials' })).toHaveAttribute(
      'href',
      settingsHref('essentials'),
    );
  });

  it('on, says what a pr or trunk landing then does', async () => {
    await mount({}, { allowPublish: true });
    const line = screen.getByTestId('publish-flag');
    expect(within(line).getByText('On')).toBeInTheDocument();
    expect(line).toHaveTextContent(
      'A phase whose landing is pr or trunk is pushed and its pull request opened.',
    );
  });

});

describe('the freeze', () => {
  it('freezes the whole console in one press, through the fleet door', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Freeze all' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/fleet/freeze')).toEqual([{}]));
    expect(await screen.findByText('Console frozen — 2 runs held where they stand.')).toBeInTheDocument();
    expect(sent(server, 'POST', '/api/fleet/thaw')).toEqual([]);
  });

  it('a frozen console offers Thaw all, says who froze it, and thaws with no question', async () => {
    await mount({}, { fleet: { frozen: true, at: '2026-10-11T09:00:00.000Z', by: 'operator' } });
    expect(screen.queryByRole('button', { name: 'Freeze all' })).toBeNull();
    expect(screen.getByText('Frozen now, by operator.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Thaw all' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/fleet/thaw')).toEqual([{}]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a console that starts nothing has nothing to freeze, and says why', async () => {
    await mount({}, { allowRun: false });
    expect(screen.getByRole('button', { name: 'Freeze all' })).toBeDisabled();
    expect(screen.getByText(/This console starts nothing, so it has nothing to freeze/)).toBeInTheDocument();
  });
});
