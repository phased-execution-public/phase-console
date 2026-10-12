/**
 * The run's journal (7.0, quiet-console phase 11) — every case of the 6.x
 * journal's suite, ported, and the count line.
 *
 *   1. **A permalink resolves even against a filter** — and against the page
 *      it sits on: a link that silently showed nothing because a filter was
 *      set, or because the line was older than the first page, is worse than no
 *      link.
 *   2. **The words.** Every event this build knows reads as a sentence that uses
 *      only the fields the writer wrote; an unknown event keeps its payload.
 *   3. **No nested scroller.** The shell owns the one scroller, so the journal
 *      pays with an explicit page step instead, at every width.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalEntry } from '@/data/api';
import { MemoryRouterProvider } from '@/shell/router';
import { expectNoAxeViolations } from '@/test/axe';
import {
  JOURNAL_PARAM,
  PAGE,
  RunJournal,
  entryText,
  filterEntries,
  journalHref,
  linkedSeq,
  sentence,
} from './journal';

function entry(seq: number, event: string, data?: Record<string, unknown>, phase?: number): JournalEntry {
  return {
    seq,
    time: new Date(Date.parse('2026-08-22T10:00:00Z') + seq * 1000).toISOString(),
    event,
    ...(phase != null ? { phase } : {}),
    ...(data ? { data } : {}),
  };
}

function mount(entries: readonly JournalEntry[], address = '#/plan/demo/run') {
  return render(
    <MemoryRouterProvider initial={address}>
      <RunJournal entries={entries} />
    </MemoryRouterProvider>,
  );
}

const seqs = () => screen.getAllByTitle('Copy a link to this entry').map((node) => node.textContent);

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('the address of an entry', () => {
  it('reads `?j=` off the hash and puts it back without losing the rest', () => {
    expect(JOURNAL_PARAM).toBe('j');
    expect(linkedSeq('#/plan/demo/run?j=42')).toBe(42);
    expect(linkedSeq('#/plan/demo/run')).toBeNull();
    // A non-numeric value is not an entry, and must not become NaN downstream.
    expect(linkedSeq('#/plan/demo/run?j=nonsense')).toBeNull();
    expect(linkedSeq('#/plan/demo/run?j=')).toBeNull();
    expect(journalHref(7, '#/plan/demo/run?tab=x')).toBe('#/plan/demo/run?tab=x&j=7');
    // An address already naming a line names the new one instead.
    expect(journalHref(9, '#/plan/demo/run?j=7&lane=p2')).toBe('#/plan/demo/run?j=9&lane=p2');
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

  it('matches the phase and the seq the way the line draws them', () => {
    const phased = [entry(5, 'phase.board', undefined, 4), entry(6, 'run.start')];
    expect(filterEntries(phased, 'p4', null).map((e) => e.seq)).toEqual([5]);
    expect(filterEntries(phased, 'phase 4', null).map((e) => e.seq)).toEqual([5]);
    expect(entryText(phased[1]!)).toContain('#6');
  });
});

describe('the worktree family, in words', () => {
  /**
   * Every event the runner writes about WHERE a session is editing. The list is
   * the assertion: a phase that adds an event and no rendering leaves the
   * operator reading three file paths and no verb.
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
    expect(sentence(entry(1, 'phase.worktree', EVENTS[0]![1]))).toContain('/s/worktrees/r1/p4');
    expect(sentence(entry(1, 'phase.worktree', EVENTS[0]![1]))).toContain('pe/demo-p4');
    expect(sentence(entry(1, 'run.branch-mismatch', EVENTS[7]![1]))).toBe(
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
    // must not offer a ruling on it.
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
    // Sentence case: the abort is said, not shouted.
    expect(land({ kind: 'conflict', detail: 'both modified x', files: ['x.ts', 'y.ts'] })).toMatch(
      /aborted and nothing was lost.*x\.ts, y\.ts/,
    );
    expect(land({ kind: 'failed', detail: 'no such branch' })).toContain('failed: no such branch');
  });

  it('says a mirror checkout without capitals for emphasis', () => {
    const said =
      sentence(entry(1, 'run.isolation', { dir: '/m', branch: 'pe/demo', mounts: ['a', 'b'] })) ?? '';
    expect(said).toContain('mirror checkout');
    expect(said).not.toMatch(/\b[A-Z]{3,}\b/);
  });

  it('degrades on a record written by another version instead of printing `undefined`', () => {
    for (const [event] of EVENTS) {
      // `phase.worktree-landed` is the one exemption: its whole sentence is
      // chosen by `kind`, so a record with a kind this build has never heard
      // of is an event shape it does not know.
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
    expect(sentence(entry(1, 'phase.board', { phase: 3 }))).toBeNull();
    expect(sentence(entry(1, 'run.worktree-invented-later', { x: 1 }))).toBeNull();
  });

  it('shows the sentence in the line, and the filter matches the words on screen', () => {
    mount([entry(1, 'run.branch-mismatch', { plan: 'pe/other', run: 'pe/demo' })]);
    expect(screen.getByText(/§Session budget names pe\/other/)).toBeInTheDocument();
    // `budget` appears nowhere in the event name or the data — only in the
    // rendered sentence.
    expect(
      filterEntries([entry(1, 'run.branch-mismatch', { plan: 'pe/other', run: 'pe/demo' })], 'budget', null),
    ).toHaveLength(1);
  });

  it('draws an unknown event as its name and its payload, in the machine face', () => {
    mount([entry(1, 'phase.board', { attempt: 2, model: 'opus' }, 3)]);
    const line = screen.getByRole('log', { name: 'Run journal' }).querySelector('[data-seq="1"]')!;
    const codes = [...line.querySelectorAll('code')].map((node) => node.textContent);
    expect(codes).toEqual(['phase.board', 'attempt=2  model=opus']);
    expect(within(line as HTMLElement).getByText('P3')).toBeInTheDocument();
  });
});

describe('the silent-session watchdog, in words', () => {
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
      sentence(entry(2, 'phase.auto-nudged', { detail: 'no output for 10 min', nudges: 1 })) ?? '';
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

describe('<RunJournal>', () => {
  it('shows newest first, in a log named Run journal', () => {
    mount([entry(1, 'run.start'), entry(2, 'phase.board')]);
    expect(screen.getByRole('log', { name: 'Run journal' })).toBeInTheDocument();
    expect(seqs()).toEqual(['#2', '#1']);
  });

  it('counts the entries, and how many a filter leaves', () => {
    const { unmount } = mount([entry(1, 'run.start')]);
    expect(screen.getByTestId('journal-count').textContent).toBe('1 entry');
    unmount();

    mount([entry(1, 'run.start'), entry(2, 'phase.board'), entry(3, 'phase.stall')]);
    expect(screen.getByTestId('journal-count').textContent).toBe('3 entries');
    fireEvent.change(screen.getByLabelText('Filter the journal'), { target: { value: 'phase' } });
    expect(screen.getByTestId('journal-count').textContent).toBe('3 entries, 2 shown');
    expect(seqs()).toEqual(['#3', '#2']);
    // A filter that narrows nothing says nothing about it.
    fireEvent.change(screen.getByLabelText('Filter the journal'), { target: { value: '.' } });
    expect(screen.getByTestId('journal-count').textContent).toBe('3 entries');
  });

  it('says so when nothing matches, and offers the way back to every entry', () => {
    mount([entry(1, 'run.start'), entry(2, 'phase.board')]);
    fireEvent.change(screen.getByLabelText('Filter the journal'), {
      target: { value: 'nothing-like-this' },
    });
    expect(screen.getByTestId('journal-no-match').textContent).toMatch(/Nothing in the journal matches/);
    expect(screen.queryByRole('log')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 2 entries' }));
    expect(seqs()).toEqual(['#2', '#1']);
  });

  it('says in one line when the run has written nothing yet', () => {
    mount([]);
    expect(screen.getByTestId('journal-empty')).toBeInTheDocument();
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('marks the line `?j=` names, and keeps it through a filter that would hide it', () => {
    mount([entry(1, 'run.start'), entry(2, 'phase.stall'), entry(3, 'phase.board')], '#/plan/demo/run?j=1');
    const log = screen.getByRole('log', { name: 'Run journal' });
    const marked = log.querySelectorAll('[data-marked]');
    expect([...marked].map((node) => node.getAttribute('data-seq'))).toEqual(['1']);
    expect(marked[0]!.getAttribute('aria-current')).toBe('true');
    fireEvent.change(screen.getByLabelText('Filter the journal'), { target: { value: 'stall' } });
    expect(seqs()).toEqual(['#2', '#1']);
  });

  it('draws the page that holds a linked line, however far back it sits', () => {
    const many = Array.from({ length: PAGE * 2 + 10 }, (_, i) => entry(i + 1, 'phase.board'));
    // Newest first, so seq 5 sits on the third page.
    mount(many, '#/plan/demo/run?j=5');
    const log = screen.getByRole('log', { name: 'Run journal' });
    expect(log.querySelector('[data-seq="5"][data-marked]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /older/ })).toBeNull();
  });

  it('says when the address names a line the journal does not hold', () => {
    mount([entry(1, 'run.start')], '#/plan/demo/run?j=999');
    expect(screen.getByTestId('journal-missing').textContent).toContain('#999');
  });

  it('copies a line’s whole address and marks it, leaving the rest of the address alone', async () => {
    mount([entry(1, 'run.start'), entry(2, 'phase.board')], '#/plan/demo/run?lane=p2');
    fireEvent.click(screen.getByRole('button', { name: 'Copy a link to entry #1' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = new URL(String(writeText.mock.calls[0]![0]));
    expect(copied.hash).toBe('#/plan/demo/run?lane=p2&j=1');
    const log = screen.getByRole('log', { name: 'Run journal' });
    expect(log.querySelector('[data-seq="1"]')!.hasAttribute('data-marked')).toBe(true);
  });

  it('nests no scroller, and steps back through older entries a page at a time', () => {
    const many = Array.from({ length: PAGE + 5 }, (_, i) => entry(i + 1, 'phase.board'));
    const { container } = mount(many);

    // The shell owns the one scroller; nothing here may declare a second.
    expect(container.querySelector('[class*="overflow-y-auto"]')).toBeNull();
    expect(container.querySelector('[class*="overflow-auto"]')).toBeNull();
    // The DOM is bounded by the page, not by the journal's length.
    expect(seqs()).toHaveLength(PAGE);

    const more = screen.getByRole('button', { name: 'Show 5 older' });
    fireEvent.click(more);
    expect(seqs()).toHaveLength(PAGE + 5);
    expect(screen.queryByRole('button', { name: /older/ })).not.toBeInTheDocument();
  });

  it('has no axe violations, a marked line and an unknown event included', async () => {
    const { container } = mount(
      [
        entry(1, 'run.branch-mismatch', { plan: 'pe/other', run: 'pe/demo' }),
        entry(2, 'phase.board', { attempt: 1 }, 2),
      ],
      '#/plan/demo/run?j=2',
    );
    await expectNoAxeViolations(container);
  });
});
