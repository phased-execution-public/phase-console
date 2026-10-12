/**
 * The registrations this console removed, still remembered (7.0,
 * quiet-console phase 22: in the free tree too).
 *
 * ```
 * Removed, still remembered
 * old laptop   acct-3   removed 2 days ago   ● Retired   organisation 3f9a1c20
 * ```
 *
 * What the machine learned about a credential outlives its registration: the
 * learned store keeps a tombstone, so a journal line that names a removed id
 * still reads as a name, and a retired credential stays retired if it is
 * registered again.
 */

import type { TombstoneView } from '@/data/api';
import { Mono, RelativeTime } from '@/ui';
import { AccountStatus } from '@/ui/status';
import { SettingsGroup } from './setting';

export function TombstonesGroup({ rows }: { rows: readonly TombstoneView[] }) {
  if (!rows.length) return null;
  return (
    <SettingsGroup
      id="tombstones"
      title="Removed, still remembered"
      lead="A removed account stays named here, so a journal line that names it still reads, and what the machine learned about its login still holds."
    >
      <ul className="flex min-w-0 flex-col gap-2" data-testid="tombstones">
        {rows.map((row) => (
          <li
            key={`${row.id}:${row.credential}`}
            data-tombstone={row.id}
            className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <span className="min-w-0 break-words text-body text-ink">{row.name}</span>
            <Mono value={row.id} />
            <span className="text-meta text-ink-muted">
              removed <RelativeTime at={row.retiredAt} live={false} />
            </span>
            <AccountStatus entitlement={row.entitlement.state} />
            {row.orgId && <span className="text-meta text-ink-muted">organisation {row.orgId}</span>}
          </li>
        ))}
      </ul>
    </SettingsGroup>
  );
}
