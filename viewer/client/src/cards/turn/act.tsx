/**
 * ONE act form per type (turn-by-turn phase 8, §Architecture 7) — what a
 * person presses on an item, and nothing a type does not ask for:
 *
 *   Task      *I've done this — check* (+ a note for the check), *I've redone it*
 *             on Redo; beside it the opener, never the primary; then *Not doing
 *             this*, *Snooze* (an hour, four, until tomorrow) and *Hand it back*
 *             (to the phase that raised it, a question for its session, or "I
 *             can't do this") — each folded until asked for;
 *   Approval  *Approve* and *Deny*, each held for the undo window, with a note
 *             (a permission's scope and typed rule are its own card's);
 *   Decision  the decision card (`../decision-card.tsx`);
 *   Heads-up  *Got it*;
 *   Checking  *Undo: I'm not finished* — the only press.
 *
 * An action the console's flags switch off is drawn disabled, with the flag
 * that turns it on (`FlaggedActions`). A terminal press waits out the undo
 * window on the page (`HeldLine`).
 */

import { useId, useState, type ReactNode } from 'react';
import { flagReason, type InboxAction } from '@/data/api/inbox';
import type { StepEvidenceInput } from '@/data/human-steps';
import type { HeldView } from '@/data/undo-window';
import { Button, Input } from '@/ui';
import { Textarea } from '@/ui/textarea';
import { MOVE_LABEL } from './moves';

/** A terminal press held on the page: what it is, that it goes in a moment, and the way to take it back. */
export function HeldLine({
  held,
  onUndo,
  onSendNow,
}: {
  held: HeldView;
  onUndo: () => void;
  onSendNow: () => void;
}) {
  return (
    <div
      data-testid="turn-held"
      role="status"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-body text-ink"
    >
      <span>
        {held.label} — sent in {Math.round(held.ms / 1000)} seconds.
      </span>
      <Button size="sm" data-testid="turn-held-undo" onClick={onUndo}>
        Undo
      </Button>
      <Button size="sm" variant="ghost" data-testid="turn-held-send" onClick={onSendNow}>
        Send now
      </Button>
    </div>
  );
}

/** Row actions the console's flags switch off: drawn, disabled, each saying which flag turns it on. */
export function FlaggedActions({ actions }: { actions: readonly InboxAction[] }) {
  const off = actions.filter((action) => action.flag);
  if (!off.length) return null;
  return (
    <ul data-testid="turn-flagged" className="flex list-none flex-col gap-1.5 p-0">
      {off.map((action) => (
        <li key={action.verb} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Button size="sm" disabled data-verb={action.verb} data-flag={action.flag}>
            {action.label}
          </Button>
          <span className="text-meta text-ink-muted">{flagReason(action.flag)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The one press while a check runs. */
export function UndoAct({ busy, onUndo }: { busy: boolean; onUndo: () => void }) {
  return (
    <div
      data-testid="turn-act"
      data-type="checking"
      className="flex min-w-0 flex-col gap-2"
      data-print="hide"
    >
      <p className="max-w-prose text-meta text-ink-muted">
        Not finished after all? Undo takes the check back, and the item is yours again.
      </p>
      <Button
        variant="primary"
        data-testid="turn-primary"
        data-move="undo"
        className="self-start"
        disabled={busy}
        onClick={onUndo}
      >
        {MOVE_LABEL.undo}
      </Button>
    </div>
  );
}

/** A heads-up: nothing to do, one acknowledgement. */
export function HeadsUpAct({ onGotIt, done }: { onGotIt: () => void; done: boolean }) {
  return (
    <div data-testid="turn-act" data-type="know" className="flex min-w-0 flex-col gap-2" data-print="hide">
      {done ? (
        <p className="text-meta text-ink-muted">Seen. Nothing checks it or waits on it.</p>
      ) : (
        <Button
          variant="primary"
          data-testid="turn-primary"
          data-move="got-it"
          className="self-start"
          onClick={onGotIt}
        >
          {MOVE_LABEL.gotIt}
        </Button>
      )}
    </div>
  );
}

/**
 * An approval: *Approve* (the one primary) and *Deny* beside it, with a note
 * the session reads. Either is a terminal press, held for the undo window by
 * the caller. `approve` absent means the item offers no yes to press here.
 */
export function ApprovalAct({
  approveLabel = MOVE_LABEL.approve,
  denyLabel = MOVE_LABEL.deny,
  onApprove,
  onDeny,
  busy = false,
  noteLabel = 'A note, if you want to say why. It goes with your answer.',
  noteHint,
  noteRequired = false,
  more,
  children,
}: {
  approveLabel?: string;
  denyLabel?: string;
  onApprove?: ((note: string | undefined) => void) | undefined;
  onDeny?: ((note: string | undefined) => void) | undefined;
  busy?: boolean;
  noteLabel?: string | undefined;
  /** What shape the note must take, said beside it ("only the dollar amount"). */
  noteHint?: string | undefined;
  /** Approve needs the note (a raise of money is the amount). */
  noteRequired?: boolean;
  /** The item's other row actions, drawn after Deny — never a second primary. */
  more?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  const [note, setNote] = useState('');
  const said = note.trim() || undefined;
  return (
    <div data-testid="turn-act" data-type="approve" className="flex min-w-0 flex-col gap-3" data-print="hide">
      {children}
      {noteLabel && (
        <label htmlFor={id} className="flex max-w-prose flex-col gap-1 text-meta text-ink-muted">
          {noteLabel}
          <Input
            id={id}
            block
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
          {noteHint && (
            <span data-testid="turn-note-hint" className="text-ink">
              {noteHint}
            </span>
          )}
        </label>
      )}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="turn-moves">
        {onApprove && (
          <Button
            variant="primary"
            data-testid="turn-primary"
            data-move="approve"
            disabled={busy || (noteRequired && !said)}
            onClick={() => onApprove(said)}
          >
            {approveLabel}
          </Button>
        )}
        {onDeny && (
          <Button
            variant="danger"
            data-move="deny"
            data-verb="deny"
            disabled={busy}
            onClick={() => onDeny(said)}
          >
            {denyLabel}
          </Button>
        )}
        {more}
      </div>
    </div>
  );
}

type TaskForm = 'decline' | 'cannot' | 'ask' | 'attach' | null;

const FORM_WORDS: Readonly<
  Record<Exclude<TaskForm, null>, { label: string; placeholder: string; submit: string }>
> = {
  decline: {
    label: 'Why not? The session is told, and finds another way.',
    placeholder: 'What should happen instead',
    submit: 'Send my reason',
  },
  cannot: {
    label: 'Why not? It becomes an errand with your words.',
    placeholder: 'Who can do it, or what is in the way',
    submit: 'Hand it back',
  },
  ask: {
    label: 'Your question. The session reads it when it resumes.',
    placeholder: 'What is unclear',
    submit: 'Ask',
  },
  attach: {
    label: 'A note for this attempt, or a file below.',
    placeholder: 'What you did, what you saw',
    submit: 'Attach',
  },
};

/** The snooze lengths on offer, in minutes. */
export const SNOOZE_OPTIONS = Object.freeze([
  { minutes: 60, label: 'An hour' },
  { minutes: 240, label: 'Four hours' },
  { minutes: 1440, label: 'Until tomorrow' },
]);

export interface TaskVerbs {
  check: (note?: string) => void;
  snooze: (minutes?: number) => void;
  cannot: (reason: string) => void;
  decline: (reason: string) => void;
  ask: (text: string) => Promise<unknown>;
  attach: (evidence: StepEvidenceInput) => Promise<unknown>;
  giveBack: (phase: number) => void;
}

/** A file, as the evidence route takes it: base64, with its type and name. */
function readEvidence(file: File): Promise<StepEvidenceInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.onload = () => {
      const data = String(reader.result ?? '').replace(/^data:[^,]*,/, '');
      resolve(
        file.type.startsWith('image/')
          ? { kind: 'image', data, mime: file.type, name: file.name }
          : { kind: 'file', data, name: file.name },
      );
    };
    reader.readAsDataURL(file);
  });
}

/**
 * A task: the check (the one primary) with a note for it, the opener beside
 * it, and the rest folded until asked for.
 */
export function TaskAct({
  redo,
  verbs,
  busy,
  noteAllowed,
  allowDecline,
  giveBackPhase,
  opener,
  onError,
}: {
  redo: boolean;
  verbs: TaskVerbs;
  /** Which verb is on its way, if any. */
  busy: { check: boolean; snooze: boolean; other: boolean; open: boolean };
  /** A note may ride the check — never on an item whose answer is a secret or a code. */
  noteAllowed: boolean;
  allowDecline: boolean;
  /** The phase that raised it, when it can take it back. */
  giveBackPhase: number | null;
  /** The kind's own opener — a link or a terminal — beside the check, never instead of it. */
  opener?: { label: string; onOpen: () => void } | undefined;
  onError: (words: string) => void;
}) {
  const id = useId();
  const [note, setNote] = useState('');
  const [fold, setFold] = useState<'snooze' | 'back' | null>(null);
  const [form, setForm] = useState<TaskForm>(null);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);

  function toggle(which: 'snooze' | 'back') {
    setFold((was) => (was === which ? null : which));
  }

  async function submit() {
    const words = text.trim();
    if (form === 'attach') {
      const evidence: StepEvidenceInput | null = file
        ? await readEvidence(file).catch((cause: unknown) => {
            onError(cause instanceof Error ? cause.message : String(cause));
            return null;
          })
        : words
          ? { kind: 'note', text: words }
          : null;
      if (!evidence) return;
      await verbs.attach(evidence);
    } else if (!words) {
      return;
    } else if (form === 'decline') {
      verbs.decline(words);
    } else if (form === 'cannot') {
      verbs.cannot(words);
    } else if (form === 'ask') {
      await verbs.ask(words);
    }
    setForm(null);
    setText('');
    setFile(null);
  }

  return (
    <div data-testid="turn-act" data-type="do" className="flex min-w-0 flex-col gap-3" data-print="hide">
      {noteAllowed && (
        <label htmlFor={`${id}-note`} className="flex max-w-prose flex-col gap-1 text-meta text-ink-muted">
          A note for the check, if it helps
          <Textarea
            id={`${id}-note`}
            data-testid="turn-check-note-box"
            rows={2}
            block
            value={note}
            disabled={busy.check}
            placeholder="What you did, what you saw"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="turn-moves">
        <Button
          variant="primary"
          data-testid="turn-primary"
          data-move="check"
          disabled={busy.check}
          onClick={() => {
            verbs.check(noteAllowed ? note : undefined);
            setNote('');
          }}
        >
          {busy.check ? 'Checking…' : redo ? MOVE_LABEL.redo : MOVE_LABEL.check}
        </Button>
        {opener && (
          <Button data-testid="turn-open" disabled={busy.open} onClick={opener.onOpen}>
            {opener.label}
          </Button>
        )}
        <Button
          variant="ghost"
          aria-expanded={form === 'attach'}
          onClick={() => setForm((was) => (was === 'attach' ? null : 'attach'))}
        >
          Attach evidence
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="turn-more-acts">
        {allowDecline && (
          <Button
            variant="ghost"
            aria-expanded={form === 'decline'}
            onClick={() => setForm((was) => (was === 'decline' ? null : 'decline'))}
          >
            Not doing this
          </Button>
        )}
        <Button
          variant="ghost"
          data-testid="turn-snooze"
          aria-expanded={fold === 'snooze'}
          onClick={() => toggle('snooze')}
        >
          Snooze
        </Button>
        <Button
          variant="ghost"
          data-testid="turn-hand-back"
          aria-expanded={fold === 'back'}
          onClick={() => toggle('back')}
        >
          Hand it back
        </Button>
      </div>
      {fold === 'snooze' && (
        <div role="group" aria-label="Snooze for" className="flex flex-wrap items-center gap-1.5">
          <span className="text-meta text-ink-muted">No reminder for</span>
          {SNOOZE_OPTIONS.map((choice) => (
            <Button
              key={choice.minutes}
              size="sm"
              data-minutes={choice.minutes}
              disabled={busy.snooze}
              onClick={() => {
                verbs.snooze(choice.minutes);
                setFold(null);
              }}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      )}
      {fold === 'back' && (
        <ul aria-label="Hand it back" className="flex list-none flex-col gap-1.5 p-0">
          {giveBackPhase !== null && (
            <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                size="sm"
                data-testid="turn-give-back"
                disabled={busy.other}
                onClick={() => verbs.giveBack(giveBackPhase)}
              >
                Give back to Phase {giveBackPhase}
              </Button>
              <span className="text-meta text-ink-muted">
                Its session takes it back and finds another way.
              </span>
            </li>
          )}
          <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <Button size="sm" aria-expanded={form === 'ask'} onClick={() => setForm('ask')}>
              Ask the session a question
            </Button>
            <span className="text-meta text-ink-muted">It reads it when it resumes.</span>
          </li>
          <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <Button size="sm" aria-expanded={form === 'cannot'} onClick={() => setForm('cannot')}>
              I can’t do this
            </Button>
            <span className="text-meta text-ink-muted">It becomes an errand, with your reason.</span>
          </li>
        </ul>
      )}
      {form && (
        <form
          data-testid={`turn-form-${form}`}
          className="flex max-w-prose flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={`${id}-words`} className="text-meta text-ink-muted">
            {FORM_WORDS[form].label}
          </label>
          {form === 'attach' || form === 'ask' ? (
            <Textarea
              id={`${id}-words`}
              rows={2}
              block
              value={text}
              placeholder={FORM_WORDS[form].placeholder}
              onChange={(event) => setText(event.target.value)}
            />
          ) : (
            <Input
              id={`${id}-words`}
              block
              value={text}
              placeholder={FORM_WORDS[form].placeholder}
              onChange={(event) => setText(event.target.value)}
            />
          )}
          {form === 'attach' && (
            <label className="flex flex-col gap-1 text-meta text-ink-muted">
              A screenshot or a file — kept on this machine, by its hash
              <Input
                type="file"
                className="h-auto py-1.5"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="submit"
              disabled={(form === 'attach' ? !text.trim() && !file : !text.trim()) || busy.other}
            >
              {FORM_WORDS[form].submit}
            </Button>
            <Button variant="ghost" type="button" onClick={() => setForm(null)}>
              Not now
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
