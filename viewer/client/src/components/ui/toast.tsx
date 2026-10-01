import * as ToastPrimitive from '@radix-ui/react-toast';
import { useSyncExternalStore } from 'react';
import { cva } from 'class-variance-authority';
import { NOTE_ROWS, NOTE_SEVERITIES, type NoteSeverity } from '@shared/status-notes.js';
import { cn } from '@/lib/cn';
import { NoteIcon } from './status-stack';

/**
 * Toasts.
 *
 * The kinds are real variants, not one grey box with different words — `warn`
 * in particular did not exist before, so "the console is running older code
 * than is on disk" arrived looking exactly like "Copied". A toast that cannot
 * show severity is a toast nobody reads. Since 6.0 a toast's kind IS a note
 * severity (`shared/status-notes.js`), painted and drawn from the same rows as
 * a banner, with the severity's icon rather than a colour-only dot.
 *
 * The store is module-level so anything — a mutation handler, an SSE listener,
 * a keyboard shortcut — can raise one without being inside a provider.
 */

export type ToastKind = NoteSeverity;

/**
 * A toast that wants something. Almost none do — this exists for the update
 * prompt, which must not act on its own and must not disappear before it has
 * been read.
 */
export interface ToastAction {
  label: string;
  onSelect: () => void;
}

export interface ToastRecord {
  id: number;
  message: string;
  kind: ToastKind;
  ms: number;
  action?: ToastAction;
}

let toasts: ToastRecord[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

const publish = () => {
  for (const notify of listeners) notify();
};

/** `ms: 0` means it stays until it is dismissed or acted on. */
export function toast(message: string, kind: ToastKind = 'ok', ms = 2600, action?: ToastAction): number {
  const id = ++nextId;
  toasts = [...toasts, { id, message, kind, ms, action }];
  publish();
  return id;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  publish();
}

export function useToasts(): ToastRecord[] {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => toasts,
    () => toasts,
  );
}

const toastVariants = cva(
  'pointer-events-auto flex items-start gap-2 rounded border border-state/55 px-3 py-2 text-sm text-ink ' +
    'shadow-card bg-surface-raised data-[state=open]:animate-rise',
  {
    variants: {
      kind: Object.fromEntries(
        NOTE_SEVERITIES.map((kind) => [kind, `state-${NOTE_ROWS[kind].paint}`]),
      ) as Record<ToastKind, string>,
    },
    defaultVariants: { kind: 'ok' },
  },
);

/**
 * Mounted once by the shell. The viewport sits above everything (`--z-toast`)
 * and above every bar along the bottom edge — the tab bar, the terminal's key
 * bar and composer — and stays visible with the software keyboard open.
 *
 * `fixed` anchors to the LAYOUT viewport, which on iOS does not shrink for
 * the keyboard, so `bottom: 0` was under the keyboard and over the key bar.
 * `--app-height` is the visual height the shell lays out against, so
 * `100% − --app-height` is the keyboard's share of the layout viewport (0
 * where the layout viewport shrank with it, as on Android); `--bottom-bars` is
 * the measured sum of the bars registered with `registerBottomBar`.
 */
export function Toaster() {
  const items = useToasts();
  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {items.map((item) => (
        <ToastPrimitive.Root
          key={item.id}
          // 0 means "until someone deals with it" — Radix reads Infinity as
          // never expiring, and a prompt that times out is a prompt that gets
          // missed.
          duration={item.ms === 0 ? Infinity : item.ms}
          onOpenChange={(open) => {
            if (!open) dismissToast(item.id);
          }}
          className={cn(toastVariants({ kind: item.kind }))}
        >
          <NoteIcon severity={item.kind} />
          <ToastPrimitive.Description className="min-w-0 flex-1">{item.message}</ToastPrimitive.Description>
          {item.action && (
            <ToastPrimitive.Action
              altText={item.action.label}
              onClick={item.action.onSelect}
              className={cn(
                'shrink-0 rounded border border-action/60 px-2 py-0.5 text-xs font-medium text-action',
                'hover:bg-action/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              )}
            >
              {item.action.label}
            </ToastPrimitive.Action>
          )}
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport
        className={cn(
          'pointer-events-none fixed inset-x-0 z-(--z-toast) m-0 flex list-none flex-col gap-2 p-3',
          'bottom-[calc(100%-var(--app-height,100%)+var(--bottom-bars,0px))]',
          'pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]',
          // Above the tab bar on a phone; the bottom END corner on a desktop.
          'md:inset-x-auto md:end-0 md:w-[min(24rem,calc(100vw-1.5rem))]',
        )}
      />
    </ToastPrimitive.Provider>
  );
}

/** Copy, with the fallback a refused clipboard needs. */
export async function copy(text: string, label = 'Copied'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy');
    area.remove();
    toast(ok ? label : 'Could not copy — select the text instead', ok ? 'ok' : 'error');
    return Boolean(ok);
  }
}
