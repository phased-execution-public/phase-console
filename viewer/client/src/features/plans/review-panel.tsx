/**
 * The review surface — a phase's diff, and the verdict on it.
 *
 * Three rules shaped what is here.
 *
 * **No dependency for the diff.** The hunk viewer is a table of lines with a
 * left gutter, because a diff renderer pulled off npm is a supply-chain
 * decision for a format that has not changed in twenty years — and because the
 * one thing the console's own styles already do well is monospace text in a
 * scroll container.
 *
 * **Nothing is fetched until somebody asks.** A review is the most expensive
 * read on the plan surface (two `git log`s and a `git diff`), so the card is
 * closed until it is opened and `usePhaseReview` is `enabled` on exactly that.
 * A plan page that ran a `git diff` per phase to decorate a chip would be a
 * page nobody could open.
 *
 * **The hold says whose it is.** A `requested-changes` verdict stops every
 * dependent phase from boarding, which is a real power, and it belongs to THIS
 * console rather than to the engine: `phase-graph.sh` cannot see it, a session
 * booted from a terminal will not, and another machine's console has its own.
 * Every sentence here that mentions the hold says so — an operator who thinks
 * the board is holding a phase will go looking in the wrong file.
 */

import { useState } from 'react';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  Empty,
  Spinner,
  field,
} from '@/components/ui';
import { DiffFileRow, DiffHunks } from '@/components/diff-view';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { keys, useApiMutation, usePhaseReview } from '@/lib/queries';
import { handoffHref, phaseHref } from '@shared/routes.js';
import type { PhaseView, ReviewComment, ReviewVerdict } from '@/lib/api';

/** Verdict → the word, the tone, and what it does. Said once. */
const VERDICT_COPY: Record<ReviewVerdict, { label: string; hint: string }> = {
  approved: { label: 'approved', hint: 'Reviewed and accepted. Nothing is held.' },
  'requested-changes': {
    label: 'changes requested',
    hint:
      'This console holds every phase that depends on this one until the verdict is ' +
      "approved or withdrawn. The engine's board does not know about it.",
  },
  commented: { label: 'commented', hint: 'A note on the record. Nothing is held.' },
};

/** The recorded verdict as a chip — the phase row's whole review surface. */
export function ReviewVerdictChip({
  review,
  href,
}: {
  review?: { verdict: string; at: string; by?: string };
  href?: string;
}) {
  if (!review) return null;
  const copy = VERDICT_COPY[review.verdict as ReviewVerdict];
  const label = copy?.label ?? review.verdict;
  const tone = review.verdict === 'requested-changes' ? 'gate' : undefined;
  const title = `Review: ${label}${review.by ? ` by ${review.by}` : ''} — ${copy?.hint ?? ''}`;
  const chip = (
    <Chip {...(tone ? { tone } : {})} title={title}>
      review {label}
    </Chip>
  );
  return href ? <a href={href}>{chip}</a> : chip;
}

/**
 * Why this phase cannot board — because a dependency's review asked for changes.
 *
 * Rendered wherever a phase is shown, and nothing when there is no hold, so a
 * caller can mount it unconditionally. It names the phases and links to them:
 * the remedy is over there, not here.
 */
export function ReviewHoldBanner({ slug, view }: { slug: string; view: PhaseView }) {
  const held = view.reviewHold ?? [];
  if (!held.length) return null;
  return (
    <Banner severity="warn" data-testid="review-hold">
      <div className="min-w-0 flex-1">
        <strong>
          Held by review — {held.length === 1 ? 'a dependency has' : 'dependencies have'} requested changes.
        </strong>
        <p className="mt-0.5 text-2xs text-ink-muted">
          This console will not board phase {view.phase} until{' '}
          {held.map((p, i) => (
            <span key={p}>
              {i > 0 ? ', ' : ''}
              <a href={phaseHref(slug, p)} className="underline">
                P{p}
              </a>
            </span>
          ))}{' '}
          {held.length === 1 ? 'is' : 'are'} approved or the verdict is withdrawn. It is{' '}
          <em>this console&apos;s</em> hold, not the engine&apos;s: the board still reads the phase as ready,
          and a session booted from a terminal will not see it.
        </p>
      </div>
    </Banner>
  );
}

/* ---------------- the diff ---------------- */

/* ---------------- comments ---------------- */

/** One stored comment, inline under the line it is about. */
function InlineComment({ comment }: { comment: ReviewComment }) {
  return (
    <div
      className={`rounded border px-2 py-1 text-2xs ${
        comment.resolved ? 'border-rule text-ink-faint' : 'border-action/40 bg-action/5 text-ink'
      }`}
    >
      <span className="font-mono text-ink-faint">{comment.id}</span>
      {comment.by ? <span className="text-ink-muted"> · {comment.by}</span> : null}
      {comment.resolved ? <span className="text-ink-faint"> · answered</span> : null}
      <p className="mt-0.5 whitespace-pre-wrap">{comment.body}</p>
    </div>
  );
}

/**
 * The comment list, with the two verbs that act on one.
 *
 * Resolved comments stay on the list rather than disappearing: a resolved
 * comment is the record of something that WAS wrong, and the follow-up
 * composer skips it, so the list is the only place it can still be read.
 */
function CommentList({
  comments,
  allowWrites,
  onAct,
  pending,
}: {
  comments: ReviewComment[];
  allowWrites: boolean;
  onAct: (action: 'resolve' | 'unresolve' | 'delete', id: string) => void;
  pending: boolean;
}) {
  if (!comments.length) return null;
  const open = comments.filter((c) => !c.resolved).length;
  return (
    <details className="rounded border border-rule px-2 py-1" data-testid="review-comments">
      <summary className="cursor-pointer text-2xs text-ink-muted">
        {comments.length} comment{comments.length === 1 ? '' : 's'}
        {open !== comments.length ? ` · ${open} unresolved` : ''}
      </summary>
      <ul className="mt-1 flex flex-col gap-1">
        {comments.map((c) => (
          <li key={c.id} className="flex flex-col gap-0.5">
            <span className="font-mono text-2xs text-ink-faint">
              {c.path}
              {c.line != null ? `:${c.line}` : ''}
              {c.side === 'old' ? ' (removed side)' : ''}
            </span>
            <InlineComment comment={c} />
            {allowWrites && (
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => onAct(c.resolved ? 'unresolve' : 'resolve', c.id)}
                >
                  {c.resolved ? 'Reopen' : 'Mark answered'}
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => onAct('delete', c.id)}>
                  Delete
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The composer that opens under a line the reader clicked `+` on. */
function CommentDraft({
  anchor,
  onCancel,
  onSubmit,
  pending,
}: {
  anchor: { path: string; line?: number; side: 'old' | 'new' };
  onCancel: () => void;
  onSubmit: (body: string) => void;
  pending: boolean;
}) {
  const [body, setBody] = useState('');
  return (
    <div className="flex flex-col gap-1 rounded border border-action/40 bg-action/5 px-2 py-1.5">
      <span className="font-mono text-2xs text-ink-muted">
        {anchor.path}
        {anchor.line != null ? `:${anchor.line}` : ''}
        {anchor.side === 'old' ? ' (removed side)' : ''}
      </span>
      <textarea
        autoFocus
        rows={3}
        value={body}
        spellCheck={false}
        aria-label="Comment on this line"
        placeholder="what is wrong here"
        onChange={(event) => setBody(event.target.value)}
        className={cn(field, 'h-auto w-full py-1 font-mono text-2xs placeholder:text-ink-faint')}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={pending || !body.trim()} onClick={() => onSubmit(body.trim())}>
          Add comment
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ---------------- the card ---------------- */

/**
 * The whole review: the window, the commits, the files, and the verdict.
 *
 * Closed until opened, because the read behind it is three git invocations.
 */
export function ReviewCard({
  slug,
  view,
  allowWrites,
  allowRun = false,
}: {
  slug: string;
  view: PhaseView;
  allowWrites: boolean;
  /** Send back re-boards the phase, which spawns a session — a third permission. */
  allowRun?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState<{
    path: string;
    line?: number;
    side: 'old' | 'new';
    hunk: string;
    code: string;
  } | null>(null);
  const { data, isLoading, isError, error } = usePhaseReview(slug, view.phase, open);

  /*
   * All three writes reach the same three keys — the review, the plan whose
   * board the verdict moves, and the list that shows the plan — so all three
   * take `keys.afterReview`. The bundle is invalidated on FAILURE too, which
   * is the point of it: a verdict that 409'd because another console recorded
   * one first must leave this card reading the verdict that actually stands.
   *
   * `onDone`, not the old `onSettled`, is what clears the note and the draft:
   * a write that failed keeps what the reviewer typed, so the retry is a
   * second press rather than a second paragraph.
   */
  const mutation = useApiMutation<ReviewVerdict | 'withdraw', { detail: string }>({
    fn: (verdict) =>
      api.setReview(slug, view.phase, {
        verdict,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(data?.diff.window.base ? { base: data.diff.window.base } : {}),
        ...(data?.diff.window.tip ? { tip: data.diff.window.tip } : {}),
      }),
    invalidates: keys.afterReview(slug, view.phase),
    onDone: () => setNote(''),
  });

  const commentMutation = useApiMutation<
    | {
        action: 'add';
        path: string;
        line?: number;
        side?: 'old' | 'new';
        hunk?: string;
        code?: string;
        body: string;
      }
    | { action: 'resolve' | 'unresolve' | 'delete'; id: string },
    unknown
  >({
    fn: (input) => api.commentOnReview(slug, view.phase, input),
    invalidates: keys.afterReview(slug, view.phase),
    onDone: () => setDraft(null),
  });

  const sendBack = useApiMutation<void, { detail: string }>({
    fn: () => api.sendBackReview(slug, view.phase),
    invalidates: keys.afterReview(slug, view.phase),
  });

  const files = data?.diff.files ?? [];
  const current = files.find((f) => f.path === picked) ?? files[0];
  const recorded = data?.review ?? (view.review ? { ...view.review, verdict: view.review.verdict } : null);
  const comments = data?.review?.comments ?? [];
  const unresolved = comments.filter((c) => !c.resolved);

  return (
    <Card data-testid="phase-review">
      <CardHeader className="flex-wrap">
        <CardTitle className="text-sm normal-case">Review — phase {view.phase}</CardTitle>
        <div className="flex flex-wrap items-center gap-1.5">
          <ReviewVerdictChip {...(view.review ? { review: view.review } : {})} />
          {data && !data.diff.failed && (
            <Chip mono>
              {files.length} file{files.length === 1 ? '' : 's'} · +{data.diff.additions} −
              {data.diff.deletions}
            </Chip>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide diff' : 'Read the diff'}
          </Button>
        </div>
      </CardHeader>

      {open && (
        <CardBody className="flex flex-col gap-3">
          {isLoading && <Spinner />}
          {isError && (
            <Banner severity="warn">
              The diff could not be read: {(error as Error)?.message ?? 'unknown error'}
            </Banner>
          )}

          {data && (
            <>
              {/* The bracket, stated. It is a heuristic over `git log`, and a
                  reader who is not told that will believe it is a record. */}
              <div className="rounded border border-rule bg-surface px-2 py-1.5">
                <p className="text-2xs text-ink-muted">{data.diff.window.note}</p>
                {(data.diff.window.base || data.diff.window.tip) && (
                  <p className="mt-0.5 font-mono text-2xs text-ink-faint">
                    {data.diff.window.base ?? '(start)'}..{data.diff.window.tip ?? '(working tree)'}
                  </p>
                )}
              </div>

              {data.staleTip && (
                <Banner severity="warn">
                  This phase has landed a commit since the review was recorded. The verdict below is about{' '}
                  {recorded?.tip ?? 'an earlier tip'}, not about what is shown.
                </Banner>
              )}
              {data.diff.truncated && (
                <Banner severity="info">
                  The diff was larger than the render budget, so some hunks were not read. Every file is
                  listed with git&apos;s own counts.
                </Banner>
              )}
              {data.diff.failed && (
                <Banner severity="warn">
                  git could not answer for this range — this is not &ldquo;no changes&rdquo;, it is &ldquo;no
                  answer&rdquo;.
                </Banner>
              )}

              {data.diff.commits.length > 0 && (
                <details className="rounded border border-rule px-2 py-1">
                  <summary className="cursor-pointer text-2xs text-ink-muted">
                    {data.diff.commits.length} commit
                    {data.diff.commits.length === 1 ? '' : 's'} in this window
                  </summary>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {data.diff.commits.map((c) => (
                      <li key={c.sha} className="font-mono text-2xs text-ink-muted">
                        <span className="text-ink-faint">{c.sha}</span> {c.subject}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {files.length === 0 ? (
                <Empty
                  title="Nothing to review"
                  body={
                    data.diff.failed
                      ? 'git could not read this range.'
                      : 'No file changed inside this window.'
                  }
                  /* The window is bracketed by the phase's handoffs, so the
                     handoff is where an empty bracket is explained — a phase
                     whose commits landed outside it says so in its own words. */
                  action={
                    <Button asChild size="sm">
                      <a href={handoffHref(slug, view.phase)}>Read the handoff</a>
                    </Button>
                  }
                />
              ) : (
                <div className="grid gap-3 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:items-start">
                  {/* Bounded only where the grid is two columns. Stacked on a
                      phone this list is above the diff in ordinary page flow,
                      and a 24 rem box there would be a scroller inside a
                      scroller for a list of eight file names. */}
                  <nav
                    aria-label={`Files changed in phase ${view.phase}`}
                    className="flex flex-col gap-0.5 rounded border border-rule p-1 lg:max-h-96 lg:overflow-y-auto lg:overscroll-contain"
                  >
                    {files.map((f) => (
                      <DiffFileRow
                        key={f.path}
                        file={f}
                        active={f.path === current?.path}
                        onPick={() => setPicked(f.path)}
                      />
                    ))}
                  </nav>
                  {/* THE scroller for the diff, and the only one — both axes,
                      contained, with `DiffHunks`' own wrapper standing down
                      (`scrolls={false}`). A diff is the one thing on this card
                      that is both taller and wider than its box. */}
                  <div className="max-h-96 min-w-0 overflow-auto overscroll-contain rounded border border-rule">
                    {current ? (
                      <DiffHunks
                        file={current}
                        {...(allowWrites
                          ? {
                              onComment: (a) => setDraft({ path: current.path, ...a }),
                            }
                          : {})}
                        // The shared component knows nothing about reviews: it
                        // asks what to put under a line and this is the answer.
                        renderComments={(line, side) =>
                          comments
                            .filter(
                              (c) =>
                                c.path === current.path &&
                                c.line === line &&
                                // A comment stored without a side predates the
                                // field or came from a reviewer that omitted it;
                                // it belongs to the new side, which is where an
                                // unqualified line number means something.
                                (c.side ?? 'new') === side,
                            )
                            .map((c) => (
                              <tr key={c.id} data-testid="inline-comment">
                                <td colSpan={3} className="px-2 py-1">
                                  <InlineComment comment={c} />
                                </td>
                              </tr>
                            ))
                        }
                      />
                    ) : null}
                  </div>
                </div>
              )}
            </>
          )}

          {draft && allowWrites && (
            <CommentDraft
              anchor={draft}
              pending={commentMutation.isPending}
              onCancel={() => setDraft(null)}
              onSubmit={(body) =>
                commentMutation.mutate({
                  action: 'add',
                  path: draft.path,
                  ...(draft.line != null ? { line: draft.line } : {}),
                  side: draft.side,
                  hunk: draft.hunk,
                  code: draft.code,
                  body,
                })
              }
            />
          )}

          <CommentList
            comments={comments}
            allowWrites={allowWrites}
            pending={commentMutation.isPending}
            onAct={(action, id) => commentMutation.mutate({ action, id })}
          />

          {/* ---- the verdict ---- */}
          {recorded && (
            <div className="rounded border border-rule px-2 py-1.5 text-2xs">
              <span className="text-ink">
                {VERDICT_COPY[recorded.verdict as ReviewVerdict]?.label ?? recorded.verdict}
              </span>
              {recorded.by ? <span className="text-ink-muted"> by {recorded.by}</span> : null}
              <span className="text-ink-faint"> — {recorded.at}</span>
              {recorded.note ? (
                <p className="mt-0.5 whitespace-pre-wrap text-ink-muted">{recorded.note}</p>
              ) : null}
              <p className="mt-0.5 text-ink-faint">
                {VERDICT_COPY[recorded.verdict as ReviewVerdict]?.hint ?? ''}
              </p>
            </div>
          )}

          {allowWrites ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={note}
                rows={2}
                spellCheck={false}
                placeholder="note — what you read, and what you want changed"
                onChange={(event) => setNote(event.target.value)}
                className={cn(field, 'h-auto w-full py-1 font-mono text-2xs placeholder:text-ink-faint')}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate('approved')}>
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="action"
                  disabled={mutation.isPending}
                  title={
                    'Records a changes-requested verdict. This console then refuses to board every ' +
                    'phase that depends on this one until it is approved or withdrawn — the ' +
                    "engine's board is not changed, and does not know."
                  }
                  onClick={() => mutation.mutate('requested-changes')}
                >
                  Request changes
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate('commented')}
                >
                  Comment only
                </Button>
                {recorded && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={mutation.isPending}
                    onClick={() => mutation.mutate('withdraw')}
                  >
                    Withdraw
                  </Button>
                )}
                {/* Only the ANSWER is inline. A failure is a toast, because
                    `useApiMutation` is the one error leg in this client and a
                    failure reported in two places is a failure reported twice. */}
                {mutation.data && <span className="text-2xs text-ink-muted">{mutation.data.detail}</span>}
              </div>

              {/* ---- send back ----
                  The other half of the loop. A verdict that holds dependents
                  was only ever half of it: the thing that has to change is the
                  phase, and re-boarding it by hand meant reading the comments,
                  writing a prompt from them, and hoping all of them were
                  quoted. The prompt is composed on the SERVER from these
                  comments, so what the session reads cannot be edited here. */}
              {allowRun ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="action"
                    data-testid="review-send-back"
                    disabled={sendBack.isPending || (!unresolved.length && !recorded?.note)}
                    title={
                      unresolved.length || recorded?.note
                        ? 'Re-boards this phase with every unresolved comment quoted. Not a restart — ' +
                          'nothing already landed is reverted.'
                        : 'There is nothing to send back: no unresolved comment and no note.'
                    }
                    onClick={() => sendBack.mutate()}
                  >
                    Send back{unresolved.length ? ` (${unresolved.length})` : ''}
                  </Button>
                  {sendBack.data && <span className="text-2xs text-ink-muted">{sendBack.data.detail}</span>}
                </div>
              ) : (
                <p className="text-2xs text-ink-faint">
                  Sending a phase back re-boards it, which starts a session that edits this repository —
                  restart with <code className="font-mono">--allow-run</code> to enable it. The comments above
                  are recorded either way.
                </p>
              )}
            </div>
          ) : (
            <p className="text-2xs text-ink-faint">
              Reading the diff needs no flag. Recording a verdict does: restart with{' '}
              <code className="font-mono">--allow-writes</code>. A changes-requested verdict stops dependent
              phases from boarding, so a read-only console does not record one.
            </p>
          )}
        </CardBody>
      )}
    </Card>
  );
}
