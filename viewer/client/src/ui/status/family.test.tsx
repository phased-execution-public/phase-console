/**
 * The typed status family, 7.0 (quiet-console phase 1). What these tests hold:
 *
 *  - each member REJECTS a foreign vocabulary at the type level — the
 *    `@ts-expect-error` lines below are proved by `typecheck:client`, which
 *    fails on a directive that no longer suppresses anything;
 *  - every member ALWAYS renders a dot, a word and `data-status` /
 *    `data-paint` / `data-attention` — colour is never the only carrier;
 *  - a word outside every vocabulary renders the first-class Unknown: hollow
 *    and dashed, never Waiting's paint, never amber;
 *  - a settled thing is hollow and quiet unless it ended badly;
 *  - the icon map is total against the model's `STATUS_ICON_NAMES`.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ATTENTION_LEVELS,
  FACT_KINDS,
  FACT_META,
  NOTE_ROWS,
  NOTE_SEVERITIES,
  STATUS_ICON_NAMES,
  STATUS_VOCABS,
  UNKNOWN_ICON,
  WORD_ROWS,
} from '@shared/status-model.js';
import { expectNoAxeViolations } from '@/test/axe';
import {
  AccountStatus,
  AttentionMark,
  FactMark,
  McpStatus,
  NOTE_ICONS,
  OpsStatus,
  PhaseStatus,
  PlanStatus,
  QaStatus,
  RunStatus,
  SeverityMark,
  STATUS_ICONS,
  TurnReadiness,
  TurnStatus,
  statusIcon,
  type OpsVocab,
  type WordOf,
} from './index';

/** The element a render produced, and the three attributes every member carries. */
function mark(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>('[data-status]');
  expect(el, 'the mark carries data-status').not.toBeNull();
  return el!;
}
function expectComplete(el: HTMLElement) {
  expect(el.getAttribute('data-status')).not.toBeNull();
  expect(el.getAttribute('data-paint')).toMatch(
    /^(needs-you|failed|running|verifying|waiting|queued|skipped|done)$/,
  );
  expect(el.getAttribute('data-attention')).toMatch(/^(none|fyi|needs-you|urgent)$/);
  expect(el.textContent?.trim().length ?? 0, 'a word is always written').toBeGreaterThan(0);
  expect(el.className).toContain(`state-${el.getAttribute('data-paint')}`);
}
/** The dot-and-word members draw a dot; the fact mark draws its icon instead. */
function expectDot(el: HTMLElement) {
  const dot = el.querySelector('[data-dot]');
  expect(dot, 'a dot is always drawn').not.toBeNull();
  expect(dot!.getAttribute('aria-hidden')).toBe('true');
}

// The tooltip opens on a keyboard reader's focus; a pointer press before it
// (the tap tests) would otherwise carry into the next test.
beforeEach(() => {
  fireEvent.keyDown(window, { key: 'Tab' });
});

describe('the icon map', () => {
  it('resolves every icon name the model can hand the family', () => {
    const missing = STATUS_ICON_NAMES.filter((name) => !STATUS_ICONS[name]);
    expect(missing).toEqual([]);
    expect(Object.keys(STATUS_ICONS).sort()).toEqual([...STATUS_ICON_NAMES].sort());
  });

  it('keeps the note icons apart, one per note severity', () => {
    for (const severity of NOTE_SEVERITIES)
      expect(NOTE_ICONS[NOTE_ROWS[severity].icon], severity).toBeTruthy();
    expect(Object.keys(NOTE_ICONS).length).toBe(new Set(NOTE_SEVERITIES.map((s) => NOTE_ROWS[s].icon)).size);
  });

  it('draws a name it does not know as Unknown, never as nothing', () => {
    expect(statusIcon('no-such-icon')).toBe(STATUS_ICONS[UNKNOWN_ICON]);
  });
});

describe('every member renders a dot, a word and the three data-* attributes', () => {
  it('RunStatus', () => {
    const { container } = render(<RunStatus run={{ id: 'r', slug: 's', status: 'halted' }} />);
    const el = mark(container);
    expectComplete(el);
    expectDot(el);
  });
  it('PhaseStatus', () => {
    const { container } = render(<PhaseStatus record={{ status: 'failed' }} board="stuck" />);
    const el = mark(container);
    expectComplete(el);
    expectDot(el);
  });
  it('PlanStatus', () => {
    const { container } = render(<PlanStatus status="active" />);
    const el = mark(container);
    expectComplete(el);
    expectDot(el);
  });
  it('QaStatus, a verdict and a regime', () => {
    for (const { container } of [render(<QaStatus result="fail" />), render(<QaStatus mode="waived" />)]) {
      const el = mark(container);
      expectComplete(el);
      expectDot(el);
    }
  });
  it('AccountStatus, a login and an entitlement', () => {
    for (const { container } of [
      render(<AccountStatus auth="signed-out" />),
      render(<AccountStatus entitlement="cooling" />),
    ]) {
      const el = mark(container);
      expectComplete(el);
      expectDot(el);
    }
  });
  it('McpStatus', () => {
    const el = mark(render(<McpStatus status="needs-auth" />).container);
    expectComplete(el);
    expectDot(el);
  });
  it('TurnStatus and TurnReadiness draw the card’s two words (turn-by-turn phase 8)', () => {
    for (const status of ['todo', 'checking', 'passed', 'redo', 'not-doing', 'closed', 'owner'] as const) {
      const { container, unmount } = render(<TurnStatus status={status} />);
      const el = mark(container);
      expectComplete(el);
      expectDot(el);
      expect(el.getAttribute('data-vocab')).toBe('turn');
      unmount();
    }
    const todo = mark(render(<TurnStatus status="todo" />).container);
    expect(todo.getAttribute('data-attention')).toBe('needs-you');
    const now = render(<TurnReadiness readiness="now" />);
    expect(mark(now.container).textContent).toContain('Now');
    now.unmount();
    const later = render(<TurnReadiness readiness="not-yet" when="when Phase 13 of demo is done" />);
    expect(mark(later.container).getAttribute('data-attention')).toBe('none');
    expect(later.getByTestId('turn-readiness-when').textContent).toBe('when Phase 13 of demo is done');
  });
  it('OpsStatus draws Your turn’s four vocabularies — step, verdict, risk, grant', () => {
    for (const vocab of ['step', 'verdict', 'risk', 'grant'] as const) {
      expect(STATUS_VOCABS).toContain(vocab);
    }
    const { container, unmount } = render(<OpsStatus vocab="step" word="returned" />);
    const el = mark(container);
    expectComplete(el);
    expectDot(el);
    expect(el.textContent).toContain('Sent back');
    unmount();
  });
  it('OpsStatus, every ops vocabulary and every one of its words', () => {
    const own = new Set([
      'run',
      'phase',
      'board',
      'plan',
      'qa-result',
      'qa-mode',
      'auth',
      'entitlement',
      'mcp',
      'turn',
      'readiness',
    ]);
    const ops = STATUS_VOCABS.filter((v) => !own.has(v)) as OpsVocab[];
    expect(ops.length).toBeGreaterThan(10);
    for (const vocab of ops) {
      for (const word of Object.keys(WORD_ROWS[vocab])) {
        const { container, unmount } = render(
          <OpsStatus vocab={vocab} word={word as WordOf<typeof vocab>} />,
        );
        const el = mark(container);
        expectComplete(el);
        expectDot(el);
        expect(el.getAttribute('data-status')).toBe(word);
        expect(el.getAttribute('data-vocab')).toBe(vocab);
        unmount();
      }
    }
  });
  it('AttentionMark, for every level that asks something — and nothing for none', () => {
    for (const level of ATTENTION_LEVELS) {
      const { container, unmount } = render(<AttentionMark level={level} />);
      if (level === 'none') expect(container.querySelector('[data-status]')).toBeNull();
      else {
        const el = mark(container);
        expectComplete(el);
        expectDot(el);
        expect(el.getAttribute('data-attention')).toBe(level);
      }
      unmount();
    }
  });
  it('FactMark, every fact kind — its own icon, its own paint, no attention', () => {
    for (const kind of FACT_KINDS) {
      const { container, unmount } = render(<FactMark fact={{ kind, text: `a ${kind}` }} />);
      const el = mark(container);
      expectComplete(el);
      expect(el.querySelector('svg'), 'a fact draws its icon').not.toBeNull();
      expect(el.getAttribute('data-paint')).toBe(FACT_META[kind].paint);
      expect(el.getAttribute('data-attention')).toBe('none');
      unmount();
    }
  });
  it('SeverityMark — the inbox severity as a dot, the kind as the word, nothing from the model', () => {
    const { container } = render(<SeverityMark severity="needs-you">Approval</SeverityMark>);
    const el = container.querySelector<HTMLElement>('[data-attention]')!;
    expect(el.getAttribute('data-paint')).toBe('needs-you');
    expect(el.className).toContain('state-needs-you');
    expectDot(el);
    expect(el.textContent).toBe('Approval');
  });
});

describe('a view carries its fact beside the word, and the fact keeps its own paint', () => {
  it('a finished run holding a failure: the word, a rule, the red count', () => {
    const { container } = render(
      <RunStatus run={{ id: 'r', slug: 's', status: 'finished', phases: { 1: { status: 'failed' } } }} />,
    );
    const el = mark(container);
    expect(el.getAttribute('data-paint')).toBe('skipped');
    const fact = el.querySelector('[data-fact="failed-count"]');
    expect(fact?.textContent).toBe('1 failed');
    expect(fact?.className).toContain('state-failed');
    expect(el.textContent).toBe('Finished, 1 failed');
    expect(el.textContent).not.toContain('·');
  });
});

describe('a settled thing is hollow and quiet, unless it ended badly', () => {
  it('a finished run: hollow dot, muted word', () => {
    const el = mark(render(<RunStatus run={{ id: 'r', slug: 's', status: 'finished' }} />).container);
    expect(el.getAttribute('data-tense')).toBe('settled');
    expect(el.hasAttribute('data-quiet')).toBe(true);
    expect(el.className).toContain('text-ink-muted');
    expect(el.querySelector('[data-dot]')!.className).toContain('bg-transparent');
  });
  it('a failed phase keeps its hue — hollow, but red', () => {
    const el = mark(render(<PhaseStatus record={{ status: 'failed' }} />).container);
    expect(el.getAttribute('data-tense')).toBe('settled');
    expect(el.hasAttribute('data-quiet')).toBe(false);
    const dot = el.querySelector('[data-dot]')!;
    expect(dot.className).toContain('border-state');
    expect(dot.className).toContain('bg-transparent');
  });
  it('a live thing is filled, and only a live running thing observed live breathes', () => {
    const live = mark(render(<RunStatus run={{ id: 'r', slug: 's', status: 'running' }} live />).container);
    expect(live.querySelector('[data-dot]')!.className).toContain('animate-pulse-soft');
    const still = mark(render(<RunStatus run={{ id: 'r', slug: 's', status: 'running' }} />).container);
    expect(still.querySelector('[data-dot]')!.className).not.toContain('animate-pulse-soft');
    const waiting = mark(
      render(<RunStatus run={{ id: 'r', slug: 's', status: 'waiting' }} live />).container,
    );
    expect(waiting.querySelector('[data-dot]')!.className).not.toContain('animate-pulse-soft');
  });
  it('a summons paints its word in the hue; everything else keeps the word in ink', () => {
    const summons = mark(render(<PhaseStatus record={{ status: 'awaiting-verification' }} />).container);
    expect(summons.getAttribute('data-attention')).toBe('needs-you');
    expect(summons.className).toContain('text-state');
    const calm = mark(render(<PhaseStatus record={{ status: 'running' }} />).container);
    expect(calm.className).toContain('text-ink');
    expect(calm.className).not.toContain('text-state');
  });
});

describe('the badge chrome — an outlined pill with the icon and the word in the hue (#361)', () => {
  it('a plan and a phase draw as a badge: icon, word, hue on the border and the word, never a fill', () => {
    for (const el of [
      mark(render(<PlanStatus status="active" chrome="badge" />).container),
      mark(render(<PhaseStatus board="stuck" chrome="badge" />).container),
    ]) {
      expectComplete(el);
      expect(el.getAttribute('data-chrome')).toBe('badge');
      expect(el.className).toContain('rounded-full');
      expect(el.className).toContain('border-state/60');
      expect(el.className).toContain('text-state');
      expect(el.className).not.toMatch(/\bbg-/);
      expect(el.querySelector('svg[data-icon]'), 'the status icon').not.toBeNull();
      expect(el.querySelector('[data-dot]'), 'no dot inside a badge').toBeNull();
      expect(el.textContent).not.toBe('');
    }
  });
  it('a settled Done or Complete keeps its hue, muted — never grey text', () => {
    for (const el of [
      mark(render(<PlanStatus status="complete" chrome="badge" />).container),
      mark(render(<PhaseStatus board="done" chrome="badge" />).container),
    ]) {
      expect(el.getAttribute('data-tense')).toBe('settled');
      expect(el.hasAttribute('data-quiet')).toBe(true);
      expect(el.className).toContain('text-state');
      expect(el.className).toContain('border-state/30');
      expect(el.className).not.toContain('text-ink-muted');
      expect(el.getAttribute('data-paint')).toBe('done');
    }
  });
  it('a bad ending keeps its red at full weight; Unknown is dashed and inked', () => {
    const failed = mark(render(<PhaseStatus record={{ status: 'failed' }} chrome="badge" />).container);
    expect(failed.getAttribute('data-paint')).toBe('failed');
    expect(failed.className).toContain('border-state/60');
    const unknown = mark(render(<PlanStatus status={'🤷' as WordOf<'plan'>} chrome="badge" />).container);
    expect(unknown.getAttribute('data-known')).toBe('false');
    expect(unknown.className).toContain('border-dashed');
    expect(unknown.className).not.toContain('text-state');
  });
  it('the default chrome is still the dot and the word', () => {
    const el = mark(render(<PlanStatus status="active" />).container);
    expect(el.hasAttribute('data-chrome')).toBe(false);
    expect(el.querySelector('[data-dot]')).not.toBeNull();
  });
  it('has no axe violations as badges', async () => {
    const { container } = render(
      <div>
        <PlanStatus status="complete" chrome="badge" />
        <PhaseStatus board="ready" chrome="badge" />
        <RunStatus run={{ id: 'r', slug: 's', status: 'running' }} chrome="badge" />
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('a word outside every vocabulary is the first-class Unknown', () => {
  const cases: [string, () => ReturnType<typeof render>][] = [
    ['a plan status that is a sentence', () => render(<PlanStatus status={'✅ GO' as WordOf<'plan'>} />)],
    ['a missing plan status', () => render(<PlanStatus status={null} />)],
    [
      'a run status from another vocabulary',
      () => render(<RunStatus run={{ status: 'complete' as WordOf<'run'> }} />),
    ],
    [
      'a phase record word nobody knows',
      () => render(<PhaseStatus record={{ status: 'mystery' as WordOf<'phase'> }} />),
    ],
    ['a QA verdict nobody wrote', () => render(<QaStatus result={'maybe' as WordOf<'qa-result'>} />)],
    [
      'an ops word from the wrong list',
      () => render(<OpsStatus vocab="probe" word={'green' as WordOf<'probe'>} />),
    ],
  ];
  for (const [what, draw] of cases) {
    it(what, () => {
      const el = mark(draw().container);
      expect(el.textContent).toBe('Unknown');
      expect(el.getAttribute('data-known')).toBe('false');
      expect(el.getAttribute('data-paint')).not.toBe('waiting');
      expect(el.getAttribute('data-paint')).not.toBe('needs-you');
      expect(el.getAttribute('data-attention')).toBe('none');
      expect(el.querySelector('[data-dot]')!.className).toContain('border-dashed');
      // No native title: the tooltip says it, on focus as on hover.
      expect(el.getAttribute('title')).toBeNull();
      fireEvent.focus(el);
      expect(screen.getByRole('tooltip').textContent).toMatch(
        /not a word this console knows|No status was given/,
      );
      fireEvent.blur(el);
    });
  }
});

describe('each member rejects a foreign vocabulary at the type level', () => {
  it('holds the lines below to a type error each (typecheck:client proves the directives are used)', () => {
    const rejected = [
      // @ts-expect-error — `pass` is a QA verdict, not a run status
      <RunStatus key="1" run={{ status: 'pass' }} />,
      // @ts-expect-error — `finished` is a run status, not a phase record word
      <PhaseStatus key="2" record={{ status: 'finished' }} />,
      // @ts-expect-error — `failed` is a phase word, not a board word
      <PhaseStatus key="3" board="failed" />,
      // @ts-expect-error — `done` is a board word, not a plan status
      <PlanStatus key="4" status="done" />,
      // @ts-expect-error — `on` is a QA regime, not a verdict
      <QaStatus key="5" result="on" />,
      // @ts-expect-error — a verdict and a regime at once is two marks
      <QaStatus key="6" result="pass" mode="on" />,
      // @ts-expect-error — `retired` is an entitlement, not a login state
      <AccountStatus key="7" auth="retired" />,
      // @ts-expect-error — `ok` is a login state, not an MCP status
      <McpStatus key="8" status="ok" />,
      // @ts-expect-error — `running` is not a probe word
      <OpsStatus key="9" vocab="probe" word="running" />,
      // @ts-expect-error — a run has its own member; it is not an ops vocabulary
      <OpsStatus key="10" vocab="run" word="running" />,
      // @ts-expect-error — `loud` is not an attention level
      <AttentionMark key="11" level="loud" />,
      // @ts-expect-error — a fact's kind is one of FACT_KINDS
      <FactMark key="12" fact={{ kind: 'running', text: 'x' }} />,
    ];
    expect(rejected).toHaveLength(12);
  });
});

describe('the family is accessible', () => {
  it('has no axe violations across a row of every member', async () => {
    const { container } = render(
      <div>
        <RunStatus run={{ id: 'r', slug: 's', status: 'waiting', waitReason: 'person' }} />
        <PhaseStatus board="ready" />
        <PlanStatus status="complete" />
        <QaStatus result="pending" />
        <AccountStatus auth="ok" />
        <McpStatus status="connected" />
        <OpsStatus vocab="health" word="warning" />
        <AttentionMark level="urgent" />
        <FactMark fact={{ kind: 'dormant', text: 'dormant' }} />
        <SeverityMark severity="fyi">Note</SeverityMark>
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});

/* ------------------------------------------------------------------ *
 * What a word means, one hover, focus or tap away (one-pool phase 14, #365)
 * ------------------------------------------------------------------ */

describe('a status says what it means and what comes next', () => {
  const parked = WORD_ROWS.phase.parked;

  it('every row of every vocabulary hands the tooltip a meaning and a next', () => {
    for (const vocab of STATUS_VOCABS) {
      for (const [word, row] of Object.entries(WORD_ROWS[vocab])) {
        expect(row.meaning, `${vocab}:${word}`).toBeTruthy();
        expect(row.next, `${vocab}:${word}`).toBeTruthy();
      }
    }
  });

  it('a focus that follows a pointer press opens nothing — a sheet moving focus to its first stop', () => {
    const { container } = render(<PhaseStatus record={{ status: 'parked' }} />);
    const el = mark(container);
    fireEvent.pointerDown(window);
    fireEvent.focus(el);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.blur(el);
  });

  it('on keyboard focus: the word, what it means, what comes next and a way to the reference', () => {
    const { container } = render(<PhaseStatus record={{ status: 'parked' }} />);
    const el = mark(container);
    expect(el.getAttribute('title'), 'no native title: a phone and a keyboard never show one').toBeNull();
    expect(el.tabIndex, 'standing alone, a status is a tab stop').toBe(0);
    expect(screen.queryByRole('tooltip'), 'nothing is built while closed').toBeNull();

    // A keyboard reader's focus follows a key: a focus no key led to — a page
    // placing focus as it arrives — opens nothing (#394).
    fireEvent.keyDown(window, { key: 'Tab' });
    fireEvent.focus(el);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('Parked');
    expect(tip.textContent).toContain(parked.meaning);
    expect(tip.textContent).toContain(parked.next);
    const more = within(tip).getByRole('link', { name: 'More in Help' });
    expect(more.getAttribute('href')).toMatch(/help=reference/);
    expect(more.getAttribute('href')).toMatch(/card=phase-record/);

    // …and the same words are the mark's accessible description.
    expect(el.getAttribute('aria-describedby')).toBe(tip.id);
    expect(el).toHaveAccessibleDescription(expect.stringContaining(parked.meaning));
    expect(el).toHaveAccessibleDescription(expect.stringContaining(parked.next));

    fireEvent.blur(el);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('on hover', async () => {
    const { container } = render(<RunStatus run={{ status: 'halted' }} />);
    const el = mark(container);
    fireEvent.pointerMove(el, { pointerType: 'mouse' });
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain(WORD_ROWS.run.halted.meaning);
    expect(tip.textContent).toContain(WORD_ROWS.run.halted.next);
    fireEvent.pointerLeave(el, { pointerType: 'mouse' });
  });

  it('on a tap, which a second tap closes', async () => {
    const { container } = render(<PlanStatus status="active" />);
    const el = mark(container);
    fireEvent.pointerDown(el, { pointerType: 'touch' });
    fireEvent.click(el);
    expect(screen.getByRole('tooltip').textContent).toContain(WORD_ROWS.plan.active.meaning);
    fireEvent.pointerDown(el, { pointerType: 'touch' });
    fireEvent.click(el);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('a word that means two things says the one it means here', () => {
    // "Live" is a session that is open and a grant that is in force.
    const said = (el: HTMLElement) => {
      fireEvent.focus(el);
      const text = screen.getByRole('tooltip').textContent;
      fireEvent.blur(el);
      return text;
    };
    const session = said(mark(render(<OpsStatus vocab="presence" word="live" />).container));
    const grant = said(mark(render(<OpsStatus vocab="grant" word="live" />).container));
    expect(WORD_ROWS.presence.live.label).toBe(WORD_ROWS.grant.live.label);
    expect(session).toContain(WORD_ROWS.presence.live.meaning);
    expect(grant).toContain(WORD_ROWS.grant.live.meaning);
    expect(session).not.toBe(grant);
  });

  it("a caller's own sentence joins the tooltip instead of a native title", () => {
    const { container } = render(
      <OpsStatus vocab="verification" word="red" title="Its own red, charged by its newest verdict" />,
    );
    const el = mark(container);
    expect(el.getAttribute('title')).toBeNull();
    fireEvent.focus(el);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('Its own red, charged by its newest verdict');
    expect(tip.textContent).toContain(WORD_ROWS.verification.red.meaning);
  });

  it('inside a link or a button it is no second tab stop, and a tap stays the control’s', () => {
    const { container } = render(
      <a href="#/runs">
        <RunStatus run={{ status: 'running' }} />
      </a>,
    );
    const el = mark(container);
    expect(el.hasAttribute('tabindex')).toBe(false);
    fireEvent.pointerDown(el, { pointerType: 'touch' });
    fireEvent.click(el);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a summons says it needs you', () => {
    const el = mark(
      render(<RunStatus run={{ id: 'r', slug: 's', status: 'waiting', waitReason: 'person' }} />).container,
    );
    fireEvent.focus(el);
    expect(screen.getByRole('tooltip').textContent).toMatch(/this needs you/);
    fireEvent.blur(el);
  });

  it('stays accessible while open', async () => {
    const { container } = render(
      <div>
        <PhaseStatus record={{ status: 'parked' }} />
      </div>,
    );
    fireEvent.focus(mark(container));
    await expectNoAxeViolations(document.body);
  });
});
