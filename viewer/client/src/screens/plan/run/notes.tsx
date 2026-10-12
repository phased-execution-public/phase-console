/**
 * What people decided about this run, and why (7.0, quiet-console phase 12;
 * the 6.x notes card, control-tower phase 96).
 *
 * ```
 * Keep this run on admin@ past its weekly limit.
 * Pinned   mobin   2d ago                                        [Unpin]
 * ───────────────────────────────────────────────────────────────────────
 * Moved ten stray clones out of the worktree, nothing deleted.
 * mobin   3h ago   about phase 4                                   [Pin]
 * ▸ 3 older notes
 * ┌ What did you decide, and why?                                      ┐
 * └ ☐ Pin it                                              [Add the note] ┘
 * ```
 *
 * The console's place for a decision and its reason, so the next person to
 * open a run sees why, not only what happened. A PINNED note is a standing
 * decision: it leads here, oldest first — its age is part of it — and every
 * phase that boards reads it in its boot prompt until somebody unpins it. The
 * rest are history, newest first; past the latest few they fold, and the
 * journal has them all.
 *
 * The composer is the one card here, because it is acted on as a unit. Free,
 * like the notes themselves: a decision about a run is not a Pro feature.
 */

import { useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pin, PinOff } from 'lucide-react';
import { runsApi, type RunNote, type RunState } from '@/data/api/runs';
import { keys } from '@/data/keys';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { Button, Label, Mono, RelativeTime, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Disclosure } from '@/ui/disclosure';
import { Textarea } from '@/ui/textarea';

/** How many unpinned notes are drawn before the older ones fold. */
const RECENT_NOTES = 5;

/** A refusal in the server's own words — the honest floor when it said nothing. */
const words = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : 'The request failed and said nothing.';

/**
 * Pinned first, oldest first — a standing decision's age is part of it; then
 * the newest few of the rest, newest first, and the earlier ones after them.
 */
export function notesInOrder(notes: readonly RunNote[]): {
  pinned: RunNote[];
  recent: RunNote[];
  earlier: RunNote[];
} {
  const loose = notes.filter((note) => !note.pinned).reverse();
  return {
    pinned: notes.filter((note) => note.pinned),
    recent: loose.slice(0, RECENT_NOTES),
    earlier: loose.slice(RECENT_NOTES),
  };
}

function NoteRow({
  note,
  onPin,
  busy,
}: {
  note: RunNote;
  /** Absent on a console that cannot write: the note is read, never moved. */
  onPin?: ((note: RunNote) => void) | undefined;
  busy: boolean;
}) {
  return (
    <li
      data-testid="run-note"
      data-pinned={note.pinned ? '' : undefined}
      className="flex min-w-0 flex-col gap-0.5 py-1.5"
    >
      <p className="min-w-0 whitespace-pre-wrap break-words text-body text-ink">{note.text}</p>
      {/* The spaces between the facts are for the words, not the layout: the gap draws it. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-muted">
        {note.pinned && (
          <>
            <span
              className="inline-flex items-center gap-1 text-ink"
              title="A standing decision: every phase that boards reads it until someone unpins it."
            >
              <Pin size={12} aria-hidden className="shrink-0" />
              Pinned
            </span>{' '}
          </>
        )}
        <span className="min-w-0 break-words">{note.by}</span> <RelativeTime at={note.at} />
        {note.phase != null && (
          <>
            {' '}
            <span className="tnum">about phase {note.phase}</span>
          </>
        )}
        {onPin && (
          <Button
            size="sm"
            variant="ghost"
            className="ms-auto"
            disabled={busy}
            aria-label={note.pinned ? 'Unpin this note' : 'Pin this note'}
            onClick={() => onPin(note)}
          >
            {note.pinned ? <PinOff size={12} aria-hidden /> : <Pin size={12} aria-hidden />}
            {note.pinned ? 'Unpin' : 'Pin'}
          </Button>
        )}
      </div>
    </li>
  );
}

/** The composer: the words, whether they stand, and the one press that writes `{text, pinned}`. */
function NoteComposer({ slug }: { slug: string }) {
  const client = useQueryClient();
  const id = useId();
  const [text, setText] = useState('');
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);
  // A ref, not the state: a click and an Enter in one tick must send once.
  const inFlight = useRef(false);

  const submit = async () => {
    const body = text.trim();
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await runsApi.runNote(slug, { text: body, pinned: pin });
      toast(pin ? 'Note added and pinned' : 'Note added', 'ok');
      setText('');
      setPin(false);
    } catch (cause) {
      toast(words(cause), 'error');
    } finally {
      inFlight.current = false;
      setBusy(false);
      void client.invalidateQueries({ queryKey: keys.run(slug) });
    }
  };

  return (
    <form
      data-testid="note-composer"
      className="flex min-w-0 max-w-(--measure) flex-col gap-2 rounded border border-rule bg-surface p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        block
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="What did you decide, and why?"
        aria-label="Note"
        disabled={busy}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className="flex min-w-0 items-center gap-2"
          title="Every phase that boards reads a pinned note, until someone unpins it."
        >
          <Checkbox
            id={`${id}-pin`}
            checked={pin}
            disabled={busy}
            onCheckedChange={(next) => setPin(next === true)}
          />
          <Label htmlFor={`${id}-pin`} className="text-meta font-normal text-ink-muted">
            Pin it
          </Label>
        </span>
        <Button type="submit" size="sm" className="ms-auto" disabled={busy || !text.trim()}>
          {busy ? 'Adding…' : 'Add the note'}
        </Button>
      </div>
    </form>
  );
}

export function RunOperatorNotes({
  run,
  allowRun = false,
  everything = false,
}: {
  run: RunState;
  allowRun?: boolean;
  /** The page's Everything: the older notes drawn rather than folded. */
  everything?: boolean;
}) {
  const client = useQueryClient();
  const reason = useId();
  const [pinning, setPinning] = useState<string | null>(null);
  const notes = run.notes ?? [];
  const { pinned, recent, earlier } = notesInOrder(notes);

  // Nothing to read and nothing this console may write: nothing to draw.
  if (!notes.length && !allowRun) return null;

  const pin = async (note: RunNote) => {
    setPinning(note.id);
    try {
      await runsApi.runPinNote(run.slug, note.id, !note.pinned);
      toast(note.pinned ? 'Unpinned' : 'Pinned', 'ok');
    } catch (cause) {
      toast(words(cause), 'error');
    } finally {
      setPinning(null);
      void client.invalidateQueries({ queryKey: keys.run(run.slug) });
    }
  };
  const onPin = allowRun ? (note: RunNote) => void pin(note) : undefined;
  const rows = (list: readonly RunNote[]) =>
    list.map((note) => <NoteRow key={note.id} note={note} onPin={onPin} busy={pinning === note.id} />);

  return (
    <div data-testid="run-operator-notes" className="flex min-w-0 flex-col gap-3">
      {!notes.length && <p className="text-body text-ink-muted">No note on this run yet.</p>}
      {pinned.length > 0 && (
        <ul className="flex min-w-0 flex-col" aria-label="Pinned notes">
          {rows(pinned)}
        </ul>
      )}
      {recent.length > 0 && (
        <ul
          className={cn('flex min-w-0 flex-col', pinned.length > 0 && 'border-t border-rule pt-2')}
          aria-label="Recent notes"
        >
          {rows(recent)}
        </ul>
      )}
      {earlier.length > 0 &&
        (everything ? (
          <ul className="flex min-w-0 flex-col" aria-label="Older notes">
            {rows(earlier)}
          </ul>
        ) : (
          <Disclosure
            label={plural(earlier.length, 'older note')}
            openLabel="Hide the older notes"
            testId="notes-older"
          >
            <ul className="flex min-w-0 flex-col pt-1" aria-label="Older notes">
              {rows(earlier)}
            </ul>
          </Disclosure>
        ))}
      {allowRun ? (
        <NoteComposer slug={run.slug} />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Button size="sm" variant="ghost" disabled aria-describedby={reason}>
            Add a note
          </Button>
          <p id={reason} className="text-meta text-ink-muted" data-testid="notes-read-only">
            Needs <Mono value="--allow-run" /> on this console.
          </p>
        </div>
      )}
    </div>
  );
}
