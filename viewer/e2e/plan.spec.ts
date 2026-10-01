import { expect, test, type Page } from '@playwright/test';

import { coverage, scrollMainWithin, touch } from './lib/grid.ts';
import { releaseRoutesAfterEach } from './lib/routes.ts';
import { TOUR_PLAN, shoot } from './lib/shots.ts';

releaseRoutesAfterEach();

/*
 * The plan page at the size #26 measured (control-tower phase 23): 72 phases.
 *
 * The plan #26 measured has 72 phases, and its plan page drew every one of
 * them in four tabs, each row in the DOM twice over. The page has
 * one phase table now, and its promise is the issue's own: 72 phases render and
 * filter without a visible cost. jsdom lays nothing out, so that is held here —
 * the table draws a WINDOW of rows, never the plan, from its first paint to the
 * last keystroke of a filter, and the window covers what `<main>` shows.
 *
 * The 72 phases are the fixture's own `tower` plan, served nine times over,
 * rather than a plan seeded that size: `tower` is where the tour stops, and
 * the tour's ratchet is not this spec's to move. Every wave keeps its states,
 * so the table groups, folds and filters them the way it does a real plan.
 */

const PHASES = 72;

/**
 * Past this many rows the phase table draws a window (`PHASE_VIRTUAL_FROM`,
 * `client/src/features/runs/phase-table.tsx`): the most phase rows the DOM may
 * hold at any moment. A table that drew the whole plan — even for one frame,
 * even before its engine had loaded — would hold 72.
 */
const WINDOW_FROM = 40;

type Phase = {
  phase: number;
  title: string;
  state: string;
  blockedBy?: { phase: number; why: string }[];
  qaHeld?: number[];
  reviewHold?: number[];
  row?: { phase: number; dependsOn: number[] };
  analysis?: { phase: number; dependsOn: number[]; dependents: number[]; transitiveDependents: number[] };
};
type Detail = {
  summary: { phases: number };
  phases: Phase[];
  eta?: { perPhase: { phase: number }[] };
};

/** What a wave beyond the first leaves behind: one live lane, one claim, the handoffs the fixture wrote. */
const FIRST_WAVE_ONLY = new Set(['live', 'lock', 'handoff']);

/** The plan's phases served `count / phases` times over, each wave numbered after the last. */
function widen(detail: Detail, count: number): Detail {
  const seed = detail.phases;
  const width = seed.length;
  const phases = Array.from({ length: count }, (_, i): Phase => {
    const base = seed[i % width]!;
    const wave = Math.floor(i / width);
    if (wave === 0) return base;
    const at = (n: number): number => n + wave * width;
    const kept = Object.fromEntries(Object.entries(base).filter(([key]) => !FIRST_WAVE_ONLY.has(key)));
    return {
      ...(kept as Phase),
      phase: at(base.phase),
      title: `${base.title} (${wave + 1})`,
      ...(base.blockedBy ? { blockedBy: base.blockedBy.map((b) => ({ ...b, phase: at(b.phase) })) } : {}),
      ...(base.qaHeld ? { qaHeld: base.qaHeld.map(at) } : {}),
      ...(base.reviewHold ? { reviewHold: base.reviewHold.map(at) } : {}),
      ...(base.row
        ? { row: { ...base.row, phase: at(base.row.phase), dependsOn: base.row.dependsOn.map(at) } }
        : {}),
      ...(base.analysis
        ? {
            analysis: {
              ...base.analysis,
              phase: at(base.analysis.phase),
              dependsOn: base.analysis.dependsOn.map(at),
              dependents: base.analysis.dependents.map(at),
              transitiveDependents: base.analysis.transitiveDependents.map(at),
            },
          }
        : {}),
    };
  });
  const eta = detail.eta;
  return {
    ...detail,
    summary: { ...detail.summary, phases: count },
    phases,
    ...(eta
      ? {
          eta: {
            ...eta,
            perPhase: phases.flatMap((p) => {
              const e = eta.perPhase.find((x) => x.phase === ((p.phase - 1) % width) + 1);
              return e ? [{ ...e, phase: p.phase }] : [];
            }),
          },
        }
      : {}),
  };
}

/**
 * Serve the plan's detail widened to `count` phases — every read of it, the
 * refetches a stream event asks for included — and hand back what was served.
 */
async function servePlan(page: Page, count: number): Promise<() => Detail | null> {
  let served: Detail | null = null;
  await page.route(new RegExp(`/api/plans/${TOUR_PLAN}(?:\\?[^/]*)?$`), async (route) => {
    const response = await route.fetch();
    served = widen((await response.json()) as Detail, count);
    await route.fulfill({ response, json: served });
  });
  return () => served;
}

/**
 * The phase table's rows, one per phase drawn. A group heading, an open row's
 * detail and the line a loading table writes under its rows are each one cell
 * wide, and the window's spacers are `aria-hidden`: none of them is a phase.
 */
const ROWS = 'table[aria-label="Phases"] tbody:not([aria-hidden="true"]) > tr:has(> td + td)';

/**
 * Record, from before the page's first script, the most phase rows the DOM
 * ever holds. A mutation observer's callback runs after each commit and before
 * the frame is painted, so no drawn frame escapes it.
 */
async function recordRows(page: Page): Promise<void> {
  await page.addInitScript((rows) => {
    const seen = window as unknown as { rowsHigh: number };
    seen.rowsHigh = 0;
    new MutationObserver(() => {
      seen.rowsHigh = Math.max(seen.rowsHigh, document.querySelectorAll(rows).length);
    }).observe(document, { childList: true, subtree: true });
  }, ROWS);
}

const rowsHigh = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { rowsHigh: number }).rowsHigh);

/**
 * Bring the table's last row to the scroller's foot, and hold it there until it
 * stays. The page goes on below the table (the plan's health, its cards), so
 * the scroller's own bottom is past the table; and a row measured as it lands
 * changes the height above it. Clicking a heading the click itself had to
 * scroll to raced those measurements — three runs in ten, at load 19.
 */
async function toTableFoot(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const table = document.querySelector('table[aria-label="Phases"]');
        const main = document.querySelector('main');
        if (!table || !main) return 'no table';
        const gap = table.getBoundingClientRect().bottom - main.getBoundingClientRect().bottom;
        if (Math.abs(gap) <= 1) return 'at the foot';
        main.scrollTop += gap;
        return `moved ${Math.round(gap)}px`;
      }),
    )
    .toBe('at the foot');
}

test.describe('the plan page at 72 phases', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(touch(info.project.name), 'the desk table; a touch viewport is the card list');
    await recordRows(page);
  });

  test('72 phases draw a window of rows from the first paint, and it covers what <main> shows', async ({
    page,
  }, info) => {
    const served = await servePlan(page, PHASES);
    await page.goto(`/#/plan/${TOUR_PLAN}/phases`);
    const table = page.getByRole('table', { name: 'Phases', exact: true });

    // The reading a plan opens in: grouped by need, Done folded. The window is
    // on once the engine has landed, and the table says how many rows it has
    // while holding only some of them.
    await expect(table).toHaveAttribute('aria-rowcount', /^\d+$/);
    const grouped = Number(await table.getAttribute('aria-rowcount')) - 1;
    expect(grouped).toBeGreaterThan(WINDOW_FROM);
    expect(await table.locator('tbody tr[aria-rowindex]').count()).toBeLessThan(grouped);

    // Done is the last group, so its heading is past the window until the
    // table's foot is in view. It unfolds by that heading: every finished
    // phase joins the count, and the window stays a window.
    // Counted from the folded table just before the unfold: the live run lands
    // when it lands, and the phase it is running moves into a group of its own
    // — one heading more than the first paint had.
    const finished = served()!.phases.filter((p) => p.state === 'done').length;
    const done = page.getByRole('button', { name: /Need:\s*Done/ });
    await toTableFoot(page);
    await expect(done).toHaveAttribute('aria-expanded', 'false');
    const folded = Number(await table.getAttribute('aria-rowcount'));
    await done.click();
    await expect(table).toHaveAttribute('aria-rowcount', String(folded + finished));

    // Plan order, chosen the way a person chooses it: one row per phase, no
    // headings — so the count is the plan's, exactly.
    await page.getByRole('button', { name: /^View/ }).click();
    const sheet = page.getByRole('dialog', { name: 'View' });
    await sheet.getByRole('radio', { name: 'Plan order' }).check();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(table).toHaveAttribute('aria-rowcount', String(PHASES + 1));
    expect(await table.locator('tbody tr[aria-rowindex]').count()).toBeLessThan(WINDOW_FROM);

    // Every number drawn reads on one line, inside its cell, beside the row's
    // toggle and its `+N`: at 64 px a two-digit phase was a digit over a digit.
    const numbers = await page.evaluate(() => {
      const cells = [
        ...document.querySelectorAll('table[aria-label="Phases"] tbody tr[aria-rowindex] > td:first-child'),
      ];
      return {
        drawn: cells.length,
        split: cells.filter((td) => (td.querySelector('.tabular-nums')?.getClientRects().length ?? 0) > 1)
          .length,
        escaped: cells.filter((td) => td.scrollWidth > td.clientWidth + 1).length,
      };
    });
    expect(numbers.drawn).toBeGreaterThan(0);
    expect(numbers).toMatchObject({ split: 0, escaped: 0 });

    // Halfway down the table, in the shell's one scroller: the window moved
    // with it, the header rode down, and the rows fill what the scroller shows.
    await scrollMainWithin(page, 'table[aria-label="Phases"]', 0.5);
    await expect
      .poll(async () =>
        Number(await table.locator('tbody tr[aria-rowindex]').first().getAttribute('aria-rowindex')),
      )
      .toBeGreaterThan(10);
    const edges = await page.evaluate(() => ({
      head: document.querySelector('table[aria-label="Phases"] thead th')?.getBoundingClientRect().top ?? NaN,
      main: document.querySelector('main')?.getBoundingClientRect().top ?? NaN,
    }));
    expect(Math.abs(edges.head - edges.main)).toBeLessThanOrEqual(2);
    await expect.poll(() => coverage(page, 'table[aria-label="Phases"]')).toBe('covered');
    expect(await table.locator('tbody tr[aria-rowindex]').count()).toBeLessThan(WINDOW_FROM);

    // And at no moment — the first paint before the grid's engine had loaded
    // included — did the DOM hold more than a window of the plan.
    expect(await rowsHigh(page)).toBeLessThanOrEqual(WINDOW_FROM);
    // For the building session to READ, never to diff (`lib/shots.ts`).
    await shoot(page, info.project.name, 'plan-72-phases');
  });

  test('typing a filter narrows 72 phases to the nine that match, one window at a time', async ({ page }) => {
    await servePlan(page, PHASES);
    await page.goto(`/#/plan/${TOUR_PLAN}/phases`);
    const table = page.getByRole('table', { name: 'Phases', exact: true });
    await expect(table).toHaveAttribute('aria-rowcount', /^\d+$/);

    // Keystroke by keystroke, as a person types: every one of them re-filters
    // the plan, and none may cost the plan's worth of rows.
    const filter = page.getByRole('searchbox', { name: 'Filter phases by phase' });
    await filter.pressSequentially('radar');
    const waves = PHASES / 8;
    await expect(page.getByText(`${waves} of ${PHASES} shown`)).toBeVisible();
    await expect(table.getByText(/^Ground movement radar/)).toHaveCount(waves);
    // Nine rows are drawn whole — a window over them would be a window of everything.
    await expect(table).not.toHaveAttribute('aria-rowcount');

    // Cleared, the plan is back, and back behind its window.
    await filter.clear();
    await expect(table).toHaveAttribute('aria-rowcount', /^\d+$/);
    await expect(page.getByText(`${waves} of ${PHASES} shown`)).toHaveCount(0);
    expect(await rowsHigh(page)).toBeLessThanOrEqual(WINDOW_FROM);
  });
});
