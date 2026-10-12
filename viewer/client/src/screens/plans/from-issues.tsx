/**
 * Plan from issues (7.0, quiet-console phase 9; control-tower phases 118 and
 * 120) — the other way a plan begins: from the issues it fixes.
 *
 * In both editions the way in is the Issues desk, opened on the issues no plan
 * has taken yet — a set of them becomes a plan there, through the same
 * plan-writing session the wizard opens. In Pro the library also follows what
 * the desk set going: every plan the author pipeline is writing from issues
 * (the supervisor's `plan-issues`, *Solve with autopilot*) is listed there
 * while it is written, checked and installed, and a settled one links to the
 * plan it became — the desk's own list (`screens/repo/pro/author-jobs.tsx`),
 * drawn on the page the plan arrives on.
 */

import { ISSUE_PLAN_STATES } from '@shared/issues-model.js';
import { repoHref } from '@/shell/routes';

/** The Issues desk, on the issues waiting for a plan — where a set of them becomes one. */
export const fromIssuesHref = (): string => repoHref('issues', { plan: ISSUE_PLAN_STATES[0] });
