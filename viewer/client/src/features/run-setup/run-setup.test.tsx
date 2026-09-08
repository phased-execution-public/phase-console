/**
 * RunSetup — the field matrix, and what each mode sends.
 *
 * The matrix is the contract the consolidation exists to state: a recovery
 * offers model, effort and skills and no permission select; a phase launch
 * carries the git section with the PR box alive only under the work-branch
 * mode; a live run is offered none of the three fields a settings patch may
 * not carry. The payloads are asserted VERBATIM, including their omissions,
 * because they are what the server validates — a key that quietly stops being
 * sent degrades to a preference and the run looks healthy while being a
 * different run from the one that was asked for.
 *
 * The payload builders are pure (`modes.ts`), so most of this suite needs no
 * DOM at all. That is the point of putting them there: a contract you can only
 * exercise by rendering a dialog and clicking a button is a contract nobody
 * re-checks.
 */

import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { RunState } from '@/lib/api';
import { EMPTY, type RunSetupValues } from './schema';
import {
  buildLaunch,
  buildPrefs,
  buildRunPayload,
  buildTicket,
  mergedSkills,
  permissionModeFor,
  permissionChoiceFor,
  shows,
} from './modes';

const { state, skills, runStart, runSettings, savePrefs, toastMock } = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runStart: vi.fn(),
  runSettings: vi.fn(),
  savePrefs: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, skills, runStart, runSettings, savePrefs } };
});

// The one thing the operator actually reads after pressing the button. It used
// to be unconditional on resolve, which is the defect below.
vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  return { ...actual, toast: toastMock };
});

const RUN = {
  id: 'run-1',
  slug: 'alpha',
  status: 'halted',
  model: 'sonnet',
  effort: 'high',
  autonomy: 'keep-going',
  permissionProfile: 'trusted',
  skills: ['design-review'],
  phaseBudgetUsd: 5,
  runBudgetUsd: 40,
  phases: {},
} as unknown as RunState;

const values = (over: Partial<RunSetupValues> = {}): RunSetupValues => ({ ...EMPTY, ...over });

async function mount(props: Record<string, unknown>, consoleState: Record<string, unknown> = {}) {
  state.mockResolvedValue({ prefs: {}, defaultSkills: ['graph-tool'], ...consoleState });
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
  // A started run, as the server really answers. `{ run: null }` — which this
  // used to be — is now a case the form reports rather than celebrates, so a
  // fixture that keeps it would be testing the refusal path everywhere.
  runStart.mockResolvedValue({ run: { id: 'run-1', slug: 'alpha' } });
  runSettings.mockResolvedValue({ run: null });
  savePrefs.mockResolvedValue({});
});

describe('the field matrix', () => {
  it('a recovery offers model, effort and skills — and no permissions', () => {
    expect(shows('recovery', 'model')).toBe(true);
    expect(shows('recovery', 'effort')).toBe(true);
    expect(shows('recovery', 'skills')).toBe(true);
    expect(shows('recovery', 'permissionProfile')).toBe(false);
    expect(shows('recovery', 'gitMode')).toBe(false);
  });

  it('an agent ticket is never offered a budget, a branch or a phase matrix', () => {
    for (const mode of ['recovery', 'qa', 'session', 'plan'] as const) {
      for (const field of ['phaseBudgetUsd', 'runBudgetUsd', 'gitMode', 'phaseOptions'] as const) {
        expect(shows(mode, field), `${mode} shows ${field}`).toBe(false);
      }
    }
  });

  it('a narrow phase launch does not reopen the run’s whole configuration', () => {
    // "Run only this one" is a choice, not a re-read of the run. The three it
    // withholds are inherited from the run instead — asserted in the payloads.
    for (const field of ['autonomy', 'phaseBudgetUsd', 'runBudgetUsd', 'phaseOptions'] as const) {
      expect(shows('phase', field)).toBe(false);
    }
    expect(shows('continue', 'phaseOptions')).toBe(true);
  });

  it('the settle control follows the branch mode', async () => {
    // Was "the PR box". The tick became a four-way select in P12 — a pull
    // request is ONE of the answers to what happens to a finished branch — but
    // the gate it rides is unchanged and is what this pins: a run with no
    // branch of its own has nothing to settle.
    await mount({ mode: 'phase', context: { slug: 'alpha', phase: 3, run: null } });
    await screen.findByText('Branch');
    expect(screen.queryByText(/When the plan completes/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'new-branch' } });
    expect(await screen.findByText(/When the plan completes/)).toBeTruthy();
    // …and the tick it replaced is NOT also on screen: two controls for one
    // fact is how a form comes to send a payload that contradicts itself.
    expect(screen.queryByText(/Open a PR when the plan completes/)).toBeNull();
  });

  it('the isolation box follows the branch mode too', async () => {
    // The same gate as the PR box, and the same reason: a run with no branch
    // of its own has nothing to check out, so offering the choice there would
    // be offering a setting the run cannot honour.
    await mount({ mode: 'phase', context: { slug: 'alpha', phase: 3, run: null } });
    await screen.findByText('Branch');
    expect(screen.queryByText(/Give this run its own checkout/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'new-branch' } });
    expect(await screen.findByText(/Give this run its own checkout/)).toBeTruthy();
  });

  it('a live queue run is shown the isolation box OFF and cannot turn it on', async () => {
    // The mid-run rule made visible. The route 409s a raise, and a control an
    // operator can press that will always fail is worse than one they cannot:
    // it is disabled, and the hint says what to do instead.
    await mount({
      mode: 'live',
      context: { slug: 'alpha', run: { ...RUN, gitMode: 'new-branch' } as unknown as RunState },
    });
    const box = await screen.findByLabelText(/Give this run its own checkout/);
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();
    expect(screen.getByText(/Stop it and start it again to isolate it/)).toBeTruthy();
  });

  it('a live run that IS isolated may still be dropped back', async () => {
    // The one direction that is honoured mid-run — and the control has to be
    // live for it, or the only way off isolation would be stopping the run.
    await mount({
      mode: 'live',
      context: {
        slug: 'alpha',
        run: { ...RUN, gitMode: 'new-branch', isolation: 'worktree' } as unknown as RunState,
      },
    });
    const box = await screen.findByLabelText(/Give this run its own checkout/);
    expect(box).toBeChecked();
    expect(box).not.toBeDisabled();
  });

  it('says where each value came from', async () => {
    // The whole reason a preference-seeded dialog is readable: a value that is
    // the run's own says so, and one the operator typed says something else.
    await mount({ mode: 'continue', context: { slug: 'alpha', run: RUN } });
    await screen.findByText('Branch');
    expect(screen.getAllByText('from this run').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/Budget for the run/), { target: { value: '99' } });
    expect(await screen.findByText('changed here')).toBeTruthy();
  });

  it('the autonomy control says what each choice does on a QA fail', async () => {
    // "Stop and ask me" now stops on a QA fail (a phase-level needs-human halt
    // that parks the run) and "Keep going" lets the ladder fix the phase while
    // independent phases run — two behaviours the two labels never explained.
    // The hint follows the selected value, so both sentences are on screen
    // exactly when they apply.
    await mount({ mode: 'continue', context: { slug: 'alpha', run: RUN } });
    const select = await screen.findByLabelText(/If something is unclear/);
    expect(select).toHaveValue('keep-going');
    expect(screen.getByText(/A QA fail does not stop the run/)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'halt-on-everything' } });
    expect(await screen.findByText(/parks the run on that phase/)).toBeTruthy();
    expect(screen.queryByText(/A QA fail does not stop the run/)).toBeNull();
  });

  it('a preference page states its defaults without provenance noise', async () => {
    // "from defaults" beside every field of the defaults page is not
    // information — and the accessible label is what `getByLabelText` reads.
    await mount({ mode: 'defaults' });
    expect(await screen.findByLabelText('Branch')).toBeTruthy();
    expect(screen.queryByText('from defaults')).toBeNull();
  });
});

describe('the payloads', () => {
  it('a phase launch sends exactly what the form shows, scoped to its phase', () => {
    expect(
      buildRunPayload(
        'phase',
        values({
          model: 'sonnet',
          effort: 'high',
          onLimit: 'switch',
          permissionProfile: 'trusted',
          skills: ['design-review'],
          attachDefaultSkills: true,
          qa: true,
        }),
        { slug: 'alpha', phase: 3, run: RUN },
      ),
    ).toEqual({
      model: 'sonnet',
      effort: 'high',
      // The deliberate default: switch to the account with headroom at the
      // usage wall, degrading to `wait` when there is only one login.
      onLimit: 'switch',
      // Inherited from the run, not shown: a narrow launch does not re-decide
      // the run's posture or its budgets.
      autonomy: 'keep-going',
      phaseBudgetUsd: 5,
      runBudgetUsd: 40,
      permissionProfile: 'trusted',
      skills: ['design-review'],
      // Always sent as shown. `continue` is the shipped default: an unreachable
      // MCP server makes a phase report what it could not do, rather than
      // stopping the plan.
      mcpPolicy: 'continue',
      attachDefaultSkills: true,
      gitMode: 'default-branch',
      qa: true,
      // Always sent as shown, like `mcpPolicy` above: on a live run an absent
      // field means "leave it alone", so a form that omitted `off` could turn
      // billed cloud reviews on and never take them back.
      ultraReview: 'off',
      // Always sent as shown, never omitted: an explicit false on a resume
      // returns the run to the off state rather than to a preference.
      autoRecover: false,
      resumeRunId: 'run-1',
      onlyPhases: [3],
    });
  });

  it('a continue resumes the run and never narrows it', () => {
    const payload = buildRunPayload('continue', values(), { slug: 'alpha', run: RUN });
    expect(payload.resumeRunId).toBe('run-1');
    expect('onlyPhases' in payload).toBe(false);
  });

  it('a continue that WAS scoped keeps saying so, because the box does', () => {
    const payload = buildRunPayload('continue', values({ onlyPhases: '2, 4-5' }), {
      slug: 'alpha',
      run: RUN,
    });
    expect(payload.onlyPhases).toEqual([2, 4, 5]);
  });

  it('a start never resumes a run that already finished', () => {
    const finished = { ...RUN, status: 'finished' } as RunState;
    expect('resumeRunId' in buildRunPayload('start', values(), { slug: 'alpha', run: finished })).toBe(false);
    expect(buildRunPayload('start', values(), { slug: 'alpha', run: RUN }).resumeRunId).toBe('run-1');
  });

  it('omits what absence means, and sends null where blank is a choice', () => {
    const payload = buildRunPayload('start', values({ model: 'opus' }), { slug: 'alpha' });
    // Absence is their meaning on disk — a run that never named servers must
    // keep meaning what it meant.
    for (const key of ['mcpServers', 'attachDefaultSkills', 'qa', 'onlyPhases', 'maxParallel']) {
      expect(key in payload, `${key} should be omitted when empty`).toBe(false);
    }
    // `null` is "no ceiling", which IS a choice; absence would mean "leave it".
    expect(payload.phaseBudgetUsd).toBeNull();
    expect(payload.runBudgetUsd).toBeNull();
  });

  it('a live patch carries the numbers it was given', () => {
    const payload = buildRunPayload(
      'live',
      values({ maxParallel: '2', maxConsecutiveFailures: '5', phaseBudgetUsd: '3.5' }),
      { slug: 'alpha', run: RUN },
    );
    expect(payload.maxParallel).toBe(2);
    expect(payload.maxConsecutiveFailures).toBe(5);
    expect(payload.phaseBudgetUsd).toBe(3.5);
    expect('resumeRunId' in payload).toBe(false);
  });

  it('a recovery ticket merges the attached defaults into the skills it sends', () => {
    const body = buildTicket(
      'recovery',
      values({ attachDefaultSkills: true }),
      { slug: 'alpha', recoveryClass: 'plan-repair' },
      ['graph-tool'],
    );
    expect(body.intent).toBe('recovery');
    expect(body.recoveryClass).toBe('plan-repair');
    expect(body.skills).toEqual(['graph-tool']);
    // A ticket has no attach flag for the server to union in, so the merge is
    // the caller's — and an empty model is an omission, not a value to check.
    expect('model' in body).toBe(false);
    expect('permissionProfile' in body).toBe(false);
    expect('attachDefaultSkills' in body).toBe(false);
  });

  it('a review activates the gate only when it was asked to AND may', () => {
    const ticked = values({ qa: true });
    expect(buildTicket('qa', ticked, { slug: 'a', phase: 2, activate: true }, []).activate).toBe(true);
    // Ticked, but the plan already gates — the context says so, and the ticket
    // must not ask the server to create `test-status.md` again.
    expect('activate' in buildTicket('qa', ticked, { slug: 'a', phase: 2 }, [])).toBe(false);
    // Offered and unticked.
    expect('activate' in buildTicket('qa', values(), { slug: 'a', phase: 2, activate: true }, [])).toBe(
      false,
    );
  });

  it('a repair ticket carries `auto` — the door resolves it against the meters', () => {
    // Stripping `auto` here meant a repair launched on the machine login, which
    // on the day you reach for auto is usually the account that just hit the
    // wall. `default` is still an omission: that IS the machine login, said
    // plainly, and the server should not have to validate a word for it.
    expect(buildTicket('recovery', values({ accountId: 'auto' }), { slug: 'a' }, []).accountId).toBe('auto');
    expect(buildTicket('recovery', values({ accountId: 'work' }), { slug: 'a' }, []).accountId).toBe('work');
    expect('accountId' in buildTicket('recovery', values(), { slug: 'a' }, [])).toBe(false);
  });

  it('a plan-authoring ticket carries no permission mode at all', () => {
    // The omission IS the choice: the server defaults a plan intent to plan
    // mode, and a mode chosen here could write a plan nobody approved.
    const body = buildLaunch(values({ attachDefaultSkills: true }), 'plan', ['graph-tool']);
    expect('permissionMode' in body).toBe(false);
    expect(body.skills).toEqual(['graph-tool']);
  });

  it('a session ticket spells its permission choice as a CLI mode', () => {
    const body = buildLaunch(values({ permissionProfile: 'trusted', permissionMode: 'acceptEdits' }));
    expect(body.permissionMode).toBe('acceptEdits');
    expect('accountId' in body).toBe(false);
  });

  it('the Automation patch is the ten run-shaped preferences', () => {
    expect(buildPrefs(values({ qa: true, autoRecover: true }))).toEqual({
      attachDefaultSkills: false,
      qaByDefault: true,
      gitMode: 'default-branch',
      openPrOnComplete: true,
      // Isolation joined in concurrent-plans P5, and rides beside `gitMode`
      // for the same reason the reviewer keys ride together: it is meaningful
      // only on a work-branch run, so saving one without the other would store
      // a request the run can never honour.
      isolation: 'queue',
      // Settle joined in concurrent-plans P12 and rides beside `gitMode` for
      // exactly the reason isolation does: it is meaningful only on a
      // work-branch run. It travels WITH `openPrOnComplete` rather than
      // replacing it — the two are one fact stored twice, and a console that
      // saved only the newer key would hand an older reader nothing.
      settle: 'pr',
      // The per-phase reviewer joined this patch in P14. Both keys travel
      // together: a policy saved without the toggle reads as configured and
      // does nothing.
      reviewEachPhaseByDefault: false,
      reviewerPolicy: 'comment-only',
      autoRecoverByDefault: true,
      mcpPolicy: 'continue',
    });
  });
});

describe('one permission vocabulary, two spellings', () => {
  it('round-trips every choice a session can be started under', () => {
    for (const choice of ['trusted', 'plan', 'auto', 'dontAsk'] as const) {
      expect(permissionChoiceFor(permissionModeFor(choice))).toBe(choice);
    }
    // Guarded is the CLI's own default, which the runner's vocabulary writes as
    // an omission rather than a value — so it round-trips through `''`.
    expect(permissionModeFor('guarded')).toBe('');
    expect(permissionChoiceFor('')).toBe('guarded');
    expect(permissionChoiceFor('manual')).toBe('guarded');
  });
});

describe('skills', () => {
  it('merges the machine list only when it is attached, without duplicates', () => {
    expect(mergedSkills(values({ skills: ['a'], attachDefaultSkills: true }), ['a', 'b'])).toEqual([
      'a',
      'b',
    ]);
    expect(mergedSkills(values({ skills: ['a'] }), ['b'])).toEqual(['a']);
  });
});

describe('the submits', () => {
  it('a phase launch reaches the run door once', async () => {
    await mount({ mode: 'phase', context: { slug: 'alpha', phase: 3, run: RUN } });
    fireEvent.click(await screen.findByRole('button', { name: 'Run phase 3' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![0]).toBe('alpha');
    expect((runStart.mock.calls[0]![1] as Record<string, unknown>).onlyPhases).toEqual([3]);
  });

  it('a live run patches its settings rather than starting anything', async () => {
    await mount({ mode: 'live', context: { slug: 'alpha', run: RUN } });
    fireEvent.click(await screen.findByRole('button', { name: /Apply from next phase/ }));
    await waitFor(() => expect(runSettings).toHaveBeenCalledTimes(1));
    expect(runStart).not.toHaveBeenCalled();
  });

  it('a claimed phase refuses, and the button says so', async () => {
    await mount({
      mode: 'phase',
      context: { slug: 'alpha', phase: 4, run: null },
      blocked: true,
      blockedReason: 'Claimed by someone/else',
    });
    const submit = await screen.findByRole('button', { name: /Run phase 4/ });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    expect(runStart).not.toHaveBeenCalled();
  });

  it('a bad number refuses before the door does', async () => {
    // The server would 400 with the same sentence; saying it here costs a
    // round trip less and points at the field.
    await mount({ mode: 'start', context: { slug: 'alpha', run: null } });
    await screen.findByText('Branch');
    fireEvent.change(screen.getByLabelText(/Max parallel/), { target: { value: '0' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/whole number between 1 and 99/);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(runStart).not.toHaveBeenCalled();
  });

  it('the defaults page saves one key per change, never the whole object', async () => {
    // Two tabs flipping different knobs must not overwrite each other — the
    // server merges, and only because the client sends a delta.
    await mount({ mode: 'defaults' });
    fireEvent.change(await screen.findByLabelText('Branch'), { target: { value: 'new-branch' } });
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ gitMode: 'new-branch' }));
  });

  it('the defaults page saves the review toggle too — it was rendered, seeded from prefs, and silently unsaved', async () => {
    // `reviewEachPhase` and `reviewerPolicy` were seeded FROM the preferences
    // and rendered in `defaults` mode, and absent from the field→pref map — so
    // flipping either in Settings ▸ Automation changed local state and saved
    // nothing (found by the console-parallel-repaint P12 posture sweep).
    await mount({ mode: 'defaults' });
    const row = (await screen.findByText('Review each phase')).closest('div')!;
    fireEvent.click(row.querySelector('button')!);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ reviewEachPhaseByDefault: true }));
  });
});

describe('a PR run that cannot ask for its one tap says so', () => {
  // The `openPr` carve-out pins `git push` and `gh pr create` to *ask* even
  // under the Trusted profile — the run's one world-visible act, for one human
  // tap. The answer window is an hour, and the only thing that tells anybody a
  // card is up is a push notification. With push down, that deal silently
  // becomes "the run parks in an hour" — which is what happened on a real run:
  // a `git push` card at midday, nobody could know, and the journal records the
  // park sixty minutes later.
  const broken = {
    environment: { issues: [{ kind: 'push-broken', detail: 'apns rejects', fix: 're-subscribe' }] },
  };

  it('warns when push is broken and the run will open a PR', async () => {
    await mount(
      { mode: 'start', context: { slug: 'alpha', run: null }, pushBroken: true },
      { ...broken, prefs: { gitMode: 'new-branch', openPrOnComplete: true } },
    );
    expect(await screen.findByText(/cannot deliver notifications/)).toBeInTheDocument();
  });

  it('stays quiet when push is healthy', async () => {
    await mount(
      { mode: 'start', context: { slug: 'alpha', run: null }, pushBroken: false },
      { prefs: { gitMode: 'new-branch', openPrOnComplete: true } },
    );
    expect(screen.queryByText(/cannot deliver notifications/)).toBeNull();
  });
});

describe('what the form says after pressing the button', () => {
  /** Every toast message this submit produced, in order, with its kind. */
  const said = () => toastMock.mock.calls.map((c) => [c[0], c[1] ?? 'ok']);

  it('a refusal is reported as an error and NEVER as success', async () => {
    // B2(b)'s last step. The response was discarded entirely — `await
    // api.runStart(...)` then an unconditional `Continuing ${slug}` — so a
    // start the server declined reached the operator as a green toast about a
    // run that did not exist. The envelope's `error` is a 200 body, so nothing
    // throws and nothing else would have caught it.
    runStart.mockResolvedValue({
      run: null,
      error: 'demo phase 9 is still being worked by a live session (pid 4242)',
    });
    await mount({ mode: 'continue', context: { slug: 'alpha', run: RUN } });
    fireEvent.click(await screen.findByRole('button', { name: /Continue/ }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(said()).toEqual([['demo phase 9 is still being worked by a live session (pid 4242)', 'error']]);
    expect(said().some(([, kind]) => kind === 'ok')).toBe(false);
  });

  it('a run that was never created is reported, not celebrated', async () => {
    // The other refusal shape: no run, and no reason given either.
    runStart.mockResolvedValue({ run: null });
    await mount({ mode: 'continue', context: { slug: 'alpha', run: RUN } });
    fireEvent.click(await screen.findByRole('button', { name: /Continue/ }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(said()).toEqual([[expect.stringMatching(/did not start a run/) as unknown as string, 'warn']]);
  });

  it('a start that worked says so, then passes on every advisory the server sent', async () => {
    // `preflight` carries what did not stop the run but the operator would
    // otherwise learn an hour in: phases that will park at boarding, and
    // phases claimed by a live holder this run must queue behind.
    runStart.mockResolvedValue({
      run: { id: 'run-2', slug: 'alpha' },
      preflight: ['phase 3 has no §Verification — it will park at boarding'],
    });
    await mount({ mode: 'continue', context: { slug: 'alpha', run: RUN } });
    fireEvent.click(await screen.findByRole('button', { name: /Continue/ }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(said()).toEqual([
      ['Continuing alpha', 'ok'],
      ['phase 3 has no §Verification — it will park at boarding', 'warn'],
    ]);
  });
});

describe('the scope a continue carries (client-11)', () => {
  it('CLEARS a scoped run rather than silently inheriting it', async () => {
    // The dialog promises "the scope is cleared — a continue never silently
    // inherits a single-phase run" and `modes.ts` repeats it in a comment; the
    // seed said the opposite. An operator who ran `only phase 3`, watched it
    // halt and pressed Continue got a box pre-filled with `3`.
    const scoped = { ...RUN, onlyPhases: [3] } as unknown as RunState;
    await mount({ mode: 'continue', context: { slug: 'alpha', run: scoped } });
    fireEvent.click(await screen.findByRole('button', { name: /Continue/ }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    const payload = runStart.mock.calls[0]![1] as Record<string, unknown>;
    expect('onlyPhases' in payload).toBe(false);
  });

  it('still narrows a PHASE launch, which says its scope outright', () => {
    expect(buildRunPayload('phase', values(), { slug: 'alpha', phase: 3 }).onlyPhases).toEqual([3]);
  });
});
