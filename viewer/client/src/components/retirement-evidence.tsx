/**
 * What a retirement stood on, and whether a later read contradicted it
 * (control-tower phase 54, #57; drawn on the free views by phase 25).
 *
 * A credential is retired only on a verdict from an API channel, and the
 * breaker keeps the evidence: the channel, the words that matched, and whose
 * stop it was. A green probe or usage read after the stamp demotes the
 * retirement to `suspect` and records `contradicted`. Both used to be drawn on
 * one Pro page only, so a free console showed a retired account with no way to
 * tell a real refusal from a quoted fixture. One module, so the account views
 * and Debug ▸ Health cannot word it two ways.
 */

import { RelativeTime } from '@/components/ui';
import type { EntitlementView } from '@/lib/api';

/**
 * The evidence as one line — `null` when the breaker kept none (an operator's
 * retirement, a write from before evidence was kept) or the account is not
 * retired or suspect.
 */
export function evidenceLine(entitlement: EntitlementView): string | null {
  const evidence = entitlement.evidence;
  if (!evidence || (entitlement.state !== 'retired' && entitlement.state !== 'suspect')) return null;
  const parts = [
    evidence.source === 'api' ? 'from the API' : 'from a session that spent nothing',
    `“${evidence.matched}”`,
    evidence.session ? `session ${evidence.session.slice(0, 8)}` : null,
    evidence.phase != null ? `phase ${evidence.phase}${evidence.slug ? ` of ${evidence.slug}` : ''}` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Does this account carry anything this module draws? */
export function hasRetirementStory(entitlement: EntitlementView | undefined): boolean {
  return Boolean(
    entitlement &&
    (evidenceLine(entitlement) || (entitlement.state === 'suspect' && entitlement.contradicted)),
  );
}

/** The evidence line and the contradiction, each on its own line; nothing when there is neither. */
export function RetirementEvidence({ entitlement }: { entitlement: EntitlementView | undefined }) {
  if (!entitlement || !hasRetirementStory(entitlement)) return null;
  const line = evidenceLine(entitlement);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {line ? (
        <span className="text-2xs break-words text-ink-muted" data-testid="retirement-evidence">
          {entitlement.state === 'retired' ? 'Retired on ' : 'Was retired on '}
          {line}
        </span>
      ) : null}
      {entitlement.state === 'suspect' && entitlement.contradicted ? (
        <span className="text-2xs break-words text-ink-muted" data-testid="retirement-contradicted">
          contradicted <RelativeTime at={entitlement.contradicted.at} live={false} /> by{' '}
          {entitlement.contradicted.by} — {entitlement.contradicted.reason}
        </span>
      ) : null}
    </span>
  );
}
