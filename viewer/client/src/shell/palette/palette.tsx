import { useCallback, useEffect, useMemo, useState } from 'react';
import { KbdChord, copy, toast } from '@/ui';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/ui/command';
import { cn } from '@/lib/cn';
import { usePrefs } from '@/lib/prefs';
import type { ConsoleState } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { usePlans } from '@/data/plans';
import { useRunList } from '@/data/runs';
import { PressRefusal } from '@/data/press';
import { pressVerb } from '@/data/verbs';
import { useNavigate } from '../router';
import { OVERLAY_KEYS, closeOverlaysHref, type Route } from '../routes';
import { byGroup, paletteActions, type CommandAction, type CommandContext } from './actions';
import { SearchResults } from './results';

/** How long to sit still before asking the server. Long enough not to search every letter. */
const DEBOUNCE_MS = 180;

/**
 * The ⌘K palette — go anywhere, find anything, do the verb.
 *
 * **Open state is the URL** (`?k=`), like the help sheet and the bell: ⌘K from
 * the Runs page keeps the Runs page underneath, and `#/search?q=cart` became
 * `#/runs?k=cart` with no redirect table of its own. What is TYPED afterwards
 * is deliberately not written back — a palette is transient. Its chunk loads
 * only while the address asks for it (`App.tsx`); the chord that opens it
 * lives in `shortcut.ts`, on first paint.
 */
export default function Palette({
  route,
  state,
  counts,
}: {
  route: Route;
  state: ConsoleState | undefined;
  counts: ShellCounts;
}) {
  const navigate = useNavigate();
  const [, setPrefs] = usePrefs();
  const initial = route.query[OVERLAY_KEYS.palette];
  const open = initial != null;

  const [value, setValue] = useState(initial ?? '');
  const [debounced, setDebounced] = useState(initial ?? '');
  // An act is pressed twice: the first press arms it, the second confirms.
  const [armed, setArmed] = useState<string | null>(null);

  // A deep link (or a second ⌘K) re-seeds the box; closing clears it.
  useEffect(() => {
    setValue(initial ?? '');
    setDebounced(initial ?? '');
    setArmed(null);
  }, [initial]);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [value]);

  const close = useCallback(() => navigate(closeOverlaysHref(route)), [navigate, route]);

  const { data: plans } = usePlans(Boolean(state?.root?.ok));
  const { data: runs } = useRunList(Boolean(state?.autopilot));

  const context = useMemo<CommandContext>(
    () => ({
      state,
      route,
      plans,
      runs,
      // Going anywhere closes it by construction: the palette is open because
      // THIS route carries `?k=`, and the address navigated to does not.
      go: (path) => navigate(path),
      setTheme: (theme) => {
        setPrefs({ theme });
        close();
      },
      setDensity: (density) => {
        setPrefs({ density });
        close();
      },
      pressVerb: (name, args, body) => {
        close();
        void pressVerb(name, args, body)
          .then((outcome) => {
            if (outcome.state === 'asked') toast(outcome.words, 'info');
            else toast(`${name}: done.`);
          })
          .catch((error: unknown) => {
            toast(
              error instanceof PressRefusal ? error.message : String((error as Error).message ?? error),
              'error',
            );
          });
      },
      // Written before the palette closes, inside the press: a clipboard write
      // needs the person's gesture, and the press is that gesture.
      copyLine: (line) => {
        void copy(line);
        close();
      },
    }),
    [state, route, plans, runs, navigate, setPrefs, close],
  );

  const actions = useMemo(() => paletteActions(context), [context]);

  const select = (action: CommandAction) => {
    if (action.confirm && armed !== action.id) {
      setArmed(action.id);
      return;
    }
    setArmed(null);
    action.run(context);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Search and commands"
      description="Type to jump to a place, a plan, a phase or a run, to search every plan and handoff, or to press a verb."
      label="Search and commands"
    >
      <CommandInput placeholder="Go to, find, or do…" value={value} onValueChange={setValue} autoFocus />
      <CommandList>
        <CommandEmpty>
          {debounced.trim().length < 2
            ? 'Two characters is enough to search the documents.'
            : `Nothing matches “${debounced.trim()}”.`}
        </CommandEmpty>

        {byGroup(actions).map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((action) => (
              <CommandItem
                key={action.id}
                value={`${action.label} ${action.keywords ?? ''}`}
                disabled={action.disabled}
                onSelect={() => select(action)}
              >
                {action.icon && <action.icon size={15} className="shrink-0 text-ink-faint" aria-hidden />}
                {/* The label gets the row; the hint is capped at half of it, so a
                    long hint never truncates the one part being read. */}
                <span className={cn('min-w-0 flex-1 truncate', action.mono && 'font-mono')}>
                  {action.label}
                </span>
                {(armed === action.id || action.hint) && (
                  <span className="min-w-0 max-w-[50%] shrink truncate ps-2 text-meta text-ink-faint">
                    {armed === action.id ? 'Press again to confirm' : action.hint}
                  </span>
                )}
                {action.shortcut && (
                  <CommandShortcut>
                    <KbdChord keys={action.shortcut} />
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        <SearchResults query={debounced} onPick={(href) => navigate(href)} />
      </CommandList>

      <div className="flex items-center justify-between gap-2 border-t border-rule px-3 py-1.5 text-meta text-ink-faint">
        <span>
          {counts.plans} plans, {counts.phases} phases
          {state?.searchDocs ? `, ${state.searchDocs} documents indexed` : ''}
        </span>
        <span className="flex items-center gap-1">
          <KbdChord keys={['↵']} /> open <KbdChord keys={['esc']} /> close
        </span>
      </div>
    </CommandDialog>
  );
}
