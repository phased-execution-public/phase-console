/**
 * The light half of the halt family (control-tower phase 17): the family
 * mark, a cap's arithmetic and the console's own crash-loop card.
 *
 * Its own module because first-paint surfaces draw it — the Now page's inbox
 * rows, the errand card every recovery surface embeds — and the full card
 * (`halt-card.tsx`) carries the recovery buttons, the plan reader and its
 * Markdown, which first paint cannot afford (`check-dist`: 190 KB served).
 */

import {
  CircleStop,
  FileWarning,
  Gauge,
  GitMerge,
  Hand,
  Hourglass,
  KeyRound,
  ListChecks,
  Unplug,
  type LucideIcon,
} from 'lucide-react';

import { HALT_CATEGORY_LABELS, categoryOfSituation, type HaltCategory } from '@shared/halt-categories.js';
import { Banner, Button } from '@/components/ui';
import { api, type Errand } from '@/lib/api';
import { keys, useApiMutation } from '@/lib/queries';
import { cn } from '@/lib/cn';

/** One icon per family — the mark a person scans for before reading. */
const CATEGORY_ICON: Record<HaltCategory, LucideIcon> = {
  decision: Hand,
  credentials: KeyRound,
  limits: Gauge,
  environment: Unplug,
  plan: FileWarning,
  verification: ListChecks,
  external: Hourglass,
  conflict: GitMerge,
  operator: CircleStop,
};

/** The family, as a mark: an icon and its word. Never amber — the family is not a summons. */
export function HaltCategoryMark({ category, className }: { category: HaltCategory; className?: string }) {
  const Icon = CATEGORY_ICON[category];
  return (
    <span
      data-testid="halt-category"
      data-halt-category={category}
      className={cn('inline-flex items-center gap-1 text-2xs font-medium text-ink-muted', className)}
    >
      <Icon size={13} aria-hidden className="shrink-0" />
      {HALT_CATEGORY_LABELS[category]}
    </span>
  );
}

/** The family of a situation key (an errand's, an inbox row's subject), or nothing. */
export function SituationCategoryMark({
  situation,
  className,
}: {
  situation: string | undefined;
  className?: string;
}) {
  const category = categoryOfSituation(situation);
  return category ? <HaltCategoryMark category={category} {...(className ? { className } : {})} /> : null;
}

/** A cap errand's arithmetic (#14): spent of allowed, what is on done phases, and the setting that raises it. */
export function capArithmetic(errand: Pick<Errand, 'cap' | 'spent' | 'limit' | 'onDonePhases' | 'setting'>) {
  if (errand.spent == null || errand.limit == null) return null;
  const setting =
    typeof errand.setting === 'string' ? errand.setting : (errand.setting?.label ?? errand.setting?.key);
  return (
    `${errand.spent} of ${errand.limit} ${errand.cap?.includes('usd') ? 'dollars' : 'rungs'} spent` +
    (errand.onDonePhases ? ` — ${errand.onDonePhases} of them on phases already done` : '') +
    (setting ? `; raised by ${setting}` : '')
  );
}

/* ------------------------------------------------------------------ *
 * The console's own stop — the crash-loop hold (#20)
 * ------------------------------------------------------------------ */

type BootHoldLike = { kind: string; why: string; at?: string };

/**
 * A console that ended hard three times in ten minutes holds its automation
 * at boot, so a supervisor's restart cannot re-park the runs it was driving
 * (#20). Drawn through the same family as a run's stop: environment, one
 * sentence, and the one recovery — release the hold once the cause is known.
 */
export function CrashLoopCard({ hold, allowRun }: { hold: BootHoldLike; allowRun: boolean }) {
  const release = useApiMutation({
    fn: () => api.releaseBootHold(),
    say: 'Released — this console re-adopts and converges its runs now.',
    invalidates: [keys.state(), keys.shutdown()],
  });
  return (
    <Banner severity="warn" data-testid="crash-loop">
      <span className="flex flex-col gap-2" data-testid="halt-card" data-halt-category="environment">
        <HaltCategoryMark category="environment" />
        <span data-testid="halt-sentence" className="text-sm font-medium text-ink">
          This console keeps ending hard, so it holds its automation.
        </span>
        <span className="text-2xs text-ink-muted">{hold.why}</span>
        {allowRun ? (
          <Button
            size="sm"
            variant="action"
            className="self-start"
            data-testid="halt-recommended"
            disabled={release.isPending}
            onClick={() => release.mutate()}
          >
            Release it for this boot
          </Button>
        ) : (
          <span className="text-2xs text-ink-muted">
            Releasing it starts work, which needs <code>--allow-run</code>.
          </span>
        )}
      </span>
    </Banner>
  );
}
