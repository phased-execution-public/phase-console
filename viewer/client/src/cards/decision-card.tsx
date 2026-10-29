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
 *     verb that takes it, and an option whose capability is off drawn disabled
 *     with the flag that would turn it on.
 *
 * Every decision has a box for the person's words (2026-10-20): the chosen
 * option's own field when it takes words (`says`), else a note for the AI,
 * which the card sends beside the press to whoever the item goes to. An open
 * decision the AI can take ends with *Hand it to the AI*, the server's option.
 *
 * The options are the kit's radio group, so Radix owns the arrow keys, and
 * each is a STRIP (Tower strips, 2026-10-20) a thumb can hit: the radio, the
 * option's words, what choosing it means beneath, and — where it is — a quiet
 * ★ *Recommended*, outlined and never coloured. The chosen strip wears an ink
 * leading edge on the raised surface: a choice is not a summons. The
 * recommended one is NAMED in words, never chosen for the person and never
 * told by its place in the list: nothing is pre-selected. *Hand it to the AI*
 * is set apart under a hairline and an "or", its strip dashed with the AI's
 * glyph — a way out, not one more answer. The note grows with what is typed,
 * to about eight lines. *Send my decision* is the one primary, on the act bar
 * (`turn/act.tsx` `ActBar`, pinned to the panel's foot where the card is the
 * panel's), and it stays disabled until there is something to send — an empty
 * answer would resume a session with nothing in its hands. A refusal (a stale
 * run, a door that may not press) is said under the form, in the server's own
 * sentence.
 */

import { useId, useState, type ReactNode } from 'react';
import { Bot, Star } from 'lucide-react';
import { HAND_OFF_OPTION_ID } from '@shared/turn-model.js';
import { flagReason } from '@/data/api/inbox';
import { cn } from '@/lib/cn';
import { Button } from '@/ui';
import { RadioGroup, RadioItem } from '@/ui/radio-group';
import { Textarea } from '@/ui/textarea';
import { ActBar, formBox } from './turn/act';
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

/** One option as a strip: its radio, its words, what it means, and *Recommended* where it is. */
function OptionStrip({
  choice,
  id,
  bound,
  handOff = false,
}: {
  choice: DecisionOption;
  id: string;
  bound: boolean;
  /** *Hand it to the AI*: dashed, with the AI's glyph. */
  handOff?: boolean;
}) {
  const off = flagReason(choice.flag);
  const description = [choice.consequence, off].filter(Boolean).join(' ');
  return (
    <div
      data-testid={bound ? `turn-option-${choice.id}` : `decision-option-${choice.id}`}
      data-recommended={choice.recommended ? 'true' : undefined}
      data-flag={choice.flag}
      data-hand-off={handOff ? '' : undefined}
    >
      <RadioItem
        id={id}
        value={choice.id}
        disabled={Boolean(choice.flag)}
        className={cn(
          // The leading edge is always there, so choosing moves nothing: a
          // hairline at rest, ink once chosen, on the raised surface.
          'border-s-2',
          'has-[[data-state=checked]]:border-rule has-[[data-state=checked]]:border-s-ink',
          'has-[[data-state=checked]]:bg-surface-raised',
          handOff && 'border-dashed has-[[data-state=checked]]:[border-inline-start-style:solid]',
        )}
        label={
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {handOff && <Bot size={14} aria-hidden className="shrink-0 text-ink-muted" />}
            <span className="font-medium">{choice.label}</span>
            {choice.recommended && (
              <span
                data-testid="option-recommended"
                className="inline-flex items-center gap-1 rounded-full border border-rule-strong px-1.5 text-meta text-ink-muted"
              >
                <Star size={11} aria-hidden className="shrink-0" />
                Recommended
              </span>
            )}
          </span>
        }
        {...(description ? { description } : {})}
      />
    </div>
  );
}

export function DecisionCard({
  options,
  onSend,
  mode = 'ledger',
  busy = false,
  disabled = false,
  refusal,
  noteHint,
  more,
  pinned = false,
}: {
  options: readonly DecisionOption[];
  /** The chosen option and the words: a ledger decision's note, a bound option's field, or a note for the AI. */
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
  /** The item's other row actions, on the act bar after the primary — never a second primary. */
  more?: ReactNode;
  /** The act bar holds to the foot of the panel's scroller. */
  pinned?: boolean;
}) {
  const [option, setOption] = useState('');
  const [note, setNote] = useState('');
  const uid = useId();
  const bound = mode === 'bound';
  const chosen = options.find((choice) => choice.id === option);
  const ready = bound ? Boolean(chosen) && !chosen?.flag : Boolean(option) || note.trim().length > 0;
  // The chosen option's own field, when it takes words; else a note for the AI.
  const field = chosen?.says;
  const noteLabel = field
    ? field.label
    : bound
      ? 'A note for the AI (optional)'
      : options.length > 0
        ? 'A note for the AI — optional, or your answer when no option fits'
        : 'Your answer, as a note';
  const notePlaceholder =
    field?.placeholder ??
    (bound
      ? 'Anything it should know — it goes with your choice'
      : 'It goes to the session with your choice');
  // *Hand it to the AI* is the decision's way out, set apart from the answers.
  const choices = options.filter((choice) => choice.id !== HAND_OFF_OPTION_ID);
  const handOff = options.find((choice) => choice.id === HAND_OFF_OPTION_ID);

  function send() {
    const answer: DecisionAnswer = {};
    if (option) answer.option = option;
    if (note.trim()) answer.note = note.trim();
    onSend(answer);
  }

  return (
    <div data-testid={bound ? 'turn-options' : 'decision-card'} className={formBox(pinned)}>
      {options.length > 0 && (
        <RadioGroup
          value={option}
          onValueChange={setOption}
          disabled={disabled || busy}
          aria-label="The options"
          className="max-w-(--measure) gap-1.5"
        >
          {choices.map((choice) => (
            <OptionStrip key={choice.id} choice={choice} id={`${uid}-${choice.id}`} bound={bound} />
          ))}
          {handOff && (
            <>
              <div
                aria-hidden
                data-testid="turn-option-or"
                className="flex items-center gap-2 py-0.5 text-meta text-ink-muted"
              >
                <span className="h-px flex-1 bg-rule" />
                or
                <span className="h-px flex-1 bg-rule" />
              </div>
              <OptionStrip choice={handOff} id={`${uid}-${handOff.id}`} bound={bound} handOff />
            </>
          )}
        </RadioGroup>
      )}
      <label
        htmlFor={`${uid}-note`}
        className="flex max-w-(--measure) flex-col gap-1 text-meta text-ink-muted"
      >
        {noteLabel}
        <Textarea
          id={`${uid}-note`}
          data-testid="decision-note"
          rows={2}
          block
          // It grows with what is typed (`field-sizing`), from two lines to about eight.
          className="min-h-[calc(2lh+0.875rem)] max-h-[calc(8lh+0.875rem)]"
          value={note}
          disabled={disabled || busy}
          onChange={(event) => setNote(event.target.value)}
          placeholder={notePlaceholder}
        />
        {noteHint && (
          <span data-testid="decision-note-hint" className="text-ink">
            {noteHint}
          </span>
        )}
      </label>
      <ActBar pinned={pinned}>
        <Button
          variant="primary"
          data-testid="turn-primary"
          data-move="decide"
          disabled={!ready || busy || disabled}
          onClick={send}
        >
          {busy ? 'Sending…' : MOVE_LABEL.decide}
        </Button>
        {more}
      </ActBar>
      {refusal && (
        <p data-testid="turn-option-refusal" role="alert" className="max-w-(--measure) text-body text-ink">
          {refusal}
        </p>
      )}
    </div>
  );
}
