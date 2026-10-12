/**
 * Every automation key reaches a control in Settings ▸ Automation, and reaches
 * exactly one (quiet-console phase 21, exit criterion 2 — 6.x's
 * `features/settings/automation-coverage.test.tsx`, carried to 7.0's place).
 *
 * The keys are the SERVER's: the settings schema's automation group
 * (`shared/prefs-model.js` `PREF_META`), which holds every `AUTOMATION_KEYS`
 * entry plus the four keys that are objects or another door's — so a key
 * added to the table is a key this test demands a control for. Two gaps are
 * why it walks them at all: `settle` was once in the loader and in no card,
 * and `stallEscalateMs` was drawn while absent from the client's own type.
 *
 * ⚠️ **Drawn once, not merely drawn.** A key with two controls is worse than
 * one with none: the two disagree the moment their fallbacks do, and a person
 * who changes the one that is not wired believes they changed the setting.
 * That is why the assertion is on the COUNT, of the `data-pref` each control
 * carries for exactly this reason — never of labels, which are prose and meant
 * to change freely.
 *
 * The exemptions below are keys whose control is somewhere else on purpose,
 * and each says where. An exemption is a decision; growing the list to quiet a
 * red gate is how the coverage stops meaning anything.
 */

import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient, schemaAnswer, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

/** The launch form, stood in for: what it was asked to draw is what Automation decides. */
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

import { AUTOMATION_KEYS } from '@shared/automation-model.js';
import { POLICY_TABLE } from '@shared/policy-model.js';
import { PREF_META } from '@shared/prefs-model.js';
import { AutomationSection } from './automation';

const FORM = 'the launch form, inline in its defaults mode (Automation ▸ Launch defaults)';

/** Where a key's control lives, when it is not one of Automation's own rows. */
const ELSEWHERE: Readonly<Record<string, string>> = {
  // The run-governing defaults are the launch form's own fields, drawn inline
  // in its `defaults` mode — so the words a person reads when setting a
  // default are the words they read when starting a run, and "the default"
  // and "this launch" are one form.
  attachDefaultSkills: FORM,
  qaByDefault: FORM,
  gitMode: FORM,
  settle: FORM,
  openPrOnComplete: FORM,
  isolation: FORM,
  reviewEachPhaseByDefault: FORM,
  reviewerPolicy: FORM,
  autoRecoverByDefault: FORM,
  maxConcurrentPerRepo: FORM,
  worktreeRetention: FORM,
  baseBranch: FORM,
  landing: FORM,
  conflictPolicy: FORM,
  messaging: FORM,
  issuesMode: FORM,
  // A policy about servers belongs beside the servers, where a person sees
  // which ones it would apply to.
  mcpPolicy: 'Settings ▸ MCP servers',
};

/**
 * Drawn here, written through ANOTHER door: the queue's words and its load
 * factor are the scheduler's (`POST /api/queue/policy`), which is why the
 * schema calls them read-only and Everything sends a person here for them.
 */
const QUEUE_DOOR = ['schedulingPolicy', 'schedulingPolicies', 'loadGuardFactor'];

/** The groups of the settings schema this section answers for. */
const GROUPS: readonly string[] = [
  'automation',
];

/** Every key the section must draw: the schema's groups, less the exemptions. */
const OWN = Object.entries(PREF_META as Record<string, { group: string }>)
  .filter(([key, meta]) => GROUPS.includes(meta.group) && !(key in ELSEWHERE))
  .map(([key]) => key)
  .sort();

/** A console that may do everything the section offers, so no control is hidden for want of a flag. */
function serve(prefs: Record<string, unknown>) {
  server.reads = {
    '/api/state': {
      root: { ok: true, path: '/home/x/repo' },
      home: '/home/x',
      prefs,
      allowRun: true,
      allowWrites: true,
      allowPublish: false,
      fleet: { frozen: false, at: null, by: null },
      models: ['opus', 'sonnet'],
    },
    '/api/prefs/schema': schemaAnswer(),
    '/api/plans': [{ slug: 'shop', phases: 3, ready: [] }],
    '/api/queue': {
      entries: [],
      lanes: [],
      hinted: [],
      withdrawn: [],
      audit: [],
      grants: [],
      policy: { console: 'seniority', plans: { shop: 'critical-path' }, default: 'seniority' },
      load: { avg5: 2.5, cores: 8, factor: 1.5, threshold: 12, holding: false },
    },
    '/api/hooks-install': {
      path: '/home/x/.claude/settings.json',
      exists: true,
      installed: false,
      partial: false,
      events: { SessionStart: false, SessionEnd: false, Stop: false },
      command: 'bash "/opt/skill/scripts/session-hook.sh"',
      stale: false,
    },
    '/api/accounts': {
      allowAccounts: true,
      accounts: [{ id: 'default', kind: 'default', builtIn: true, email: 'me@example.com' }],
    },
    'POST /api/prefs': {},
  };
}

/** The markers each mount drew: the keys, and the policy table's rows. */
interface Drawn {
  prefs: string[];
  policy: string[];
  /** The keys drawn inside The queue's group. */
  queue: string[];
}

/** The keys a control is drawn for only once its read has answered — so the count is of a settled section. */
const SETTLED = [
  'boardingSchedule',
  'relayRules',
  'policy',
  'loadGuardFactor',
  'schedulingPolicies',
  'ceilingUsdPerHour',
];

/** Mount the WHOLE section, not a card of it: a second control is as likely in a group added tomorrow. */
async function mount(prefs: Record<string, unknown> = {}): Promise<Drawn> {
  serve(prefs);
  const { container, client, unmount } = renderWithClient(<AutomationSection />);
  await screen.findByTestId('launch-form');
  await waitFor(() => {
    for (const key of SETTLED) expect(container.querySelector(`[data-pref="${key}"]`), key).toBeTruthy();
    expect(client.isFetching()).toBe(0);
  });
  const attr = (selector: string, name: string, within: ParentNode = container) =>
    [...within.querySelectorAll(selector)].map((el) => el.getAttribute(name) ?? '');
  const queue = container.querySelector('[data-settings-group="queue"]');
  const drawn: Drawn = {
    prefs: attr('[data-pref]', 'data-pref'),
    policy: attr('[data-policy-control]', 'data-policy-control'),
    queue: queue ? attr('[data-pref]', 'data-pref', queue) : [],
  };
  unmount();
  return drawn;
}

/** How many times each key was drawn in one mount. */
function tally(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

beforeEach(() => {
  server.calls = [];
  launch.props = [];
});

describe('Settings ▸ Automation draws every automation key, once', () => {
  it('every key of the schema’s automation group has exactly one control here, or is named elsewhere', async () => {
    expect(OWN.length).toBeGreaterThan(40);
    /*
     * Both reachable shapes of the section. The four worktree knobs are drawn
     * only while new runs are isolated — a cap on console-managed checkouts
     * means nothing to a run that will never have one, and the section says
     * so. Mounting once would report them missing, and exempting them would
     * stop checking them at all; walking both keeps the claim honest: every
     * key reaches a control in some state a person can get to. Duplication
     * is counted WITHIN a mount — a control drawn in both states is one.
     */
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const prefs of [{}, { isolation: 'worktree' }]) {
      const { prefs: keys } = await mount(prefs);
      for (const [key, n] of tally(keys)) {
        seen.add(key);
        if (n > 1) duplicated.push(`${key} ×${n} (${JSON.stringify(prefs)})`);
      }
    }
    const missing = OWN.filter((key) => !seen.has(key));
    const stray = [...seen].filter((key) => !OWN.includes(key)).sort();
    expect(missing, 'these keys load and save, and no control here reaches them').toEqual([]);
    expect(duplicated, 'two controls for one key disagree the day their fallbacks do').toEqual([]);
    expect(stray, 'a control here for a key another place owns, or the schema lacks').toEqual([]);
  }, 30_000);

  it('the launch form is drawn inline in its defaults mode, and none of its fields again', async () => {
    const drawn = await mount();
    expect(launch.props.at(-1)).toMatchObject({ mode: 'defaults' });
    const formKeys = Object.keys(ELSEWHERE).filter((key) => ELSEWHERE[key] === FORM);
    expect(formKeys).toHaveLength(16);
    expect(drawn.prefs.filter((key) => formKeys.includes(key))).toEqual([]);
  });

  it('every row of the policy table has exactly one control, and the object they write is one key', async () => {
    expect(POLICY_TABLE.length).toBeGreaterThan(10);
    const drawn = await mount();
    const counts = tally(drawn.policy);
    const classes: readonly string[] = POLICY_TABLE.map((row) => row.class);
    expect(
      classes.filter((cls) => !counts.has(cls)),
      'a policy row with no control',
    ).toEqual([]);
    expect(
      [...counts].filter(([, n]) => n > 1).map(([cls, n]) => `${cls} ×${n}`),
      'two controls on one row',
    ).toEqual([]);
    expect(
      [...counts.keys()].filter((cls) => !classes.includes(cls)),
      'a control for a row the table lacks',
    ).toEqual([]);
    expect(drawn.prefs.filter((key) => key === 'policy')).toHaveLength(1);
  });

  it('the queue’s word, its per-plan words and its load factor are drawn in The queue, and only there', async () => {
    for (const key of QUEUE_DOOR) {
      expect(
        (PREF_META as Record<string, { writable: boolean }>)[key]?.writable,
        `${key} is the queue door’s`,
      ).toBe(false);
    }
    const drawn = await mount();
    expect(drawn.queue.filter((key) => QUEUE_DOOR.includes(key)).sort()).toEqual([...QUEUE_DOOR].sort());
    for (const key of QUEUE_DOOR)
      expect(
        drawn.prefs.filter((one) => one === key),
        key,
      ).toHaveLength(1);
  });


  it('the schema’s table holds every automation key, and every exemption names a key it still has', () => {
    const meta = PREF_META as Record<string, unknown>;
    expect(
      AUTOMATION_KEYS.filter((key) => !(key in meta)),
      'an automation key the schema does not serve',
    ).toEqual([]);
    expect(
      Object.keys(ELSEWHERE).filter((key) => !(key in meta)),
      'these exemptions name keys that no longer exist',
    ).toEqual([]);
  });
});
