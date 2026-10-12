import { lazy, Suspense, useState, type ReactElement } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ConsoleState } from '@/data/api';
import { RouteGlyph } from './brand';

/* The menu stands on the dropdown primitive and loads when first opened:
   first paint carries the button and the name, never a menu it is not showing. */
const SwitcherMenu = lazy(() => import('./switcher-menu'));

/**
 * The instance switcher (7.0): which console this is, and the way to every
 * other console of the machine — at the top of the rail, and at the start of
 * a phone's header. In Free the menu lists the machine's console registry
 * (`GET /api/instances`); in Pro it reads the fleet census, worst-first, and
 * opens Fleet. Below the consoles, the sources this console can open here —
 * the recents, and the directory picker — which was the 6.x switcher's whole
 * job.
 *
 * The trigger is a plain button until the first press: the dropdown primitive
 * then mounts around it and stays, so the chunk is fetched once.
 */
export function Switcher({
  state,
  variant,
}: {
  state: ConsoleState | undefined;
  variant: 'rail' | 'header';
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const name = state?.instance?.name ?? 'Phase Console';
  const project = state?.root?.label ?? 'no source open';

  const trigger: ReactElement = (
    <button
      type="button"
      aria-label={`This console: ${name}, on ${project}. Switch console or source.`}
      title={state?.root?.path ?? 'no source open'}
      onClick={() => {
        setLoaded(true);
        setOpen(true);
      }}
      className={cn(
        'rounded text-ink-muted transition-colors duration-fast ease-transit hover:bg-surface hover:text-ink',
        variant === 'rail'
          ? 'flex min-h-12 w-full flex-col items-center justify-center gap-1 px-1 py-1.5'
          : 'flex min-h-(--tap-min) min-w-0 shrink items-center gap-1 px-1',
      )}
    >
      <RouteGlyph size={variant === 'rail' ? 26 : 22} />
      <span
        className={cn(
          'min-w-0 truncate text-meta leading-none',
          variant === 'rail' ? 'max-w-full' : 'text-body text-ink',
        )}
      >
        {name}
      </span>
      <ChevronsUpDown size={12} className="shrink-0 text-ink-faint" aria-hidden />
    </button>
  );

  if (!loaded) return trigger;
  return (
    <Suspense fallback={trigger}>
      <SwitcherMenu state={state} open={open} onOpenChange={setOpen} trigger={trigger} variant={variant} />
    </Suspense>
  );
}
