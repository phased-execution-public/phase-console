/**
 * Where this run's work actually IS, and what it is about to run into.
 *
 * ## Why a card, and why only sometimes
 *
 * Phase 9 built the probe: how far the run branch has moved, what it changed,
 * what its checkout costs on disk, and — pairwise across every live branch —
 * whether two of them would merge. All of it arrived on one `run:git` event and
 * nothing drew it, so the answer to "are these two runs about to collide" was
 * still a command somebody had to know to type in a checkout they had to know
 * to find.
 *
 * It renders for a run with a checkout story to tell: an isolated run, or one
 * that ASKED to be isolated and was refused. An ordinary shared run gets no
 * card at all. That is a deliberate pick out of the two the plan allowed: a
 * one-line "shared checkout" on every run would put a standing configuration
 * fact on every page, and this page already has a place for those (the status
 * strip's `scoped`/`profile` notes) precisely so they stay out of the way.
 *
 * ## Every fact says "I cannot tell you" rather than guessing
 *
 * The probe's contract is that a number it could not measure is `undefined`, a
 * verdict it could not reach is `unknown`, and a list it could not build is
 * empty — because none of those is news about the RUN, and a monitoring layer
 * that turns a healthy run's page red is worse than one that occasionally says
 * it does not know. So an absent fact draws a dash in the muted ink, never an
 * alarm, and `unknown` on the radar is drawn distinctly from `clean`: an
 * unmeasured pair must never paint as a safe one.
 *
 * The card can also render with NO probe view at all — an isolated run whose
 * console is no longer driving it. `service.runGit` reads the live runner's
 * cache and never probes on demand, so `git: null` is the ordinary answer for a
 * stopped run. The branch and the checkout come off the run record in that
 * case, and the measured half says it was not measured.
 */

import { GitBranch } from 'lucide-react';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  KeyValue,
  type BadgeTone,
} from '@/components/ui';
import type { RadarPair, RunGitView, RunState } from '@/lib/api';
import { useConsoleState } from '@/lib/queries';
import { bytes, homePath, plural, relativeTime } from '@/lib/format';
import { ourWorktreeLock, SETTLE_LABELS, settleOf, type RadarState } from '@shared/worktree-model.js';

/** The dash. One spelling, so "not measured" looks the same in every row. */
const UNKNOWN = '—';

/**
 * How each verdict paints.
 *
 * `unknown` is `neutral` and `clean` is `ok` — the distinction the probe went to
 * the trouble of making, kept on the page. `overlap` is the accent because it is
 * the state the whole feature exists for: two lanes editing one file still merge
 * cleanly, right up until the edits touch the same lines, and the moment worth
 * telling somebody about is while serializing them is still cheap.
 */
const RADAR_TONE: Readonly<Record<RadarState, BadgeTone>> = Object.freeze({
  clean: 'ok',
  overlap: 'accent',
  conflicted: 'bad',
  unknown: 'neutral',
});

const RADAR_BLURB: Readonly<Record<RadarState, string>> = Object.freeze({
  clean: 'These two branches touch no file in common.',
  overlap: 'They touch files in common and still merge cleanly — serializing them is cheap now.',
  conflicted: 'A real merge conflict is already sitting between these two.',
  unknown: 'The probe could not answer for this pair. Not the same as clean.',
});

/** Which git arm resolved the base, and who declared the word — in words a title can carry. */
const BASE_SOURCE_WORDS: Record<string, string> = {
  'origin-head': 'the remote’s HEAD',
  trunk: 'the local trunk — no remote to ask',
  head: 'whatever the checkout had out',
  ref: 'a ref named by hand',
};
const BASE_DECLARED_WORDS: Record<string, string> = {
  plan: 'the plan’s `Base branch:` line',
  run: 'this run’s launch form',
  console: 'Settings ▸ Automation',
  default: 'the shipped default',
};

/**
 * The branch one lane is committing on — the chip Now and the phase table wear.
 *
 * ONE component for both surfaces, because the rule about when it appears is
 * the interesting part and it must not be written twice: a `ChildRef.branch` is
 * set only alongside `worktree`, never on its own, so **absent means this lane
 * is on the run's own branch** and there is nothing to distinguish. A chip on
 * every row would say nothing; a chip on the rows that have one says which of
 * several concurrent branches this lane's commits are landing on, which is the
 * question two lanes in one repository create.
 */
export function BranchChip({ branch, base }: { branch?: string; base?: RunState['base'] }) {
  if (!branch) return null;
  // The base every `pe/<slug>-pN` was cut from (phase 15), on the title
  // rather than the row: two lanes of one plan share it, and what the row
  // exists to tell apart is the branch.
  const cut = base
    ? ` Cut from ${base.ref} at ${base.sha.slice(0, 12)} (${BASE_SOURCE_WORDS[base.source] ?? base.source}; ` +
      `${BASE_DECLARED_WORDS[base.declaredBy] ?? base.declaredBy}).`
    : '';
  return (
    <Chip
      tone="neutral"
      mono
      data-testid="branch-chip"
      title={`This lane commits on ${branch} — its own checkout, not the run's shared tree.${cut}`}
    >
      <GitBranch size={11} aria-hidden />
      {branch}
    </Chip>
  );
}

/** Does this run have a checkout story worth a card? */
export function hasGitStory(run: RunState | null | undefined, git: RunGitView | null | undefined): boolean {
  if (!run) return false;
  return run.checkout === 'worktree' || run.checkout === 'refused' || git != null;
}

/** `3 ahead · 1 behind`, or the dash when the probe could not ask. */
function divergenceText(git: RunGitView | null | undefined): string {
  const d = git?.divergence;
  if (!d) return UNKNOWN;
  return `${d.ahead} ahead · ${d.behind} behind`;
}

/**
 * One pairwise verdict, with the files it is about.
 *
 * The files are the point: "conflicted" with nothing named is the same dead end
 * "queued" was before the scheduler said what it was queued behind.
 */
function RadarRow({ pair }: { pair: RadarPair }) {
  return (
    <li data-testid="radar-row" data-state={pair.state} className="flex flex-col gap-0.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
        <Badge tone={RADAR_TONE[pair.state]} title={RADAR_BLURB[pair.state]}>
          {pair.state}
        </Badge>
        {/*
          A clash zone is worth a badge of its own even when the verdict is
          `clean` or `overlap`: these files MERGE and are wrong afterwards, so
          the verdict beside it is the thing that understates the situation.
        */}
        {pair.zones?.length ? (
          <Badge tone="accent" title={`clash zones: ${pair.zones.join(', ')}`} data-testid="radar-zone">
            clash zone
          </Badge>
        ) : null}
        <code className="min-w-0 truncate font-mono text-2xs text-ink-muted">
          {pair.a} ↔ {pair.b}
        </code>
      </div>
      {pair.zones?.length ? (
        <p className="pl-0.5 font-mono text-2xs text-ink-faint">{pair.zones.join(', ')}</p>
      ) : null}
      {pair.files.length > 0 && (
        <p className="pl-0.5 font-mono text-2xs text-ink-faint">
          {pair.files.slice(0, 6).join(', ')}
          {pair.files.length > 6 ? ` +${pair.files.length - 6} more` : ''}
        </p>
      )}
    </li>
  );
}

export function GitCard({ run, git }: { run: RunState | null; git?: RunGitView | null }) {
  const { data: state } = useConsoleState();
  if (!hasGitStory(run, git)) return null;
  const refused = run?.checkout === 'refused';

  // The run record is the fallback for the one fact it owns itself, so a
  // stopped isolated run still says WHERE it was working.
  const shownBranch = git?.branch;
  const shownRoot = homePath(git?.workRoot ?? run?.workRoot, state?.home);
  const settle = run ? settleOf(run) : undefined;
  const managed = git?.checkouts.filter((c) => c.managed) ?? [];
  const totalDisk = managed.reduce((sum, c) => sum + (c.disk ?? 0), 0);

  return (
    <Card data-testid="git-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch size={16} aria-hidden />
          Branch &amp; checkout
        </CardTitle>
        {git?.at && (
          <span className="text-2xs text-ink-faint" title={new Date(git.at).toLocaleString()}>
            probed {relativeTime(Date.parse(git.at))}
          </span>
        )}
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {refused && (
          <p className="text-2xs text-ink-muted" data-testid="git-refused">
            This run asked for its own checkout and could not have one, so it is working in the shared tree
            with queue semantics — exactly as every run did before worktrees existed. The runner recorded{' '}
            <code className="font-mono">{run?.isolationRefusal ?? 'no reason'}</code>
            {/* The sentence is the server's table for the key (G-20); an older
                server sends none, and then the journal below still has it. */}
            {run?.isolationRefusal && state?.refusalReasons?.[run.isolationRefusal]
              ? `: ${state.refusalReasons[run.isolationRefusal]}.`
              : '; the journal below carries the sentence.'}
          </p>
        )}

        <KeyValue
          items={[
            [
              'checkout',
              run?.checkout === 'worktree'
                ? run.mountedRepos?.length
                  ? `a mirror of ${run.mountedRepos.length} repositories`
                  : 'its own worktree'
                : 'shared with the console',
            ],
            ...(run?.mountedRepos?.length
              ? [['mounts', run.mountedRepos.join(', ')] as [string, React.ReactNode]]
              : []),
            ['branch', shownBranch ? <code className="font-mono text-2xs">{shownBranch}</code> : UNKNOWN],
            // The probe's measured base first; else what the runner RESOLVED
            // when it cut the branch (phase 15) — the one fact a stopped run's
            // card can still say, pinned to the commit and naming who declared
            // the word. Neither, and it is the dash.
            [
              'base',
              git?.base ? (
                <code className="font-mono text-2xs" data-testid="git-base">
                  {git.base}
                </code>
              ) : run?.base ? (
                <code
                  className="font-mono text-2xs"
                  data-testid="git-base"
                  title={`Cut at ${run.base.sha} (${BASE_SOURCE_WORDS[run.base.source] ?? run.base.source}; ${BASE_DECLARED_WORDS[run.base.declaredBy] ?? run.base.declaredBy}).`}
                >
                  {run.base.ref} @ {run.base.sha.slice(0, 12)}
                </code>
              ) : (
                UNKNOWN
              ),
            ],
            [
              'work root',
              shownRoot ? <code className="font-mono text-2xs break-all">{shownRoot}</code> : UNKNOWN,
            ],
            ['divergence', divergenceText(git)],
            [
              'changed files',
              git
                ? git.filesTruncated
                  ? // The `+` is the cap, said out loud: there are more than
                    // this, and a plain count would be a lie about the number.
                    `${git.files.length}+ files`
                  : git.files.length === 0
                    ? 'none'
                    : plural(git.files.length, 'file')
                : UNKNOWN,
            ],
            ['disk', bytes(git?.disk) ?? UNKNOWN],
            settle ? ['settles by', SETTLE_LABELS[settle]] : null,
          ]}
        />

        {git && git.files.length > 0 && (
          <details data-testid="git-files">
            <summary className="cursor-pointer text-2xs text-ink-muted">
              What this branch changed{git.filesTruncated ? ' (the first of them)' : ''}
            </summary>
            <ol className="mt-1 max-h-40 overflow-y-auto overscroll-contain font-mono text-2xs text-ink-faint">
              {git.files.map((file) => (
                <li key={file} className="truncate">
                  {file}
                </li>
              ))}
            </ol>
            {git.filesTruncated && (
              <p className="mt-1 text-2xs text-ink-faint">
                The probe caps this list. There are more — a list that silently stopped would be a lie.
              </p>
            )}
          </details>
        )}

        <div>
          <h3 className="text-2xs uppercase tracking-wide text-ink-faint">Conflict radar</h3>
          {git?.radar.length ? (
            <ol className="mt-1 flex flex-col gap-1.5" data-testid="radar">
              {git.radar.map((pair) => (
                <RadarRow key={`${pair.a}|${pair.b}`} pair={pair} />
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-2xs text-ink-faint">
              {git
                ? 'Only one live branch — there is no pair to compare.'
                : 'Not measured: nothing is driving this run, so the probe has no live cache to read.'}
            </p>
          )}
        </div>

        {managed.length > 0 && (
          <div>
            <h3 className="text-2xs uppercase tracking-wide text-ink-faint">
              Managed checkouts{totalDisk > 0 ? ` · ${bytes(totalDisk)}` : ''}
            </h3>
            <ul className="mt-1 flex flex-col gap-1" data-testid="git-checkouts">
              {managed.map((entry) => (
                <li key={entry.dir} className="flex min-w-0 flex-wrap items-baseline gap-1.5">
                  {entry.branch && (
                    <Chip tone="neutral" mono>
                      {entry.branch}
                    </Chip>
                  )}
                  <code className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint">
                    {homePath(entry.dir, state?.home)}
                  </code>
                  {entry.prunable && (
                    <Chip tone="warn" title="git still lists this checkout and its directory is gone.">
                      prunable
                    </Chip>
                  )}
                  {/*
                    Two different facts, and an operator needs to tell them
                    apart before they reach for `git worktree remove`: OUR lock
                    is the console protecting a live tree and it comes off by
                    itself, while somebody else's is a tree the sweeps will
                    never touch — and neither can be removed without one
                    `git worktree unlock` first.
                  */}
                  {entry.locked !== undefined && (
                    <Chip
                      tone={ourWorktreeLock(entry.locked) ? 'neutral' : 'warn'}
                      title={entry.locked || 'locked, with no reason given'}
                      data-testid="checkout-lock"
                    >
                      {ourWorktreeLock(entry.locked) ? 'locked' : 'locked by hand'}
                    </Chip>
                  )}
                  <span className="text-2xs text-ink-faint">{bytes(entry.disk) ?? UNKNOWN}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export default GitCard;
