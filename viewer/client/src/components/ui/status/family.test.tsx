/**
 * The typed badge family (control-tower phase 16). What these tests hold:
 *
 *  - each wrapper REJECTS a foreign vocabulary at the type level — the
 *    `@ts-expect-error` lines below are proved by `typecheck:client`, which
 *    fails on a directive that no longer suppresses anything;
 *  - every member ALWAYS renders an icon, a word and `data-status` /
 *    `data-paint` / `data-attention` — colour is never the only carrier;
 *  - a word outside every vocabulary renders the first-class Unknown: its own
 *    icon, never Waiting's hourglass, never amber;
 *  - the icon map is total against the model's `STATUS_ICON_NAMES`.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
import { STATE_META } from '@/lib/status-vocab';
import { expectNoAxeViolations } from '@/test/axe';
import {
  AccountBadge,
  AttentionMark,
  FactBadge,
  McpBadge,
  NOTE_ICONS,
  OpsBadge,
  PhaseStatusBadge,
  PlanStatusBadge,
  QaBadge,
  RunStatusBadge,
  STATUS_ICONS,
  statusIcon,
  type OpsVocab,
  type WordOf,
} from './index';

/** The badge element a render produced, and the three attributes every member carries. */
function badge(container: HTMLElement) {
  const el = container.querySelector<HTMLElement>('[data-status]');
  expect(el, 'the badge carries data-status').not.toBeNull();
  return el!;
}
function expectComplete(el: HTMLElement) {
  expect(el.getAttribute('data-status')).not.toBeNull();
  expect(el.getAttribute('data-paint')).toMatch(
    /^(needs-you|failed|running|verifying|waiting|queued|skipped|done)$/,
  );
  expect(el.getAttribute('data-attention')).toMatch(/^(none|fyi|needs-you|urgent)$/);
  expect(el.querySelector('svg'), 'an icon is always drawn').not.toBeNull();
  expect(el.textContent?.trim().length ?? 0, 'a word is always written').toBeGreaterThan(0);
  expect(el.className).toContain(`state-${el.getAttribute('data-paint')}`);
}

describe('the icon map', () => {
  it('resolves every icon name the model can hand a badge', () => {
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

describe('every member renders icon, word and the three data-* attributes', () => {
  it('RunStatusBadge', () => {
    const { container } = render(<RunStatusBadge run={{ id: 'r', slug: 's', status: 'halted' }} />);
    expectComplete(badge(container));
  });
  it('PhaseStatusBadge', () => {
    const { container } = render(<PhaseStatusBadge record={{ status: 'failed' }} board="stuck" />);
    expectComplete(badge(container));
  });
  it('PlanStatusBadge', () => {
    const { container } = render(<PlanStatusBadge status="active" />);
    expectComplete(badge(container));
  });
  it('QaBadge, a verdict and a regime', () => {
    expectComplete(badge(render(<QaBadge result="fail" />).container));
    expectComplete(badge(render(<QaBadge mode="waived" />).container));
  });
  it('AccountBadge, a login and an entitlement', () => {
    expectComplete(badge(render(<AccountBadge auth="signed-out" />).container));
    expectComplete(badge(render(<AccountBadge entitlement="cooling" />).container));
  });
  it('McpBadge', () => {
    expectComplete(badge(render(<McpBadge status="needs-auth" />).container));
  });
  it('OpsBadge draws Your turn’s four vocabularies — step, verdict, risk, grant (control-tower phase 130)', () => {
    for (const vocab of ['step', 'verdict', 'risk', 'grant'] as const) {
      expect(STATUS_VOCABS).toContain(vocab);
    }
    const { container, unmount } = render(<OpsBadge vocab="step" word="returned" />);
    const el = badge(container);
    expectComplete(el);
    expect(el.textContent).toContain('Sent back');
    unmount();
  });
  it('OpsBadge, every ops vocabulary and every one of its words', () => {
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
    ]);
    const ops = STATUS_VOCABS.filter((v) => !own.has(v)) as OpsVocab[];
    expect(ops.length).toBeGreaterThan(10);
    for (const vocab of ops) {
      for (const word of Object.keys(WORD_ROWS[vocab])) {
        const { container, unmount } = render(<OpsBadge vocab={vocab} word={word as WordOf<typeof vocab>} />);
        const el = badge(container);
        expectComplete(el);
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
        const el = badge(container);
        expectComplete(el);
        expect(el.getAttribute('data-attention')).toBe(level);
      }
      unmount();
    }
  });
  it('FactBadge, every fact kind', () => {
    for (const kind of FACT_KINDS) {
      const { container, unmount } = render(<FactBadge fact={{ kind, text: `a ${kind}` }} />);
      const el = badge(container);
      expectComplete(el);
      expect(el.getAttribute('data-paint')).toBe(FACT_META[kind].paint);
      expect(el.getAttribute('data-attention')).toBe('none');
      unmount();
    }
  });
});

describe('a view carries its fact inside the badge, and the fact keeps its own paint', () => {
  it('a finished run holding a failure: the word, a rule, the red count', () => {
    const { container } = render(
      <RunStatusBadge
        run={{ id: 'r', slug: 's', status: 'finished', phases: { 1: { status: 'failed' } } }}
      />,
    );
    const el = badge(container);
    expect(el.getAttribute('data-paint')).toBe('skipped');
    const fact = el.querySelector('[data-fact="failed-count"]');
    expect(fact?.textContent).toBe('1 failed');
    expect(fact?.className).toContain('state-failed');
    expect(el.textContent).toBe('Finished, 1 failed');
    expect(el.textContent).not.toContain('·');
  });
});

describe('a word outside every vocabulary is the first-class Unknown', () => {
  const cases: [string, () => ReturnType<typeof render>][] = [
    [
      'a plan status that is a sentence',
      () => render(<PlanStatusBadge status={'✅ GO' as WordOf<'plan'>} />),
    ],
    ['a missing plan status', () => render(<PlanStatusBadge status={null} />)],
    [
      'a run status from another vocabulary',
      () => render(<RunStatusBadge run={{ status: 'complete' as WordOf<'run'> }} />),
    ],
    [
      'a phase record word nobody knows',
      () => render(<PhaseStatusBadge record={{ status: 'mystery' as WordOf<'phase'> }} />),
    ],
    ['a QA verdict nobody wrote', () => render(<QaBadge result={'maybe' as WordOf<'qa-result'>} />)],
    [
      'an ops word from the wrong list',
      () => render(<OpsBadge vocab="probe" word={'green' as WordOf<'probe'>} />),
    ],
  ];
  for (const [what, draw] of cases) {
    it(what, () => {
      const el = badge(draw().container);
      expect(el.textContent).toBe('Unknown');
      expect(el.getAttribute('data-paint')).not.toBe('waiting');
      expect(el.getAttribute('data-paint')).not.toBe('needs-you');
      expect(el.getAttribute('data-attention')).toBe('none');
      expect(el.querySelector('svg')?.getAttribute('class') ?? '').toContain(`lucide-${UNKNOWN_ICON}`);
      expect(STATE_META.waiting.icon).not.toBe(UNKNOWN_ICON);
      expect(el.getAttribute('title')).toMatch(/not a word this console knows|No status was given/);
    });
  }
});

describe('each wrapper rejects a foreign vocabulary at the type level', () => {
  it('holds the lines below to a type error each (typecheck:client proves the directives are used)', () => {
    const rejected = [
      // @ts-expect-error — `pass` is a QA verdict, not a run status
      <RunStatusBadge key="1" run={{ status: 'pass' }} />,
      // @ts-expect-error — `finished` is a run status, not a phase record word
      <PhaseStatusBadge key="2" record={{ status: 'finished' }} />,
      // @ts-expect-error — `failed` is a phase word, not a board word
      <PhaseStatusBadge key="3" board="failed" />,
      // @ts-expect-error — `done` is a board word, not a plan status
      <PlanStatusBadge key="4" status="done" />,
      // @ts-expect-error — `on` is a QA regime, not a verdict
      <QaBadge key="5" result="on" />,
      // @ts-expect-error — a verdict and a regime at once is two badges
      <QaBadge key="6" result="pass" mode="on" />,
      // @ts-expect-error — `retired` is an entitlement, not a login state
      <AccountBadge key="7" auth="retired" />,
      // @ts-expect-error — `ok` is a login state, not an MCP status
      <McpBadge key="8" status="ok" />,
      // @ts-expect-error — `running` is not a probe word
      <OpsBadge key="9" vocab="probe" word="running" />,
      // @ts-expect-error — a run has its own badge; it is not an ops vocabulary
      <OpsBadge key="10" vocab="run" word="running" />,
      // @ts-expect-error — `loud` is not an attention level
      <AttentionMark key="11" level="loud" />,
      // @ts-expect-error — a fact's kind is one of FACT_KINDS
      <FactBadge key="12" fact={{ kind: 'running', text: 'x' }} />,
    ];
    expect(rejected).toHaveLength(12);
  });
});

describe('the family is accessible', () => {
  it('has no axe violations across a row of every member', async () => {
    const { container } = render(
      <div>
        <RunStatusBadge run={{ id: 'r', slug: 's', status: 'waiting', waitReason: 'person' }} />
        <PhaseStatusBadge board="ready" />
        <PlanStatusBadge status="complete" />
        <QaBadge result="pending" />
        <AccountBadge auth="ok" />
        <McpBadge status="connected" />
        <OpsBadge vocab="health" word="warning" />
        <AttentionMark level="urgent" />
        <FactBadge fact={{ kind: 'dormant', text: 'dormant' }} />
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});
