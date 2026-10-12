/**
 * Where this run's work stands — the Run view's Checkout fold (7.0,
 * quiet-console phase 12; the 6.x git card).
 *
 * ```
 * Checkout        ● Own worktree  a mirror of 2 repositories
 * Branch          pe/demo
 * Base            main
 * Work root       ~/state/wt/demo
 * Divergence      3 ahead · 1 behind
 * Changed files   2 files
 * Disk            412 MB
 * Settles by      Pull request — push the branch and open a PR for a person to read
 * Probed          4 minutes ago
 * › What this branch changed (2)
 * ────────────────
 * Merge radar 2
 * ● Conflicted    pe/demo ↔ pe/other
 *                 viewer/server/a.ts
 * ● Not checked   pe/demo ↔ main
 * ────────────────
 * Managed checkouts 1                                               412 MB
 * pe/demo   ~/state/wt/demo   locked by the console                 412 MB
 * ```
 *
 * Drawn for a run with a checkout story: one working in a checkout of its own,
 * one that ASKED for one and was refused, or one the probe has a view of. An
 * ordinary shared run gets nothing — "shared checkout" on every run would be a
 * standing configuration fact, and the view says those elsewhere.
 *
 * A refused isolation leads, in words: the runner's key, the server's sentence
 * for it and its fix, and whether the run is parked on it (a refusal a person
 * can fix) or sharing the console's checkout (a structural one).
 *
 * Every fact says "I cannot tell you" rather than guessing. The probe answers
 * `undefined` for a number it could not measure, `unknown` for a pair it could
 * not merge in memory and an empty list for one it could not build — none of
 * them news about the run — so an absent fact is a quiet dash, and `unknown`
 * on the radar is its own word, never painted as `clean`. A run no console is
 * driving has no probe view at all (`service.runGit` reads the live runner's
 * cache and never probes on demand): where it worked comes off the record, and
 * the measured half says it was not measured.
 */

import { ourWorktreeLock, SETTLE_LABELS, settleOf, type RadarState } from '@shared/worktree-model.js';
import type { CheckoutEntry, RadarPair, RunGitView, RunState } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { cn } from '@/lib/cn';
import { bytes, homePath, plural } from '@/lib/format';
import { KeyValue, Mono, RelativeTime, SectionHeading } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { OpsStatus, type WordOf } from '@/ui/status';

/** What a run no console drives cannot say about itself. */
const NOT_MEASURED = 'Not measured: nothing is driving this run, so the probe has no live cache to read.';

/** A fact the probe could not give — a quiet dash, never an alarm, with why on hover. */
const none = (why: string) => (
  <span className="text-ink-faint" title={why}>
    —
  </span>
);

/** What each radar verdict means — the hover on its word. */
const RADAR_WHY: Readonly<Record<RadarState, string>> = {
  clean: 'These two branches touch no file in common.',
  overlap: 'They touch files in common and still merge cleanly: serializing them is cheap now.',
  conflicted: 'A real merge conflict is already sitting between these two.',
  unknown: 'The probe could not answer for this pair, which is not the same as clean.',
};

/** Which git arm resolved a run's base, and who declared the word. */
const BASE_SOURCE_WORDS: Readonly<Record<string, string>> = {
  'origin-head': 'the remote’s HEAD',
  trunk: 'the local trunk, with no remote to ask',
  head: 'whatever the checkout had out',
  ref: 'a ref named by hand',
};
const BASE_DECLARED_WORDS: Readonly<Record<string, string>> = {
  plan: 'the plan’s `Base branch:` line',
  run: 'this run’s launch form',
  console: 'Settings ▸ Automation',
  default: 'the shipped default',
};

const cutWords = (base: NonNullable<RunState['base']>): string =>
  `${BASE_SOURCE_WORDS[base.source] ?? base.source}; ${BASE_DECLARED_WORDS[base.declaredBy] ?? base.declaredBy}`;

/** Does this run have a checkout story to tell? What decides whether the fold is drawn. */
export function hasGitStory(run: RunState | null | undefined, git: RunGitView | null | undefined): boolean {
  if (!run) return false;
  return run.checkout === 'worktree' || run.checkout === 'refused' || git != null;
}

/**
 * The branch a checkout of its own commits on, in the machine face, with what
 * it was cut from on hover. Nothing without one: a lane with no branch of its
 * own commits on the run's branch, and there is nothing to tell apart.
 */
export function RunBranch({
  branch,
  base,
}: {
  branch?: string | undefined;
  base?: RunState['base'] | undefined;
}) {
  if (!branch) return null;
  const cut = base ? ` Cut from ${base.ref} at ${base.sha.slice(0, 12)} (${cutWords(base)}).` : '';
  return (
    <Mono
      value={branch}
      data-testid="run-branch"
      className="min-w-0 wrap-anywhere text-ink"
      title={`Commits here land on ${branch}, in a checkout of its own rather than the run’s shared tree.${cut}`}
    />
  );
}

export function RunCheckout({ run, git }: { run: RunState | null; git?: RunGitView | null | undefined }) {
  const { data: state } = useConsoleState();
  // Parked on a refusal a person can fix, or sharing the console's checkout
  // after a structural one: the halt says which.
  const parked = run?.halt?.kind === 'isolation-refused';
  if (!run || !hasGitStory(run, git)) return null;

  const home = state?.home;
  const word = run.checkout ?? 'shared';
  const root = homePath(git?.workRoot ?? run.workRoot, home);
  const settle = settleOf(run);
  const managed = git?.checkouts.filter((entry) => entry.managed) ?? [];
  const totalDisk = managed.reduce((sum, entry) => sum + (entry.disk ?? 0), 0);
  const unmeasured = (why: string) => none(git ? why : NOT_MEASURED);

  return (
    <div data-testid="run-checkout" className="flex min-w-0 flex-col gap-3">
      {word === 'refused' && (
        <Refusal run={run} parked={parked} reasons={state?.refusalReasons} fixes={state?.refusalFixes} />
      )}

      <KeyValue
        items={[
          [
            'Checkout',
            <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2">
              <OpsStatus vocab="checkout" word={word as WordOf<'checkout'>} data-testid="git-checkout" />
              {word === 'worktree' && run.mountedRepos?.length ? (
                <span className="text-meta text-ink-muted">
                  a mirror of {plural(run.mountedRepos.length, 'repository', 'repositories')}
                </span>
              ) : word === 'refused' ? (
                <span className="text-meta text-ink-muted">
                  {parked ? 'the run is parked' : 'shared with the console'}
                </span>
              ) : null}
            </span>,
          ],
          run.mountedRepos?.length
            ? ['Mounts', <Mono value={run.mountedRepos.join(', ')} className="wrap-anywhere text-ink" />]
            : null,
          [
            'Branch',
            git?.branch ? (
              <Mono value={git.branch} className="wrap-anywhere text-ink" />
            ) : (
              unmeasured('The probe found no run branch.')
            ),
          ],
          // The probe's measured base first; else what the runner RESOLVED when
          // it cut the branch, pinned to the commit — the one fact a stopped
          // run can still say.
          [
            'Base',
            git?.base ? (
              <Mono value={git.base} data-testid="git-base" className="wrap-anywhere text-ink" />
            ) : run.base ? (
              <Mono
                value={`${run.base.ref} @ ${run.base.sha.slice(0, 12)}`}
                data-testid="git-base"
                className="wrap-anywhere text-ink"
                title={`Cut at ${run.base.sha} (${cutWords(run.base)}).`}
              />
            ) : (
              unmeasured('The probe could not name the base.')
            ),
          ],
          [
            'Work root',
            root ? (
              <Mono value={root} className="wrap-anywhere text-ink" />
            ) : word === 'worktree' ? (
              unmeasured('The probe found no work root.')
            ) : (
              none('The run has no checkout of its own: it works in the console’s.')
            ),
          ],
          [
            'Divergence',
            git?.divergence
              ? `${git.divergence.ahead} ahead · ${git.divergence.behind} behind`
              : unmeasured('The probe could not ask how far the branch has moved.'),
          ],
          [
            'Changed files',
            git
              ? git.filesTruncated
                ? // The `+` is the cap, said: there are more than this.
                  `${git.files.length}+ files`
                : git.files.length
                  ? plural(git.files.length, 'file')
                  : 'None'
              : none(NOT_MEASURED),
          ],
          ['Disk', bytes(git?.disk) ?? unmeasured('du could not answer for this checkout.')],
          ['Settles by', SETTLE_LABELS[settle]],
          git ? ['Probed', <RelativeTime at={git.at} />] : null,
        ]}
      />

      {git && git.files.length > 0 && (
        <Disclosure
          label={git.filesTruncated ? 'The first files this branch changed' : 'What this branch changed'}
          openLabel="Hide the changed files"
          count={git.files.length}
          testId="git-files"
          bodyClassName="flex min-w-0 flex-col gap-1 pt-1"
        >
          <ol className="flex min-w-0 flex-col gap-0.5" aria-label="Changed files">
            {git.files.map((file) => (
              <li key={file} className="min-w-0 wrap-anywhere">
                <Mono value={file} />
              </li>
            ))}
          </ol>
          {git.filesTruncated && (
            <p className="text-meta text-ink-muted">The probe caps this list: there are more.</p>
          )}
        </Disclosure>
      )}

      <section aria-label="Merge radar" className="flex min-w-0 flex-col gap-1.5 border-t border-rule pt-3">
        <SectionHeading as="h3" count={git?.radar.length || undefined}>
          Merge radar
        </SectionHeading>
        {git?.radar.length ? (
          <ol data-testid="radar" className="flex min-w-0 flex-col gap-1">
            {git.radar.map((pair) => (
              <RadarLine key={`${pair.a}|${pair.b}`} pair={pair} />
            ))}
          </ol>
        ) : (
          <p className="text-meta text-ink-muted">
            {git ? 'Only one live branch: there is no pair to compare.' : NOT_MEASURED}
          </p>
        )}
      </section>

      {managed.length > 0 && (
        <section
          aria-label="Managed checkouts"
          className="flex min-w-0 flex-col gap-1.5 border-t border-rule pt-3"
        >
          <SectionHeading
            as="h3"
            count={managed.length}
            aside={
              totalDisk > 0 ? (
                <span className="text-meta text-ink-muted tnum">{bytes(totalDisk)}</span>
              ) : undefined
            }
          >
            Managed checkouts
          </SectionHeading>
          <ul data-testid="git-checkouts" className="flex min-w-0 flex-col gap-1">
            {managed.map((entry) => (
              <CheckoutLine key={entry.dir} entry={entry} base={run.base} home={home} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * The refusal, in words: what it means for the run, the runner's key with the
 * server's sentence for it (looked up, never stored, so it cannot drift from
 * the code that decided), the refusal's own detail, and the fix.
 */
function Refusal({
  run,
  parked,
  reasons,
  fixes,
}: {
  run: RunState;
  parked: boolean;
  reasons: Record<string, string> | undefined;
  fixes: Record<string, string> | undefined;
}) {
  const key = run.isolationRefusal;
  const reason = key ? reasons?.[key]?.replace(/\.$/, '') : undefined;
  const fix = key ? fixes?.[key] : undefined;
  return (
    <div
      data-testid="git-refused"
      data-parked={parked ? '' : undefined}
      className={cn(
        'flex min-w-0 flex-col gap-1 border-s-2 border-state py-1 ps-3',
        parked ? 'state-needs-you' : 'state-skipped',
      )}
    >
      <p className="min-w-0 break-words text-body text-ink">
        {parked
          ? 'This run asked for its own checkout and could not have one, so it is parked: nothing boards in the shared tree until the refusal is fixed or isolation is dropped.'
          : 'This run asked for its own checkout and could not have one, so it works in the checkout shared with the console, where runs that overlap it wait their turn.'}
      </p>
      <p className="min-w-0 break-words text-meta text-ink-muted">
        The runner recorded <Mono value={key ?? 'no reason'} />
        {reason ? `: ${reason}.` : '; the journal has its sentence.'}
      </p>
      {run.isolationRefusalDetail && (
        <p className="min-w-0 break-words text-meta text-ink-muted">{run.isolationRefusalDetail}</p>
      )}
      {fix && <p className="min-w-0 break-words text-body text-ink">{fix}</p>}
    </div>
  );
}

/**
 * One pairwise verdict, with the files it is about — "conflicted" naming
 * nothing is a dead end. A clash zone is said even beside `clean` or
 * `overlap`: those files MERGE and are wrong afterwards, so the verdict is the
 * part that understates it.
 */
function RadarLine({ pair }: { pair: RadarPair }) {
  const zones = pair.zones ?? [];
  return (
    <li data-testid="radar-row" data-state={pair.state} className="flex min-w-0 flex-col gap-0.5 py-0.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <OpsStatus
          vocab="radar"
          word={pair.state as WordOf<'radar'>}
          title={RADAR_WHY[pair.state]}
          data-testid="radar-word"
        />
        <span className="min-w-0 wrap-anywhere text-meta text-ink-muted">
          <Mono value={pair.a} className="text-ink" /> ↔ <Mono value={pair.b} className="text-ink" />
        </span>
      </div>
      {zones.length > 0 && (
        <p
          data-testid="radar-zone"
          className="min-w-0 wrap-anywhere text-meta text-ink"
          title="Files that merge cleanly and are wrong afterwards"
        >
          Clash {zones.length === 1 ? 'zone' : 'zones'}: <Mono value={zones.join(', ')} />
        </p>
      )}
      {pair.files.length > 0 && (
        <p className="min-w-0 wrap-anywhere text-meta text-ink-muted">
          <Mono value={pair.files.slice(0, 6).join(', ')} />
          {pair.files.length > 6 ? `, and ${pair.files.length - 6} more` : ''}
        </p>
      )}
    </li>
  );
}

/**
 * One checkout the console made. Its lock is two different facts an operator
 * must tell apart before reaching for `git worktree remove`: the console's
 * own lock protects a live tree and comes off by itself; anybody else's marks
 * a tree the sweeps never touch. Either needs `git worktree unlock` first.
 */
function CheckoutLine({
  entry,
  base,
  home,
}: {
  entry: CheckoutEntry;
  base: RunState['base'] | undefined;
  home: string | undefined;
}) {
  const ours = entry.locked !== undefined && ourWorktreeLock(entry.locked);
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <RunBranch branch={entry.branch} base={base} />
      <Mono value={homePath(entry.dir, home) ?? entry.dir} className="min-w-0 wrap-anywhere" />
      {entry.prunable && (
        <span
          className="text-meta text-ink"
          title="git still lists this checkout, and its directory is gone."
        >
          prunable
        </span>
      )}
      {entry.locked !== undefined && (
        <span
          data-testid="checkout-lock"
          data-ours={ours ? '' : undefined}
          className="text-meta text-ink-muted"
          title={entry.locked || 'Locked, with no reason given.'}
        >
          {ours ? 'locked by the console' : 'locked by hand'}
        </span>
      )}
      <span className="ms-auto text-meta text-ink-muted tnum">
        {bytes(entry.disk) ?? none('du could not answer for this checkout.')}
      </span>
    </li>
  );
}
