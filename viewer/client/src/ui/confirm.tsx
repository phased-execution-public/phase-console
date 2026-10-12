import * as AlertPrimitive from '@radix-ui/react-alert-dialog';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button, type ButtonProps } from './button';
import { dialogBox, scrim } from './dialog';

/** What a confirm says and does — the same words whether a button or the flow asks it. */
interface ConfirmWords {
  /** The question, as a question. */
  title: string;
  /** What pressing it will actually do — the part the title has no room for. */
  description?: ReactNode;
  /** Name the other outcome where there is one worth naming. */
  cancelLabel?: string;
  /** The act cannot be taken back: the confirm wears the failed hue. */
  destructive?: boolean;
  onConfirm: () => void;
  /** Extra body for the question — the list being acted on, named. */
  details?: ReactNode;
}

/** The question itself: an alert dialog, so a press outside it never answers it. */
function ConfirmBody({
  title,
  description,
  details,
  cancelLabel = 'Cancel',
  confirmLabel,
  destructive = false,
  onConfirm,
}: ConfirmWords & { confirmLabel: string }) {
  return (
    <AlertPrimitive.Portal>
      <AlertPrimitive.Overlay className={scrim} />
      <AlertPrimitive.Content
        className={cn(dialogBox, 'max-h-[min(42rem,calc(var(--app-height,100%)-2rem))] overflow-y-auto p-4')}
      >
        <AlertPrimitive.Title className="text-section font-semibold text-ink">{title}</AlertPrimitive.Title>
        {description != null && (
          <AlertPrimitive.Description className="mt-1 max-w-prose text-body text-ink-muted">
            {description}
          </AlertPrimitive.Description>
        )}
        {details != null && <div className="mt-3">{details}</div>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <AlertPrimitive.Cancel asChild>
            <Button variant="ghost">{cancelLabel}</Button>
          </AlertPrimitive.Cancel>
          <AlertPrimitive.Action asChild>
            <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </AlertPrimitive.Action>
        </div>
      </AlertPrimitive.Content>
    </AlertPrimitive.Portal>
  );
}

/**
 * A button whose press has to be meant — the button and the question it asks,
 * as ONE decision. Imported by path.
 *
 * The confirm keeps the button's own words (`confirmLabel` defaults to them),
 * because an action keeps its name through the whole flow (design.md §9): a
 * *Clear all* confirms with *Clear all*, never *OK*. An alert dialog, not a
 * dialog: it is not dismissed by a press outside it, and focus starts on the
 * way back, so a stray Enter never takes the act. A destructive act is the
 * failed hue on the way OUT, and only there.
 */
export function ConfirmButton({
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  busy = false,
  details,
  children,
  disabled,
  ...props
}: ConfirmWords & {
  /** Defaults to the button's own words. */
  confirmLabel?: string;
  /** In flight: the trigger is disabled. */
  busy?: boolean;
  /** The trigger's own label. */
  children: ReactNode;
} & Omit<ButtonProps, 'children' | 'onClick' | 'title'>) {
  return (
    <AlertPrimitive.Root>
      <AlertPrimitive.Trigger asChild>
        <Button disabled={disabled || busy} {...props}>
          {children}
        </Button>
      </AlertPrimitive.Trigger>
      <ConfirmBody
        title={title}
        description={description}
        details={details}
        cancelLabel={cancelLabel}
        destructive={destructive}
        onConfirm={onConfirm}
        confirmLabel={confirmLabel ?? (typeof children === 'string' ? children : 'Confirm')}
      />
    </AlertPrimitive.Root>
  );
}

/**
 * The same question, asked by the FLOW rather than by a button: a press that
 * turned out to need a yes — a settings patch that would turn a plan's QA gate
 * on — holds itself and opens this. Controlled; closing it any way but the
 * confirm is the no.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  confirmLabel,
  ...words
}: ConfirmWords & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The act's own name — never *OK*. */
  confirmLabel: string;
}) {
  return (
    <AlertPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <ConfirmBody {...words} confirmLabel={confirmLabel} />
    </AlertPrimitive.Root>
  );
}
