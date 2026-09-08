/**
 * A text field you can talk into, on the browsers that allow it.
 *
 * Two rules, both about not lying to the operator:
 *
 * 1. **No mic button where there is no microphone API.** `speechSupport()` is
 *    asked once at mount; on Firefox — which has no `SpeechRecognition` at all
 *    — the field renders as an ordinary field with no dead control beside it.
 *    A button that does nothing teaches people the feature is broken.
 * 2. **Dictation fills the box; it never presses the button.** The transcript
 *    lands in a field that is still editable and still has to be submitted by
 *    hand. A microphone that could approve a gate is a different product.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { Button, Input, toast } from '@/components/ui';
import { dictate, speechSupport, type Dictation } from '@/lib/speech';

export interface MicFieldProps {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function MicField({ label, placeholder, value, onChange, disabled }: MicFieldProps) {
  const id = useId();
  // Read at mount rather than at module load: a test that installs the global
  // after import must still see it, and a browser answers the same either way.
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const session = useRef<Dictation | null>(null);

  useEffect(() => setSupported(speechSupport()), []);

  // A recogniser left running when the surface unmounts is a microphone left
  // on. There is no visible control to stop it by then, so this is the only
  // thing that can.
  useEffect(() => () => session.current?.stop(), []);

  const start = useCallback(() => {
    if (session.current) {
      session.current.stop();
      return;
    }
    // The transcript REPLACES what dictation added and leaves what was typed:
    // interim results arrive as a growing whole sentence, so appending each one
    // would stutter the field.
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
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-2xs text-ink-muted">
        {label}
      </label>
      <div className="flex items-center gap-1.5">
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
            type="button"
            size="icon"
            variant={listening ? 'action' : 'default'}
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
