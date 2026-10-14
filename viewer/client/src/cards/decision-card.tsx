/**
 * A decision, answered on its card (7.0; control-tower phase 137, #214;
 * turn-by-turn phase 8 — projected decisions too).
 *
 * ONE form for every decision an item carries:
 *
 *   - a LEDGER decision (`mode: 'ledger'`): its options and a note, which is an
 *     answer by itself when no option fits, sent as `{option?, note?}`;
 *   - a PROJECTED one (`mode: 'bound'`, turn-by-turn phase 5): a conflict, a QA
 *     verdict, a relayed question, an errand's ask — each option bound to the
 *     verb that takes it; a box for words only when the chosen option takes
 *     them (`says`), and an option whose capability is off drawn disabled with
 *     the flag that would turn it on.
 *
 * The options are the kit's radio group, so Radix owns the arrow keys, each a
 * card a thumb can hit with what choosing it means. The recommended one is
 * NAMED in words, never chosen for the person and never told by its place in
 * the list: nothing is pre-selected. *Send my decision* is the one primary, and
 * it stays disabled until there is something to send — an empty answer would
 * resume a session with nothing in its hands. A refusal (a stale run, a door
 * that may not press) is said under the form, in the server's own sentence.
 */

import { useId, useState } from 'react';
import { flagReason } from '@/data/api/inbox';
import { Button, Input } from '@/ui';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { Textarea } from '@/ui/textarea';
import { MOVE_LABEL } from './turn/moves';

export type DecisionOption = {
  id: string;
  label: string;
  consequence?: string | undefined;
  recommended?: boolean | undefined;
  /** A projected option's capability, when one is off. */
  flag?: string | undefined;
  /** A projected option that takes words, and the field they go in. */
  says?: { field: string; label: string; placeholder?: string | undefined } | undefined;
};
export type DecisionAnswer = { option?: string; note?: string };

export function DecisionCard({
  options,
  onSend,
  mode = 'ledger',
  busy = false,
  disabled = false,
  refusal,
  noteHint,
}: {
  options: readonly DecisionOption[];
  /** The chosen option and the words: a ledger decision's note, a bound option's typed field. */
  onSend: (answer: DecisionAnswer) => void;
  mode?: 'ledger' | 'bound';
  /** An answer is on its way. */
  busy?: boolean;
  /** Nothing can be sent now — a press is held, or the item cannot take one. */
  disabled?: boolean;
  /** The server's sentence for a press it refused. */
  refusal?: string | null | undefined;
  /** A sentence beside the note box when the note has a shape the server reads. */
  noteHint?: string | undefined;
}) {
  const [option, setOption] = useState('');
  const [note, setNote] = useState('');
  const uid = useId();
  const bound = mode === 'bound';
  const chosen = options.find((choice) => choice.id === option);
  const ready = bound ? Boolean(chosen) && !chosen?.flag : Boolean(option) || note.trim().length > 0;
  const noteBox = bound ? chosen?.says : { label: '', placeholder: undefined };

  function send() {
    const answer: DecisionAnswer = {};
    if (option) answer.option = option;
    if (note.trim() && (!bound || chosen?.says)) answer.note = note.trim();
    onSend(answer);
  }

  return (
    <div data-testid={bound ? 'turn-options' : 'decision-card'} className="flex min-w-0 flex-col gap-3">
      {options.length > 0 && (
        <RadioGroup
          value={option}
          onValueChange={setOption}
          disabled={disabled || busy}
          aria-label="The options"
          className="max-w-prose"
        >
          {options.map((choice) => {
            const off = flagReason(choice.flag);
            const description = [choice.consequence, off].filter(Boolean).join(' ');
            return (
              <div
                key={choice.id}
                data-testid={bound ? `turn-option-${choice.id}` : `decision-option-${choice.id}`}
                data-recommended={choice.recommended ? 'true' : undefined}
                data-flag={choice.flag}
              >
                <RadioItem
                  id={`${uid}-${choice.id}`}
                  value={choice.id}
                  disabled={Boolean(choice.flag)}
                  label={
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{choice.label}</span>
                      {choice.recommended && <span className="text-meta text-ink-muted">Recommended</span>}
                    </span>
                  }
                  {...(description ? { description } : {})}
                />
              </div>
            );
          })}
        </RadioGroup>
      )}
      {noteBox && (
        <label htmlFor={`${uid}-note`} className="flex max-w-prose flex-col gap-1 text-meta text-ink-muted">
          {bound
            ? noteBox.label
            : options.length > 0
              ? 'A note, if no option says it all'
              : 'Your answer, as a note'}
          {bound ? (
            <Input
              id={`${uid}-note`}
              block
              value={note}
              disabled={disabled || busy}
              placeholder={noteBox.placeholder}
              onChange={(event) => setNote(event.target.value)}
            />
          ) : (
            <Textarea
              id={`${uid}-note`}
              rows={2}
              block
              value={note}
              disabled={disabled || busy}
              onChange={(event) => setNote(event.target.value)}
              placeholder="It goes to the session with your choice"
            />
          )}
          {noteHint && (
            <span data-testid="decision-note-hint" className="text-ink">
              {noteHint}
            </span>
          )}
        </label>
      )}
      <Button
        variant="primary"
        data-testid="turn-primary"
        data-move="decide"
        className="self-start"
        disabled={!ready || busy || disabled}
        onClick={send}
      >
        {busy ? 'Sending…' : MOVE_LABEL.decide}
      </Button>
      {refusal && (
        <p data-testid="turn-option-refusal" role="alert" className="max-w-prose text-body text-ink">
          {refusal}
        </p>
      )}
    </div>
  );
}
