/**
 * What people decided about this run, and why (control-tower phase 96, #142).
 *
 * Supervising four runs on 2026-09-25/26, the watchdog kept about 400 lines a
 * day of decisions and their reasons in a log of its own — "keep every run on
 * admin@ past its weekly limit", "moved ten stray clones out of the worktree,
 * nothing deleted" — because the console had nowhere to put them. The next
 * operator saw what happened to the run and never why.
 *
 * So the run page carries its notes. A PINNED note is a standing decision: it
 * stays at the top of this card, and every phase it applies to reads it in its
 * boot prompt, until somebody unpins it. The rest are history — the latest few
 * here, every one on the timeline and in the journal.
 *
 * Free, like the notes themselves: a decision about a run is not a Pro feature.
 */

import { useRef, useState } from 'react';
import { Pin, PinOff } from 'lucide-react';

import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Checkbox, Textarea } from '@/components/ui';
import { api, type RunNote, type RunState } from '@/lib/api';
import { cn } from '@/lib/cn';
import { keys, useApiMutation } from '@/lib/queries';

/** How many unpinned notes the card shows; the timeline and the journal have them all. */
const RECENT_NOTES = 5;

/** Pinned first, oldest first — a standing decision's age is part of it; then the newest few of the rest. */
export function notesForCard(notes: readonly RunNote[]): {
  pinned: RunNote[];
  recent: RunNote[];
  older: number;
} {
  const pinned = notes.filter((note) => note.pinned);
  const loose = notes.filter((note) => !note.pinned);
  return {
    pinned,
    recent: loose.slice(-RECENT_NOTES).reverse(),
    older: Math.max(0, loose.length - RECENT_NOTES),
  };
}

function NoteRow({
  note,
  onPin,
  busy,
}: {
  note: RunNote;
  onPin?: (id: string, pinned: boolean) => void;
  busy?: boolean;
}) {
  return (
    <li
      className={cn(
        'flex flex-col gap-1 rounded border border-rule/60 p-2',
        note.pinned && 'border-l-2 border-l-ink',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {note.pinned ? <Pin size={12} aria-label="Pinned" className="self-center text-ink" /> : null}
        <span className="text-2xs text-ink-muted">{note.by}</span>
        {note.phase !== undefined ? <Badge tone="neutral">phase {note.phase}</Badge> : null}
        <span className="ml-auto text-2xs text-ink-faint tabular-nums">
          {new Date(note.at).toLocaleString()}
        </span>
      </div>
      <p className="text-sm break-words whitespace-pre-wrap">{note.text}</p>
      {onPin ? (
        <div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onPin(note.id, !note.pinned)}>
            {note.pinned ? (
              <>
                <PinOff size={12} aria-hidden /> Unpin
              </>
            ) : (
              <>
                <Pin size={12} aria-hidden /> Pin
              </>
            )}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function NotesCard({ run, allowRun }: { run: RunState; allowRun?: boolean }) {
  const notes = run.notes ?? [];
  const { pinned, recent, older } = notesForCard(notes);
  const [text, setText] = useState('');
  const [pin, setPin] = useState(false);
  // `AskBox`'s discipline: a ref, so a click and an Enter in one tick send once.
  const inFlight = useRef(false);

  const write = useApiMutation({
    fn: (body: { text: string; pinned: boolean }) => api.runNote(run.slug, body),
    invalidates: [keys.run(run.slug)],
    say: (_result, body) => (body.pinned ? 'Note pinned' : 'Note saved'),
    onDone: () => {
      setText('');
      setPin(false);
    },
  });
  const pinning = useApiMutation({
    fn: (args: { id: string; pinned: boolean }) => api.runPinNote(run.slug, args.id, args.pinned),
    invalidates: [keys.run(run.slug)],
    say: (_result, args) => (args.pinned ? 'Pinned' : 'Unpinned'),
  });

  if (!notes.length && !allowRun) return null;

  const submit = () => {
    const body = text.trim();
    if (!body || inFlight.current) return;
    inFlight.current = true;
    write.mutate(
      { text: body, pinned: pin },
      {
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };
  const onPin = allowRun ? (id: string, next: boolean) => pinning.mutate({ id, pinned: next }) : undefined;

  return (
    <Card>
      <CardHeader className="flex-wrap items-baseline gap-x-3">
        <CardTitle>Notes</CardTitle>
        <span className="max-w-prose text-2xs text-ink-faint">
          What was decided about this run, and why. A pinned note stays here, and every phase that boards
          reads it, until someone unpins it.
        </span>
        {pinned.length ? <Badge tone="neutral">{pinned.length} pinned</Badge> : null}
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {pinned.length ? (
          <ul className="flex flex-col gap-2" aria-label="Pinned notes">
            {pinned.map((note) => (
              <NoteRow key={note.id} note={note} onPin={onPin} busy={pinning.isPending} />
            ))}
          </ul>
        ) : null}
        {recent.length ? (
          <ul className="flex flex-col gap-2" aria-label="Recent notes">
            {recent.map((note) => (
              <NoteRow key={note.id} note={note} onPin={onPin} busy={pinning.isPending} />
            ))}
          </ul>
        ) : null}
        {older ? (
          <p className="text-2xs text-ink-faint">
            {older} older note{older === 1 ? '' : 's'} on the timeline and in the journal.
          </p>
        ) : null}
        {!notes.length ? (
          <p className="text-sm text-ink-muted">
            No notes yet. When you decide something about this run, write it here so the next person to open
            it knows why.
          </p>
        ) : null}

        {allowRun ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="What did you decide, and why?"
              aria-label="Note"
              rows={2}
              disabled={write.isPending}
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-2xs text-ink-muted">
                <Checkbox
                  checked={pin}
                  onCheckedChange={(value) => setPin(value === true)}
                  aria-label="Pin it"
                />
                Pin it so every phase that boards reads it
              </label>
              <Button type="submit" size="sm" className="ml-auto" disabled={write.isPending || !text.trim()}>
                {write.isPending ? 'Saving…' : pin ? 'Pin note' : 'Save note'}
              </Button>
            </div>
          </form>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default NotesCard;
