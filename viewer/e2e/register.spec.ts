import { expect, test } from '@playwright/test';

import { compare, leaveFragment, readBaseline, tally, writing, type Tally } from './lib/baseline.ts';
import { axeFindings, focusFindings, layoutFindings, type Finding } from './lib/probes.ts';
import { STOPS, VIEWPORTS, fixture, settle, visit } from './lib/shots.ts';

// The register: every stop, in every viewport, measured — and held to
// `baseline.json` both ways. It supersedes the 688-row manual register of the
// commerce plan (docs/plans/phase-console-commerce-ui-register.md), which was
// true on the day it was written and on no day since.
//
// What runs where: overflow and escape everywhere; the three touch questions in
// the touch viewports (a desk has no thumb floor to keep); axe in both themes
// everywhere; the focus walk on the desks, where a keyboard is.

const baseline = readBaseline();

/** Two readings that agree, or the third — a transient is not a page's truth. */
const same = (a: Tally, b: Tally): boolean => JSON.stringify(a) === JSON.stringify(b);

for (const stop of STOPS) {
  test(`register: ${stop.name}`, async ({ page }, info) => {
    const viewport = VIEWPORTS.find((v) => v.name === info.project.name);
    if (!viewport) throw new Error(`no viewport named ${info.project.name}`);
    const fx = await fixture();
    await visit(page, stop, fx.anchor);

    // An overlay's stop measures the overlay; the page behind it has its own.
    const dialog = stop.overlay ? '[role="dialog"]' : undefined;
    const measure = async (): Promise<Tally> => {
      const found: Finding[] = [
        ...(await layoutFindings(page, { touch: viewport.touch })),
        ...(await axeFindings(page, 'light', dialog)),
        ...(await axeFindings(page, 'dark', dialog)),
        ...(viewport.touch ? [] : await focusFindings(page, 24, dialog)),
      ];
      await page.emulateMedia({ colorScheme: 'light' });
      return tally(found);
    };
    const again = async (): Promise<Tally> => {
      await page.waitForTimeout(1_500);
      await settle(page);
      return measure();
    };

    let now = await measure();
    if (writing()) {
      const second = await again();
      return leaveFragment(viewport.name, stop.name, same(now, second) ? second : await again());
    }
    const allowed = baseline.stops[viewport.name]?.[stop.name] ?? {};
    // A page still settling (a late push re-rendering one list) reads
    // differently for a moment. One more reading after a pause, and only a
    // difference that is still there fails — the same one retry `gates.sh`
    // gives its three timing-sensitive files.
    let diff = compare(allowed, now);
    if (diff.added.length + diff.fixed.length) {
      now = await again();
      diff = compare(allowed, now);
    }
    const { added, fixed } = diff;
    const why = [
      added.length ? `NEW — not in the baseline:\n    ${added.join('\n    ')}` : '',
      fixed.length
        ? `FIXED — still in the baseline, so bank it (npm run test:e2e:baseline) and commit the lower count:\n    ${fixed.join('\n    ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n  ');
    expect(added.length + fixed.length, `${viewport.name} ${stop.name}:\n  ${why}`).toBe(0);
  });
}
