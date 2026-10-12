/**
 * Settings ▸ Automation, what every launch opens on (7.0, quiet-console phase
 * 21): the launch form in its `defaults` mode, and the console's own keys
 * around it.
 *
 * ```
 * Launch defaults
 * What every launch opens on. A launch can still change any of them for itself.
 * [ the launch form, inline: skills, QA, branch, isolation, landing, … ]
 * Outward writes                                                     Off
 *
 * The freeze
 * Freeze the whole console                                 [Freeze all]
 *
 * Recovery and watches     [x] Continue runs a recovery fixed …
 * The check                [x] Check what a command cannot …
 * Checkouts and branches   [x] Repository guard …  Worktree root [Inside the project ▾]
 * ```
 *
 * The form IS the editor of the run-governing defaults — the component, the
 * words and the order a launch uses, each field saving its own key as it
 * changes — so no key it edits is drawn here a second time. What this file
 * draws is what is not a run setting: the watches, the check on Your turn,
 * the console's checkouts and branches, and the freeze, which is no
 * preference at all but an act with a moment and an author.
 *
 * The four worktree knobs are drawn only while new runs are isolated, and the
 * sentence standing in for them says why: a cap that governs nothing reads as
 * configured and does nothing.
 */

import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ISOLATED,
  WORKTREE_DEFAULTS,
  WORKTREE_ROOTS,
  isolationMode,
  reclaimModeOf,
  worktreeRootOf,
  type WorktreeRoot,
} from '@shared/worktree-model.js';
import { useConsoleState } from '@/data/console';
import { pressFleet } from '@/data/lifecycle';
import { LaunchForm } from '@/screens/launch/door';
import { EFFORTS, offeredModelOptions } from '@/screens/launch/model/defaults';
import { settingsHref } from '@/shell/routes';
import { Button, Skeleton } from '@/ui';
import {
  BoolSetting,
  NumberSetting,
  SettingRow,
  SettingsGroup,
  TextSetting,
  WordSetting,
  useSchemaRow,
  useSetting,
} from './setting';

/** A link inside a sentence, kept on one line so no tap lands between its halves. */
const LINK = 'tap-line whitespace-nowrap text-ink underline decoration-ink-faint underline-offset-2';

/** What the checking session runs as, and at, when nothing says otherwise (`server/config.ts`). */
const CHECK_MODEL = 'sonnet';
const CHECK_EFFORT = 'low';

/** Where the console's checkouts live, in a person's words. */
const ROOT_WORDS: Readonly<Record<WorktreeRoot, string>> = {
  project: 'Inside the project folder',
  state: 'In the state directory',
};

/** What stands in the form's place until its chunk arrives: it is the heaviest thing the console draws. */
const FORM_FALLBACK = (
  <div className="flex min-w-0 flex-col gap-4" aria-busy="true">
    {[0, 1, 2, 3].map((n) => (
      <Skeleton key={n} className="h-9 max-w-md" />
    ))}
  </div>
);

export function AutomationDefaults() {
  return (
    <>
      <LaunchDefaultsGroup />
      <FreezeGroup />
      <RecoveryGroup />
      <CheckGroup />
      <CheckoutsGroup />
    </>
  );
}

/* ---------------- what every launch opens on ---------------- */

function LaunchDefaultsGroup() {
  const { data: state } = useConsoleState();
  return (
    <SettingsGroup
      id="automation-launch"
      title="Launch defaults"
      lead="What every launch opens on. A launch can still change any of them for itself."
    >
      <LaunchForm mode="defaults" fallback={FORM_FALLBACK} />
      {state && <OutwardWrites on={state.allowPublish === true} />}
    </SettingsGroup>
  );
}

/** A start flag, said as the word the console runs with. */
function FlagWord({ on }: { on: boolean }) {
  return (
    <span className="block text-body text-ink sm:text-end" data-flag-state>
      {on ? 'On' : 'Off'}
    </span>
  );
}

/**
 * Not a preference and not a control: the start flag the landing defaults in
 * the form mean one thing with and another without. Said beside them because
 * nothing on this page can turn it on — a start flag is changed at the start
 * command.
 */
function OutwardWrites({ on }: { on: boolean }) {
  return (
    <div data-testid="publish-flag">
      <SettingRow
        label="Outward writes"
        hint={
          <>
            <code>--allow-publish</code> is a start flag, not a preference.{' '}
            {on
              ? 'A phase whose landing is pr or trunk is pushed and its pull request opened.'
              : 'Nothing is pushed: a pr or trunk landing is held and says so.'}
          </>
        }
        note={
          <>
            Restart the console with or without the flag to change it.{' '}
            <a href={settingsHref('essentials')} className={LINK}>
              Essentials
            </a>{' '}
            shows the start command.
          </>
        }
      >
        <FlagWord on={on} />
      </SettingRow>
    </div>
  );
}


/* ---------------- the freeze ---------------- */

/**
 * The panic button, as an act rather than a field: a freeze has a moment and
 * an author. Pressed through the one fleet door (`pressFleet`), so a console
 * with an owner key asks its owner. No confirmation here — no Stop sits
 * beside it, and thawing puts everything back.
 */
function FreezeGroup() {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const [busy, setBusy] = useState(false);
  const fleet = state?.fleet;
  const frozen = fleet?.frozen === true;
  const canRun = state?.allowRun === true;

  const act = async () => {
    setBusy(true);
    try {
      await pressFleet(client, frozen ? 'thaw' : 'freeze');
    } finally {
      setBusy(false);
    }
  };

  // Why it cannot be pressed, else who froze the console.
  let note: ReactNode;
  if (state && !canRun) {
    note = (
      <>
        This console starts nothing, so it has nothing to freeze: it runs without <code>--allow-run</code>.
      </>
    );
  } else if (frozen) {
    note = fleet?.by ? `Frozen now, by ${fleet.by}.` : 'Frozen now.';
  }

  return (
    <SettingsGroup id="automation-freeze" title="The freeze">
      <SettingRow
        label="Freeze the whole console"
        hint="Stop every running session where it stands and start nothing new: no queued phase, no wait, no recovery. Thawing continues each session mid-token and puts the queue back as it was, and a freeze survives a restart."
        note={note}
      >
        {({ describedBy }) => (
          <Button
            size="sm"
            aria-describedby={describedBy}
            disabled={busy || !canRun}
            onClick={() => void act()}
          >
            {busy ? (frozen ? 'Thawing…' : 'Freezing…') : frozen ? 'Thaw all' : 'Freeze all'}
          </Button>
        )}
      </SettingRow>
    </SettingsGroup>
  );
}

/* ---------------- recovery and watches ---------------- */

function RecoveryGroup() {
  return (
    <SettingsGroup id="automation-recovery" title="Recovery and watches">
      <BoolSetting
        pref="autoContinueRecovery"
        label="Continue runs a recovery fixed"
        hint="When a recovery session ends and the board reads fixed, the run carries on by itself, after a recovery you started by hand too."
      />
      <BoolSetting
        pref="watchCmdRefs"
        label={
          <>
            Run <code>cmd:</code> watch refs
          </>
        }
        hint={
          <>
            A session may declare <code>--watch cmd:"…"</code>, and the console runs that command on a timer
            to see whether what it waits for has landed, under the read-only policy a plan’s verification
            gets: 60 seconds, never a shell. Off, such a ref never runs and nothing resumes on it.
          </>
        }
      />
      <BoolSetting
        pref="watchMintedCmdRefs"
        label={
          <>
            Run <code>cmd:</code> refs the console minted
          </>
        }
        hint="When the watchdog parks a lane that was polling inside its turn, it files that poll as a watch ref of its own. Off (shipped), such a ref is recorded and never run, so the console’s own guess never runs a writing command, and the park still resumes on its clock."
      />
    </SettingsGroup>
  );
}

/* ---------------- the check on Your turn ---------------- */

/**
 * What reads a person's "I've done this" when no command can — one short
 * read-only session per item — and when a third "not yet" goes to the owner
 * (control-tower phase 134).
 */
function CheckGroup() {
  const { data: state } = useConsoleState();
  const model = useSetting<string>('checkModel');
  const effort = useSetting<string>('checkEffort');
  const runsAs = typeof model.value === 'string' && model.value ? model.value : CHECK_MODEL;
  const thinks = typeof effort.value === 'string' && effort.value ? effort.value : CHECK_EFFORT;
  return (
    <SettingsGroup id="automation-check" title="The check">
      <BoolSetting
        pref="checkJudgement"
        label="Check what a command cannot"
        hint="When a person says they have done something only words can prove, a short read-only session reads what they sent against the proof and answers passed, sent back with what to redo, or needs more: at most 12 turns, $0.50 and five minutes. Off, such an item is accepted on the person’s word and marked unverified."
      />
      <WordSetting
        pref="checkModel"
        label="Checking model"
        hint="What the checking session runs as (shipped: sonnet). It only reads, so a small model is usually enough."
        options={offeredModelOptions(state?.models, runsAs)
          .filter(Boolean)
          .map((name) => [name, name] as const)}
        value={runsAs}
        onChange={model.save}
      />
      <WordSetting
        pref="checkEffort"
        label="Checking effort"
        hint="How hard the checking session thinks (shipped: low)."
        options={EFFORTS.filter(Boolean).map((level) => [level, level] as const)}
        value={thinks}
        onChange={effort.save}
      />
      <NumberSetting
        pref="turnEscalateAfter"
        label="Send to the owner after"
        unit="rejections"
        integer
        min={1}
        max={20}
        hint="When one item is sent back this many times, the owner is told once and shown every attempt side by side, with three ways out: rewrite the guide, I can’t, or accept it anyway (shipped: 3)."
      />
    </SettingsGroup>
  );
}

/* ---------------- checkouts and branches ---------------- */

/**
 * Whether a new run gets a checkout of its own — the gate on the four worktree
 * knobs. Read first where the launch form above reads and writes it, the
 * console's state (a save there re-reads the state, not the schema), and from
 * the schema while the state names no word.
 */
function useIsolated(): boolean {
  const { data: state } = useConsoleState();
  const { row } = useSchemaRow('isolation');
  const stated: unknown = state?.prefs?.isolation;
  return isolationMode(typeof stated === 'string' ? stated : (row?.value ?? row?.default)) === ISOLATED;
}

function CheckoutsGroup() {
  const isolated = useIsolated();
  const root = useSetting<string>('worktreeRoot');
  const setup = useSetting<string>('worktreeSetup');
  const reclaim = useSetting<string>('isolationReclaim');
  return (
    <SettingsGroup id="automation-checkouts" title="Checkouts and branches">
      <BoolSetting
        pref="repoGuard"
        label="Repository guard"
        hint="Queue runs whose repositories overlap. Off, overlapping runs may start at once, and a work-branch run sharing a repository is steered into a git worktree."
      />
      <BoolSetting
        pref="radarSerialize"
        label="Serialise conflicted branches"
        hint={
          <>
            When the conflict radar measures two live branches as conflicted, the one the landing order puts
            second waits until the first has landed: a <code>radar</code> holder on the queue,{' '}
            <code>phase.radar-hold</code> in the journal. Off (shipped), the pair is only shown, and a console
            without the radar does nothing either way.
          </>
        }
      />
      <BoolSetting
        pref="deleteMergedRunBranches"
        label="Delete merged run branches"
        hint={
          <>
            Once a run’s pull request has merged, delete its <code>pe/&lt;slug&gt;</code> and lane branches
            with <code>git branch -d</code>, which git refuses for a branch whose commits nothing else
            reaches, so an unmerged branch survives whatever this says.
          </>
        }
      />
      {/* Two words of the owner's list, not a boolean: the door drops a value it cannot read. */}
      <WordSetting
        pref="worktreeRoot"
        label="Worktree root"
        hint={
          <>
            Where every checkout the console makes for this project lives: its lanes, mirrors and staging
            tree. Inside the project folder keeps them under <code>.worktrees/</code>, out of the root’s own
            git status; the state directory is the older placement. Trees already standing under either are
            still found and swept.
          </>
        }
        options={WORKTREE_ROOTS.map((where) => [where, ROOT_WORDS[where]] as const)}
        value={worktreeRootOf(root.value)}
        onChange={root.save}
      />
      {isolated ? (
        <>
          <NumberSetting
            pref="worktreeMaxConcurrent"
            label="Worktrees at once"
            unit="trees"
            integer
            min={1}
            hint={`How many console-made checkouts may exist across every live run, each a full working tree on disk (shipped: ${WORKTREE_DEFAULTS.worktreeMaxConcurrent}). A run over the cap runs in the shared checkout and says so.`}
          />
          {/* Trimmed before it is sent, as the 6.x field sent it: this value becomes a shell command. */}
          <TextSetting
            pref="worktreeSetup"
            label="Setup command"
            mono
            placeholder="nothing"
            hint={
              <>
                Run once inside a fresh worktree before any session boards it, such as <code>npm ci</code> or
                a symlink. Empty runs nothing.
              </>
            }
            value={typeof setup.value === 'string' ? setup.value : ''}
            onChange={(next) => setup.save((next ?? '').trim())}
          />
          <BoolSetting
            pref="worktreeCopyEnv"
            label="Copy .env files into a new worktree"
            hint="A linked checkout does not carry the source tree’s ignored files, so a run that needs them cannot build without this. Off by default: copying secrets into a second directory is a decision, not something to discover."
          />
          {/* A box over two words of the owner's list: ticked is `clean-only`, the
              shipped answer; unticked is `never`. A boolean on the wire would be
              dropped by the door in silence. */}
          <BoolSetting
            pref="isolationReclaim"
            label="Take the run branch back from a clean checkout"
            hint={
              <>
                Sessions are told to check <code>pe/&lt;slug&gt;</code> out, so your own checkout can end up
                holding it and every later run of the plan sharing that tree. On, a checkout on the run branch
                with nothing uncommitted is switched to the default branch; a checkout holding work is never
                touched, and no branch is deleted.
              </>
            }
            value={reclaimModeOf(reclaim.value) !== 'never'}
            onChange={(on) => reclaim.save(on ? 'clean-only' : 'never')}
          />
        </>
      ) : (
        <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="worktree-knobs-off">
          The worktree cap, the setup command, the .env copy and taking the run branch back apply to isolated
          runs only. To use them, choose a work branch per run in the launch defaults above, then give each
          run its own checkout.
        </p>
      )}
    </SettingsGroup>
  );
}
