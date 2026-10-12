/**
 * The terminal's composer: one line, sent WITH its Enter — `text + '\r'`, the
 * keystroke the TUI waits for — through the path the key bar uses.
 *
 * Why a line is composed here and not typed into xterm's hidden textarea: a
 * phone keyboard's autocorrect and capitalisation rewrite a command mid-word,
 * and the TUI's own line editing sees every keystroke in between. So nothing
 * may rewrite it on the way — autocorrect, capitalisation and spellcheck off —
 * the field is the 16 px input size (smaller and iOS zooms the page), the
 * return key says "send", and focus stays in the field after a send so the
 * keyboard stays up.
 *
 * A phone's, by the pane's choice (a desk has a real keyboard), above the key
 * bar, registered with it as a bottom bar so toasts clear both.
 */

import { useRef, useState } from 'react';
import { SendHorizontal } from 'lucide-react';
import { Button, Input } from '@/ui';

export function Composer({
  onSend,
  placeholder = 'Message the session',
}: {
  /** The line with its Enter: `text + '\r'`. */
  onSend(data: string): void;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const ready = text.trim().length > 0;

  return (
    <form
      aria-label="Composer"
      className="flex shrink-0 items-center gap-1.5 border-t border-rule bg-ground-deep px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onSend(`${text}\r`);
        setText('');
        // Keep composing — without scrolling the page to do it.
        field.current?.focus({ preventScroll: true });
      }}
    >
      <Input
        ref={field}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        aria-label="Message"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        className="min-h-(--tap-min) min-w-0 flex-1"
      />
      <Button type="submit" variant="primary" className="min-h-(--tap-min)" disabled={!ready}>
        <SendHorizontal size={15} aria-hidden /> Send
      </Button>
    </form>
  );
}
