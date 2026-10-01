/**
 * One tile of the quick view (control-tower phase 22).
 *
 * A tile is a category at a glance: its icon, what it is set to (a few
 * badges), where those values mostly came from (the dominant provenance
 * word), how many were changed in this dialog, and one verb. On a desk the
 * verb expands the tile IN PLACE onto the category's existing controls
 * (`CategorySection` — every control still written once), one tile at a
 * time; on a phone the tile is a row that pushes the controls as a sub-view
 * inside the same scroller. A tile holding a blocking decision is the
 * summons: amber, and its verb is Answer.
 */

import {
  ChevronRight,
  Crosshair,
  Cpu,
  GitBranch,
  MessageCircleQuestion,
  ScanSearch,
  ShieldCheck,
  UserRound,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { Category, CategoryId } from './categories';
import { Provenance, type Source } from './fields';

export const CATEGORY_ICONS: Readonly<Record<CategoryId, LucideIcon>> = Object.freeze({
  scope: Crosshair,
  engine: Cpu,
  safety: ShieldCheck,
  git: GitBranch,
  money: Wallet,
  review: ScanSearch,
  tools: Wrench,
  accounts: UserRound,
  decisions: MessageCircleQuestion,
});

export interface TileProps {
  category: Category;
  badges: readonly string[];
  source?: Source;
  changed: number;
  /** A blocking decision lives here: the tile is the summons. */
  summons?: boolean;
  open: boolean;
  onToggle: () => void;
  /** The phone's row, which pushes a sub-view rather than expanding. */
  phone?: boolean;
  /** The category's controls — rendered only while open. */
  children?: ReactNode;
}

export function tilePanelId(id: CategoryId): string {
  return `launch-tile-${id}`;
}

function Glance({ badges, summons, label }: { badges: readonly string[]; summons?: boolean; label: string }) {
  if (!badges.length) return null;
  return (
    <ul className="flex min-w-0 flex-wrap gap-1" aria-label={`${label} now`}>
      {badges.map((text, i) => (
        <li key={text} className="min-w-0">
          <Badge tone={summons && i === 0 ? 'accent' : 'neutral'} className="max-w-full truncate">
            {text}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function Tally({ source, changed }: { source?: Source; changed: number }) {
  if (!source && !changed) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-2xs text-ink-muted">
      <Provenance source={source} />
      {changed > 0 && (
        <span className="text-ink" data-changed={changed}>
          changed {changed}
        </span>
      )}
    </p>
  );
}

export function CategoryTile({
  category,
  badges,
  source,
  changed,
  summons = false,
  open,
  onToggle,
  phone = false,
  children,
}: TileProps) {
  const Icon = CATEGORY_ICONS[category.id];
  const verb = summons ? 'Answer' : 'Edit';

  if (phone) {
    // The whole row is the verb: a list of settings on a phone is a list of
    // doors, and a small button at the end of each is a worse target than
    // the row it sits in.
    return (
      <li data-category={category.id} data-summons={summons || undefined}>
        <button
          type="button"
          aria-label={`${verb} ${category.label}`}
          onClick={onToggle}
          className={cn(
            'tap-row flex w-full min-w-0 items-start gap-3 border-b border-rule py-2.5 text-left',
            summons && 'border-l-2 border-l-accent pl-2',
          )}
        >
          <Icon
            size={16}
            aria-hidden
            className={cn('mt-0.5 shrink-0', summons ? 'text-accent' : 'text-ink-muted')}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-sm leading-tight font-medium text-ink">{category.label}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Glance badges={badges} summons={summons} label={category.label} />
              <Tally source={source} changed={changed} />
            </span>
          </span>
          <ChevronRight size={16} aria-hidden className="mt-0.5 shrink-0 text-ink-muted" />
        </button>
      </li>
    );
  }

  const panelId = tilePanelId(category.id);
  return (
    <>
      <li
        data-category={category.id}
        data-open={open || undefined}
        data-summons={summons || undefined}
        className={cn(
          'flex min-w-0 flex-col gap-1.5 rounded-md border bg-surface p-3',
          open ? 'border-ink/50' : summons ? 'border-accent/60' : 'border-rule',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            size={15}
            aria-hidden
            className={cn('shrink-0', summons ? 'text-accent' : 'text-ink-muted')}
          />
          <h3 className="min-w-0 flex-1 text-sm leading-tight font-medium text-ink">{category.label}</h3>
          <Button
            size="sm"
            variant="ghost"
            className="-my-1 -mr-1.5 shrink-0"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-label={`${open ? 'Done' : verb} ${category.label}`}
            onClick={onToggle}
          >
            {open ? 'Done' : verb}
          </Button>
        </div>
        <Glance badges={badges} summons={summons} label={category.label} />
        <Tally source={source} changed={changed} />
      </li>
      {open && (
        // The panel is its own grid row, straight under the row its tile is
        // in — the list packs dense, so the tiles after it close up around
        // the tile rather than leaving it a hole. The expand is the tokens'
        // own motion: rows 0fr → 1fr as it mounts (`starting:`), none when
        // motion is reduced.
        <li className="col-span-full min-w-0">
          <div
            id={panelId}
            role="region"
            aria-label={category.label}
            className="grid grid-rows-[1fr] rounded-md border border-ink/50 bg-surface transition-[grid-template-rows] duration-medium ease-transit starting:grid-rows-[0fr] motion-reduce:transition-none"
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex min-w-0 flex-col gap-4 p-4">
                <p className="max-w-prose text-xs text-ink-muted">{category.blurb}</p>
                {children}
              </div>
            </div>
          </div>
        </li>
      )}
    </>
  );
}
