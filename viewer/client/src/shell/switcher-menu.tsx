import type { ReactElement } from 'react';
import { Check, FolderOpen } from 'lucide-react';
import { toast } from '@/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown';
import { isLiveness } from '@shared/fleet-model.js';
import type { ConsoleState } from '@/data/api';
import { useInstances, useOpenRoot } from '@/data/machine';
import { OpsStatus } from '@/ui/status';
import { useNavigate } from './router';
import { sourceHref } from './routes';

/** One console of the machine, as the menu lists it. */
interface ConsoleRow {
  id: string;
  name: string;
  port: number | null;
  /** `live` · `stopped` · … — the census's word, or nothing where the registry says nothing. */
  liveness: string | null;
  needsYou: number | null;
}

/** Another console on this machine: the same host, its own port. */
function consoleUrl(port: number): string {
  return `${window.location.protocol}//${window.location.hostname}:${port}/`;
}


/**
 * The switcher's menu: this console first, every other console of the machine
 * (worst-first in Pro, as the fleet census orders them), then the sources this
 * console can open here. Loaded on the first press (`switcher.tsx`).
 */
export default function SwitcherMenu({
  state,
  open,
  onOpenChange,
  trigger,
  variant,
}: {
  state: ConsoleState | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  variant: 'rail' | 'header';
}) {
  const navigate = useNavigate();
  const here = state?.instance?.id;
  const pinned = state?.instance?.pinned === true;
  const { data: instances } = useInstances(open);
  const registryRows: ConsoleRow[] = (instances?.rows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    port: row.port ?? null,
    liveness: row.liveness ?? null,
    needsYou: null,
  }));
  const rows: ConsoleRow[] =
    registryRows;
  const others = rows.filter((row) => row.id !== here);

  const openRoot = useOpenRoot();
  const recents = (state?.recentRoots ?? []).filter((recent) => recent.path !== state?.root?.path);
  const choose = (path: string) => {
    openRoot.mutate(path, {
      onSuccess: (result) => {
        if (!result.check?.ok) {
          toast(result.check?.reason ?? 'Could not open that directory', 'error');
          return;
        }
        toast(`Opened ${result.check.label}`);
        navigate('runs');
      },
      onError: (error: Error) => toast(String(error.message ?? error), 'error'),
    });
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      {/* Never wider than the screen leaves it: the menu sizes to its longest
          line — a console's name, this console's path — and Radix's wrapper
          sizes to the menu, so only the space Radix measures can cap it. */}
      <DropdownMenuContent
        align={variant === 'rail' ? 'start' : 'start'}
        className="min-w-[min(18rem,var(--radix-dropdown-menu-content-available-width))] max-w-[min(24rem,var(--radix-dropdown-menu-content-available-width))]"
      >
        <DropdownMenuLabel>This console</DropdownMenuLabel>
        <DropdownMenuItem disabled className="opacity-100">
          <Check size={14} className="shrink-0 text-ink" aria-hidden />
          <span className="min-w-0">
            <span className="block break-words text-ink">{state?.instance?.name ?? 'Phase Console'}</span>
            <span className="block truncate font-mono text-meta text-ink-faint" title={state?.root?.path}>
              {state?.root?.path ?? 'no source open'}
            </span>
          </span>
        </DropdownMenuItem>


        {others.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Other consoles on this machine</DropdownMenuLabel>
            {others.map((row) => (
              <DropdownMenuItem
                key={row.id}
                disabled={row.port == null}
                onSelect={() => {
                  if (row.port != null) window.location.assign(consoleUrl(row.port));
                }}
              >
                <span className="min-w-0 flex-1">
                  {/* Wrapped, never cut: two consoles' names often share their first half. */}
                  <span className="block break-words text-ink">{row.name}</span>
                  <span className="flex min-w-0 items-center gap-2 text-meta text-ink-faint">
                    {isLiveness(row.liveness) ? (
                      <OpsStatus vocab="liveness" word={row.liveness} />
                    ) : row.liveness ? (
                      <span>{row.liveness}</span>
                    ) : null}
                    {row.port != null && <span className="tabular-nums">port {row.port}</span>}
                  </span>
                </span>
                {row.needsYou != null && row.needsYou > 0 && (
                  <span className="shrink-0 text-meta font-medium text-accent tabular-nums">
                    {row.needsYou} need{row.needsYou === 1 ? 's' : ''} you
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        <DropdownMenuSeparator />
        {pinned ? (
          <div className="px-2 py-1.5 text-meta text-ink-faint">
            This console serves one source. To open another, run{' '}
            <code className="font-mono">phase-console start</code> in it — it gets its own console, port and
            state.
          </div>
        ) : (
          <>
            <DropdownMenuLabel>Open another source here</DropdownMenuLabel>
            {recents.map((recent) => (
              <DropdownMenuItem
                key={recent.path}
                disabled={openRoot.isPending}
                onSelect={() => choose(recent.path)}
              >
                <span className="min-w-0">
                  <span className="block truncate">{recent.label}</span>
                  <span className="block truncate font-mono text-meta text-ink-faint">{recent.path}</span>
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onSelect={() => navigate(sourceHref())}>
              <FolderOpen size={14} className="shrink-0" aria-hidden />
              Browse for a directory…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
