/**
 * Every automation preference reaches a control, and reaches exactly one.
 *
 * The Automation section is five cards written at five different times, and
 * the preference list they render between them has never been checked against
 * the list the SERVER actually accepts. Two gaps are what motivated this:
 * `settle` was in the loader and in no card and not even in the writer, and
 * `stallEscalateMs` was rendered by `ladder.tsx` while being absent from the
 * client's own `Prefs` type — both invisible because nothing walked the keys.
 *
 * So this walks them. The source is `AUTOMATION_MAP`'s own key list on the
 * server, reached through the migration round-trip, which means a preference
 * added to the object is a preference this test demands a control for.
 *
 * ⚠️ **Rendered once, not merely rendered.** A preference with two controls is
 * worse than one with none: the two disagree the moment their fallbacks do, and
 * an operator who changes the one that is not wired believes they have changed
 * the setting. That is why the assertion is on the COUNT.
 *
 * The exemptions below are all preferences whose control is somewhere else on
 * purpose, and each says where. An exemption is a decision; growing this list
 * to silence a red gate is how the coverage stops meaning anything.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const { state, savePrefs, hooksStatus } = vi.hoisted(() => ({
  state: vi.fn(),
  savePrefs: vi.fn(),
  // The session-hook card is part of the section and asks for its own status.
  // Unmocked it would reach for `fetch` in jsdom and answer nothing anyway.
  hooksStatus: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, savePrefs, hooksStatus } };
});

/**
 * Where a preference's control lives, when it is not in the Automation cards.
 *
 * Every entry names the surface that owns it and why that is the right home.
 */
const ELSEWHERE: Record<string, string> = {
  // The six run-governing defaults are rendered by the shared launch form
  // (`<RunSetup mode="defaults" />`), so that the words an operator reads when
  // setting a default are the same words they read when starting a run.
  attachDefaultSkills: 'RunSetup defaults',
  qaByDefault: 'RunSetup defaults',
  gitMode: 'RunSetup defaults',
  settle: 'RunSetup defaults',
  openPrOnComplete: 'RunSetup defaults',
  isolation: 'RunSetup defaults',
  reviewEachPhaseByDefault: 'RunSetup defaults',
  reviewerPolicy: 'RunSetup defaults',
  autoRecoverByDefault: 'RunSetup defaults',
  // Its own card, because it is a policy object rather than a knob and it is
  // sent whole on every change.
  boardingSchedule: 'ScheduleCard',
  // The MCP registry owns both: a policy about servers belongs beside the
  // servers, where the operator can see which ones it would apply to.
  mcpPolicy: 'MCP servers section',
  mcpRequireTimeoutMs: 'MCP servers section',
  // Accounts section — it is a statement about which logins may be spent.
  autoAccountSwitch: 'Accounts section',
};

/**
 * The WHOLE section, not the two cards that happen to carry controls today.
 *
 * Mounting `AutomationCard` + `LadderCard` made the duplication half of this
 * guard unenforceable exactly where it is about to matter: `ScheduleCard`,
 * `SessionHookCard` and `PostureCard` are also in the section, `PostureCard` is
 * the group the automation-posture sweep lands its new preferences in, and a
 * second control there for a key one of the first two cards already renders is
 * the precise failure this test exists to catch. Scraping the section means the
 * scrape follows the section as cards are added to it.
 */
async function renderedPrefs(prefs: Record<string, unknown>): Promise<string[]> {
  state.mockResolvedValue({
    root: { ok: true, path: '/repo' },
    autopilot: true,
    allowRun: true,
    prefs,
    defaultSkills: [],
  });
  savePrefs.mockResolvedValue({});
  hooksStatus.mockResolvedValue({ installed: false, partial: false, path: '/home/settings.json' });
  const client = new QueryClient(queryClientConfig);
  const { AutomationSection } = await import('./automation');
  const { container, unmount } = render(
    <QueryClientProvider client={client}>
      <AutomationSection />
    </QueryClientProvider>,
  );
  await screen.findByText('Automation · the ladder');
  const found = [...container.querySelectorAll('[data-pref]')].map(
    (el) => el.getAttribute('data-pref') ?? '',
  );
  // The policy editor's rows: one control per row of the policy table,
  // counted the same way the preferences are (phase 12).
  policyControls.length = 0;
  for (const el of container.querySelectorAll('[data-policy-control]')) {
    policyControls.push(el.getAttribute('data-policy-control') ?? '');
  }
  unmount();
  return found;
}

/** The `data-policy-control` markers of the LAST mount `renderedPrefs` made. */
const policyControls: string[] = [];

/**
 * Both reachable shapes of the section, unioned.
 *
 * The four worktree knobs render only under `isolation: 'worktree'` — the card
 * hides them deliberately and says why, because a cap on console-managed
 * checkouts means nothing to a run that will never have one. Mounting once
 * would therefore report them missing, and the fix for THAT would be to exempt
 * them, which would stop checking them entirely. Walking both states is what
 * keeps the claim honest: every preference reaches a control in some state a
 * person can actually get to.
 */
async function coverage(): Promise<Map<string, number>> {
  const seen = new Map<string, number>();
  for (const prefs of [{}, { isolation: 'worktree' }]) {
    for (const key of await renderedPrefs(prefs)) {
      seen.set(key, Math.max(seen.get(key) ?? 0, 1));
    }
  }
  // Duplication is counted WITHIN one mount, not across the two: a control
  // that legitimately renders in both states is one control, not two.
  for (const prefs of [{}, { isolation: 'worktree' }]) {
    const counts = new Map<string, number>();
    for (const key of await renderedPrefs(prefs)) counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const [key, n] of counts) if (n > 1) seen.set(key, Math.max(seen.get(key) ?? 0, n));
  }
  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('automation preference coverage', () => {
  it('renders every automation preference the server accepts, exactly once', async () => {
    const { AUTOMATION_KEYS } = await import('@shared/automation-model.js');
    const keys = [...AUTOMATION_KEYS, 'boardingSchedule'];
    expect(keys.length).toBeGreaterThan(30);

    // Controls are wired by key: `onSave={num('ladderPerRunUsd')}`,
    // `onOff(value, 'watchCmdRefs')`. The rendered marker is the `data-pref`
    // attribute each control carries for exactly this reason — matching on
    // visible LABELS would tie this test to prose, which is the one thing
    // about a settings card that is meant to change freely.
    const seen = await coverage();

    const missing: string[] = [];
    const duplicated: string[] = [];
    for (const key of keys) {
      if (key in ELSEWHERE) continue;
      const count = seen.get(key) ?? 0;
      if (count === 0) missing.push(key);
      else if (count > 1) duplicated.push(`${key} (${count})`);
    }

    expect(missing, 'these preferences load and save but no control reaches them').toEqual([]);
    expect(duplicated, 'two controls for one preference disagree the day their fallbacks do').toEqual([]);
  });

  it('every policy row has exactly one control (phase 12)', async () => {
    const { POLICY_TABLE } = await import('@shared/policy-model.js');
    expect(POLICY_TABLE.length).toBeGreaterThan(10);
    await renderedPrefs({});
    const counts = new Map<string, number>();
    for (const cls of policyControls) counts.set(cls, (counts.get(cls) ?? 0) + 1);
    const missing = POLICY_TABLE.map((row) => row.class).filter((cls) => !counts.has(cls));
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([cls, n]) => `${cls} (${n})`);
    const unknown = [...counts.keys()].filter((cls) => !POLICY_TABLE.some((row) => row.class === cls));
    expect(missing, 'these policy rows render with no control').toEqual([]);
    expect(duplicated, 'two controls on one row').toEqual([]);
    expect(unknown, 'a control for a row the table does not have').toEqual([]);
    // And the object preference they all write is one control to the coverage
    // rule above — the card, not eighteen rows.
    expect((await renderedPrefs({})).filter((k) => k === 'policy')).toHaveLength(1);
  });

  it('every exemption names a preference that still exists', async () => {
    // An exemption that outlives its preference is a comment nobody will read
    // and a name nobody will grep — the same rot the UNDOCUMENTED_FLAGS
    // allowance is gated against on the docs side.
    const { AUTOMATION_KEYS } = await import('@shared/automation-model.js');
    const keys = new Set([...AUTOMATION_KEYS, 'boardingSchedule']);
    const stale = Object.keys(ELSEWHERE).filter((key) => !keys.has(key));
    expect(stale, 'these exemptions name preferences that no longer exist').toEqual([]);
  });
});
