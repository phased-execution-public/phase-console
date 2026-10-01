/**
 * The run page's folds (control-tower phase 24) — "minimal by default, rich
 * info if wanted", in the operator's words.
 *
 * The page opens on a glance: the strip, the halt card when the run is
 * stopped, the asks, the verbs and the four figures. Everything else — the
 * phases, the sessions and their consoles, where the time went, why it started
 * and what it cost, the notes, the messages, the checkout and its landing, the
 * journal, the earlier runs and the raw record — is one press away, folded
 * under a row that NAMES what opening it shows and, while folded, how much is
 * in it (`docs/design.md` §1, L1). Each fold is remembered per person
 * (`prefs.runSectionsOpen`): a section somebody opened is a section they read.
 *
 * One departure from `Disclosure`: a section may be `keepMounted`. The session
 * panes hold the live stream in component state and a pane that unmounts loses
 * lines no replay refills (`lanes.tsx`), so that fold hides its body instead of
 * unmounting it. Every other fold unmounts — a fold is not a cache.
 */

import { ChevronRight } from 'lucide-react';
import { useCallback, useId, type ReactNode } from 'react';
import { usePrefs } from '@/lib/prefs';
import { cn } from '@/lib/cn';

/** Every fold the run page draws, in page order — the ids `prefs.runSectionsOpen` stores. */
export const RUN_SECTIONS = Object.freeze([
  'phases',
  'sessions',
  'time',
  'ledger',
  'notes',
  'messages',
  'git',
  'landing',
  'journal',
  'history',
  'raw',
] as const);

export type RunSectionId = (typeof RUN_SECTIONS)[number];

/** Is this fold open for this person, and the setter that remembers it. */
export function useRunSection(id: RunSectionId): [boolean, (next: boolean) => void] {
  const [prefs, setPrefs] = usePrefs();
  const open = prefs.runSectionsOpen.includes(id);
  const setOpen = useCallback(
    (next: boolean) => {
      const others = prefs.runSectionsOpen.filter((section) => section !== id);
      setPrefs({ runSectionsOpen: next ? [...others, id] : others });
    },
    [id, prefs.runSectionsOpen, setPrefs],
  );
  return [open, setOpen];
}

export function RunSection({
  id,
  name,
  count,
  hint,
  forceOpen = false,
  keepMounted = false,
  children,
}: {
  id: RunSectionId;
  /** What opening it shows, named — sentence case, never "More". */
  name: string;
  /** How much is folded, drawn only while folded. `null` draws none. */
  count?: number | null;
  /** One line of what the count counts, for the row's title. */
  hint?: string;
  /** Open whatever the preference says — a link into the section (`?j=`) must land in it. */
  forceOpen?: boolean;
  /** Hide rather than unmount when folded (the live console's stream lives in its panes). */
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const [remembered, setOpen] = useRunSection(id);
  const open = remembered || forceOpen;
  const region = useId();
  return (
    <section data-section={id} data-open={open ? 'true' : 'false'} aria-label={name} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open || keepMounted ? region : undefined}
        onClick={() => setOpen(!open)}
        title={hint}
        data-testid="run-section-toggle"
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-sm py-1.5 text-left text-sm text-ink',
          'hover:text-action [@media(hover:none)]:min-h-(--tap-min)',
        )}
      >
        <ChevronRight
          size={14}
          aria-hidden
          className={cn(
            'shrink-0 text-ink-muted transition-transform duration-fast ease-transit',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 truncate font-medium">{name}</span>
        {count != null && !open && (
          <span className="tnum shrink-0 text-xs text-ink-muted" data-testid="run-section-count">
            ({count})
          </span>
        )}
      </button>
      {keepMounted ? (
        <div id={region} hidden={!open} className="pt-2">
          {children}
        </div>
      ) : (
        open && (
          <div className="expand-region">
            <div id={region} className="pt-2">
              {children}
            </div>
          </div>
        )
      )}
    </section>
  );
}
