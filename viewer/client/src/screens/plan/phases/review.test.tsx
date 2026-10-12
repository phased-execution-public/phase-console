/**
 * The review surface, as a reader meets it (7.0, quiet-console phase 10;
 * ported from `features/plans/review-panel.test.tsx`).
 *
 * Four claims, and each of them is a thing the card could plausibly get wrong
 * in a way nobody would notice for weeks:
 *
 *   1. **nothing is fetched until it is opened.** The read behind this card is
 *      three git invocations; a card that fetched on mount would make every
 *      phase page pay for a diff nobody asked to see;
 *   2. **a verdict renders where a verdict is claimed to render** — as words
 *      now, never a chip, and absent is not approved;
 *   3. **the hold names itself as this console's.** An operator who reads
 *      "held" and believes the ENGINE is holding a phase will go looking in
 *      `phase-graph.sh` and find nothing;
 *   4. **a read-only console still shows the diff.** Reading is not the gated
 *      act.
 *
 * And what 7.0 adds: every write is a press through the owner door, and every
 * write re-reads the review, the plan and the list whether it landed or not.
 * The old file's two phase-row cases (the verdict and the hold as the row's
 * chips, `FlagsCell`) belong to the grid row and are not ported here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseReview, PhaseView } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { TooltipProvider } from '@/ui/tooltip';
import { expectNoAxeViolations } from '@/test/axe';
import { ReviewCard, ReviewHoldBanner, ReviewVerdictWord } from './review';

const { review, setReview, commentOnReview, sendBackReview, toast } = vi.hoisted(() => ({
  review: vi.fn(),
  setReview: vi.fn(),
  commentOnReview: vi.fn(),
  sendBackReview: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, review, setReview, commentOnReview, sendBackReview } };
});

// The toast store is module-level; the card raises a failure and an owner's
// ask there, so the test reads what it was handed.
vi.mock('@/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/toast')>();
  return { ...actual, toast };
});

const here = dirname(fileURLToPath(import.meta.url));

const phase = (over: Partial<PhaseView> = {}): PhaseView =>
  ({
    phase: 13,
    title: 'Diff review page',
    state: 'done',
    size: 'L',
    gated: false,
    ...over,
  }) as unknown as PhaseView;

const REVIEW: PhaseReview = {
  diff: {
    slug: 'demo',
    phase: 13,
    window: { kind: 'handoff-window', base: 'aaaaaaa', tip: 'bbbbbbb', note: 'Bracketed by the handoffs.' },
    commits: [{ sha: 'bbbbbbb', subject: 'p13: the review page' }],
    files: [
      {
        path: 'server/review.ts',
        status: 'added',
        additions: 2,
        deletions: 0,
        binary: false,
        hunks: [
          {
            header: '@@ -0,0 +1,2 @@',
            lines: [
              { kind: 'add', text: 'export const a = 1;', newLine: 1 },
              { kind: 'add', text: 'export const b = 2;', newLine: 2 },
            ],
          },
        ],
      },
      {
        path: 'client/panel.tsx',
        status: 'modified',
        additions: 1,
        deletions: 1,
        binary: false,
        hunks: [
          {
            header: '@@ -4,2 +4,2 @@',
            lines: [
              { kind: 'del', text: 'const old = 1;', oldLine: 4 },
              { kind: 'add', text: 'const fresh = 2;', newLine: 4 },
            ],
          },
        ],
      },
    ],
    additions: 3,
    deletions: 1,
    truncated: false,
    failed: false,
  },
  review: null,
  staleTip: false,
};

function renderCard(
  view: PhaseView,
  allowWrites = true,
  allowRun = false,
  client = new QueryClient(queryClientConfig),
) {
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ReviewCard slug="demo" view={view} allowWrites={allowWrites} allowRun={allowRun} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const openDiff = () => fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));

beforeEach(() => {
  review.mockReset().mockResolvedValue(REVIEW);
  setReview.mockReset().mockResolvedValue({ ok: true, review: null, detail: 'ok' });
  commentOnReview.mockReset().mockResolvedValue({ ok: true, review: null, detail: 'ok' });
  sendBackReview.mockReset().mockResolvedValue({ ok: true, detail: 'sent', boarded: true });
  toast.mockReset();
});

describe('the diff', () => {
  it('fetches nothing until the diff is actually asked for', async () => {
    renderCard(phase());
    expect(review).not.toHaveBeenCalled();

    openDiff();
    await waitFor(() => expect(review).toHaveBeenCalledWith('demo', 13));
  });

  it('lists every changed file and shows the first one hunk by hunk', async () => {
    renderCard(phase());
    openDiff();

    const files = await screen.findByRole('navigation', { name: /Files changed in phase 13/ });
    expect(files).toHaveTextContent('server/review.ts');
    expect(files).toHaveTextContent('client/panel.tsx');
    // The first file's hunk is on screen without a click.
    expect(await screen.findByText('export const a = 1;')).toBeInTheDocument();
    // …and the second file's is not, until it is picked.
    expect(screen.queryByText('const fresh = 2;')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /client\/panel\.tsx/ }));
    expect(await screen.findByText('const fresh = 2;')).toBeInTheDocument();
  });

  it('states the window rather than implying the bracket is a record', async () => {
    renderCard(phase());
    openDiff();
    expect(await screen.findByText('Bracketed by the handoffs.')).toBeInTheDocument();
    expect(screen.getByText('aaaaaaa..bbbbbbb')).toBeInTheDocument();
  });

  it('says "no answer" rather than "no changes" when git could not read the range', async () => {
    review.mockResolvedValue({
      ...REVIEW,
      diff: { ...REVIEW.diff, files: [], additions: 0, deletions: 0, commits: [], failed: true },
    });
    renderCard(phase());
    openDiff();
    expect(await screen.findByText(/it is .no answer/)).toBeInTheDocument();
  });

  it('warns that a verdict was given on an older tip instead of quietly re-using it', async () => {
    review.mockResolvedValue({
      ...REVIEW,
      review: {
        version: 1,
        slug: 'demo',
        phase: 13,
        verdict: 'approved',
        at: '2026-08-24T00:00:00Z',
        tip: 'old1234',
      },
      staleTip: true,
    });
    renderCard(phase());
    openDiff();
    expect(await screen.findByText(/landed a commit since the review was recorded/)).toBeInTheDocument();
    expect(screen.getByText(/old1234/)).toBeInTheDocument();
  });

  it('folds the diff away again with the same control, and says what opening shows', async () => {
    renderCard(phase());
    openDiff();
    await screen.findByText('export const a = 1;');
    // The summary rides beside the heading once the diff has been read.
    expect(screen.getByText('2 files, +3 −1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the diff' }));
    expect(screen.queryByText('export const a = 1;')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read the diff' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('the verdict', () => {
  it('records a changes-requested verdict with the note and the window it was given on', async () => {
    renderCard(phase());
    openDiff();
    await screen.findByText('Bracketed by the handoffs.');

    fireEvent.change(screen.getByLabelText('Review note'), {
      target: { value: 'the parser mis-numbers a rename' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));

    await waitFor(() =>
      expect(setReview).toHaveBeenCalledWith('demo', 13, {
        verdict: 'requested-changes',
        note: 'the parser mis-numbers a rename',
        base: 'aaaaaaa',
        tip: 'bbbbbbb',
      }),
    );
    // Landed: the server's own answer inline, and the note cleared for the next one.
    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.getByLabelText('Review note')).toHaveValue('');
  });

  it('shows the diff on a read-only console, and refuses only the verdict', async () => {
    renderCard(phase(), false);
    openDiff();

    // The whole point: reading is not the gated act.
    expect(await screen.findByText('export const a = 1;')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument();
    expect(screen.getByText(/Reading the diff needs no flag/)).toBeInTheDocument();
    expect(screen.getByText(/--allow-writes/)).toBeInTheDocument();
  });

  it('draws the verdict on record with its words and what it holds', async () => {
    renderCard(phase({ review: { verdict: 'requested-changes', at: '2026-08-24T00:00:00Z', by: 'me' } }));
    // Before the diff is read, the recorded verdict is already on the card.
    expect(screen.getByText('review changes requested')).toBeInTheDocument();
    openDiff();
    const verdict = await screen.findByTestId('review-verdict');
    expect(verdict).toHaveTextContent('Changes requested');
    expect(verdict).toHaveTextContent('by me');
    expect(verdict).toHaveTextContent(/holds every phase that depends on this one/);
    // A verdict on record can be withdrawn.
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });
});

describe('a write is a press', () => {
  it('says the owner was asked instead of reading a 202 as done — and keeps what was typed', async () => {
    setReview.mockResolvedValue({
      requested: true,
      request: {
        id: 'r1',
        ask: 'Approve the review of demo phase 13',
        method: 'POST',
        path: '/api/plans/demo/review/13',
      },
      error: 'This console asked its owner to confirm the verdict.',
    });
    renderCard(phase());
    openDiff();
    await screen.findByText('Bracketed by the handoffs.');
    fireEvent.change(screen.getByLabelText('Review note'), { target: { value: 'reads well' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('This console asked its owner to confirm the verdict.', 'info'),
    );
    expect(screen.getByLabelText('Review note')).toHaveValue('reads well');
  });

  it('re-reads the review, the plan and the list even when the write fails', async () => {
    setReview.mockRejectedValue(new Error('Another console recorded a verdict first.'));
    const client = new QueryClient(queryClientConfig);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    renderCard(phase(), true, false, client);
    openDiff();
    await screen.findByText('Bracketed by the handoffs.');
    fireEvent.change(screen.getByLabelText('Review note'), { target: { value: 'kept on failure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    // One error leg: the server's words, as a toast.
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Another console recorded a verdict first.', 'error'),
    );
    for (const key of keys.afterReview('demo', 13)) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    }
    // A failed write keeps what the reviewer typed.
    expect(screen.getByLabelText('Review note')).toHaveValue('kept on failure');
  });
});

describe('the hold', () => {
  it('names the holding phases, links to them, and says whose hold it is', () => {
    render(<ReviewHoldBanner slug="demo" view={phase({ phase: 14, reviewHold: [13] })} />);
    const banner = screen.getByTestId('review-hold');
    expect(banner).toHaveTextContent('Held by review');
    expect(screen.getByRole('link', { name: 'P13' })).toHaveAttribute('href', '#/plan/demo/phase/13');
    // The sentence an operator needs, or they will go looking in the engine.
    expect(banner).toHaveTextContent(/this console's hold, not the engine's/);
  });

  it('renders nothing when nothing is held, so a caller can mount it unconditionally', () => {
    const { container } = render(<ReviewHoldBanner slug="demo" view={phase({ phase: 14 })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names every holding phase when more than one asked for changes', () => {
    render(<ReviewHoldBanner slug="demo" view={phase({ phase: 15, reviewHold: [13, 14] })} />);
    expect(screen.getByTestId('review-hold')).toHaveTextContent('dependencies have requested changes');
    expect(screen.getByRole('link', { name: 'P14' })).toHaveAttribute('href', '#/plan/demo/phase/14');
  });
});

/*
 * The diff is a TABLE, named after its file, with each hunk's header a real
 * header — and it is ONE scroll container deep: the box around it, in both
 * directions, with the table's own wrapper standing down.
 */
describe('the diff table', () => {
  it('is named after the file it shows, so twenty of them are twenty things', async () => {
    renderCard(phase());
    openDiff();
    await screen.findByText('export const a = 1;');
    expect(screen.getByRole('table', { name: 'Diff of server/review.ts' })).toBeInTheDocument();
  });

  it("makes each hunk's header a real header for the rows under it", async () => {
    renderCard(phase());
    openDiff();
    await screen.findByText('export const a = 1;');
    const head = screen.getByRole('columnheader', { name: '@@ -0,0 +1,2 @@' });
    expect(head.tagName).toBe('TH');
    expect(head).toHaveAttribute('scope', 'colgroup');
  });

  it('stands its own wrapper down so the box around it is the only scroller', () => {
    // Source text: jsdom computes no styles, so "how many scroll containers"
    // is only answerable from what ships. Split across the seam: the shared
    // hunk table stands its wrapper down, and this card owns the one box.
    const source = readFileSync(join(here, 'review.tsx'), 'utf8');
    const shared = readFileSync(join(here, '..', '..', 'repo', 'diff-view.tsx'), 'utf8');
    expect(shared).toMatch(/<TableWrap scrolls=\{false\}/);
    expect(source).toMatch(/max-h-96 min-w-0 overflow-auto overscroll-contain/);
  });

  it('reveals the comment affordance on a variant that can actually match', () => {
    // `group-hover:` needs a `group` ancestor and the row is a plain `<tr>`;
    // `[tr:hover_&]` is the one that works and `[@media(hover:none)]` is what a
    // phone gets instead. The button lives in the shared hunk table.
    const source = readFileSync(join(here, '..', '..', 'repo', 'diff-view.tsx'), 'utf8');
    expect(source).not.toMatch(/group-hover:opacity-100/);
    expect(source).toMatch(/\[tr:hover_&\]:opacity-100/);
    expect(source).toMatch(/\[@media\(hover:none\)\]:opacity-100/);
  });
});

describe('accessibility', () => {
  /* Scoped to the rendered container: jsdom's bare `<html>` has no `lang`,
     which is the shell's business and not this card's. */
  it('the open review has no axe violations', async () => {
    const { container } = renderCard(phase());
    openDiff();
    await screen.findByText('export const a = 1;');
    await expectNoAxeViolations(container);
  });

  it('the hold banner has none either', async () => {
    const { container } = render(
      <ReviewHoldBanner slug="demo" view={phase({ phase: 14, reviewHold: [13] })} />,
    );
    await expectNoAxeViolations(container);
  });
});

describe('the verdict as words', () => {
  it('shows nothing for a phase nobody reviewed — absent is not approved', () => {
    const { container } = render(<ReviewVerdictWord />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/review /)).not.toBeInTheDocument();
  });

  it('says each verdict in words, never a chip', () => {
    const at = '2026-08-24T00:00:00Z';
    render(
      <>
        <ReviewVerdictWord review={{ verdict: 'approved', at }} />
        <ReviewVerdictWord review={{ verdict: 'requested-changes', at, by: 'me' }} />
        <ReviewVerdictWord review={{ verdict: 'commented', at }} />
      </>,
    );
    expect(screen.getByText('review approved')).toBeInTheDocument();
    expect(screen.getByText('review commented')).toBeInTheDocument();
    const held = screen.getByText('review changes requested');
    // The one verdict that holds anything is ink — and never amber, which is a summons.
    expect(held).toHaveClass('text-ink');
    expect(held.className).not.toMatch(/accent|needs-you|bg-/);
    expect(held).toHaveAttribute(
      'title',
      expect.stringMatching(/^Review changes requested by me\. This console holds/),
    );
    expect(screen.getByText('review approved')).toHaveClass('text-ink-muted');
  });

  it('links to the phase when given an address', () => {
    render(
      <ReviewVerdictWord
        review={{ verdict: 'approved', at: '2026-08-24T00:00:00Z' }}
        href="#/plan/demo/phase/13"
      />,
    );
    expect(screen.getByRole('link', { name: 'review approved' })).toHaveAttribute(
      'href',
      '#/plan/demo/phase/13',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Comments, and sending the phase back
 * ------------------------------------------------------------------ */

/** A review carrying comments, as the server would return it. */
const COMMENTED: PhaseReview = {
  ...REVIEW,
  review: {
    version: 2,
    slug: 'demo',
    phase: 13,
    verdict: 'commented',
    by: 'operator',
    at: '2026-08-24T10:00:00Z',
    comments: [
      {
        id: 'c1',
        path: 'server/review.ts',
        line: 2,
        side: 'new',
        body: 'this can be null here',
        at: '2026-08-24T10:00:00Z',
      },
      {
        id: 'c2',
        path: 'client/panel.tsx',
        line: 4,
        side: 'old',
        body: 'already answered',
        at: '2026-08-24T10:01:00Z',
        resolved: true,
      },
    ],
  },
  staleTip: false,
};

describe('comments', () => {
  it('anchors a new comment to the exact file, line and side the reader clicked', async () => {
    renderCard(phase());
    openDiff();
    // The first file is selected by default; its only added line is line 2.
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on server/review.ts line 2' }));

    const box = await screen.findByLabelText('Comment on this line');
    fireEvent.change(box, { target: { value: 'this can be null here' } });
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    await waitFor(() => expect(commentOnReview).toHaveBeenCalled());
    const [slug, phaseNo, body] = commentOnReview.mock.calls[0]!;
    expect(slug).toBe('demo');
    expect(phaseNo).toBe(13);
    // The anchor is the whole point: a comment that reaches the server without
    // its line is a comment the follow-up cannot address to anything.
    expect(body).toMatchObject({
      action: 'add',
      path: 'server/review.ts',
      line: 2,
      side: 'new',
      body: 'this can be null here',
    });
    // And the hunk and the line's own code travel with it: `side`, `hunk` and
    // `code` are what the follow-up quotes back.
    expect((body as { hunk?: unknown }).hunk).toEqual(expect.any(String));
    expect((body as { code?: unknown }).code).toEqual(expect.any(String));
    expect((body as { hunk: string }).hunk.length).toBeGreaterThan(0);
    // Landed: the composer closes.
    await waitFor(() => expect(screen.queryByLabelText('Comment on this line')).not.toBeInTheDocument());
  });

  it('anchors a comment on a REMOVED line to the old side, not the new one', async () => {
    renderCard(phase());
    openDiff();
    // The second file's hunk has one deletion (old line 4) and one addition
    // (new line 4): two different remarks, which one side would merge.
    fireEvent.click(await screen.findByRole('button', { name: /client\/panel\.tsx/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Comment on client/panel.tsx removed line 4' }),
    );
    fireEvent.change(await screen.findByLabelText('Comment on this line'), {
      target: { value: 'why was this removed?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    await waitFor(() => expect(commentOnReview).toHaveBeenCalled());
    expect(commentOnReview.mock.calls[0]![2]).toMatchObject({ line: 4, side: 'old' });
  });

  it('shows a stored comment inline under the line it is about', async () => {
    review.mockResolvedValue(COMMENTED);
    renderCard(phase());
    openDiff();
    // Two surfaces show it on purpose: inline, where the code is, and in the
    // roll-up list. Scoped to the inline row so this asserts the anchoring.
    const inline = await screen.findAllByTestId('inline-comment');
    expect(inline).toHaveLength(1);
    expect(inline[0]).toHaveTextContent('this can be null here');
    // The resolved comment belongs to the OTHER file, so it is not inline here
    // — but it is still on the record, in the list (folded, with its count).
    expect(screen.queryAllByTestId('inline-comment')[1]).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: /2 comments, 1 unresolved/ }));
    expect(screen.getByTestId('review-comments')).toHaveTextContent('already answered');
  });

  it('a read-only console reads comments but is offered no way to leave one', async () => {
    review.mockResolvedValue(COMMENTED);
    renderCard(phase(), false);
    openDiff();
    expect(await screen.findAllByTestId('inline-comment')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Comment on / })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /2 comments/ }));
    expect(screen.queryByRole('button', { name: 'Mark answered' })).not.toBeInTheDocument();
  });

  it('marks a comment answered, and deletes one only once the question is answered', async () => {
    review.mockResolvedValue(COMMENTED);
    renderCard(phase());
    openDiff();
    await screen.findAllByTestId('inline-comment');
    fireEvent.click(screen.getByRole('button', { name: /2 comments/ }));
    const list = screen.getByTestId('review-comments');

    fireEvent.click(within(list).getByRole('button', { name: 'Mark answered' }));
    await waitFor(() =>
      expect(commentOnReview).toHaveBeenCalledWith('demo', 13, { action: 'resolve', id: 'c1' }),
    );

    // Delete is destructive: it asks first, and only the answer sends it.
    fireEvent.click(within(list).getAllByRole('button', { name: 'Delete' })[1]!);
    const dialog = await screen.findByRole('alertdialog');
    expect(commentOnReview).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(commentOnReview).toHaveBeenCalledWith('demo', 13, { action: 'delete', id: 'c2' }),
    );
  });
});

describe('send back', () => {
  it('is not offered without --allow-run, and says which flag', async () => {
    review.mockResolvedValue(COMMENTED);
    renderCard(phase(), true, false);
    openDiff();
    await screen.findAllByTestId('inline-comment');
    expect(screen.queryByTestId('review-send-back')).not.toBeInTheDocument();
    expect(screen.getByText(/--allow-run/)).toBeInTheDocument();
  });

  it('counts only the UNRESOLVED comments, and sends nothing but the phase', async () => {
    review.mockResolvedValue(COMMENTED);
    renderCard(phase(), true, true);
    openDiff();
    // The count arrives with the comments, so wait for the loaded state.
    await screen.findAllByTestId('inline-comment');
    const button = await screen.findByTestId('review-send-back');
    // Two comments, one answered: the button offers to send back one.
    expect(button).toHaveTextContent('Send back (1)');

    fireEvent.click(button);
    await waitFor(() => expect(sendBackReview).toHaveBeenCalled());
    const [slug, phaseNo, ...rest] = sendBackReview.mock.calls[0]!;
    expect([slug, phaseNo]).toEqual(['demo', 13]);
    // The prompt is composed on the server. If a follow-up body ever appears
    // in this call, the review surface has become an arbitrary
    // prompt-injection endpoint wearing a review's name.
    expect(JSON.stringify(rest)).not.toMatch(/FOLLOW-UP|this can be null/);
    expect(await screen.findByText('sent')).toBeInTheDocument();
  });

  it('is refused when there is nothing unresolved to send', async () => {
    review.mockResolvedValue({
      ...COMMENTED,
      review: { ...COMMENTED.review!, note: undefined, comments: [COMMENTED.review!.comments![1]!] },
    });
    renderCard(phase(), true, true);
    openDiff();
    const button = await screen.findByTestId('review-send-back');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Send back');
    expect(button).not.toHaveTextContent('(0)');
  });

  it('the comment surface has no axe violations', async () => {
    review.mockResolvedValue(COMMENTED);
    const { container } = renderCard(phase(), true, true);
    openDiff();
    await screen.findAllByTestId('inline-comment');
    fireEvent.click(screen.getByRole('button', { name: 'Comment on server/review.ts line 2' }));
    await screen.findByLabelText('Comment on this line');
    fireEvent.click(screen.getByRole('button', { name: /2 comments/ }));
    await expectNoAxeViolations(container);
  });
});
