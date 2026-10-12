/**
 * The light half of the halt family (control-tower phase 17; 7.0 in
 * quiet-console phase 5): the family mark, a cap's arithmetic and the
 * console's own crash-loop card.
 *
 * Its own module because the errand card and the inbox row draw the mark, and
 * the full card (`halt-card.tsx`) carries the recovery verbs, the plan reader
 * and its Markdown, which a row has no business loading.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { api, type Errand } from '@/data/api';
import { keys } from '@/data/keys';
import { press } from '@/data/press';
import { cn } from '@/lib/cn';
import { Banner, Button, toast } from '@/ui';

/** One glyph per family — the mark a person scans for before reading. */
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

/**
 * The family, as a quiet mark: its glyph and its word, in muted ink. Never a
 * hue — a family is a KIND of stop, not a state, and never amber: the family
 * is not the summons, the item is.
 */
export function HaltCategoryMark({ category, className }: { category: HaltCategory; className?: string }) {
  const Icon = CATEGORY_ICON[category];
  return (
    <span
      data-testid="halt-category"
      data-halt-category={category}
      className={cn('inline-flex items-center gap-1.5 text-meta font-medium text-ink-muted', className)}
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
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const release = async () => {
    setBusy(true);
    try {
      const pressed = await press(() => api.releaseBootHold());
      toast(
        pressed.state === 'asked'
          ? pressed.words
          : 'Released — this console re-adopts and converges its runs now.',
        pressed.state === 'asked' ? 'info' : 'ok',
      );
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy(false);
      for (const queryKey of [keys.state(), keys.shutdown()]) void client.invalidateQueries({ queryKey });
    }
  };
  return (
    <Banner severity="warn" data-testid="crash-loop">
      <div className="flex flex-col gap-2" data-testid="halt-card" data-halt-category="environment">
        <HaltCategoryMark category="environment" />
        <p data-testid="halt-sentence" className="text-section font-semibold text-ink">
          This console keeps ending hard, so it holds its automation.
        </p>
        <p className="max-w-prose text-meta text-ink-muted">{hold.why}</p>
        {allowRun ? (
          <Button
            variant="primary"
            className="self-start"
            data-testid="halt-recommended"
            disabled={busy}
            onClick={() => void release()}
          >
            {busy ? 'Releasing…' : 'Release it for this boot'}
          </Button>
        ) : (
          <p className="text-meta text-ink-muted">
            Releasing it starts work, which needs <code className="font-mono">--allow-run</code>.
          </p>
        )}
      </div>
    </Banner>
  );
}
