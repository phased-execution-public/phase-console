import { describeWord } from '@shared/status-model.js';
import { ViewBadge, type BadgeChrome, type WordOf } from './view-badge';

/**
 * An account — whether its login can start a session (`auth`), or where its
 * credential stands with the organisation that pays for it (`entitlement`).
 * The amber ones are the states only a person can mend.
 */
export type AccountBadgeProps = (
  | { auth: WordOf<'auth'> | null | undefined; entitlement?: never }
  | { entitlement: WordOf<'entitlement'> | null | undefined; auth?: never }
) &
  BadgeChrome;

export function AccountBadge({ auth, entitlement, ...chrome }: AccountBadgeProps) {
  const view =
    entitlement !== undefined ? describeWord('entitlement', entitlement) : describeWord('auth', auth);
  return <ViewBadge view={view} {...chrome} />;
}
