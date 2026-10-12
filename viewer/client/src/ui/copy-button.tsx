import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, type ButtonProps } from './button';
import { copy } from './toast';

/**
 * Copy, and say so on the button rather than only in a toast: the one
 * question after pressing is "did that work?", and the tick answers it where
 * the finger already is. Imported by path — a page that copies nothing never
 * loads it.
 */
export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  size = 'sm',
  variant = 'default',
  ...props
}: {
  /** A string, or a function producing one — for text that is read on press. */
  text: string | (() => string | Promise<string>);
  label?: string;
  copiedLabel?: string;
} & Omit<ButtonProps, 'children' | 'onClick'>) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A timer firing into an unmounted button is the classic warning; clearing it is the whole fix.
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Button
      size={size}
      variant={variant}
      title="Copy to the clipboard"
      onClick={async () => {
        const value = typeof text === 'function' ? await text() : text;
        if (!(await copy(value, copiedLabel))) return;
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      }}
      {...props}
    >
      {done ? <Check size={13} aria-hidden className="text-done" /> : <Copy size={13} aria-hidden />}
      {done ? copiedLabel : label}
    </Button>
  );
}
