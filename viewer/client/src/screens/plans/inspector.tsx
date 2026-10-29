/**
 * A plan in the panel — Inspect, the second door to depth (7.0, quiet-console
 * phase 9; design.md principle 3), and the drawer its status opens.
 *
 * The row hands the shell ONE record: its name and mark, its Overview — the
 * reasons behind the status word first, then its phases as a pipeline in
 * their own order, then every fact the summary carries (`why-panel.tsx`,
 * which reads the plan live) — the verbs the registry knows for a plan and,
 * once it has one, for its run (Actions), and the summary as the server sent
 * it (Raw). The shell draws it where the width calls for — the column at 1200
 * and up, a sheet below.
 */

import type { ConsoleState } from '@/data/api';
import { plural } from '@/lib/format';
import { ActionsTab } from '@/shell/panel/actions-tab';
import { inspect } from '@/shell/panel/inspector-host';
import { kindWord, type PlanRow } from './model';
import { PlanOverview, PlanPanelMeta } from './why-panel';

/** The key a plan's record wears in the panel — what a row asks to know it is the one on show. */
export const planRecordKey = (slug: string): string => `plan:${slug}`;

/** Show the plan in the panel. */
export function inspectPlan(row: PlanRow, state: ConsoleState | undefined): void {
  inspect({
    key: planRecordKey(row.slug),
    title: row.title,
    description: row.isPlan ? `${plural(row.phases, 'phase')}, ${row.done} done.` : kindWord(row),
    meta: <PlanPanelMeta slug={row.slug} held={row} />,
    overview: <PlanOverview slug={row.slug} held={row} />,
    actions: (
      <ActionsTab
        kind={row.run ? ['plan', 'run'] : 'plan'}
        args={{ slug: row.slug, runId: row.run?.id }}
        capabilities={state as Parameters<typeof ActionsTab>[0]['capabilities']}
      />
    ),
    raw: JSON.stringify(row.summary ?? row, null, 2),
  });
}
