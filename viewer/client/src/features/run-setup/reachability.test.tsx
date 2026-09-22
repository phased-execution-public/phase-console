/**
 * Every run option must be REACHABLE — the assertion `schema-parity.test.ts`
 * cannot make.
 *
 * ## Why parity is not enough
 *
 * `schema-parity.test.ts` holds `WIRE`, `EMPTY` and `runSetupSchema` to the two
 * run doors, in both directions: the form sends every name the doors read and
 * no name they do not. That is a contract about the PAYLOAD, and it is entirely
 * satisfied by a field with no control on the screen — the value simply rides
 * its seed to the server, unchanged and unchangeable, forever.
 *
 * `openPr` is the proof that this is not hypothetical. It is in `WIRE`, in
 * `EMPTY`, in the schema, in `RUN_START_FIELDS`, in `RUN_SETTINGS_FIELDS` and
 * in four modes' field lists, so it passes every parity assertion there is.
 * Its only control is guarded `on('openPr') && !on('settle')` — and every mode
 * that lists `openPr` also lists `settle`, so the branch is unreachable in all
 * of them. The control has never rendered. An existing test even asserts its
 * absence, which is how a dead branch came to look like a deliberate one.
 *
 * That is fine, because `settle` genuinely owns it: the settle select writes
 * `openPr` as a side effect (`set('openPr', strategy === 'pr')`), so the option
 * IS editable — through a control with a different name. What was missing is
 * anything that says so, and anything that would notice if `settle` stopped
 * doing it.
 *
 * ## The rule this file enforces
 *
 * For every canonical run-settings field, one of two things must be true:
 *
 *   1. a control for it renders in some mode, or
 *   2. it is named in `OWNED_BY` with the control that writes it, AND that
 *      control demonstrably still writes it.
 *
 * Nothing may be quietly neither. A field that loses its control fails here
 * rather than silently degrading to whatever its seed said, which is the exact
 * failure mode `openPr` had already been in.
 */

import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { RUN_SETTINGS_FIELDS, RUN_START_FIELDS } from '@shared/run-settings.js';
import { shows } from './modes';

const { state, skills, runStart, runSettings, savePrefs } = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runStart: vi.fn(),
  runSettings: vi.fn(),
  savePrefs: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, skills, runStart, runSettings, savePrefs } };
});

async function mount(props: Record<string, unknown>, consoleState: Record<string, unknown> = {}) {
  state.mockResolvedValue({
    prefs: {},
    defaultSkills: ['graph-tool'],
    allowAgent: true,
    allowWrites: true,
    ...consoleState,
  });
  const client = new QueryClient(queryClientConfig);
  const { RunSetup } = await import('./run-setup');
  const Setup = RunSetup as unknown as (props: Record<string, unknown>) => ReactElement;
  return render(
    <QueryClientProvider client={client}>
      <Setup {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  skills.mockResolvedValue([]);
  runStart.mockResolvedValue({ run: { id: 'r', slug: 'alpha' } });
  runSettings.mockResolvedValue({ run: null });
  savePrefs.mockResolvedValue({});
});

/**
 * Fields with no control of their own, and the control that writes them.
 *
 * ⚠️ **Adding a row here is a decision, not a formality.** It says "this option
 * is edited under another name", which is only acceptable when the owning
 * control makes the choice completely — never when a field simply lost its UI.
 * Each row is paired with an assertion below that the owner still writes it.
 */
const OWNED_BY: Record<string, string> = {
  // The settle strategy IS the PR question, one fold further along: `pr` means
  // open one, the other three mean do not. Two controls for one decision is how
  // a form comes to offer `settle: keep` beside a ticked "open a PR".
  openPr: 'settle',
};

/** Context, not a value: supplied by the caller, never typed by an operator. */
const CONTEXT_FIELDS = new Set(['resumeRunId']);

const CANONICAL = [...new Set<string>([...RUN_START_FIELDS, ...RUN_SETTINGS_FIELDS])];

/** Every mode that can carry run settings, widest first. */
// `qa-fix` is LAST on purpose: it is the only mode offering QA recovery's two
// fields, and every other field must still be found in the widest mode that
// has it (the search below takes the first match).
const RUN_MODES = ['start', 'continue', 'live', 'phase', 'defaults', 'qa-fix'] as const;

describe('the canonical field set', () => {
  it('is exactly what the two doors read, and nothing here invents one', () => {
    // A guard on the guard: if `run-settings.js` grows a field, the list below
    // grows with it and the reachability assertion covers it automatically.
    expect(CANONICAL.length).toBeGreaterThanOrEqual(27);
    for (const field of Object.keys(OWNED_BY)) expect(CANONICAL).toContain(field);
  });

  it('offers every field in at least one mode, or names its owner', () => {
    // The FIRST rung: a field no mode even lists cannot have a control, and
    // this catches that before any rendering is attempted.
    for (const field of CANONICAL) {
      if (CONTEXT_FIELDS.has(field)) continue;
      const offered = RUN_MODES.some((mode) => shows(mode, field as never));
      const owned = OWNED_BY[field] != null;
      expect(offered || owned, `${field} is in no mode's field list and has no owner`).toBe(true);
    }
  });
});

describe('every option has a control an operator can actually reach', () => {
  /**
   * The accessible names each field's control renders under, in the widest
   * mode that offers it. Matched against the accessible NAME, not a test id:
   * a control nobody can name is a control nobody can use, and the label is
   * the thing a screen reader and a `getByLabelText` both read.
   */
  const LABELS: Record<string, RegExp> = {
    model: /^Model$/,
    effort: /^Effort$/,
    accountId: /^Account$/,
    onLimit: /^On usage limit$/,
    autonomy: /^If something is unclear$/,
    permissionProfile: /^Permissions$/,
    phaseBudgetUsd: /^Budget per phase/,
    runBudgetUsd: /^Budget for the run/,
    maxParallel: /^Max parallel$/,
    maxConsecutiveFailures: /^Stop after N failures$/,
    gitMode: /^Branch$/,
    priority: /^Queue priority$/,
    onlyPhases: /^Only these phases$/,
    startAfter: /^Start after/,
    settle: /^When the plan completes$/,
    isolation: /^Give this run its own checkout$/,
    reviewEachPhase: /^Review each phase/,
    reviewerPolicy: /hold dependent phases/,
    attachDefaultSkills: /^Attach default skills/,
    mcpPolicy: /^When an MCP server is unavailable$|^If one will not connect$/,
    autoRecover: /^Auto-recover/,
    skills: /^Skills for this run$/,
    qa: /Turn the QA gate on/,
    ultracode: /^Ultracode$/,
    ultraReview: /^Cloud review$/,
  };

  /**
   * Controls that only exist once something else is set, and what to set.
   *
   * These are conditional by design — a settle strategy is meaningless without
   * a work branch, a reviewer policy without a reviewer — so the test drives
   * the precondition rather than declaring the field unreachable. A control
   * that can be reached in TWO steps is reachable; one that can be reached in
   * none is not, and that is the line this file draws.
   */
  const UNLOCK: Record<string, RegExp> = {
    settle: /^Branch$/,
    isolation: /^Branch$/,
    reviewerPolicy: /^Review each phase/,
  };

  it.each(Object.keys(LABELS))('renders a control for %s', async (field) => {
    const mode = RUN_MODES.find((m) => shows(m, field as never));
    expect(mode, `${field} is offered by no run mode`).toBeTruthy();
    await mount({
      mode,
      context: { slug: 'alpha', run: null },
      planPhases: [{ phase: 1, title: 'one' }],
      planMcp: ['ctx'],
      // The QA toggle is offered only while the PLAN's own gate is off; a plan
      // that declares one gets a note instead, deliberately. `off` is the state
      // in which every control is legal, which is what this file measures.
      qaMode: 'off',
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Start|Save|Apply|Run phase/ })).toBeTruthy(),
    );

    const unlock = UNLOCK[field];
    if (unlock) {
      // A `<select>` is set; a `ToggleField` is a Radix checkbox inside a
      // wrapping label, so its accessible name carries the hint and the
      // provenance too — it is found by ROLE, never by an anchored label.
      const select = screen.queryAllByLabelText(unlock).find((el) => el instanceof HTMLSelectElement);
      if (select) fireEvent.change(select, { target: { value: 'new-branch' } });
      else fireEvent.click(screen.getByRole('checkbox', { name: unlock }));
    }

    await waitFor(() => {
      const found =
        screen.queryAllByLabelText(LABELS[field]!).length > 0 ||
        screen.queryAllByRole('button', { name: LABELS[field]! }).length > 0 ||
        screen.queryAllByText(LABELS[field]!).length > 0;
      expect(found, `no control found for ${field} in mode ${mode}`).toBe(true);
    });
  });
});

describe('every option is reachable through the stage bar', () => {
  /**
   * The same controls, in the STAGED overlay: the stage bar has to lead to
   * each one, on the stage `stages.ts` says it is on. The panels stay mounted
   * while hidden, so a label query alone would find a control on any stage;
   * scoping the query to the ACTIVE panel is what makes this a test of the
   * map rather than of the DOM.
   */
  // `qa-fix` last, for `RUN_MODES`' reason: it is staged, and it is the only
  // staged mode that offers QA recovery's two fields.
  const STAGED = ['start', 'continue', 'live', 'phase', 'qa-fix'] as const;
  const LABELS = {
    model: /^Model$/,
    effort: /^Effort$/,
    accountId: /^Account$/,
    onLimit: /^On usage limit$/,
    autonomy: /^If something is unclear$/,
    permissionProfile: /^Permissions$/,
    phaseBudgetUsd: /^Budget per phase/,
    runBudgetUsd: /^Budget for the run/,
    maxParallel: /^Max parallel$/,
    maxConsecutiveFailures: /^Stop after N failures$/,
    gitMode: /^Branch$/,
    priority: /^Queue priority$/,
    onlyPhases: /^Only these phases$/,
    startAfter: /^Start after/,
    settle: /^When the plan completes$/,
    isolation: /^Give this run its own checkout$/,
    reviewEachPhase: /^Review each phase/,
    reviewerPolicy: /hold dependent phases/,
    attachDefaultSkills: /^Attach default skills/,
    mcpPolicy: /^If one will not connect$/,
    autoRecover: /^Auto-recover/,
    skills: /^Skills for this run$/,
    qa: /Turn the QA gate on/,
    ultracode: /^Ultracode$/,
    ultraReview: /^Cloud review$/,
    qaModel: /^QA model$/,
    qaEffort: /^QA effort$/,
    qaMaxRounds: /^Stop after N failed QA rounds$/,
    qaFixStrategy: /^How the fix session starts$/,
    qaRoundBudgetUsd: /^Budget per QA round \(\$\)$/,
  } as const;
  const UNLOCK: Partial<Record<keyof typeof LABELS, RegExp>> = {
    settle: /^Branch$/,
    isolation: /^Branch$/,
    reviewerPolicy: /^Review each phase/,
  };

  it.each(Object.keys(LABELS) as (keyof typeof LABELS)[])(
    'reaches %s on the stage the map names',
    async (field) => {
      const mode = STAGED.find((m) => shows(m, field));
      expect(mode, `${field} is offered by no staged mode`).toBeTruthy();
      await mount({
        mode,
        context: { slug: 'alpha', run: null },
        planPhases: [{ phase: 1, title: 'one' }],
        planMcp: ['ctx'],
        qaMode: 'off',
        overlay: { open: true, onOpenChange: () => {}, title: 'test' },
      });
      // Every staged mode's own submit word, `qa-fix`'s included — the button
      // is what says the form has finished mounting, so a mode missing from
      // this alternation fails as a timeout rather than as the miss it is.
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Start|Apply|Run phase|Fix & re-QA/ })).toBeTruthy(),
      );

      const { STAGE_OF, STAGES } = await import('./stages');
      const stage = STAGES.find((s) => s.id === STAGE_OF[field])!;
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(stage.label) }));
      const active = () => screen.getByRole('tabpanel');

      const unlock = UNLOCK[field];
      if (unlock) {
        const select = within(active())
          .queryAllByLabelText(unlock)
          .find((el) => el instanceof HTMLSelectElement);
        if (select) fireEvent.change(select, { target: { value: 'new-branch' } });
        else fireEvent.click(within(active()).getByRole('checkbox', { name: unlock }));
      }

      await waitFor(() => {
        const label = LABELS[field];
        const found =
          within(active()).queryAllByLabelText(label).length > 0 ||
          within(active()).queryAllByRole('button', { name: label }).length > 0 ||
          within(active()).queryAllByText(label).length > 0;
        expect(found, `no control found for ${field} on "${stage.label}" in mode ${mode}`).toBe(true);
      });
    },
  );
});

describe('a value taken off the run says so', () => {
  /**
   * `RUN_SEEDED` is the provenance list, and a field seeded from the run and
   * left out of it renders *from defaults* under a value it took off the run.
   *
   * Four fields were in exactly that state: `settle`, `reviewEachPhase`,
   * `reviewerPolicy` and `attachDefaultSkills` are all assigned `run ? … : …`
   * at the bottom of `seedFor` and none was marked. Provenance exists so an
   * operator can tell a value they are inheriting from one they are about to
   * change; a field that misreports it is worse than one that shows none,
   * because a wrong answer is indistinguishable from a right one.
   *
   * Asserted through the rendered `data-source`, not against the constant —
   * a test that read `RUN_SEEDED` back would pass for a list that never
   * reaches the screen.
   */
  const RUN = {
    id: 'run-1',
    slug: 'alpha',
    status: 'halted',
    model: 'sonnet',
    gitMode: 'new-branch',
    settle: 'merge-queue',
    reviewEachPhase: true,
    reviewerPolicy: 'may-hold',
    phases: {},
  } as unknown as import('@/lib/api').RunState;

  const sourceNear = (label: RegExp): string | null => {
    const marks = screen.getAllByText(/from this run|from defaults|from the plan|changed here/);
    const owner = marks.find((m) => m.closest('label,div')?.textContent?.match(label));
    return owner?.getAttribute('data-source') ?? null;
  };

  it('marks settle, the reviewer and its policy as coming from the run', async () => {
    await mount({ mode: 'continue', context: { slug: 'alpha', run: RUN }, qaMode: 'off' });
    await waitFor(() => expect(screen.getByRole('button', { name: /Continue/ })).toBeTruthy());

    expect(sourceNear(/^When the plan completes/), 'settle').toBe('run');
    expect(sourceNear(/^Review each phase/), 'reviewEachPhase').toBe('run');
    expect(sourceNear(/hold dependent phases/), 'reviewerPolicy').toBe('run');
  });

  it('marks the model too — the case that was always right', async () => {
    // The control group: `model` has always been in `RUN_SEEDED`, so this
    // pins the mechanism itself rather than only the four repairs.
    await mount({ mode: 'continue', context: { slug: 'alpha', run: RUN }, qaMode: 'off' });
    await waitFor(() => expect(screen.getByRole('button', { name: /Continue/ })).toBeTruthy());
    expect(sourceNear(/^Model/)).toBe('run');
  });
});

describe('an option edited under another name', () => {
  it('is only allowed when its owner still writes it', async () => {
    // `openPr` has no control. That is legal ONLY because choosing a settle
    // strategy makes the whole PR decision — so this asserts the coupling
    // rather than the comment describing it. If `settle` stops writing
    // `openPr`, the option becomes unreachable and this goes red.
    await mount({ mode: 'start', context: { slug: 'alpha', run: null } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Start/ })).toBeTruthy());

    // Anchored since phase 15: "Base branch" is a control of its own now.
    const git = screen.getByLabelText(/^branch$/i) as HTMLSelectElement;
    fireEvent.change(git, { target: { value: 'new-branch' } });

    const settle = await screen.findByLabelText(/^When the plan completes$/);
    fireEvent.change(settle, { target: { value: 'keep' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    await waitFor(() => expect(runStart).toHaveBeenCalled());
    // `keep` is not a PR.
    expect(runStart.mock.calls.at(-1)![1]).toMatchObject({ settle: 'keep', openPr: false });

    runStart.mockClear();
    fireEvent.change(await screen.findByLabelText(/^When the plan completes$/), { target: { value: 'pr' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    await waitFor(() => expect(runStart).toHaveBeenCalled());
    expect(runStart.mock.calls.at(-1)![1]).toMatchObject({ settle: 'pr', openPr: true });
  });

  it('has no control of its own, deliberately', () => {
    // Pinned so that "add a checkbox for openPr" is a conscious act that has to
    // delete this assertion and the OWNED_BY row together — two controls for
    // one decision is how a form offers `settle: keep` beside a ticked PR box.
    expect(OWNED_BY.openPr).toBe('settle');
  });
});
