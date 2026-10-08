/**
 * A decision, answered on its card (control-tower phase 137, #214, exit
 * criterion 4).
 *
 * The options are cards a thumb can hit — the kit's radio group, so Radix
 * owns the arrow keys — each with what choosing it means, and the
 * recommended one marked in WORDS, never by a colour alone. Then a note,
 * which is an answer by itself when no option fits. *Send my answer* is the
 * item's one primary, and it stays disabled until there is something to send:
 * an empty answer would resume a session with nothing in its hands.
 */

import { useId, useState } from 'react';
import { Button, RadioGroup, RadioItem, Textarea } from '@/components/ui';

export type DecisionOption = { id: string; label: string; consequence?: string; recommended?: true };
export type DecisionAnswer = { option?: string; note?: string };

export function DecisionCard({
  options,
  onSend,
  busy = false,
  disabled = false,
}: {
  options: readonly DecisionOption[];
  onSend: (answer: DecisionAnswer) => void;
  /** An answer is on its way. */
  busy?: boolean;
  /** Nothing can be sent now — the item is settled, or not due yet. */
  disabled?: boolean;
}) {
  const [option, setOption] = useState('');
  const [note, setNote] = useState('');
  const uid = useId();
  const ready = Boolean(option) || note.trim().length > 0;

  function send() {
    const answer: DecisionAnswer = {};
    if (option) answer.option = option;
    if (note.trim()) answer.note = note.trim();
    onSend(answer);
  }

  return (
    <div data-testid="decision-card" className="flex min-w-0 flex-col gap-3">
      {options.length > 0 && (
        <RadioGroup
          value={option}
          onValueChange={setOption}
          disabled={disabled || busy}
          aria-label="The options"
          className="gap-2"
        >
          {options.map((choice) => (
            <div
              key={choice.id}
              data-testid={`decision-option-${choice.id}`}
              data-recommended={choice.recommended}
            >
              <RadioItem
                id={`${uid}-${choice.id}`}
                value={choice.id}
                className="decision-option border-rule bg-surface px-3 py-2.5"
                label={
                  <span className="flex flex-wrap items-baseline gap-x-2 font-medium">
                    {choice.label}
                    {choice.recommended && (
                      <span className="text-2xs font-medium text-ink-muted">Recommended</span>
                    )}
                  </span>
                }
                {...(choice.consequence ? { description: choice.consequence } : {})}
              />
            </div>
          ))}
        </RadioGroup>
      )}
      <label htmlFor={`${uid}-note`} className="flex max-w-prose flex-col gap-1 text-xs text-ink-muted">
        {options.length > 0 ? 'A note, if no option says it all' : 'Your answer, as a note'}
        <Textarea
          id={`${uid}-note`}
          rows={2}
          value={note}
          disabled={disabled || busy}
          onChange={(event) => setNote(event.target.value)}
          placeholder="It goes to the session with your choice"
        />
      </label>
      <Button
        variant="action"
        size="lg"
        data-testid="turn-primary"
        data-move="answer"
        className="min-h-(--tap-min) self-start"
        disabled={!ready || busy || disabled}
        onClick={send}
      >
        {busy ? 'Sending…' : 'Send my answer'}
      </Button>
    </div>
  );
}
