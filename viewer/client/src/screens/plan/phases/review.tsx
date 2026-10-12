/**
 * The review surface — a phase's diff, and the verdict on it (7.0,
 * quiet-console phase 10).
 *
 * Three rules shaped what is here.
 *
 * **No dependency for the diff.** The hunk viewer is a table of lines with a
 * gutter, because a diff renderer pulled off npm is a supply-chain decision for
 * a format that has not changed in twenty years. The table is the one Repo's
 * Changes draws (`screens/repo/diff-view.tsx`), with this card's comments.
 *
 * **Nothing is fetched until somebody asks.** A review is the most expensive
 * read on the plan surface (two `git log`s and a `git diff`), so the diff sits
 * behind a CONTROLLED fold and `usePhaseReview` is `enabled` on exactly that
 * fold being open — the one fetch this card makes. A plan page that ran a
 * `git diff` per phase to decorate a word would be a page nobody could open.
 *
 * **The hold says whose it is.** A `requested-changes` verdict stops every
 * dependent phase from boarding, which is a real power, and it belongs to THIS
 * console rather than to the engine: `phase-graph.sh` cannot see it, a session
 * booted from a terminal will not, and another machine's console has its own.
 * Every sentence here that mentions the hold says so — an operator who thinks
 * the board is holding a phase will go looking in the wrong file.
 *
 * Every write is a press (`press()`, the owner door) and re-reads
 * `keys.afterReview` whether it landed or not: a verdict refused because
 * another console recorded one first must leave this card reading the verdict
 * that actually stands.
 */

import { Fragment, useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type PhaseView, type ReviewComment, type ReviewVerdict } from '@/data/api';
import { keys } from '@/data/keys';
import { usePhaseReview } from '@/data/plans';
import { press } from '@/data/press';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { Banner, Button, Empty, Mono, RelativeTime, SectionHeading, Spinner, toast } from '@/ui';
import { ConfirmButton } from '@/ui/confirm';
import { Disclosure } from '@/ui/disclosure';
import { Textarea } from '@/ui/textarea';
import { handoffHref } from '@/shell/routes';
import { DiffFileRow, DiffHunks } from '@/screens/repo/diff-view';
import { PhaseLink } from './cells';

/**
 * Verdict → its words and what it does. There is no review vocabulary in the
 * status model — a review is this console's own record, not a status a page
 * paints — so these are words, never a dot.
 */
const VERDICT_WORDS: Record<ReviewVerdict, { label: string; headline: string; hint: string }> = {
  approved: { label: 'approved', headline: 'Approved', hint: 'Reviewed and accepted. Nothing is held.' },
  'requested-changes': {
    label: 'changes requested',
    headline: 'Changes requested',
    hint:
      'This console holds every phase that depends on this one until the verdict is approved or withdrawn. ' +
      'The engine’s board does not know about it.',
  },
  commented: { label: 'commented', headline: 'Commented', hint: 'A note on the record. Nothing is held.' },
};

const wordsOf = (verdict: string) =>
  VERDICT_WORDS[verdict as ReviewVerdict] as (typeof VERDICT_WORDS)[ReviewVerdict] | undefined;

/**
 * The recorded verdict as words — "review approved", "review changes
 * requested", "review commented" — and nothing for a phase nobody reviewed
 * here: absent is not approved. Changes requested is the one that holds
 * anything, so it is in ink and the rest are muted; never amber, because a
 * verdict is not a summons.
 */
export function ReviewVerdictWord({
  review,
  href,
  className,
}: {
  review?: { verdict: string; at: string; by?: string } | undefined;
  href?: string;
  className?: string;
}) {
  if (!review) return null;
  const words = wordsOf(review.verdict);
  const label = words?.label ?? review.verdict;
  const title = `Review ${label}${review.by ? ` by ${review.by}` : ''}. ${words?.hint ?? ''}`.trim();
  const word = (
    <span
      data-review={review.verdict}
      title={title}
      className={cn(
        'text-meta',
        review.verdict === 'requested-changes' ? 'text-ink' : 'text-ink-muted',
        className,
      )}
    >
      review {label}
    </span>
  );
  return href ? (
    <a href={href} className="rounded-sm underline-offset-2 hover:underline">
      {word}
    </a>
  ) : (
    word
  );
}

/**
 * Why this phase cannot board — because a dependency's review asked for
 * changes. Nothing when there is no hold, so a caller can mount it
 * unconditionally. It names the phases and links to them: the remedy is over
 * there, not here.
 */
export function ReviewHoldBanner({ slug, view }: { slug: string; view: PhaseView }) {
  const held = view.reviewHold ?? [];
  if (!held.length) return null;
  return (
    <Banner severity="warn" data-testid="review-hold">
      <p className="text-ink">
        Held by review: {held.length === 1 ? 'a dependency has' : 'dependencies have'} requested changes.
      </p>
      <p className="mt-0.5 max-w-(--measure) text-meta text-ink-muted">
        This console will not board phase {view.phase} until{' '}
        {held.map((phase, i) => (
          <Fragment key={phase}>
            {i > 0 ? ', ' : ''}
            <PhaseLink slug={slug} phase={phase} />
          </Fragment>
        ))}{' '}
        {held.length === 1 ? 'is' : 'are'} approved or the verdict is withdrawn. It is this console&apos;s
        hold, not the engine&apos;s: the board still reads the phase as ready, and a session booted from a
        terminal will not see it.
      </p>
    </Banner>
  );
}

/* ---------------- comments ---------------- */

type Side = NonNullable<ReviewComment['side']>;
type CommentInput = Parameters<typeof api.commentOnReview>[2];
type CommentAct = Extract<CommentInput, { id: string }>['action'];

/** Where a comment points: the file, the line, and — for a removed line — which side. */
function AnchorWords({
  path,
  line,
  side,
}: {
  path: string;
  line?: number | undefined;
  side?: Side | undefined;
}) {
  return (
    <span className="min-w-0 wrap-anywhere text-meta text-ink-muted">
      <Mono value={`${path}${line != null ? `:${line}` : ''}`} />
      {side === 'old' ? ' on the removed side' : ''}
    </span>
  );
}

/** One stored comment, under the line it is about. Sans, not the diff's mono: it is prose. */
function InlineComment({ comment }: { comment: ReviewComment }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-0.5 rounded border px-2 py-1 font-sans text-meta whitespace-normal',
        comment.resolved ? 'border-rule text-ink-muted' : 'border-rule-strong bg-surface text-ink',
      )}
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-ink-muted">
        <Mono value={comment.id} />
        {comment.by && <span>{comment.by}</span>}
        {comment.resolved && <span>answered</span>}
      </span>
      <p className="min-w-0 whitespace-pre-wrap break-words">{comment.body}</p>
    </div>
  );
}

/**
 * Every comment, with the two verbs that act on one. A resolved comment stays
 * on the list: it is the record of something that WAS wrong, and the follow-up
 * composer skips it, so the list is the only place it can still be read.
 */
function CommentList({
  comments,
  allowWrites,
  pending,
  onAct,
}: {
  comments: readonly ReviewComment[];
  allowWrites: boolean;
  pending: boolean;
  onAct: (action: CommentAct, id: string) => void;
}) {
  if (!comments.length) return null;
  const open = comments.filter((c) => !c.resolved).length;
  const label = `${plural(comments.length, 'comment')}${open !== comments.length ? `, ${open} unresolved` : ''}`;
  return (
    <Disclosure label={label} openLabel="Hide the comments" bodyClassName="pt-2">
      <ul className="flex min-w-0 flex-col gap-3" data-testid="review-comments">
        {comments.map((c) => (
          <li key={c.id} className="flex min-w-0 flex-col gap-1">
            <AnchorWords path={c.path} line={c.line} side={c.side} />
            <InlineComment comment={c} />
            {allowWrites && (
              <span className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => onAct(c.resolved ? 'unresolve' : 'resolve', c.id)}
                >
                  {c.resolved ? 'Reopen' : 'Mark answered'}
                </Button>
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  destructive
                  busy={pending}
                  title="Delete this comment?"
                  description="It leaves the review for good. Mark it answered instead to keep it on the record."
                  confirmLabel="Delete"
                  onConfirm={() => onAct('delete', c.id)}
                >
                  Delete
                </ConfirmButton>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

type Anchor = { path: string; line?: number; side: Side; hunk: string; code: string };

/** The composer that opens under a line the reader pressed `+` on. */
function CommentDraft({
  anchor,
  pending,
  onCancel,
  onSubmit,
}: {
  anchor: Anchor;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState('');
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded border border-rule-strong p-2">
      <AnchorWords path={anchor.path} line={anchor.line} side={anchor.side} />
      <Textarea
        autoFocus
        block
        rows={3}
        value={body}
        spellCheck={false}
        aria-label="Comment on this line"
        placeholder="What is wrong here"
        onChange={(event) => setBody(event.target.value)}
      />
      <span className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending || !body.trim()} onClick={() => onSubmit(body.trim())}>
          Add comment
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

/* ---------------- the card ---------------- */

type Busy = 'verdict' | 'comment' | 'send-back';

/**
 * The whole review: the window, the commits, the files, the comments and the
 * verdict — folded until someone asks to read the diff, because the read
 * behind it is three git invocations.
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
  const client = useQueryClient();
  const heading = useId();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sentBack, setSentBack] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch } = usePhaseReview(slug, view.phase, open);

  /*
   * One door for the three writes. The answer is drawn inline and a failure is
   * a toast — one error leg. What the reviewer typed is cleared only when the
   * write landed, so a retry is a second press rather than a second paragraph.
   */
  const write = async <T,>(what: Busy, call: () => Promise<T>, landed: (result: T) => void) => {
    setBusy(what);
    try {
      const pressed = await press(call);
      if (pressed.state === 'asked') toast(pressed.words, 'info');
      else landed(pressed.result);
    } catch (failure) {
      toast((failure as Error | undefined)?.message || 'The press failed and said nothing.', 'error');
    } finally {
      setBusy(null);
      for (const key of keys.afterReview(slug, view.phase)) void client.invalidateQueries({ queryKey: key });
    }
  };

  const recordVerdict = (verdict: ReviewVerdict | 'withdraw') => {
    setAnswer(null);
    void write(
      'verdict',
      () =>
        api.setReview(slug, view.phase, {
          verdict,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(data?.diff.window.base ? { base: data.diff.window.base } : {}),
          ...(data?.diff.window.tip ? { tip: data.diff.window.tip } : {}),
        }),
      (result) => {
        setNote('');
        setAnswer(result.detail);
      },
    );
  };

  const comment = (input: CommentInput) =>
    void write(
      'comment',
      () => api.commentOnReview(slug, view.phase, input),
      () => setDraft(null),
    );

  const sendBack = () => {
    setSentBack(null);
    // The prompt is composed on the SERVER from the stored comments: this
    // press names the phase and nothing else, so it cannot put words in front
    // of a session.
    void write(
      'send-back',
      () => api.sendBackReview(slug, view.phase),
      (result) => setSentBack(result.detail),
    );
  };

  const files = data?.diff.files ?? [];
  const current = files.find((f) => f.path === picked) ?? files[0];
  const recorded: { verdict: string; at: string; by?: string; note?: string; tip?: string } | null =
    data?.review ?? view.review ?? null;
  const comments = data?.review?.comments ?? [];
  const unresolved = comments.filter((c) => !c.resolved);
  const recordedWords = recorded ? wordsOf(recorded.verdict) : undefined;
  const canSendBack = unresolved.length > 0 || Boolean(recorded?.note);

  return (
    <section
      aria-labelledby={heading}
      data-testid="phase-review"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-rule bg-surface p-4 sm:p-5"
    >
      <SectionHeading id={heading}>Review</SectionHeading>
      {(view.review || (data && !data.diff.failed)) && (
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-meta text-ink-muted">
          <ReviewVerdictWord review={view.review} />
          {data && !data.diff.failed && (
            <span className="tabular-nums">
              {plural(files.length, 'file')}, +{data.diff.additions} −{data.diff.deletions}
            </span>
          )}
        </p>
      )}

      <Disclosure
        label="Read the diff"
        openLabel="Hide the diff"
        open={open}
        onOpenChange={setOpen}
        bodyClassName="flex min-w-0 flex-col gap-3 pt-3"
      >
        {isLoading && <Spinner label="Reading the diff" />}
        {isError && (
          <Banner
            severity="error"
            action={
              <Button size="sm" onClick={() => void refetch()}>
                Read it again
              </Button>
            }
          >
            The diff could not be read: {(error as Error | null)?.message || 'the server said nothing more.'}
          </Banner>
        )}

        {data && (
          <>
            {/* The bracket, stated. It is a heuristic over `git log`, and a
                reader who is not told that will believe it is a record. */}
            <div className="flex min-w-0 flex-col gap-0.5 text-meta text-ink-muted">
              <p className="max-w-(--measure)">{data.diff.window.note}</p>
              {(data.diff.window.base || data.diff.window.tip) && (
                <Mono
                  value={`${data.diff.window.base ?? '(start)'}..${data.diff.window.tip ?? '(working tree)'}`}
                />
              )}
            </div>

            {data.staleTip && (
              <Banner severity="warn">
                This phase has landed a commit since the review was recorded. The verdict below is about{' '}
                {recorded?.tip ? <Mono value={recorded.tip} /> : 'an earlier tip'}, not about what is shown.
              </Banner>
            )}
            {data.diff.truncated && (
              <Banner severity="info">
                The diff was larger than the render budget, so some hunks were not read. Every file is listed
                with git&apos;s own counts.
              </Banner>
            )}
            {data.diff.failed && (
              <Banner severity="warn">
                git could not answer for this range. That is not &ldquo;no changes&rdquo;, it is &ldquo;no
                answer&rdquo;.
              </Banner>
            )}

            {data.diff.commits.length > 0 && (
              <Disclosure
                label={`${plural(data.diff.commits.length, 'commit')} in this window`}
                openLabel="Hide the commits"
                bodyClassName="pt-1"
              >
                <ul className="flex min-w-0 flex-col gap-0.5 text-meta text-ink-muted">
                  {data.diff.commits.map((c) => (
                    <li key={c.sha} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <Mono value={c.sha} />
                      <span className="min-w-0 break-words text-ink">{c.subject}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}

            {files.length === 0 ? (
              // The window is bracketed by the phase's handoffs, so the handoff
              // is where an empty bracket is explained.
              <Empty
                title={
                  data.diff.failed
                    ? 'Nothing to review: git could not read this range.'
                    : 'Nothing to review: no file changed inside this window.'
                }
                action={
                  <Button asChild size="sm">
                    <a href={handoffHref(slug, view.phase)}>Read the handoff</a>
                  </Button>
                }
              />
            ) : (
              <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:items-start">
                {/* Bounded only where the grid is two columns: stacked, this
                    list sits above the diff in the page's own flow, and a box
                    there would be a scroller inside a scroller. */}
                <nav
                  aria-label={`Files changed in phase ${view.phase}`}
                  className="flex min-w-0 flex-col gap-0.5 rounded border border-rule p-1 lg:max-h-96 lg:overflow-y-auto lg:overscroll-contain"
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
                    contained, with the hunk table's own wrapper standing down.
                    A diff is the one thing on this card both taller and wider
                    than its box. */}
                <div className="max-h-96 min-w-0 overflow-auto overscroll-contain rounded border border-rule">
                  {current ? (
                    <DiffHunks
                      file={current}
                      {...(allowWrites ? { onComment: (at) => setDraft({ path: current.path, ...at }) } : {})}
                      renderComments={(line, side) =>
                        comments
                          // A comment stored without a side predates the field;
                          // an unqualified line number means the new side.
                          .filter(
                            (c) => c.path === current.path && c.line === line && (c.side ?? 'new') === side,
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
            pending={busy === 'comment'}
            onCancel={() => setDraft(null)}
            onSubmit={(body) =>
              comment({
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
          pending={busy === 'comment'}
          onAct={(action, id) => comment({ action, id })}
        />

        {recorded && (
          <div className="flex min-w-0 flex-col gap-0.5 text-meta" data-testid="review-verdict">
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-body text-ink">{recordedWords?.headline ?? recorded.verdict}</span>
              {recorded.by && <span className="text-ink-muted">by {recorded.by}</span>}
              <RelativeTime at={recorded.at} className="text-ink-muted" />
            </p>
            {recorded.note && (
              <p className="max-w-(--measure) whitespace-pre-wrap break-words text-body text-ink">
                {recorded.note}
              </p>
            )}
            {recordedWords && <p className="max-w-(--measure) text-ink-muted">{recordedWords.hint}</p>}
          </div>
        )}

        {allowWrites ? (
          <div className="flex min-w-0 flex-col gap-2">
            <Textarea
              block
              rows={2}
              value={note}
              spellCheck={false}
              aria-label="Review note"
              placeholder="What you read, and what you want changed"
              onChange={(event) => setNote(event.target.value)}
            />
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy === 'verdict'} onClick={() => recordVerdict('approved')}>
                Approve
              </Button>
              <Button
                size="sm"
                disabled={busy === 'verdict'}
                title={
                  'Records a changes-requested verdict. This console then refuses to board every phase that ' +
                  'depends on this one until it is approved or withdrawn. The engine’s board is not changed, ' +
                  'and does not know.'
                }
                onClick={() => recordVerdict('requested-changes')}
              >
                Request changes
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === 'verdict'}
                onClick={() => recordVerdict('commented')}
              >
                Comment only
              </Button>
              {recorded && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === 'verdict'}
                  onClick={() => recordVerdict('withdraw')}
                >
                  Withdraw
                </Button>
              )}
              {answer && <span className="text-meta text-ink-muted">{answer}</span>}
            </span>

            {/* The other half of the loop: a verdict that holds dependents was
                only ever half of it — the thing that has to change is the
                phase. Send back re-boards it with every unresolved comment
                quoted. */}
            {allowRun ? (
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  data-testid="review-send-back"
                  disabled={busy === 'send-back' || !canSendBack}
                  title={
                    canSendBack
                      ? 'Re-boards this phase with every unresolved comment quoted. Not a restart: nothing already landed is reverted.'
                      : 'There is nothing to send back: no unresolved comment and no note.'
                  }
                  onClick={sendBack}
                >
                  Send back{unresolved.length ? ` (${unresolved.length})` : ''}
                </Button>
                {sentBack && <span className="text-meta text-ink-muted">{sentBack}</span>}
              </span>
            ) : (
              <p className="max-w-(--measure) text-meta text-ink-muted">
                Sending a phase back re-boards it, which starts a session that edits this repository. Restart
                with <code className="font-mono">--allow-run</code> to enable it. The comments above are
                recorded either way.
              </p>
            )}
          </div>
        ) : (
          <p className="max-w-(--measure) text-meta text-ink-muted">
            Reading the diff needs no flag. Recording a verdict does: restart with{' '}
            <code className="font-mono">--allow-writes</code>. A changes-requested verdict stops dependent
            phases from boarding, so a read-only console does not record one.
          </p>
        )}
      </Disclosure>
    </section>
  );
}
