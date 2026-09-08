import type { ReactNode } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from './alert-dialog';
import { Button, type ButtonProps } from './button';

/**
 * A button whose press has to be meant.
 *
 * Thirteen surfaces wired the same four elements by hand — `AlertDialog` >
 * `AlertDialogTrigger asChild` > `Button` > `AlertDialogContent` — and the
 * copies drifted in exactly the places that matter: some named the cancel side
 * ("Keep the wall", "Leave it queued") and some left it as *Cancel*; some
 * marked the act `destructive` and some painted the trigger `danger` instead,
 * so the red was on the way in rather than on the way out.
 *
 * What this fixes is that the two labels — the button and its confirm — are one
 * decision. `confirmLabel` defaults to the button's own words when they are a
 * plain string, so a Stop button confirms with *Stop* rather than *Confirm*,
 * which is the copy rule this console follows everywhere else: an action keeps
 * its name through the whole flow.
 *
 * Use `AlertDialog` directly for the other shape — a dialog opened by state
 * rather than by its own trigger (a bulk bar, a row menu, a confirm raised by
 * something that already happened). This is only the trigger-and-dialog pair.
 */
export function ConfirmButton({
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
  busy = false,
  busyLabel,
  details,
  children,
  disabled,
  onOpenChange,
  ...props
}: {
  /** The question, as a question. */
  title: ReactNode;
  /** What pressing it will actually do — the part the title has no room for. */
  description?: ReactNode;
  /** Defaults to the button's own words. Only override to say something better. */
  confirmLabel?: string;
  /** Name the other outcome where there is one worth naming. */
  cancelLabel?: string;
  /** Red, and the act cannot be taken back. */
  destructive?: boolean;
  onConfirm: () => void;
  /** In flight: the button is disabled and wears `busyLabel` if there is one. */
  busy?: boolean;
  busyLabel?: string;
  /** Extra body for the dialog — an inventory, a diff, the list being acted on. */
  details?: ReactNode;
  /** The button's own label. */
  children: ReactNode;
  /** Fires as the dialog opens/closes — for a confirm whose details need a
   * fresh read at the moment of asking (mount-on-open covers most cases). */
  onOpenChange?: (open: boolean) => void;
} & Omit<ButtonProps, 'children' | 'onClick' | 'title'>) {
  const label = busy && busyLabel ? busyLabel : children;
  return (
    <AlertDialog {...(onOpenChange ? { onOpenChange } : {})}>
      <AlertDialogTrigger asChild>
        <Button disabled={disabled || busy} {...props}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        title={title}
        description={description}
        confirmLabel={confirmLabel ?? (typeof children === 'string' ? children : 'Confirm')}
        {...(cancelLabel ? { cancelLabel } : {})}
        destructive={destructive}
        onConfirm={onConfirm}
      >
        {details}
      </AlertDialogContent>
    </AlertDialog>
  );
}
