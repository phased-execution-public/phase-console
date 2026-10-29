import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePrefs, PANEL_WIDTH } from '@/lib/prefs';
import { Sheet, SheetContent } from '@/ui/sheet';
import { useSettledWidth } from '@/ui/sheet-width';
import type { ConsoleState } from '@/data/api';
import type { Route } from '../routes';
import { InspectorHost, useInspected } from './inspector-host';
import {
  MODE_LABEL,
  PANEL_MODES,
  clampWidth,
  closePanel,
  openPanel,
  panelMode,
  setPanelWidth,
  type PanelMode,
} from './modes';

/** Where the panel stands, the width's answer. */
type PanelHost = 'column' | 'end' | 'bottom';

/**
 * The right panel's frame (7.0): where Inspect stands, and — in Pro — the
 * Supervisor beside the page. Three hosts, the width's answer: a `column` of
 * the shell's grid at 1200 and up, as wide as the person dragged it; an `end`
 * sheet between 900 and 1200; a `bottom` sheet on a phone (Details only — the
 * Supervisor is `#/chat` there). Loaded when it first stands.
 *
 * Its header is a segmented control between its modes when there is more than
 * one to choose, and a way out — the ONE header: a mode's body draws none of
 * its own. Its body is the mode's: the inspected record through the kit's bare
 * inspector frame, or the Supervisor (`pro/supervisor.tsx`).
 */
export default function Panel({
  host,
}: {
  state: ConsoleState | undefined;
  route: Route;
  host: PanelHost;
}) {
  const [prefs] = usePrefs();
  const mode = panelMode(prefs.panel);
  const label = MODE_LABEL[mode];
  // How wide its record may make it (2026-10-20): the inspected record's
  // measure in Details, a reading measure for the Supervisor.
  const inspected = useInspected();
  const measure = mode === 'details' ? (inspected?.measure ?? 'reading') : 'reading';
  const fit = prefs.panel.width === 'auto';
  const aside = useRef<HTMLElement>(null);
  const settled = useSettledWidth<HTMLElement>(host === 'column' && fit, inspected?.key ?? mode);
  const modes = offeredModes(
    host,
  );
  const body: ReactNode = (
    <PanelBody
      mode={mode}
      host={host}
    />
  );

  const switcher =
    modes.length > 1 ? (
      <div role="group" aria-label="Panel mode" className="inline-flex rounded border border-rule-strong">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={m === mode}
            onClick={() => openPanel(m)}
            className={cn(
              'h-7 px-2.5 text-meta font-medium transition-colors duration-fast ease-transit first:rounded-s last:rounded-e',
              m === mode ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>
    ) : null;

  if (host !== 'column') {
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) closePanel();
        }}
      >
        <SheetContent
          side={host}
          size={measure}
          title={label}
          showTitle
          subheader={switcher ? <div className="py-2">{switcher}</div> : undefined}
          bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
          data-panel={mode}
        >
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      ref={(node) => {
        aside.current = node;
        settled(node);
      }}
      aria-label={label}
      data-panel={mode}
      {...(fit ? { 'data-sheet-size': measure } : {})}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden border-s border-rule bg-ground',
        // As wide as its record asks, within its measure — and never so wide that
        // the page beside it has under 50 rem — the room a desk page had beside the
        // old 400 px column, which every page is laid out to hold (`100cqi` is the shell's own width, `@container/shell`).
        fit && 'sheet-fit [--sheet-cap:min(56rem,calc(100cqi_-_var(--rail-width)_-_50rem))]',
      )}
      style={
        fit
          ? undefined
          : {
              width: clampWidth(prefs.panel.width as number),
              maxWidth: 'calc(100cqi - var(--rail-width) - 50rem)',
            }
      }
    >
      <Edge
        width={fit ? null : (prefs.panel.width as number)}
        measured={() => aside.current?.getBoundingClientRect().width ?? PANEL_WIDTH.min}
      />
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-rule px-3 py-2">
        {switcher ?? <h2 className="text-section font-semibold text-ink">{label}</h2>}
        <button
          type="button"
          onClick={closePanel}
          aria-label="Close the panel"
          className="-me-1 inline-grid size-8 place-items-center rounded text-ink-faint hover:bg-surface-raised hover:text-ink"
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
    </aside>
  );
}

/**
 * The modes this console can offer: Details always; in Pro the Supervisor too,
 * where the server has a chat to show — but never in a phone's sheet, where
 * the Supervisor is its own page (`#/chat`, the tab bar's fourth slot) and
 * `panelStands` closes the panel the moment it is chosen: a switch there was a
 * control that made the sheet vanish (quiet-console phase 27).
 */
function offeredModes(
  host: PanelHost,
): readonly PanelMode[] {
  if (host === 'bottom') return PANEL_MODES.filter((m) => m === 'details');
  return PANEL_MODES;
}

/** The mode's body: the inspected record, or — in Pro, in Supervisor mode — the chat's own panel. */
function PanelBody({
  mode,
  host,
}: {
  mode: PanelMode;
  host: PanelHost;
  state?: ConsoleState | undefined;
}) {
  // Details has one body whatever the host; the free tree reads these two
  // here and nowhere else, so they are named rather than left unused.
  void mode;
  void host;
  return <InspectorHost />;
}

/** The step a key press moves the panel's edge, in px — four times that with Shift. */
const KEY_STEP = 16;

/**
 * The panel's edge: drag it, or focus it and use the arrow keys. A window
 * splitter in ARIA's own words, so a screen reader says how wide it is and
 * which way it moves. The width under a drag is the pointer's; it is written
 * to the preference once, when the drag ends. A column that fits its record
 * (`width` null) starts a drag from the width it has; a double-click, or
 * Home, lets go of a set width, so the column fits its record again.
 */
function Edge({ width, measured }: { width: number | null; measured: () => number }) {
  const [dragged, setDragged] = useState<number | null>(null);
  const from = useRef<{ x: number; width: number } | null>(null);
  const shown = clampWidth(dragged ?? width ?? measured());
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (from.current) setDragged(clampWidth(from.current.width + (from.current.x - event.clientX)));
  };
  const end = () => {
    if (from.current && dragged !== null) setPanelWidth(dragged);
    from.current = null;
    setDragged(null);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuemin={PANEL_WIDTH.min}
      aria-valuemax={PANEL_WIDTH.max}
      aria-valuenow={shown}
      tabIndex={0}
      onPointerDown={(event) => {
        from.current = { x: event.clientX, width: shown };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => setPanelWidth('auto')}
      onKeyDown={(event) => {
        const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
        if (event.key === 'ArrowLeft') setPanelWidth(shown + step);
        else if (event.key === 'ArrowRight') setPanelWidth(shown - step);
        else if (event.key === 'Home') setPanelWidth('auto');
        else return;
        event.preventDefault();
      }}
      className="absolute inset-y-0 start-0 z-10 w-1.5 cursor-col-resize hover:bg-rule-strong focus-visible:bg-focus"
    />
  );
}
