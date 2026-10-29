/**
 * ONE act form per type (turn-by-turn phase 8, §Architecture 7) — what a
 * person presses on an item, and nothing a type does not ask for:
 *
 *   Task      *I've done this — check* (+ a note for the check), *I've redone it*
 *             on Redo; beside it the opener, never the primary; then *Not doing
 *             this*, *I can't do this*, *Snooze* (an hour, four, until
 *             tomorrow) and *Hand it back* (to the phase that raised it, or a
 *             question for its session) — each folded until asked for;
 *   Approval  *Approve* and *Deny*, each held for the undo window, with a note
 *             (a permission's scope and typed rule are its own card's);
 *   Decision  the decision card (`../decision-card.tsx`);
 *   Heads-up  *Got it*;
 *   Checking  *Undo: I'm not finished* — the only press.
 *
 * Every open ledger item — a Task's, a Decision's, an Approval's — offers *I
 * can't do this* one press from the card (`CannotAct`): it settles the item
 * as an errand carrying the person's reason. An action the console's flags
 * switch off is drawn disabled, with the flag that turns it on
 * (`FlaggedActions`). A terminal press waits out the undo window on the page
 * (`HeldLine`), and once it went through the card says so in place of its
 * form until the server moves the item (`SentAct`).
 *
 * Every form ends in ONE act bar (`ActBar`, Tower strips 2026-10-20): the
 * primary and the quiet presses beside it. Where the card is the panel's whole
 * subject the bar is PINNED — it holds to the foot of the panel's scroller, a
 * hairline over it and the card's ground under it — so the primary is in reach
 * however long the card runs. A pinned form draws no box of its own (`contents`):
 * the bar then travels the whole of the card's act, from its first line to its
 * last, rather than only its own form.
 */

import { useId, useState, type HTMLAttributes, type ReactNode } from 'react';
import { flagReason, type InboxAction } from '@/data/api/inbox';
import type { StepEvidenceInput } from '@/data/human-steps';
import type { HeldView } from '@/data/undo-window';
import { cn } from '@/lib/cn';
import { Button, Input } from '@/ui';
import { Textarea } from '@/ui/textarea';
import { stamp } from './step-words';
import { MOVE_LABEL } from './moves';

/**
 * A pinned bar's room: the foot of the scroller, over the card's own padding,
 * on the card's ground. Sticky stops at the scroller's PADDING edge, so the
 * bar reaches down through the panel's `--pad-y` and fills it: nothing reads
 * through the band under it.
 */
export const PINNED_BAR =
  'sticky -bottom-(--pad-y) -mx-4 border-t border-rule bg-surface px-4 pt-2.5 pb-[calc(0.625rem+var(--pad-y))] @xl/card:-mx-5 @xl/card:px-5';

/**
 * The act bar: the one primary and the presses beside it — in flow on the
 * page, pinned to the foot of the panel's scroller where the card is the
 * panel's (`pinned`).
 */
export function ActBar({
  pinned = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { pinned?: boolean }) {
  return (
    <div
      data-testid="turn-moves"
      data-pinned={pinned ? '' : undefined}
      className={cn('flex min-w-0 flex-wrap items-center gap-1.5', pinned && PINNED_BAR, className)}
      {...props}
    >
      {children}
    </div>
  );
}

/** A form's own box — none where it is pinned, so its bar travels the whole act (see above). */
export function formBox(pinned: boolean, gap = 'gap-3'): string {
  return cn('flex min-w-0 flex-col', gap, pinned && 'contents');
}

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

/** A press the card sent, and when — held in place of its form until the server moves the item. */
export type SentPress = { label: string; at: string };

/**
 * A terminal press that went through: what was sent and when, and nothing to
 * press again while the console settles it — the server's next word moves the
 * item (Passed, Being checked, or off the page). One way back to the choices,
 * for an item that stays open after all.
 */
export function SentAct({ sent, onShowAgain }: { sent: SentPress; onShowAgain: () => void }) {
  return (
    <div
      data-testid="turn-sent"
      role="status"
      className="flex min-w-0 max-w-(--measure) flex-col gap-2 border-s-2 border-rule-strong ps-3 text-body text-ink"
      data-print="hide"
    >
      <p>
        <span className="font-medium">
          {sent.label} — sent at {stamp(sent.at)}.
        </span>{' '}
        <span className="text-ink-muted">The console is settling it; there is nothing to press again.</span>
      </p>
      <Button size="sm" variant="ghost" className="self-start" onClick={onShowAgain}>
        Show the choices again
      </Button>
    </div>
  );
}

/**
 * *I can't do this* on a card whose form is not a task's (a Decision's, an
 * Approval's): one press opens the reason, and sending it settles the item as
 * an errand carrying the person's words — the same verb the task's form takes.
 */
export function CannotAct({ busy, onCannot }: { busy: boolean; onCannot: (reason: string) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const words = FORM_WORDS.cannot;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="turn-more-acts" data-print="hide">
      <Button
        variant="ghost"
        data-testid="turn-cannot"
        className="self-start"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {MOVE_LABEL.cannot}
      </Button>
      {open && (
        <form
          data-testid="turn-form-cannot"
          className="flex max-w-(--measure) flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const said = reason.trim();
            if (!said) return;
            onCannot(said);
            setOpen(false);
            setReason('');
          }}
        >
          <label htmlFor={id} className="text-meta text-ink-muted">
            {words.label}
          </label>
          <Input
            id={id}
            block
            value={reason}
            placeholder={words.placeholder}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            <Button type="submit" disabled={!reason.trim() || busy}>
              {words.submit}
            </Button>
            <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
              Not now
            </Button>
          </div>
        </form>
      )}
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
export function UndoAct({
  busy,
  onUndo,
  pinned = false,
}: {
  busy: boolean;
  onUndo: () => void;
  pinned?: boolean;
}) {
  return (
    <div data-testid="turn-act" data-type="checking" className={formBox(pinned, 'gap-2')} data-print="hide">
      <p className="max-w-(--measure) text-meta text-ink-muted">
        Not finished after all? Undo takes the check back, and the item is yours again.
      </p>
      <ActBar pinned={pinned}>
        <Button
          variant="primary"
          data-testid="turn-primary"
          data-move="undo"
          disabled={busy}
          onClick={onUndo}
        >
          {MOVE_LABEL.undo}
        </Button>
      </ActBar>
    </div>
  );
}

/** A heads-up: nothing to do, one acknowledgement. */
export function HeadsUpAct({
  onGotIt,
  done,
  pinned = false,
}: {
  onGotIt: () => void;
  done: boolean;
  pinned?: boolean;
}) {
  return (
    <div data-testid="turn-act" data-type="know" className={formBox(pinned, 'gap-2')} data-print="hide">
      {done ? (
        <p className="text-meta text-ink-muted">Seen. Nothing checks it or waits on it.</p>
      ) : (
        <ActBar pinned={pinned}>
          <Button variant="primary" data-testid="turn-primary" data-move="got-it" onClick={onGotIt}>
            {MOVE_LABEL.gotIt}
          </Button>
        </ActBar>
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
  sending = false,
  noteLabel = 'A note, if you want to say why. It goes with your answer.',
  noteHint,
  noteRequired = false,
  more,
  pinned = false,
  children,
}: {
  approveLabel?: string;
  denyLabel?: string;
  onApprove?: ((note: string | undefined) => void) | undefined;
  onDeny?: ((note: string | undefined) => void) | undefined;
  busy?: boolean;
  /** An answer is on its way to the server — the primary says so. */
  sending?: boolean;
  noteLabel?: string | undefined;
  /** What shape the note must take, said beside it ("only the dollar amount"). */
  noteHint?: string | undefined;
  /** Approve needs the note (a raise of money is the amount). */
  noteRequired?: boolean;
  /** The item's other row actions, drawn after Deny — never a second primary. */
  more?: ReactNode;
  /** The act bar holds to the foot of the panel's scroller. */
  pinned?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  const [note, setNote] = useState('');
  const said = note.trim() || undefined;
  return (
    <div data-testid="turn-act" data-type="approve" className={formBox(pinned)} data-print="hide">
      {children}
      {noteLabel && (
        <label htmlFor={id} className="flex max-w-(--measure) flex-col gap-1 text-meta text-ink-muted">
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
      <ActBar pinned={pinned}>
        {onApprove && (
          <Button
            variant="primary"
            data-testid="turn-primary"
            data-move="approve"
            disabled={busy || sending || (noteRequired && !said)}
            onClick={() => onApprove(said)}
          >
            {sending ? 'Sending…' : approveLabel}
          </Button>
        )}
        {onDeny && (
          <Button
            variant="danger"
            data-move="deny"
            data-verb="deny"
            disabled={busy || sending}
            onClick={() => onDeny(said)}
          >
            {denyLabel}
          </Button>
        )}
        {more}
      </ActBar>
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
    submit: 'Send my reason',
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
  cannotHere = true,
  pinned = false,
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
  /** *I can't do this* among the task's moves — not while the escalation's box offers its own. */
  cannotHere?: boolean;
  /** The act bar holds to the foot of the panel's scroller. */
  pinned?: boolean;
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
    <div data-testid="turn-act" data-type="do" className={formBox(pinned)} data-print="hide">
      {noteAllowed && (
        <label
          htmlFor={`${id}-note`}
          className="flex max-w-(--measure) flex-col gap-1 text-meta text-ink-muted"
        >
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
      <ActBar pinned={pinned}>
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
      </ActBar>
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
        {cannotHere && (
          <Button
            variant="ghost"
            data-testid="turn-cannot"
            aria-expanded={form === 'cannot'}
            onClick={() => setForm((was) => (was === 'cannot' ? null : 'cannot'))}
          >
            {MOVE_LABEL.cannot}
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
        </ul>
      )}
      {form && (
        <form
          data-testid={`turn-form-${form}`}
          className="flex max-w-(--measure) flex-col gap-2"
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
