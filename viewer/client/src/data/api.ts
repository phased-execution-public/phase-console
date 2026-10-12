/**
 * The barrel over the domain modules in `./api/` — what `@/data/api` resolves to.
 *
 * Every type and fetcher the one-file `lib/api.ts` used to export comes through
 * here under the same name, and `api` is the one object every view calls
 * (`api.plan(…)`, `api.runStart(…)`), merged from one `<domain>Api`
 * object per module. A key lives in exactly one domain: a spread lets the last
 * module win silently, so keep the domain objects disjoint.
 */

import { stateApi } from './api/state';
import { plansApi } from './api/plans';
import { runsApi } from './api/runs';
import { sessionsApi } from './api/sessions';
import { accountsApi } from './api/accounts';
import { mcpApi } from './api/mcp';
import { notificationsApi } from './api/notifications';
import { policyApi } from './api/policy';
import { systemApi } from './api/system';
import { inboxApi } from './api/inbox';
import { spendApi } from './api/spend';
import { webhooksApi } from './api/webhooks';
import { repoApi } from './api/repo';
import { issuesApi } from './api/issues';
import { debugApi } from './api/debug';

export * from './http';
export * from './api/state';
export * from './api/plans';
export * from './api/runs';
export * from './api/sessions';
export * from './api/accounts';
export * from './api/mcp';
export * from './api/notifications';
export * from './api/policy';
export * from './api/system';
export * from './api/inbox';
export * from './api/spend';
export * from './api/webhooks';
export * from './api/repo';
export * from './api/issues';
export * from './api/debug';
// Types only — the fetchers stay out of `api` (first paint), like the chat's:
// the card that presses them is lazy and imports `humanStepsApi` itself.
export type * from './human-steps';
// Your turn's one read (control-tower phase 132) — its page, phase 137, imports `turnApi` itself.
export type * from './turn';

export const api = {
  ...stateApi,
  ...plansApi,
  ...runsApi,
  ...sessionsApi,
  ...accountsApi,
  ...mcpApi,
  ...notificationsApi,
  ...policyApi,
  ...systemApi,
  ...inboxApi,
  ...spendApi,
  ...webhooksApi,
  ...repoApi,
  ...issuesApi,
  ...debugApi,
};
