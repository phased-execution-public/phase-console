/**
 * The review surface, as a reader meets it.
 *
 * Four claims, and each of them is a thing the card could plausibly get wrong
 * in a way nobody would notice for weeks:
 *
 *   1. **nothing is fetched until it is opened.** The read behind this card is
 *      three git invocations; a card that fetched on mount would make every
 *      phase page pay for a diff nobody asked to see;
 *   2. **a verdict renders where a verdict is claimed to render** — the chip on
 *      the phase row is half of exit criterion 1, and it is the half that is
 *      easy to leave out because the panel looks finished without it;
 *   3. **the hold names itself as this console's.** An operator who reads
 *      "held" and believes the ENGINE is holding a phase will go looking in
 *      `phase-graph.sh` and find nothing;
 *   4. **a read-only console still shows the diff.** Reading is not the gated
 *      act. Getting this backwards would hide the one thing the card is for
 *      from the console most likely to be running.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { expectNoAxeViolations } from '@/test/axe';
import type { PhaseReview, PhaseView } from '@/lib/api';
import { ReviewCard, ReviewHoldBanner, ReviewVerdictChip } from './review-panel';
import { FlagsCell } from './phase-cells';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      review: vi.fn(),
      setReview: vi.fn(),
      commentOnReview: vi.fn(),
      sendBackReview: vi.fn(),
    },
  };
});

const { api } = await import('@/lib/api');

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

function renderCard(view: PhaseView, allowWrites = true, allowRun = false) {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <ReviewCard slug="demo" view={view} allowWrites={allowWrites} allowRun={allowRun} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.review).mockReset().mockResolvedValue(REVIEW);
  vi.mocked(api.setReview).mockReset().mockResolvedValue({ ok: true, review: null, detail: 'ok' });
  vi.mocked(api.commentOnReview).mockReset().mockResolvedValue({ ok: true, review: null, detail: 'ok' });
  vi.mocked(api.sendBackReview).mockReset().mockResolvedValue({ ok: true, detail: 'sent', boarded: true });
});

describe('the diff', () => {
  it('fetches nothing until the diff is actually asked for', async () => {
    renderCard(phase());
    expect(api.review).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));
    await waitFor(() => expect(api.review).toHaveBeenCalledWith('demo', 13));
  });

  it('lists every changed file and shows the first one hunk by hunk', async () => {
    renderCard(phase());
    fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));
    expect(await screen.findByText('Bracketed by the handoffs.')).toBeInTheDocument();
    expect(screen.getByText('aaaaaaa..bbbbbbb')).toBeInTheDocument();
  });

  it('says "no answer" rather than "no changes" when git could not read the range', async () => {
    vi.mocked(api.review).mockResolvedValue({
      ...REVIEW,
      diff: { ...REVIEW.diff, files: [], additions: 0, deletions: 0, commits: [], failed: true },
    });
    renderCard(phase());
    fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));
    expect(await screen.findByText(/it is .no answer/)).toBeInTheDocument();
  });

  it('warns that a verdict was given on an older tip instead of quietly re-using it', async () => {
    vi.mocked(api.review).mockResolvedValue({
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
    fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));
    expect(await screen.findByText(/landed a commit since the review was recorded/)).toBeInTheDocument();
    expect(screen.getByText(/old1234/)).toBeInTheDocument();
  });
});

describe('the verdict', () => {
  it('records a changes-requested verdict with the note and the window it was given on', async () => {
    renderCard(phase());
    fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));
    await screen.findByText('Bracketed by the handoffs.');

    fireEvent.change(screen.getByPlaceholderText(/what you read/), {
      target: { value: 'the parser mis-numbers a rename' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));

    await waitFor(() =>
      expect(api.setReview).toHaveBeenCalledWith('demo', 13, {
        verdict: 'requested-changes',
        note: 'the parser mis-numbers a rename',
        base: 'aaaaaaa',
        tip: 'bbbbbbb',
      }),
    );
  });

  it('shows the diff on a read-only console, and refuses only the verdict', async () => {
    renderCard(phase(), false);
    fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));

    // The whole point: reading is not the gated act.
    expect(await screen.findByText('export const a = 1;')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument();
    expect(screen.getByText(/Reading the diff needs no flag/)).toBeInTheDocument();
    expect(screen.getByText(/--allow-writes/)).toBeInTheDocument();
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
});

/*
 * The diff is a TABLE, and for two releases it was one nobody could name: no
 * `<thead>`, no `<th>` anywhere, and the row that says which lines a hunk holds
 * was a `<td colSpan={3}>` — announced as data, on a card that can hold twenty
 * of them.
 *
 * And it was three scroll containers deep. The box around it, this table's own
 * `TableWrap` (whose `overflow-x` computes `overflow-y` to `auto`, so it is a
 * vertical scroller nobody declared) and the panel body: a touch flick had to
 * choose between three, and the one it chose was rarely the one under the
 * finger. The box is the one scroller now, in both directions.
 */
describe('the diff table', () => {
  it('is named after the file it shows, so twenty of them are twenty things', async () => {
    renderCard(phase());
    fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));
    await screen.findByText('export const a = 1;');
    expect(screen.getByRole('table', { name: 'Diff of server/review.ts' })).toBeInTheDocument();
  });

  it("makes each hunk's header a real header for the rows under it", async () => {
    renderCard(phase());
    fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));
    await screen.findByText('export const a = 1;');
    const head = screen.getByRole('columnheader', { name: '@@ -0,0 +1,2 @@' });
    expect(head.tagName).toBe('TH');
    expect(head).toHaveAttribute('scope', 'colgroup');
  });

  it('stands its own wrapper down so the box around it is the only scroller', () => {
    // Source text: jsdom computes no styles, so "how many scroll containers"
    // is only answerable from what ships.
    //
    // TWO files now, because Phase 9 extracted the hunk table into
    // `components/diff-view.tsx` so the Repo destination could render the same
    // picture. The invariant is unchanged and split across the seam: the shared
    // table stands its wrapper down, and each CALLER owns the one box around
    // it. Asserting only on this file would have quietly stopped checking the
    // half that moved.
    const source = readFileSync(join(here, 'review-panel.tsx'), 'utf8');
    const shared = readFileSync(join(here, '..', '..', 'components', 'diff-view.tsx'), 'utf8');
    expect(shared).toMatch(/<TableWrap scrolls=\{false\}/);
    // One box, both axes, contained — and no second `max-h` scroller nested
    // inside it.
    expect(source).toMatch(/max-h-96 min-w-0 overflow-auto overscroll-contain/);
  });

  it('reveals the comment affordance on a variant that can actually match', () => {
    // `group-hover:` needs a `group` ancestor and the row is a plain `<tr>`, so
    // the class never matched anything; `[tr:hover_&]` is the one that works
    // and `[@media(hover:none)]` is what a phone gets instead.
    // In `components/diff-view.tsx` since Phase 9 extracted the hunk table —
    // the class is on the button, and the button went with it.
    const source = readFileSync(join(here, '..', '..', 'components', 'diff-view.tsx'), 'utf8');
    expect(source).not.toMatch(/group-hover:opacity-100/);
    expect(source).toMatch(/\[tr:hover_&\]:opacity-100/);
    expect(source).toMatch(/\[@media\(hover:none\)\]:opacity-100/);
  });
});

describe('accessibility', () => {
  /* The open card is the only new interactive surface this phase adds, and it
     is the shape axe is most useful on: a table of lines, a list of file
     buttons and a form, all inside one card. `a11y.test.tsx` renders the card
     CLOSED (it fetches nothing on mount, which is the point), so the open
     state would otherwise never be scanned at all. */
  /* Scoped to the rendered container, not the document: jsdom's bare `<html>`
     has no `lang`, which is the shell's business (`app/shell/a11y.test.tsx`)
     and not this card's. */
  it('the open review has no axe violations', async () => {
    const { container } = renderCard(phase());
    fireEvent.click(screen.getByRole('button', { name: 'Read the diff' }));
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

describe('the phase row', () => {
  it('carries the verdict as a chip', () => {
    render(
      <FlagsCell
        slug="demo"
        phase={phase({ review: { verdict: 'approved', at: '2026-08-24T00:00:00Z', by: 'me' } })}
      />,
    );
    expect(screen.getByText('review approved')).toBeInTheDocument();
  });

  it('carries the hold as its own chip, distinct from the verdict', () => {
    render(<FlagsCell slug="demo" phase={phase({ phase: 14, reviewHold: [13] })} />);
    expect(screen.getByText('review hold')).toBeInTheDocument();
    expect(screen.queryByText(/review approved/)).not.toBeInTheDocument();
  });

  it('shows nothing for a phase nobody reviewed — absent is not approved', () => {
    render(<ReviewVerdictChip />);
    expect(screen.queryByText(/review /)).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Comments, and sending the phase back (P14)
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
    fireEvent.click(screen.getByRole('button', { name: /read the diff/i }));
    // The first file is selected by default; its only added line is line 2.
    const add = await screen.findByRole('button', { name: 'Comment on server/review.ts line 2' });
    fireEvent.click(add);

    const box = await screen.findByLabelText('Comment on this line');
    fireEvent.change(box, { target: { value: 'this can be null here' } });
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    await waitFor(() => expect(api.commentOnReview).toHaveBeenCalled());
    const [slug, phaseNo, body] = vi.mocked(api.commentOnReview).mock.calls[0]!;
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
  });

  it('anchors a comment on a REMOVED line to the old side, not the new one', async () => {
    renderCard(phase());
    fireEvent.click(screen.getByRole('button', { name: /read the diff/i }));
    // Pick the second file, whose hunk has one deletion (old line 4) and one
    // addition (new line 4). Commenting on the removed line and on the line
    // that replaced it are two different remarks; one side would merge them.
    fireEvent.click(await screen.findByRole('button', { name: /client\/panel\.tsx/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Comment on client/panel.tsx removed line 4' }),
    );
    fireEvent.change(await screen.findByLabelText('Comment on this line'), {
      target: { value: 'why was this removed?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add comment/i }));

    await waitFor(() => expect(api.commentOnReview).toHaveBeenCalled());
    expect(vi.mocked(api.commentOnReview).mock.calls[0]![2]).toMatchObject({ line: 4, side: 'old' });
  });

  it('shows a stored comment inline under the line it is about', async () => {
    vi.mocked(api.review).mockResolvedValue(COMMENTED);
    renderCard(phase());
    fireEvent.click(screen.getByRole('button', { name: /read the diff/i }));
    // Two surfaces show it on purpose: inline, where the code is, and in the
    // roll-up list. Scoped to the inline row so this asserts the anchoring
    // rather than merely that the words appear somewhere on the card.
    const inline = await screen.findAllByTestId('inline-comment');
    expect(inline).toHaveLength(1);
    expect(inline[0]).toHaveTextContent('this can be null here');
    // The resolved comment belongs to the OTHER file, so it is not inline here
    // — but it is still on the record, in the list below.
    expect(screen.queryAllByTestId('inline-comment')[1]).toBeUndefined();
    expect(screen.getByTestId('review-comments')).toHaveTextContent('already answered');
  });

  it('a read-only console reads comments but is offered no way to leave one', async () => {
    vi.mocked(api.review).mockResolvedValue(COMMENTED);
    renderCard(phase(), false);
    fireEvent.click(screen.getByRole('button', { name: /read the diff/i }));
    expect(await screen.findAllByTestId('inline-comment')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Comment on / })).not.toBeInTheDocument();
  });
});

describe('send back', () => {
  it('is not offered without --allow-run, and says which flag', async () => {
    vi.mocked(api.review).mockResolvedValue(COMMENTED);
    renderCard(phase(), true, false);
    fireEvent.click(screen.getByRole('button', { name: /read the diff/i }));
    await screen.findAllByTestId('inline-comment');
    expect(screen.queryByTestId('review-send-back')).not.toBeInTheDocument();
    expect(screen.getByText(/--allow-run/)).toBeInTheDocument();
  });

  it('counts only the UNRESOLVED comments, and sends nothing but the phase', async () => {
    vi.mocked(api.review).mockResolvedValue(COMMENTED);
    renderCard(phase(), true, true);
    fireEvent.click(screen.getByRole('button', { name: /read the diff/i }));
    // The button exists before the diff has loaded — the count arrives with
    // the comments, so this waits for the loaded state rather than racing it.
    await screen.findAllByTestId('inline-comment');
    const button = await screen.findByTestId('review-send-back');
    // Two comments, one answered: the button offers to send back one.
    expect(button).toHaveTextContent('Send back (1)');

    fireEvent.click(button);
    await waitFor(() => expect(api.sendBackReview).toHaveBeenCalled());
    const [slug, phaseNo, ...rest] = vi.mocked(api.sendBackReview).mock.calls[0]!;
    expect([slug, phaseNo]).toEqual(['demo', 13]);
    // The prompt is composed on the server. If a follow-up body ever appears
    // in this call, the review surface has become an arbitrary
    // prompt-injection endpoint wearing a review's name.
    expect(JSON.stringify(rest)).not.toMatch(/FOLLOW-UP|this can be null/);
  });

  it('is refused when there is nothing unresolved to send', async () => {
    vi.mocked(api.review).mockResolvedValue({
      ...COMMENTED,
      review: { ...COMMENTED.review!, note: undefined, comments: [COMMENTED.review!.comments![1]] },
    });
    renderCard(phase(), true, true);
    fireEvent.click(screen.getByRole('button', { name: /read the diff/i }));
    const button = await screen.findByTestId('review-send-back');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Send back');
    expect(button).not.toHaveTextContent('(0)');
  });

  it('the comment surface has no axe violations', async () => {
    vi.mocked(api.review).mockResolvedValue(COMMENTED);
    const { container } = renderCard(phase(), true, true);
    fireEvent.click(screen.getByRole('button', { name: /read the diff/i }));
    await screen.findAllByTestId('inline-comment');
    fireEvent.click(screen.getByRole('button', { name: 'Comment on server/review.ts line 2' }));
    await screen.findByLabelText('Comment on this line');
    await expectNoAxeViolations(container);
  });
});
