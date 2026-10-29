/**
 * The permission policy — the shipped lists, the operator's adds and strikes,
 * and the one edit verb. The shapes are the wire's (`shared/wire/policy.js`).
 */

import { request, post, q } from '../http';
import type { PolicyAdvisoryKind } from '@shared/ops-vocab.js';
import type { PolicyAdvisoryAck, PolicyEdit, PolicyEditBody, PolicyView } from '@shared/wire/policy.js';

export type {
  PolicyAdvisory,
  PolicyAdvisoryAck,
  PolicyEdit,
  PolicyEditBody,
  PolicyExtras,
  PolicyLists,
  PolicyView,
  RuleSupport,
} from '@shared/wire/policy.js';

/** The policy fetchers — merged into `api` by `./index`. */
export const policyApi = {
  policy: (slug?: string) => request<PolicyView>(`/api/policy${slug ? `?slug=${q(slug)}` : ''}`),
  addPolicy: (rules: unknown) => post<PolicyView>('/api/policy', rules),
  /** The operator has read a standing advisory — recorded against its rules. */
  acknowledgePolicyAdvisory: (kind: PolicyAdvisoryKind) =>
    post<PolicyAdvisoryAck>('/api/policy/advisory/acknowledge', { kind }),
  editPolicy: ({ autoApprove, ...edit }: PolicyEdit) =>
    post<PolicyView>('/api/policy', {
      ...edit,
      // The scalar rides `set` on the wire; a request without it sends no `set`
      // at all, so a rule edit can never accidentally clear the stored value.
      ...(autoApprove !== undefined ? { set: { autoApprove } } : {}),
    } satisfies PolicyEditBody),
};
