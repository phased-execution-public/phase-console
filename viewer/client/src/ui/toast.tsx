import * as ToastPrimitive from '@radix-ui/react-toast';
import { useSyncExternalStore } from 'react';
import { NOTE_ROWS, type NoteSeverity } from '@shared/status-notes.js';
import { cn } from '@/lib/cn';
import { NoteIcon } from './banner';

/**
 * Toasts — the store and the tray.
 *
 * A toast's kind IS a note severity (`shared/status-notes.js`), drawn with the
 * severity's icon and painted through the same rows as a banner, so "Copied"
 * and "the console is running older code than is on disk" never look alike.
 *
 * The store is module-level so anything — a mutation handler, an event
 * listener, a keyboard shortcut — can raise one without being inside a
 * provider. FIRST PAINT: the barrel carries it, so it reads the note rows and
 * nothing of the status model.
 */

export type ToastKind = NoteSeverity;

/** A toast that wants something — the update prompt, which must not act on its own nor vanish unread. */
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

/**
 * Mounted once by the shell. The tray sits above everything (`--z-toast`) and
 * above every bar along the bottom edge, and stays visible with the software
 * keyboard open: `fixed` anchors to the LAYOUT viewport, which on iOS does not
 * shrink for the keyboard, so `100% − --app-height` is the keyboard's share and
 * `--bottom-bars` the measured sum of the bars the shell registers.
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
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-lg border border-rule-strong border-s-2 border-s-state bg-surface px-3 py-2',
            'text-body text-ink shadow-overlay data-[state=open]:animate-rise',
            `state-${NOTE_ROWS[item.kind].paint}`,
          )}
        >
          <span className="mt-0.5 text-state">
            <NoteIcon severity={item.kind} />
          </span>
          <ToastPrimitive.Description className="min-w-0 flex-1">{item.message}</ToastPrimitive.Description>
          {item.action && (
            <ToastPrimitive.Action
              altText={item.action.label}
              onClick={item.action.onSelect}
              className="shrink-0 rounded border border-rule-strong px-2 py-0.5 text-meta font-medium text-ink hover:bg-surface-raised"
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
          // Above the tab bar on a phone; the bottom END corner on a desk.
          'md:inset-x-auto md:end-0 md:w-[min(24rem,calc(100%-1.5rem))]',
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
