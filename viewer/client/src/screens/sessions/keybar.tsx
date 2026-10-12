/**
 * The keys a phone keyboard does not have (7.0, quiet-console phase 15; the
 * bar since Phase 10).
 *
 * A software keyboard has no Esc, no Tab, no arrows and no Ctrl, which is most
 * of what a shell is driven with. This bar supplies them — and Ctrl is
 * *sticky*: tap it, then a letter on the real keyboard, and the next character
 * becomes its control code. That is how `^C` is typed on a phone without a
 * button per combination.
 *
 * ## A grid, never a scroller
 *
 * Two rows of five on a phone (`Esc Tab ⇧Tab ^C Ctrl` over `↑ ↓ ← → Paste`),
 * one row of ten from `sm`, and a `⋯` key that flips to a second page (`Home
 * End PgUp PgDn Del` over `A− A+ ^L ^D ^R`). The first version was one
 * sideways-scrolling row, 559 px wide at 390, whose keys fired on `touchend`
 * with no movement test — a swipe that started on Esc typed Esc. So:
 *
 *  - every key is in the grid, thumb-sized, reachable without sliding;
 *  - a key fires on **`click`**: the browser's own tap-versus-scroll slop
 *    decides what a moving finger meant, and a swipe never becomes a key;
 *  - `pointerdown` (and its `mousedown` twin) is cancelled, which keeps focus
 *    on xterm's hidden textarea — a key that blurred the terminal would drop
 *    the iOS keyboard — and leaves the `click` intact;
 *  - `touch-action: manipulation`, no text selection and no callout, so a long
 *    press on a key is a key.
 */

import { useState, type SyntheticEvent } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Ellipsis,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/ui';

export interface KeyBarProps {
  /** Send a literal byte sequence to the pty. */
  onSend(data: string): void;
  /** Ctrl is armed for the next character typed on the real keyboard. */
  ctrl: boolean;
  onCtrl(next: boolean): void;
  onPaste(): void;
  /** `A−` / `A+`: the pane steps the terminal font and refits. */
  onFont(delta: -1 | 1): void;
}

export type BarKey =
  | { kind: 'send'; label: string; icon?: LucideIcon; data: string; title: string }
  | { kind: 'ctrl' }
  | { kind: 'paste' }
  | { kind: 'font'; delta: -1 | 1; label: string; title: string };

const send = (label: string, data: string, title: string, icon?: LucideIcon): BarKey => ({
  kind: 'send',
  label,
  data,
  title,
  ...(icon ? { icon } : {}),
});

/**
 * Two pages of ten. The second is what a pager or an editor wants, plus the
 * font stepper — a bigger font is what people mean when they pinch a
 * terminal, and a zoomed terminal is a cropped one.
 */
export const KEY_PAGES: readonly (readonly BarKey[])[] = [
  [
    send('Esc', '\x1b', 'Escape'),
    send('Tab', '\t', 'Tab — completion'),
    // CSI Z, the backtab: in a claude session it is Shift+Tab — the
    // permission-mode cycle a phone keyboard cannot type.
    send('⇧Tab', '\x1b[Z', 'Shift-Tab — cycle Claude permission modes'),
    send('^C', '\x03', 'Interrupt (Ctrl-C)'),
    { kind: 'ctrl' },
    send('↑', '\x1b[A', 'Up — previous command', ArrowUp),
    send('↓', '\x1b[B', 'Down', ArrowDown),
    send('←', '\x1b[D', 'Left', ArrowLeft),
    send('→', '\x1b[C', 'Right', ArrowRight),
    { kind: 'paste' },
  ],
  [
    send('Home', '\x1b[H', 'Home — start of line'),
    send('End', '\x1b[F', 'End — end of line'),
    send('PgUp', '\x1b[5~', 'Page up'),
    send('PgDn', '\x1b[6~', 'Page down'),
    send('Del', '\x1b[3~', 'Delete — the character under the cursor'),
    { kind: 'font', delta: -1, label: 'A−', title: 'Smaller terminal font' },
    { kind: 'font', delta: 1, label: 'A+', title: 'Larger terminal font' },
    send('^L', '\x0c', 'Clear the screen (Ctrl-L)'),
    send('^D', '\x04', 'End of input (Ctrl-D)'),
    send('^R', '\x12', 'Search history (Ctrl-R)'),
  ],
];

/** A key is a tile of the bar's own tone — keys, not buttons on a page. */
const KEY = 'h-auto min-h-(--tap-min) min-w-0 shrink px-1 font-mono text-body';
const IDLE = 'border border-rule bg-surface text-ink-muted hover:bg-surface-raised hover:text-ink';
const ARMED = 'border border-action bg-action text-ground hover:bg-action hover:text-ground';

export function KeyBar({ onSend, ctrl, onCtrl, onPaste, onFont }: KeyBarProps) {
  const [page, setPage] = useState(0);

  /** Keep the terminal focused: the focus move is `pointerdown`'s default, and the `click` still types. */
  const hold = (event: SyntheticEvent) => {
    event.preventDefault();
  };
  const keyProps = { onPointerDown: hold, onMouseDown: hold } as const;

  const renderKey = (key: BarKey, index: number) => {
    if (key.kind === 'ctrl') {
      return (
        <Button
          key="ctrl"
          variant="ghost"
          aria-pressed={ctrl}
          title="Ctrl — the next key you type becomes its control code"
          {...keyProps}
          onClick={() => onCtrl(!ctrl)}
          className={cn(KEY, ctrl ? ARMED : IDLE)}
        >
          Ctrl
        </Button>
      );
    }
    if (key.kind === 'paste') {
      return (
        <Button
          key="paste"
          variant="ghost"
          title="Paste from the clipboard"
          aria-label="Paste"
          {...keyProps}
          onClick={onPaste}
          className={cn(KEY, IDLE, 'gap-1 font-sans')}
        >
          {/* The word, always; the glyph only where a key is wide enough for both. */}
          <ClipboardPaste size={16} aria-hidden className="hidden sm:inline" />
          <span className="truncate">Paste</span>
        </Button>
      );
    }
    if (key.kind === 'font') {
      return (
        <Button
          key={key.label}
          variant="ghost"
          title={key.title}
          aria-label={key.title}
          {...keyProps}
          onClick={() => onFont(key.delta)}
          className={cn(KEY, IDLE)}
        >
          {key.label}
        </Button>
      );
    }
    return (
      <Button
        key={`${page}-${index}`}
        variant="ghost"
        title={key.title}
        aria-label={key.title}
        {...keyProps}
        onClick={() => onSend(key.data)}
        className={cn(KEY, IDLE)}
      >
        {key.icon ? <key.icon size={18} aria-hidden /> : key.label}
      </Button>
    );
  };

  return (
    <div
      // A grid row of the terminal column, never `position: fixed` — the tab
      // bar's rule, for the same iOS reason. The `⋯` page key takes the last
      // column, both rows on a phone.
      className={cn(
        'grid shrink-0 grid-cols-[repeat(5,minmax(0,1fr))_auto] gap-1.5 border-t border-rule bg-ground-deep px-2 py-1.5',
        'sm:grid-cols-[repeat(10,minmax(0,1fr))_auto]',
        'select-none [-webkit-touch-callout:none] [touch-action:manipulation]',
      )}
      role="toolbar"
      aria-label="Terminal keys"
      data-page={page}
    >
      {KEY_PAGES[page]!.map(renderKey)}
      <Button
        variant="ghost"
        aria-label={page === 0 ? 'More keys' : 'Main keys'}
        aria-pressed={page === 1}
        title={page === 0 ? 'Home, End, PgUp, PgDn, Del, font size, ^L ^D ^R' : 'Back to the main keys'}
        {...keyProps}
        onClick={() => setPage((current) => (current === 0 ? 1 : 0))}
        className={cn(
          // Placed explicitly so the ten keys flow into columns 1–5 (1–10 from
          // `sm`) and never into this one.
          KEY,
          'col-start-6 row-span-2 row-start-1 min-w-(--tap-min) flex-col gap-1',
          'sm:col-start-11 sm:row-span-1',
          page === 1 ? 'border border-rule-strong bg-surface-raised text-ink' : IDLE,
        )}
      >
        <Ellipsis size={18} aria-hidden />
        {/* Which of the two pages is up. */}
        <span className="flex gap-1" aria-hidden>
          <span className={cn('size-1.5 rounded-full', page === 0 ? 'bg-ink' : 'bg-rule-strong')} />
          <span className={cn('size-1.5 rounded-full', page === 1 ? 'bg-ink' : 'bg-rule-strong')} />
        </span>
      </Button>
    </div>
  );
}

/**
 * Apply an armed Ctrl to what was typed. Only a single printable character is
 * transformed: an arrow key arrives as a three-byte escape sequence and must
 * pass through untouched, or the bar would break the very keys it provides.
 */
export function applyCtrl(data: string): string | null {
  if (data.length !== 1) return null;
  const code = data.toUpperCase().charCodeAt(0);
  // Ctrl maps @A–Z[\]^_ to 0–31; anything else is sent as itself.
  if (code < 64 || code > 95) return null;
  return String.fromCharCode(code - 64);
}
