/**
 * Settings ▸ Permissions — every grant and what it changed, the owner keys,
 * and what a session may run unasked (7.0's since quiet-console phase 23; the
 * basename is kept, so the section stays a chunk of its own, `permissions-*`,
 * held by `check-dist`).
 *
 * ```
 * Grants                          every grant a person gave, what it changed, revoke
 * Owner keys                      the passkeys that tell the owner's press from any other door's
 * What a session may run unasked  the deny wall, the ask list, the allow list, and a rule builder
 * ```
 *
 * In the order a person arrives with: "what did I let it do" first, because a
 * grant is the newest and the most specific change to what a session may do;
 * then who may press; then the standing rules every run starts from.
 */

import { useConsoleState } from '@/data/console';
import { GrantsGroup } from './grants';
import { OwnerKeysGroup } from './owner-keys';
import { RulesGroup } from './rules';

export function PermissionSettingsSection() {
  const { data: state } = useConsoleState();
  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="permissions-settings">
      <GrantsGroup />
      <OwnerKeysGroup />
      <RulesGroup allowWrites={state?.allowWrites === true} />
    </div>
  );
}
