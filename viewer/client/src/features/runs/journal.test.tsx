/**
 * The journal's two claims worth pinning:
 *
 *   1. **a permalink resolves even against a filter.** A link that silently
 *      showed nothing because a filter happened to be set would be worse than
 *      no link, and it is the failure mode a filter+permalink pair invites.
 *   2. **a phone nests no scroller.** The shell owns the ONE scroller; a
 *      second one inside it is what makes a page impossible to flick past. The
 *      phone rendering pays for that with an explicit page step instead.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { Journal, PAGE, filterEntries, journalHref, linkedSeq, sentence } from './journal';
import type { JournalEntry } from '@/lib/api';

vi.mock('@/lib/media', () => ({
  usePhone: () => phone,
  useNarrow: () => false,
  useMediaQuery: () => false,
}));

let phone = false;

function entry(seq: number, event: string, data?: Record<string, unknown>): JournalEntry {
  return {
    seq,
    time: new Date(Date.parse('2026-08-22T10:00:00Z') + seq * 1000).toISOString(),
    event,
    ...(data ? { data } : {}),
  };
}

beforeEach(() => {
  phone = false;
  window.location.hash = '#/plan/demo/run';
});
afterEach(() => {
  window.location.hash = '';
});

describe('the address of an entry', () => {
  it('reads `?j=` off the hash and puts it back without losing the rest', () => {
    expect(linkedSeq('#/plan/demo/run?j=42')).toBe(42);
    expect(linkedSeq('#/plan/demo/run')).toBeNull();
    // A non-numeric value is not an entry, and must not become NaN downstream.
    expect(linkedSeq('#/plan/demo/run?j=nonsense')).toBeNull();
    expect(journalHref(7, '#/plan/demo/run?tab=x')).toBe('#/plan/demo/run?tab=x&j=7');
  });
});

describe('filterEntries', () => {
  const entries = [entry(1, 'phase.board', { phase: 3 }), entry(2, 'phase.stall', { signal: 'silent' })];

  it('matches the event name and the flattened data', () => {
    expect(filterEntries(entries, 'stall', null).map((e) => e.seq)).toEqual([2]);
    expect(filterEntries(entries, 'silent', null).map((e) => e.seq)).toEqual([2]);
    expect(filterEntries(entries, '', null)).toHaveLength(2);
  });

  it('ALWAYS keeps the linked entry, even when the filter excludes it', () => {
    // The whole point: a permalink handed to somebody with a filter already
    // set must still resolve to the line it names.
    expect(filterEntries(entries, 'stall', 1).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('the worktree family, in words', () => {
  /**
   * Every event the runner writes about WHERE a session is editing. The list is
   * the assertion: a phase that adds an event and no rendering leaves the
   * operator reading three file paths and no verb, which is the state this
   * renderer exists to end.
   */
  const EVENTS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['phase.worktree', { dir: '/s/worktrees/r1/p4', branch: 'pe/demo-p4', into: 'pe/demo' }],
    ['phase.worktree-failed', { dir: '/s/worktrees/r1/p4', branch: 'pe/demo-p4', detail: 'git said no' }],
    ['phase.worktree-resynced', { behind: 3, merged: true }],
    [
      'phase.worktree-landed',
      { branch: 'pe/demo-p4', into: 'pe/demo', kind: 'merged', commits: 2, fastForward: true },
    ],
    ['run.worktree-unavailable', { refusal: 'submodules', reason: 'the run root has submodules' }],
    ['run.worktrees-pruned', { removed: 2, kept: ['4'] }],
    ['phase.shared-checkout', { scope: 'hub', holders: ['other P2 (someone)'], guard: 'on(race)' }],
    ['run.branch-mismatch', { plan: 'pe/other', run: 'pe/demo' }],
  ];

  it('renders a sentence — not `key=value` — for every worktree event the runner writes', () => {
    for (const [event, data] of EVENTS) {
      const said = sentence(entry(1, event, data));
      expect(said, `${event} has no word rendering`).toBeTruthy();
      // A sentence, not a payload dump: it ends in a full stop and carries no
      // `key=value` pair anywhere in it.
      expect(said).toMatch(/\.$/);
      expect(said).not.toMatch(/\w+=/);
    }
  });

  it('says what happened, naming the branch and the tree', () => {
    expect(sentence(entry(1, 'phase.worktree', EVENTS[0][1]))).toContain('/s/worktrees/r1/p4');
    expect(sentence(entry(1, 'phase.worktree', EVENTS[0][1]))).toContain('pe/demo-p4');
    expect(sentence(entry(1, 'run.branch-mismatch', EVENTS[7][1]))).toBe(
      'The plan’s §Session budget names pe/other, but this run works on pe/demo. ' +
        'The session is told, and nothing is changed for it.',
    );
  });

  it('gives a frozen run that stopped nothing a sentence, not a key=value dump', () => {
    // The closing line of the `frozen` drive-loop branch. It landed as raw
    // `run.frozen-idle phase=1` while every neighbouring ending got prose.
    const said = sentence(entry(1, 'run.frozen-idle', { phase: 1 })) ?? '';
    expect(said).toContain('nothing left running');
    expect(said).toContain('phase 1 never started');
    expect(said).not.toMatch(/\w+=/);
    // The freeze is already spent by the time this is written, so the sentence
    // must not offer a ruling on it — that was N-2, in the operator's words.
    expect(said).not.toMatch(/rules on the freeze/);
    // A record written without the phase degrades the sentence rather than
    // printing `undefined` into prose.
    const bare = sentence(entry(2, 'run.frozen-idle', {})) ?? '';
    expect(bare).toContain('nothing left running');
    expect(bare).not.toContain('undefined');
  });

  it('reads every landing outcome differently — a conflict must not read like a merge', () => {
    const land = (data: Record<string, unknown>) =>
      sentence(entry(1, 'phase.worktree-landed', { branch: 'pe/demo-p4', into: 'pe/demo', ...data })) ?? '';
    expect(land({ kind: 'empty' })).toContain('no commits to land');
    expect(land({ kind: 'merged', commits: 1, fastForward: false })).toContain('1 commit');
    expect(land({ kind: 'conflict', detail: 'both modified x', files: ['x.ts', 'y.ts'] })).toMatch(
      /ABORTED and nothing was lost.*x\.ts, y\.ts/,
    );
    expect(land({ kind: 'failed', detail: 'no such branch' })).toContain('failed: no such branch');
  });

  it('degrades on a record written by another version instead of printing `undefined`', () => {
    // A journal outlives the build that wrote it. A field this build expects
    // and does not find must cost the sentence a clause, never fill one with
    // the word `undefined` — the failure that makes a renderer worse than the
    // pairs it replaced.
    for (const [event] of EVENTS) {
      // `phase.worktree-landed` is the one exemption, and it is the same rule
      // as the fall-through below rather than an exception to it: its whole
      // sentence is chosen by `kind`, so a record with a kind this build has
      // never heard of is an event shape it does not know. Guessing there
      // would report a conflict as a merge.
      const said = sentence(entry(1, event)) ?? '';
      if (event !== 'phase.worktree-landed') {
        expect(said, `${event} renders nothing at all without its data`).toBeTruthy();
      }
      expect(said, `${event} leaked undefined`).not.toContain('undefined');
      expect(said).not.toContain('null');
    }
    expect(sentence(entry(1, 'phase.worktree-landed', { kind: 'invented-later' }))).toBeNull();
  });

  it('leaves an event it has never heard of to the generic fall-through', () => {
    // The set of events grows every phase. Returning null here is what keeps a
    // new one rendering its payload instead of a sentence that pretends to
    // cover it.
    expect(sentence(entry(1, 'phase.board', { phase: 3 }))).toBeNull();
    expect(sentence(entry(1, 'run.worktree-invented-later', { x: 1 }))).toBeNull();
  });

  it('shows the sentence in the row, and the filter matches the words on screen', () => {
    phone = true;
    render(<Journal entries={[entry(1, 'run.branch-mismatch', { plan: 'pe/other', run: 'pe/demo' })]} />);
    expect(screen.getByText(/§Session budget names pe\/other/)).toBeInTheDocument();
    // `budget` appears nowhere in the event name or the data — only in the
    // rendered sentence, which is the half `entryText` used to miss.
    expect(
      filterEntries([entry(1, 'run.branch-mismatch', { plan: 'pe/other', run: 'pe/demo' })], 'budget', null),
    ).toHaveLength(1);
  });
});

describe('the silent-session watchdog, in words', () => {
  // Phase 20's exit criterion 6 says "the journal words render", and QA round 1
  // pointed out that nothing checked it. Four events, and the same two rules as
  // the worktree family: a sentence may only use fields the writer wrote, and a
  // missing field costs a clause rather than printing `undefined`.
  const WATCHDOG: [string, Record<string, unknown>, RegExp][] = [
    [
      'phase.auto-nudged',
      { detail: 'no output for 10 min; no tool call is open', attempt: 0, nudges: 1 },
      /wrote to the session itself/,
    ],
    [
      'phase.auto-nudge-refused',
      { reason: 'nothing is running to steer', attempt: 0 },
      /tried to write to this silent session and could not/,
    ],
    [
      'phase.auto-recycled',
      { sessionId: 'abcdef12-3456', recycles: 1, graceMs: 300000 },
      /the session was ended and the phase re-boarded/,
    ],
    [
      'phase.stall-parked',
      { need: 'a person to look at why this phase boots and then says nothing', nudges: 1, recycles: 1 },
      /parked rather than tried a third time/,
    ],
  ];

  it('says what the console did, and never says a field it was not given', () => {
    for (const [event, data, matcher] of WATCHDOG) {
      const full = sentence(entry(1, event, data)) ?? '';
      expect(full, `${event} renders nothing`).toMatch(matcher);
      expect(full, `${event} leaked undefined`).not.toContain('undefined');
      // …and with NO data at all: still a sentence, still no placeholder.
      const bare = sentence(entry(2, event)) ?? '';
      expect(bare, `${event} renders nothing without its data`).toBeTruthy();
      expect(bare, `${event} leaked undefined when bare`).not.toContain('undefined');
      expect(bare).not.toContain('null');
    }
  });

  it('tells a local-job nudge apart from a silent one — they mean opposite things', () => {
    // Both ladders write `phase.auto-nudged`. The silent one is about a lane
    // that has produced nothing and is next in line to be RECYCLED; the
    // local-job one is about a lane that is working and has merely put its
    // waiting inside the turn. Narrating the second as the first tells an
    // operator their healthy session is about to be killed.
    const local =
      sentence(
        entry(1, 'phase.auto-nudged', {
          detail: 'a Bash call matching `until [ -f /tmp/x ]; do` has been open for 6 min',
          scope: 'local',
          parkAfterMs: 2_700_000,
        }),
      ) ?? '';
    expect(local).toMatch(/job this session started itself/);
    expect(local).toMatch(/Nothing is killed/);
    expect(local).not.toMatch(/recycled/);

    const silent =
      sentence(
        entry(2, 'phase.auto-nudged', {
          detail: 'no output for 10 min',
          nudges: 1,
        }),
      ) ?? '';
    expect(silent).toMatch(/recycled/);

    // And the refusal names which kind of session it could not reach.
    expect(
      sentence(entry(3, 'phase.auto-nudge-refused', { scope: 'local', reason: 'stdin closed' })) ?? '',
    ).toMatch(/write to this waiting session/);
    expect(sentence(entry(4, 'phase.auto-nudge-refused', { reason: 'stdin closed' })) ?? '').toMatch(
      /write to this silent session/,
    );
  });

  it('names the session it resumed, and says nothing about one it was not given', () => {
    const withId = sentence(entry(1, 'phase.auto-recycled', { sessionId: 'abcdef1234' })) ?? '';
    expect(withId).toContain('abcdef12');
    expect(sentence(entry(2, 'phase.auto-recycled', {}))).not.toContain('same session id');
  });
});

describe('<Journal>', () => {
  it('shows newest first and links an entry by seq', () => {
    // Asserted in the PHONE rendering because that is the one that puts rows
    // in ordinary flow. jsdom gives the desktop scroller a height of zero, so
    // the virtualizer honestly reports that nothing is on screen and renders
    // no rows at all — see the desktop case below.
    phone = true;
    render(<Journal entries={[entry(1, 'run.start'), entry(2, 'phase.board')]} />);
    const links = screen.getAllByTitle('Copy a link to this entry');
    expect(links[0]).toHaveTextContent('#2');
    expect(links[1]).toHaveTextContent('#1');
  });

  it('filters, and says the buffer is not the whole story when nothing matches', () => {
    render(<Journal entries={[entry(1, 'run.start'), entry(2, 'phase.board')]} />);
    fireEvent.change(screen.getByLabelText('Filter the journal'), {
      target: { value: 'nothing-like-this' },
    });
    expect(screen.getByText(/Nothing matches that/)).toBeInTheDocument();
  });

  it('on a phone: no nested scroller, and an explicit step for older entries', () => {
    phone = true;
    const many = Array.from({ length: PAGE + 5 }, (_, i) => entry(i + 1, 'phase.board'));
    const { container } = render(<Journal entries={many} />);

    // The shell owns the one scroller. Nothing this component renders may
    // declare a second — that is the phone rule, and it is why the phone
    // rendering pages instead of virtualizing.
    expect(container.querySelector('[class*="overflow-y-auto"]')).toBeNull();

    const more = screen.getByRole('button', { name: /Show 5 older/ });
    expect(more).toBeInTheDocument();
    fireEvent.click(more);
    expect(screen.queryByRole('button', { name: /older/ })).not.toBeInTheDocument();
  });

  it('on a desktop: one bounded scroller, and far fewer rows than entries', () => {
    const many = Array.from({ length: 400 }, (_, i) => entry(i + 1, 'phase.board'));
    render(<Journal entries={many} />);
    // The virtualized list declares its own scroller — the thing the phone
    // rendering deliberately does not.
    expect(screen.getByRole('log', { name: 'Run journal' })).toBeInTheDocument();
    // And the DOM is not 400 rows. jsdom measures the scroller at zero height,
    // so the honest assertion is the bound, not a count: without
    // virtualization this is 400 regardless of viewport.
    expect(screen.queryAllByTitle('Copy a link to this entry').length).toBeLessThan(100);
  });
});
