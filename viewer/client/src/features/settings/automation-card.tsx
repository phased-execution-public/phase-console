/**
 * Automation defaults — the opening values for every launch surface.
 *
 * The six that govern a RUN are rendered by `RunSetup` in `defaults` mode: the
 * same component, the same words and the same order as the launch dialog and
 * the run page's controls, so "the default" and "this launch" are visibly the
 * same form rather than two forms that happen to agree. Each still saves as
 * its own key the moment it changes (`POST /api/prefs` merges server-side —
 * two tabs flipping different knobs must not overwrite each other).
 *
 * What stays declared here is what is NOT a run setting: the knobs that govern
 * the console's own scheduling and worktree lifecycle rather than what a
 * session may do. The isolation TOGGLE is a run setting and belongs to the form
 * above, beside the branch choice it depends on; the cap, the setup command and
 * the .env copy are this console's, and they are shown only while isolation is
 * on so that a knob governing nothing is never presented as one that does.
 *
 * State is rendered from `/api/state`, the same discipline as the
 * notifications card: a preference that governs a server process is shown from
 * what that process actually holds, never from a local copy of the intention.
 */

import { useConsoleState, useSavePrefs } from '@/lib/queries';
import { automationPrefs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { settingsHref } from '@/app/routes';
import { Button, Card, CardBody, CardHeader, CardTitle, CardSkeleton } from '@/components/ui';
import { RunSetup } from '@/features/run-setup/run-setup';
import { NumberField } from '@/features/settings/ladder';
import { FleetFreezeControl } from '@/components/fleet-freeze';
import { ISOLATED, WORKTREE_DEFAULTS } from '@shared/worktree-model.js';

export function AutomationCard() {
  const { data: state, isPending } = useConsoleState();

  // One key at a time, merged server-side — two tabs flipping different knobs
  // must not overwrite each other.
  const save = useSavePrefs();

  if (isPending && !state) return <CardSkeleton loading h="64" />;

  const prefs = automationPrefs(state);
  const busy = save.isPending;

  const row = 'flex flex-wrap items-center justify-between gap-2';
  const onOff = (value: boolean, key: string, on = 'On', off = 'Off') => (
    <Button
      size="sm"
      data-pref={key}
      aria-pressed={value}
      disabled={busy}
      onClick={() => save.mutate({ [key]: !value })}
    >
      {value ? on : off}
    </Button>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automation</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {/* The launch form itself, in the mode that edits the defaults every
            other mode opens on. No submit button: a page of preferences has
            no "Save", and each field is its own patch. */}
        <RunSetup mode="defaults" />

        {/* Not a preference either, and not a verb: the eighth capability flag
            (phase 8), stated beside the landing and issues defaults it
            governs, because `Landing: pr` and `Issues: file` above mean one
            thing with it and another without — and nothing on this page can
            turn it on. A start flag is changed at the start command. */}
        <p className={cn(row, 'text-2xs text-ink-muted')} data-testid="publish-flag">
          <span className="min-w-0">
            <span className="text-sm text-ink">Outward writes</span>
            <span className="mt-0.5 block">
              <code>--allow-publish</code> is <strong>{state?.allowPublish ? 'on' : 'off'}</strong> on this
              console — a start flag, not a preference.{' '}
              {state?.allowPublish
                ? 'A phase whose word is pr or trunk is pushed and its pull request opened; an issue a plan says to file is filed.'
                : 'Nothing is pushed and no issue is filed: a pr or trunk landing is held and says so, and Issues: file holds every draft in the inbox for a person. Restart with the flag to change that.'}{' '}
              <a href={settingsHref('essentials')} className="text-action underline">
                Essentials
              </a>{' '}
              shows the start command.
            </span>
          </span>
        </p>

        {/* Not a preference — which is why it is a verb button and not a
            toggle: a freeze is an ACT with a moment and an author, the same
            distinction that makes hold/release verbs rather than fields. It
            lives here only until the orchestration board's header exists
            (phase 19); an endpoint no surface can reach is an endpoint nobody
            can trust. Hidden without `--allow-run`, because a console that
            starts nothing has nothing to stop. */}
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Freeze the whole console</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              Stop every running session where it stands and start nothing new — no queued phase, no wait, no
              recovery. Nothing is lost: thawing continues each session mid-token and puts the queue back
              exactly as it was. Survives a restart.
            </span>
          </span>
          <FleetFreezeControl />
        </div>

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Continue runs a recovery fixed</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              When a recovery session ends and the board reads fixed, the run resumes by itself — manual
              Fix-with-AI sessions included.
            </span>
          </span>
          {onOff(prefs.autoContinueRecovery, 'autoContinueRecovery')}
        </div>

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">
              Run <code>cmd:</code> watch refs
            </span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              A session can declare <code>--watch cmd:&quot;…&quot;</code> and the console runs that command
              on a timer to see whether the thing it is waiting for has landed — under the same read-only
              policy a plan&apos;s Verification gets, 60 s, never a shell. Off: such a ref is never run and
              nothing resumes on it.
            </span>
          </span>
          {onOff(prefs.watchCmdRefs, 'watchCmdRefs')}
        </div>

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">
              Run <code>cmd:</code> refs the console minted
            </span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              When the watchdog parks a lane that was polling inside its turn, it files the command it was
              polling with as a watch ref of its own. Off (shipped): such a ref is recorded and never run —
              the console&apos;s own inference does not execute a writing command against a repository nobody
              is watching; the park still resumes on its clock. On: minted refs run exactly as declared ones
              do.
            </span>
          </span>
          {onOff(prefs.watchMintedCmdRefs, 'watchMintedCmdRefs')}
        </div>

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Repository guard</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              Queue runs whose repositories overlap. Off: overlapping runs may start at once, and a
              work-branch run sharing a repo is steered into a git worktree.
            </span>
          </span>
          {onOff(prefs.repoGuard, 'repoGuard')}
        </div>

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Serialise conflicted branches</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              When the repository&apos;s conflict radar measures two live branches as CONFLICTED, make the one
              the landing order puts second wait until the first has landed (a <code>radar</code> holder on
              the queue, <code>phase.radar-hold</code> in the journal). Off (shipped): the radar stays
              advisory — the pair is shown, nothing waits. Does nothing on a console without the radar.
            </span>
          </span>
          {onOff(prefs.radarSerialize, 'radarSerialize')}
        </div>

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Delete merged run branches</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              Once a run&apos;s pull request has MERGED, delete its <code>pe/&lt;slug&gt;</code> and lane
              branches. Always <code>git branch -d</code>, which git refuses for a branch whose commits are
              reachable from nothing else — so an unmerged branch survives this whatever the setting says.
            </span>
          </span>
          {onOff(prefs.deleteMergedRunBranches, 'deleteMergedRunBranches')}
        </div>

        {/* The isolation TOGGLE is a run setting and is rendered by the form
            above, beside the branch choice it depends on. These three are not:
            they govern the console's own worktree lifecycle rather than what a
            run asks for, which is why they sit here with the repository guard.

            Shown only while isolation is on, deliberately. A cap and a setup
            command that govern nothing are the kind of setting that reads as
            configured and does nothing — and the row that replaces them SAYS
            they are inapplicable rather than simply vanishing, the same way the
            launch dialog explains a hidden PR toggle. */}
        {prefs.isolation === ISOLATED ? (
          <>
            <NumberField
              pref="worktreeMaxConcurrent"
              id="worktree-max-concurrent"
              label="Worktrees at once"
              value={prefs.worktreeMaxConcurrent}
              unit="trees"
              min={1}
              hint={`How many console-managed checkouts may exist across every live run — each one is a full working tree on disk (shipped: ${WORKTREE_DEFAULTS.worktreeMaxConcurrent}). A run over the cap runs in the shared checkout and says so.`}
              disabled={busy}
              onSave={(next) => save.mutate({ worktreeMaxConcurrent: next })}
            />

            <div className={row}>
              <span className="min-w-0">
                <span className="text-sm text-ink">Setup command</span>
                <span className="mt-0.5 block text-2xs text-ink-muted">
                  Run once inside a freshly created worktree, before any session boards it — an
                  <code className="mx-1">npm ci</code>, a symlink, whatever the tree needs to be usable. Empty
                  runs nothing.
                </span>
              </span>
              <input
                type="text"
                data-pref="worktreeSetup"
                aria-label="Setup command"
                className="min-h-(--tap-min) w-full max-w-64 rounded border border-rule bg-ground px-2 font-mono text-xs text-ink"
                placeholder="nothing"
                defaultValue={prefs.worktreeSetup}
                disabled={busy}
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next !== prefs.worktreeSetup) save.mutate({ worktreeSetup: next });
                }}
              />
            </div>

            <div className={row}>
              <span className="min-w-0">
                <span className="text-sm text-ink">Copy .env files into a new worktree</span>
                <span className="mt-0.5 block text-2xs text-ink-muted">
                  A linked checkout does not carry the source tree&apos;s ignored files, so a run that needs
                  them cannot build without this. Off by default: copying secrets into a second directory is a
                  decision, not something to discover.
                </span>
              </span>
              {onOff(prefs.worktreeCopyEnv, 'worktreeCopyEnv')}
            </div>

            <div className={row}>
              <span className="min-w-0">
                <span className="text-sm text-ink">Take the run branch back from a clean checkout</span>
                <span className="mt-0.5 block text-2xs text-ink-muted">
                  The console tells sessions to check <code>pe/&lt;slug&gt;</code> out, so your own checkout
                  ends up holding it — and then every later run of that plan silently shares that tree. With
                  this on, a checkout sitting on the run branch with nothing uncommitted in it is switched to
                  the default branch. A checkout holding work is never touched, and no branch is ever deleted.
                </span>
              </span>
              {/* Not `onOff`: that helper writes a BOOLEAN, and this setting's
                  two values are words the owner list holds. Spelling the
                  patch out here keeps the wire value the server's door will
                  actually accept — a `true` would be dropped in silence. */}
              <Button
                size="sm"
                data-pref="isolationReclaim"
                aria-pressed={prefs.isolationReclaim !== 'never'}
                disabled={busy}
                onClick={() =>
                  save.mutate({
                    isolationReclaim: prefs.isolationReclaim === 'never' ? 'clean-only' : 'never',
                  })
                }
              >
                {prefs.isolationReclaim === 'never' ? 'Never' : 'Clean only'}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-2xs text-ink-faint">
            The worktree cap, setup command and .env copy apply to isolated runs; turn “Give this run its own
            checkout” on above to use them.
          </p>
        )}

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Worktree root</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              Where every checkout the console makes for this project lives — lanes, mirrors and the staging
              tree. <em>Inside the project</em> keeps them under <code>.worktrees/</code> beside the work,
              excluded from the root&apos;s own git status; <em>state directory</em> is the older placement
              under the console&apos;s own state. Trees already standing under either are still found and
              swept.
            </span>
          </span>
          {/* Two words the owner list holds, not a boolean — same reason as the
              reclaim control above. */}
          <Button
            size="sm"
            data-pref="worktreeRoot"
            aria-pressed={prefs.worktreeRoot !== 'state'}
            disabled={busy}
            onClick={() =>
              save.mutate({ worktreeRoot: prefs.worktreeRoot === 'state' ? 'project' : 'state' })
            }
          >
            {prefs.worktreeRoot === 'state' ? 'State directory' : 'Inside the project'}
          </Button>
        </div>

        <p className="text-2xs text-ink-muted">
          Stored with the console — these are the opening values for every launch dialog; each launch can
          still override them for itself.
        </p>
      </CardBody>
    </Card>
  );
}
