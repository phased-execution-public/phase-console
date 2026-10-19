import { describeWord } from '@shared/status-model.js';
import { DotWord } from './dot-word';
import type { Chrome, WordOf } from './view';

/**
 * An account — whether its login can start a session (`auth`), or where its
 * credential stands with the organisation that pays for it (`entitlement`).
 * The amber ones are the states only a person can mend.
 */
export type AccountStatusProps = (
  | { auth: WordOf<'auth'> | null | undefined; entitlement?: never }
  | { entitlement: WordOf<'entitlement'> | null | undefined; auth?: never }
) &
  Chrome;

export function AccountStatus({ auth, entitlement, ...chrome }: AccountStatusProps) {
  const view =
    entitlement !== undefined ? describeWord('entitlement', entitlement) : describeWord('auth', auth);
  return <DotWord view={view} {...chrome} />;
}

