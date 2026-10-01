/**
 * One form for every way of starting or configuring work.
 *
 * Before this there were four: a launch dialog, the run page's controls card,
 * the agent launcher and the Automation settings card. They offered
 * overlapping subsets of the same choices under different words, seeded from
 * different places, and sent different payloads — so "Continue" on a plan page
 * could not set a budget while "Continue" on the run page could, "Permissions"
 * meant a run profile in one and a CLI mode in another, and a preference the
 * operator had set in Settings reached three of the four.
 *
 * `RunSetup` is the one component. A **mode** is a field set plus a payload
 * builder (`modes.ts`), the value shape is one object (`schema.ts`), and the
 * payloads are built by pure functions so the contract can be tested without
 * rendering anything.
 *
 * ## The three things this file is careful about
 *
 * 1. **Where a value came from is shown, not implied** — `sourceOf` compares
 *    the live value with the seed and the seed's origin, and every control
 *    carries the answer. See `fields.tsx` and `seed.ts`.
 * 2. **Preference-seeded fields derive LIVE until the operator touches them.**
 *    `/api/state` arrives after the first render, so a `useState` seed taken
 *    before it would silently show the fallback instead of the preference.
 *    `null` in a choice slot means "the operator has not said".
 * 3. **The doors are called from here and nowhere else.** `api.runStart`,
 *    `api.runSettings` and the two agent-ticket helpers have exactly one
 *    caller each, guarded by `single-source.test.ts`.
 *
 * ## The launch flow (Phase 8; one screen since control-tower phase 22)
 *
 * The values, the seed, the provenance and the submit live here; the
 * ARRANGEMENT lives in `sections.tsx` (the controls, grouped by what they
 * decide) and, in an overlay, in the quick view (`quick.tsx`) — what runs, a
 * preset, nine category tiles (`categories.ts`) that expand onto those
 * sections, how many values differ — under `launch-shell.tsx`'s frame.
 * `stages.ts` says which modes are staged at all. Rendered inline on a page (the
 * Automation card, the launcher, the wizard) the form is flat: the same
 * sections, stacked. Nothing it posts changed: `modes.ts` is untouched, so
 * the payload is byte-identical to the one the old dialog sent.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Bot, Play, ShieldCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertDialog, AlertDialogContent, Button, toast } from '@/components/ui';
import { LIVE_LANE_LOCKED_FIELDS, QA_CONFIRM, SETTING_EFFECTS } from '@shared/run-settings.js';
import type { ApiError } from '@/lib/api/client';
import {
  api,
  automationPrefs,
  ladderPrefs,
  type PhaseView,
  type PlanReviewer,
  type RunState,
  type SkillInfo,
} from '@/lib/api';
import {
  keys,
  toastError,
  useAccounts,
  useConsoleState,
  useIsolationPreflight,
  useMcp,
  useSkills,
  usePrelude,
} from '@/lib/queries';
import { DEFAULT_ISOLATION_FOR_NEW_BRANCH, ISOLATED } from '@shared/worktree-model.js';
import { startSession } from '@/lib/start-session';
import { cn } from '@/lib/cn';
import { DEFAULTS, EFFORTS, EFFORT_NOTE, MODEL_NOTE, MODELS } from '@/features/runs/defaults';
import { PressField, ToggleField, sourceOf, type FieldEffect, type Source } from './fields';
import { SetupFormProvider, type SetupForm } from './form-context';
import { LaunchShell } from './launch-shell';
import { recallLaunch, rememberLaunch } from './launch-memory';
import {
  MODES,
  PERMISSION_CHOICES,
  QA_PERMISSIONS,
  RUN_PERMISSIONS,
  SESSION_PERMISSIONS,
  buildLaunch,
  buildPrefs,
  buildRunPayload,
  buildTicket,
  mergedSkills,
  runsPrelude,
  shows,
  submitLabel,
  type RunSetupContext,
  type RunSetupMode,
} from './modes';
import { formatAccounts, runSetupSchema, type RunSetupField, type RunSetupValues } from './schema';
import type { CategoryId } from './categories';
import { FlatForm, accountWho } from './sections';
import { BASELINE, seedFor, type Origins } from './seed';
import { preludeDraft } from './decisions';
import { gitLinesOf } from './git-reconcile';
import { matchingPreset, presetAgrees, presetValues, presetsFor, withPreset, type PresetId } from './presets';
import { QuickView } from './quick';
import { NoAllowRun } from './review';
import { isLive, isStaged } from './stages';

/** The overlay a caller puts the form in. Present = a dialog; absent = inline on a page. */
export interface RunSetupOverlay {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
}

export interface RunSetupProps {
  mode: RunSetupMode;
  context?: RunSetupContext;
  /** The plan's phases — the per-phase matrix and the What-runs fold read them. */
  planPhases?: PhaseView[];
  /** What the plan asks every session to invoke / attach. Shown, never unticked here. */
  planSkills?: string[];
  planMcp?: string[];
  /**
   * Where the plan orders its own in-session reviewer (`plan.reviewers`). With
   * Review each phase on, the Reviewers section says every phase would be
   * reviewed twice (autopilot-token-drain phase 5).
   */
  planReviewers?: PlanReviewer[];
  /** The plan's qa-mode; `off` is the only value that offers the QA toggle. */
  qaMode?: string;
  /**
   * This console cannot currently deliver a push notification (the environment
   * doctor's `push-broken`). It matters HERE and nowhere else in this dialog:
   * `openPr` is the one setting that guarantees the run will stop and ask for a
   * human tap, and push is the only thing that tells anybody a card is up.
   */
  pushBroken?: boolean;
  /** Whether the console may WRITE — a different flag from `allowRun`. */
  allowWrites?: boolean;
  /**
   * Whether `/api/skills` can be asked at all. It needs an open source
   * directory; without one the picker hides rather than 409ing, and — the part
   * a prop is needed for — the query is never issued. `agent.test.tsx` pins
   * that no request goes out, which is the honest version of "hides".
   */
  skillsEnabled?: boolean;
  /** Refuse to submit (a live claim on the phase, the session cap). */
  blocked?: boolean;
  blockedReason?: string;
  /**
   * A lane of this run is working (control-tower phase 24): the fields the
   * settings door refuses under a live lane (`LIVE_LANE_LOCKED_FIELDS`) say so
   * beside their controls, before the press. Read in `live` mode only.
   */
  laneWorking?: boolean;
  /** Called after a successful submit, with a session id where one was minted. */
  onDone?: (sessionId?: string) => void;
  /** `session` mode only: the launcher owns the pty, so it owns the call. */
  onLaunch?: (body: Record<string, unknown>) => void | Promise<void>;
  /** Rendered above the fields — claim banners, verdict notes, whatever the surface knows. */
  children?: ReactNode;
  /** Render the submit row. Off where the surface has its own (the run page's verb bar). */
  submit?: boolean;
  /** The muted line to the LEFT of the buttons — what this form opens on, usually. */
  footerNote?: ReactNode;
  /** A Cancel, when the surface is an inline dialog of its own. Sits beside the submit, never instead of it. */
  cancel?: ReactNode;
  /** Put the form in a dialog: a staged launch flow for a run mode, a framed form for a ticket. */
  overlay?: RunSetupOverlay;
  className?: string;
}

export function RunSetup({
  mode,
  context = {},
  planPhases = [],
  planSkills = [],
  planMcp = [],
  planReviewers = [],
  qaMode,
  pushBroken,
  allowWrites,
  skillsEnabled = true,
  blocked: blockedProp = false,
  blockedReason: blockedReasonProp,
  laneWorking = false,
  onDone,
  onLaunch,
  children,
  submit = true,
  footerNote,
  cancel,
  overlay,
  className,
}: RunSetupProps) {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const { data: skillsState } = useSkills(skillsEnabled);
  const { data: mcpState } = useMcp();
  const { data: accountsState } = useAccounts();
  const prefs = automationPrefs(state);
  const rawPrefs = (state?.prefs ?? {}) as Record<string, unknown>;
  const defaultSkills = state?.defaultSkills ?? [];
  const accounts = accountsState?.accounts ?? [];
  const skills: SkillInfo[] = skillsState ?? [];
  const run: RunState | null = context.run ?? null;
  const staged = isStaged(mode, Boolean(overlay));
  // What "own checkout" would DO for this plan — asked only while the control
  // is on screen for a start-shaped dialog; a live run reads the RUN, not a
  // prediction.
  const { data: isolationPreflight } = useIsolationPreflight(
    shows(mode, 'isolation') && mode !== 'live' ? context.slug : undefined,
  );

  // The server's own list when it can say, this build's copy when it cannot —
  // an older server has no `models` on its state, and a form that offered
  // nothing would be worse than one offering a list that may lag by a release.
  const models = useMemo<readonly string[]>(
    () => (state?.models?.length ? state.models : MODELS),
    [state?.models],
  );

  // This browser's last launch of the plan — a fresh start only. A run's own
  // record outranks it (`seed.ts`), so a continue never reads it.
  const memory = useMemo(
    () =>
      (mode === 'start' || mode === 'phase') && !run && context.slug ? recallLaunch(context.slug) : null,
    [mode, run, context.slug],
  );

  // `prefs`, `rawPrefs`, `context` and `defaultSkills` are fresh objects each
  // render; their CONTENT is what matters, so the identity used below is the
  // content.
  const prefsKey = JSON.stringify(prefs);
  const rawPrefsKey = JSON.stringify(rawPrefs);
  const contextKey = JSON.stringify(context);
  const skillsKey = defaultSkills.join(',');
  const [seedBase, originsBase] = useMemo(
    () => seedFor(mode, { run, prefs, rawPrefs, qaMode, context, defaultSkills, memory }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, run, prefsKey, rawPrefsKey, qaMode, contextKey, skillsKey, memory],
  );

  // `null` per field means "the operator has not said" — the seed keeps
  // answering, and keeps re-deriving as `/api/state` and the run arrive.
  const [touched, setTouched] = useState<Partial<RunSetupValues>>({});
  // The preset the operator pressed (control-tower phase 22): a SEED layer,
  // under their own touches, so what it moved reads "from preset".
  const [preset, setPreset] = useState<PresetId | null>(null);
  // The quick view's one expanded tile — null is the list.
  const [openCategory, setOpenCategory] = useState<CategoryId | null>(null);
  const [busy, setBusy] = useState(false);
  // A settings patch that turns QA on, held for the person's confirmation.
  const [qaAsk, setQaAsk] = useState<Record<string, unknown> | null>(null);

  // The prelude for THIS draft (phase 11): asked whenever the mode asks the
  // Decisions tile's questions, and it gates the submit — a blocking row
  // still open disables Launch and names itself in the footer, unless the
  // operator has signed an override. The tiles ask the same key; two hooks,
  // one request. Asked over the BASE seed and the operator's edits, so the
  // account list it resolves can seed the form below without the draft
  // changing under it.
  // Only a launch through the run door (control-tower phase 77): the live
  // sheet shows three of these answers and passes no door.
  const asksDecisions =
    runsPrelude(mode) && (shows(mode, 'resumeOnRestart') || shows(mode, 'relay') || shows(mode, 'accounts'));
  const { data: prelude, isError: preludeUnread } = usePrelude(
    context.slug,
    preludeDraft({ ...withPreset(seedBase, originsBase, preset, mode, memory)[0], ...touched }),
    asksDecisions,
  );
  // Launch waits for the prelude's FIRST answer: it fills a fresh start's
  // account list and names any blocking row, and a press before it landed was
  // refused by the start door for having no accounts (control-tower phase 33,
  // the tower rehearsal's quick start). A prelude that could not be read holds
  // nothing — the door's own refusal then says what is missing.
  const preludePending = asksDecisions && Boolean(context.slug) && !prelude && !preludeUnread;
  // The account list a fresh start opens on is the prelude's resolved clause
  // — the plan's `**Accounts:**` line, else the machine login — SEEDED rather
  // than typed, so the review reads it as the plan's word (or the default),
  // never as a change the operator made here. A run answers for itself.
  const [seedPlain, originsPlain] = useMemo<[RunSetupValues, Origins]>(() => {
    // A run with a stored list keeps it; one without (from before the field,
    // or a finished run a phase launch starts afresh) takes the prelude's.
    if (!prelude?.accounts.length || seedBase.accounts) return [seedBase, originsBase];
    const row = prelude.rows.find((r) => r.key === 'accounts');
    return [
      { ...seedBase, accounts: formatAccounts(prelude.accounts) },
      { ...originsBase, accounts: row?.origin === 'plan' ? 'plan' : 'defaults' },
    ];
  }, [prelude, seedBase, originsBase]);
  // The preset, laid over the seed — the seed every provenance word and the
  // review compare against, so a value a preset moved reads "from preset".
  const [seed, origins] = useMemo(
    () => withPreset(seedPlain, originsPlain, preset, mode, memory),
    [seedPlain, originsPlain, preset, mode, memory],
  );
  const values: RunSetupValues = { ...seed, ...touched };
  const parsed = runSetupSchema.safeParse(values);
  const errors = fieldErrors(parsed);
  const openDecision =
    asksDecisions && !values.manifestOverride.trim() ? (prelude?.blocking[0] ?? null) : null;
  // #18: the plan's git lines this launch will not honour hold Launch until
  // they are answered — the start door would refuse it by name anyway, and a
  // refusal after the press is the answer asked too late (control-tower phase 22).
  const gitUnanswered =
    asksDecisions &&
    shows(mode, 'gitStrategyAck') &&
    gitLinesOf(prelude).length > 0 &&
    !values.gitStrategyAck;
  const decisionsReason = openDecision
    ? `Decision outstanding: ${openDecision.key} — ${openDecision.why}`
    : gitUnanswered
      ? 'Answer the plan’s git lines first — honour or override, in Git.'
      : preludePending
        ? 'Reading this plan’s decisions…'
        : undefined;
  const blocked = blockedProp || Boolean(openDecision) || gitUnanswered || preludePending;
  const blockedReason = blockedProp ? blockedReasonProp : decisionsReason;

  // The preset row (a launch through the run door, staged): the choice on
  // screen is the one pressed while the values still agree with it, else the
  // first the values happen to match — or none, the operator's own mix.
  const presets = staged ? presetsFor(mode, memory) : [];
  const shownPreset =
    preset && presetAgrees(preset, values, mode, memory) ? preset : matchingPreset(values, mode, memory);
  const choosePreset = (id: PresetId) => {
    const moved = Object.keys(presetValues(id, mode, memory));
    setPreset(id);
    // The preset answers for its keys from now: an earlier touch of one of
    // them would otherwise sit on top of it and the press would do nothing.
    setTouched((prior) => {
      const next = { ...prior } as Record<string, unknown>;
      for (const key of moved) delete next[key];
      return next as Partial<RunSetupValues>;
    });
  };

  const canQaToggle = qaMode === 'off' && allowWrites !== false;
  const canAutoRecover = state?.allowAgent === true;
  const ladder = ladderPrefs(state);
  const on = (field: RunSetupField) => shows(mode, field);
  // What the mode offers, narrowed by what the live values allow — the one
  // predicate the sections gate their controls on and the review lists rows by.
  const live = (field: RunSetupField) => isLive(mode, field, values);
  const src = (field: RunSetupField): Source | undefined =>
    mode === 'defaults' ? undefined : sourceOf(values[field], seed[field], origins[field] ?? 'defaults');
  // When a change lands (#31): the settings sheet only — a launch has nothing
  // running for a change to land on, so every word would read "now".
  const fx = (field: RunSetupField): FieldEffect | undefined => {
    const word =
      mode === 'live' ? (SETTING_EFFECTS as Record<string, FieldEffect['word']>)[field] : undefined;
    if (!word) return undefined;
    return laneWorking && (LIVE_LANE_LOCKED_FIELDS as readonly string[]).includes(field)
      ? { word, refused: 'Refused while a lane is working — a change here is not applied' }
      : { word };
  };

  // Settings ▸ Automation states a preference; a launch ticks a box for one
  // run. Same value, same field, two idioms — and the idiom matters here for a
  // mechanical reason as well as a readable one: the launch dialog's "there is
  // exactly one checkbox" pin is only meaningful while these stay apart.
  const Bool = mode === 'defaults' ? PressField : ToggleField;

  const set = <K extends RunSetupField>(field: K, next: RunSetupValues[K]) => {
    setTouched((prior) => {
      // Decision 13, in the form: a branch the console cuts is isolated by
      // default. The seed answers from the preference, which is `queue` on a
      // default-branch console — right for a run that adopts a branch somebody
      // may be standing on, wrong the moment the operator asks for a NEW one.
      // Only while nobody has said (the operator's own tick outranks it), and
      // only on a launch: the defaults page saves one key at a time and the
      // server folds this default itself; a live run's checkout is settled.
      const follows =
        field === 'gitMode' &&
        next === 'new-branch' &&
        prior.isolation === undefined &&
        mode !== 'defaults' &&
        mode !== 'live' &&
        DEFAULT_ISOLATION_FOR_NEW_BRANCH;
      return { ...prior, [field]: next, ...(follows ? { isolation: ISOLATED } : {}) };
    });
    // Settings ▸ Automation saves as you go, one key at a time, merged
    // server-side: two tabs flipping different knobs must not overwrite each
    // other, and there is no "Save" on a page of preferences.
    if (mode === 'defaults') {
      const patch = buildPrefs({ ...values, [field]: next });
      const key = PREF_KEY[field];
      if (key) void savePref(client, { [key]: patch[key] });
    }
  };

  /**
   * One settings patch, and what came of it. A 409 carries `refused` — the
   * fields the door would not take, BY NAME (a live lane holds `gitMode`, the
   * account is its own verb) — beside the run with everything else applied,
   * so it reads as a partial success rather than a failure (phase 13, #31).
   */
  async function postSettings(slug: string, payload: Record<string, unknown>) {
    try {
      await api.runSettings(slug, payload as never);
      toast('Settings applied.', 'ok');
      onDone?.();
    } catch (error) {
      const refused = (error as ApiError).status === 409 ? refusedOf((error as ApiError).body) : [];
      if (!refused.length) throw error;
      toast('Applied everything else in the patch.', 'ok');
      for (const row of refused) toast(`${row.field} was not applied — ${row.why}`, 'warn');
      for (const queryKey of keys.afterRunLaunch()) void client.invalidateQueries({ queryKey });
      onDone?.();
    }
  }

  async function onSubmit() {
    if (blocked || busy) return;
    if (!parsed.success) {
      toast('Some fields need fixing before this can start.', 'warn');
      return;
    }
    setBusy(true);
    try {
      const door = MODES[mode].door;
      if (door === 'ticket') {
        const id = await startSession(
          client,
          buildTicket(mode as 'qa' | 'recovery', values, context, defaultSkills),
        );
        if (id) onDone?.(id);
        return;
      }
      if (door === 'launch') {
        await onLaunch?.(buildLaunch(values, mode, defaultSkills));
        onDone?.();
        return;
      }
      if (door === 'prefs') {
        await savePref(client, buildPrefs(values));
        toast('Defaults saved.', 'ok');
        onDone?.();
        return;
      }
      const slug = context.slug!;
      const payload = buildRunPayload(mode, values, context);
      // The QA-recovery door. Its answer is the same `{ run, error }` envelope
      // the two run doors give, and it is read the same way — a refusal comes
      // back as a 409 body rather than a throw, and a recovery the server
      // declined must never read as one that started.
      if (door === 'qaRecover') {
        const answer = await api.qaRecover(slug, context.phase!, payload as never);
        if (answer.error) toast(answer.error, 'error');
        else if (!answer.run) toast('The QA recovery did not start.', 'error');
        else toast(`Fix & re-QA started on phase ${context.phase}.`, 'ok');
        onDone?.();
        return;
      }
      if (door === 'runSettings') {
        // Turning the plan's QA gate on writes `test-status.md`, so the person
        // is asked BEFORE the patch posts (control-tower phase 13, #31); the
        // dialog's confirm posts it again with the server's word for "yes".
        if (payload.qa === true && !/^on\b/.test(qaMode ?? '')) {
          setQaAsk(payload);
          return;
        }
        await postSettings(slug, payload);
        return;
      } else {
        // The RESPONSE decides what this says. It used to be discarded
        // entirely — `await` then an unconditional "Continuing …" — so a start
        // the server declined still read as success, which is B2(b)'s last
        // step: a refusal reached the operator as a green toast and the run
        // they were told about did not exist. Three things can come back:
        //
        //   `error`     the envelope refused it. A 200 body, so nothing throws.
        //   `run: null` no run was created and no reason was given.
        //   `run`       it started — and `preflight` may still carry warnings
        //               worth saying now rather than an hour into the run.
        const answer = await api.runStart(slug, payload as never);
        if (answer?.error) {
          toast(answer.error, 'error');
          return;
        }
        if (!answer?.run) {
          toast(
            'The console did not start a run, and gave no reason. Reload and look at the status.',
            'warn',
          );
          return;
        }
        toast(mode === 'phase' ? `Running phase ${context.phase} of ${slug}` : `Continuing ${slug}`, 'ok');
        // Advisory, and deliberately AFTER the success line: phases that will
        // park at boarding, and phases claimed by a live holder this run will
        // queue behind. Neither stopped the run; both are things the operator
        // would otherwise discover much later.
        for (const line of answer.preflight ?? []) toast(line, 'warn');
        // What this plan was launched with, for next time — posture only, on
        // success only (`launch-memory.ts`).
        rememberLaunch(slug, values, BASELINE, on);
        // The named bundle, not four hand-listed keys: "what a launch moves"
        // is a fact about the cache and belongs in one place.
        for (const queryKey of keys.afterRunLaunch()) void client.invalidateQueries({ queryKey });
      }
      onDone?.();
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  }

  const permissionChoices =
    mode === 'qa' ? QA_PERMISSIONS : MODES[mode].sessionPermissions ? SESSION_PERMISSIONS : RUN_PERMISSIONS;
  const permissionOptions = permissionChoices.map((choice) => [choice, PERMISSION_CHOICES[choice]] as const);
  const permissionName = (choice: string) => (PERMISSION_CHOICES[choice] ?? choice).split(' — ')[0]!;
  const permissionQualifier = (choice: string) =>
    (PERMISSION_CHOICES[choice] ?? '').split(' — ').slice(1).join(' — ');
  const accountName = (id: string) => {
    if (id === 'auto') return 'auto — the most headroom';
    const account = accounts.find((a) => a.id === id);
    if (!account) return id === 'default' ? 'machine login' : id;
    // Credits carry it past its plan windows (control-tower phase 93): said
    // where the account is chosen, so nobody picks it thinking it is capped.
    return account.credits?.carrying
      ? `${accountWho(account)} — uses credits past plan limits`
      : accountWho(account);
  };

  const form: SetupForm = {
    mode,
    context,
    values,
    seed,
    origins,
    errors,
    set,
    on,
    live,
    src,
    fx,
    Bool,
    models,
    modelOptions: models.map((name) => [name, MODEL_NOTE[name] ?? name] as const),
    effortOptions: EFFORTS.map((level) => [level, EFFORT_NOTE[level] ?? level] as const),
    permissionOptions,
    permissionName,
    permissionQualifier,
    permissionHint: (choice) => PERMISSION_HINT[choice] ?? '',
    accounts,
    accountName,
    skills,
    mcpServers: mcpState?.servers ?? [],
    defaultSkills,
    planSkills,
    planMcp,
    planPhases,
    planReviewers,
    qaMode,
    pushBroken,
    allowWrites,
    // From the console's own state rather than a prop: the flag is a fact
    // about THIS process, which every launch surface shares (phase 15).
    allowPublish: state?.allowPublish,
    skillsEnabled,
    canQaToggle,
    canAutoRecover,
    isolationPreflight,
    concurrencyMax: state?.concurrency?.max,
    ladderCaps: { perRun: ladder.ladderPerRunRungs, perPhase: ladder.ladderPerPhaseRungs },
    blocked,
    blockedReason,
    busy,
    valid: parsed.success,
    submitLabel: submitLabel(mode, context),
    submit: () => void onSubmit(),
    footerNote,
    ...(staged
      ? {
          openCategory,
          goCategory: setOpenCategory,
          presets,
          preset: shownPreset,
          choosePreset,
        }
      : {}),
  };

  const icon =
    mode === 'qa' ? (
      <ShieldCheck size={15} aria-hidden />
    ) : mode === 'session' ? (
      <Play size={15} aria-hidden />
    ) : (
      <Bot size={15} aria-hidden />
    );

  if (overlay) {
    const runDoor = MODES[mode].door === 'runStart' || MODES[mode].door === 'runSettings';
    return (
      <SetupFormProvider value={form}>
        <LaunchShell
          open={overlay.open}
          onOpenChange={overlay.onOpenChange}
          title={overlay.title}
          description={overlay.description}
          mode={mode}
          staged={staged}
          scrollKey={openCategory ?? 'list'}
          banners={
            <>
              {state?.allowRun === false && runDoor && <NoAllowRun />}
              {children}
            </>
          }
          submit={{
            label: submitLabel(mode, context),
            busy,
            disabled: busy || blocked || !parsed.success,
            ...(blocked && blockedReason ? { title: blockedReason } : {}),
            onSubmit: () => void onSubmit(),
            note: blocked && blockedReason ? blockedReason : staged ? undefined : footerNote,
          }}
        >
          {/* A staged launch is the quick view (control-tower phase 22): one
              screen of category tiles, each control one Edit away. */}
          {staged ? <QuickView /> : <FlatForm />}
        </LaunchShell>
        <AlertDialog open={qaAsk !== null} onOpenChange={(open) => (open ? null : setQaAsk(null))}>
          {qaAsk !== null ? (
            <AlertDialogContent
              title="Turn the QA gate on for this plan?"
              description="This creates test-status.md: each phase that finishes from now waits for an independent review before its dependents board, and the phases that finished before now are recorded as waived."
              confirmLabel="Turn QA on"
              cancelLabel="Leave QA off"
              onConfirm={() => {
                const pending = qaAsk;
                setQaAsk(null);
                setBusy(true);
                void postSettings(context.slug!, { ...pending, confirm: QA_CONFIRM })
                  .catch(toastError)
                  .finally(() => setBusy(false));
              }}
            />
          ) : null}
        </AlertDialog>
      </SetupFormProvider>
    );
  }

  return (
    <SetupFormProvider value={form}>
      <div className={cn('flex min-w-0 flex-col gap-3', className)}>
        {children}
        <FlatForm />
        {submit && MODES[mode].door !== 'prefs' && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-2xs text-ink-muted">
              {blocked && blockedReason ? blockedReason : footerNote}
            </span>
            <div className="flex gap-2">
              {cancel}
              <Button
                variant="action"
                disabled={busy || blocked || !parsed.success}
                title={blocked ? blockedReason : undefined}
                onClick={() => void onSubmit()}
              >
                {icon} {busy ? 'Starting…' : submitLabel(mode, context)}
              </Button>
            </div>
          </div>
        )}
      </div>
      <AlertDialog open={qaAsk !== null} onOpenChange={(open) => (open ? null : setQaAsk(null))}>
        {qaAsk !== null ? (
          <AlertDialogContent
            title="Turn the QA gate on for this plan?"
            description="This creates test-status.md: each phase that finishes from now waits for an independent review before its dependents board, and the phases that finished before now are recorded as waived."
            confirmLabel="Turn QA on"
            cancelLabel="Leave QA off"
            onConfirm={() => {
              const pending = qaAsk;
              setQaAsk(null);
              setBusy(true);
              void postSettings(context.slug!, { ...pending, confirm: QA_CONFIRM })
                .catch(toastError)
                .finally(() => setBusy(false));
            }}
          />
        ) : null}
      </AlertDialog>
    </SetupFormProvider>
  );
}

/** The fields a settings 409 names as not applied (control-tower phase 13) — empty for any other refusal. */
export function refusedOf(body: unknown): { field: string; why: string; verb?: string }[] {
  const rows = (body as { refused?: unknown } | null | undefined)?.refused;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is { field: string; why: string; verb?: string } =>
      typeof (row as { field?: unknown })?.field === 'string' &&
      typeof (row as { why?: unknown })?.why === 'string',
  );
}

/** What each toggle in `defaults` mode is called on the server. */
const PREF_KEY: Partial<Record<RunSetupField, string>> = {
  attachDefaultSkills: 'attachDefaultSkills',
  qa: 'qaByDefault',
  gitMode: 'gitMode',
  openPr: 'openPrOnComplete',
  // The select that replaced that tick in every mode which offers both. Its
  // form field and server key share a name, like `isolation` below, and it is
  // listed for the same reason: absence here means the control silently does
  // not save in `defaults` mode.
  settle: 'settle',
  // The one pref whose form field and server key share a name — the toggle
  // writes `isolation` and the run reads `isolation`, so there is nothing to
  // translate. Listed anyway: this map is what makes a field per-key saveable
  // in `defaults` mode, and absence here means the toggle silently does not save.
  isolation: 'isolation',
  autoRecover: 'autoRecoverByDefault',
  mcpPolicy: 'mcpPolicy',
  // Phase 15's seven, each under the key `server/config.ts` stores it as —
  // the same name on both sides, listed for `isolation`'s reason: absence
  // here means the control silently does not save in `defaults` mode.
  baseBranch: 'baseBranch',
  maxConcurrentPerRepo: 'maxConcurrentPerRepo',
  worktreeRetention: 'worktreeRetention',
  landing: 'landing',
  conflictPolicy: 'conflictPolicy',
  messaging: 'messaging',
  issuesMode: 'issuesMode',
  // Both were seeded FROM prefs and rendered in `defaults` mode, and absent
  // from this map — so flipping either in Settings ▸ Automation changed local
  // state and saved nothing (console-parallel-repaint P12, the posture sweep).
  reviewEachPhase: 'reviewEachPhaseByDefault',
  reviewerPolicy: 'reviewerPolicy',
};

async function savePref(client: ReturnType<typeof useQueryClient>, patch: Record<string, unknown>) {
  try {
    await api.savePrefs(patch);
    await client.invalidateQueries({ queryKey: keys.state() });
  } catch (error) {
    toastError(error);
  }
}

/** One line under the permission select, so the cost is read while choosing. */
const PERMISSION_HINT: Record<string, string> = {
  guarded:
    'Commits, installs, merges and fetches raise a card. The deny list — pushes, destructive git, deploys, publishes — is refused outright and no card can approve it.',
  trusted:
    'Nothing raises a card. The deny list still holds, and still holds with this console dead — it is enforced by the CLI, not by the hook.',
  bypass:
    'Nothing raises a card and the CLI stops asking too (--permission-mode bypassPermissions). Requires the bypass disclaimer to have been accepted once, interactively, on this machine; without it the CLI silently downgrades and refuses every edit.',
  plan: 'Read-only until a plan is approved in the session itself.',
  auto: 'The CLI decides what needs asking.',
  dontAsk: 'Refuses rather than prompting.',
};

/** The resolver's messages, keyed by field, for the controls to render. */
function fieldErrors(parsed: ReturnType<typeof runSetupSchema.safeParse>): Record<string, string> {
  if (parsed.success) return {};
  const out: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export { mergedSkills, DEFAULTS };
