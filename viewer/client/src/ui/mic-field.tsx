/**
 * A text field you can talk into, on the browsers that allow it.
 *
 * Two rules, both about not lying to the person:
 *
 * 1. **No mic button where there is no microphone API.** `speechSupport()` is
 *    asked once at mount; a browser without `SpeechRecognition` draws an
 *    ordinary field with no dead control beside it.
 * 2. **Dictation fills the box; it never presses the button.** The transcript
 *    lands in a field that is still editable and still submitted by hand. A
 *    microphone that could approve a gate is a different product.
 *
 * Imported by path.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { dictate, speechSupport, type Dictation } from '@/lib/speech';
// Through the light barrel, which first paint has already loaded: a page
// reaching this field by its own path must not split the input out of it.
import { Button, Input, toast } from '@/ui';

export interface MicFieldProps {
  label: string;
  placeholder?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
}

export function MicField({ label, placeholder, value, onChange, disabled }: MicFieldProps) {
  const id = useId();
  // Read at mount rather than at module load: a test that installs the global
  // after import still sees it, and a browser answers the same either way.
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const session = useRef<Dictation | null>(null);

  useEffect(() => setSupported(speechSupport()), []);
  // A recogniser left running when the field unmounts is a microphone left on,
  // with no control left to stop it.
  useEffect(() => () => session.current?.stop(), []);

  const start = useCallback(() => {
    if (session.current) {
      session.current.stop();
      return;
    }
    // The transcript REPLACES what dictation added and keeps what was typed:
    // interim results arrive as a growing whole sentence.
    const before = value ? `${value.trimEnd()} ` : '';
    const started = dictate({
      onText: (text) => onChange(`${before}${text}`),
      onEnd: (error) => {
        session.current = null;
        setListening(false);
        if (error) {
          toast(
            error === 'not-allowed' || error === 'service-not-allowed'
              ? 'This browser would not give the page a microphone.'
              : `Dictation stopped (${error}).`,
            'warn',
          );
        }
      },
    });
    if (!started) {
      toast('This browser would not start dictation.', 'warn');
      return;
    }
    session.current = started;
    setListening(true);
  }, [onChange, value]);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-meta text-ink-muted">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          id={id}
          block
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        {supported && (
          <Button
            size="icon"
            variant={listening ? 'primary' : 'default'}
            disabled={disabled}
            onClick={start}
            aria-pressed={listening}
            aria-label={listening ? 'Stop dictating' : 'Dictate'}
            title={listening ? 'Stop dictating' : 'Dictate'}
          >
            {listening ? <Square aria-hidden className="size-4" /> : <Mic aria-hidden className="size-4" />}
          </Button>
        )}
      </div>
    </div>
  );
}
