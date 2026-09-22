/**
 * "Notes for this phase" — what earlier phases left for one that has not run.
 *
 * The block itself is built in bash and lives inside the phase's boot prompt,
 * where only the session that boards will ever read it. That is the right home
 * for it and the wrong home for an operator: the one question a person asks
 * about a forward note is *did it get through?*, and until this existed the
 * only way to answer was to board the phase and read its transcript.
 *
 * So this renders exactly what `phase-graph.sh --notes N` answers — the same
 * arm, through `GET /api/plans/<slug>/notes/<N>`, never a second reading of
 * the same three files. A page that parsed the handoffs itself would sooner or
 * later show a note the prompt did not carry, which is the failure the whole
 * feature exists to prevent.
 *
 * It fetches for itself, on open, like the inspector around it: notes are a
 * subprocess on the server and they belong to a phase somebody opened, not to
 * every row of a forty-phase board.
 */

import { Chip } from '@/components/ui';
import { usePhaseNotes } from '@/lib/queries';
import type { NoteKind, PhaseNote } from '@/lib/api';

/**
 * What each kind is, in one word and one sentence.
 *
 * The three are genuinely different promises and an operator reading the list
 * needs to know which they are looking at: a handoff bullet is a person
 * writing for a person, a deferral is a session's own record of what it left,
 * and a message is mail somebody addressed and can be told landed.
 */
const KIND_COPY: Record<Exclude<NoteKind, 'trailer'>, { label: string; hint: string }> = {
  handoff: { label: 'handoff', hint: 'a bullet from an earlier phase’s ## Notes for later phases' },
  deferral: { label: 'deferral', hint: 'a session recorded that it left this deliberately' },
  message: { label: 'mail', hint: 'a peer addressed this to the phase; it is acknowledged by id' },
};

function NoteRow({ note }: { note: PhaseNote }) {
  if (note.kind === 'trailer') {
    return <li className="text-xs text-muted-foreground italic">{note.text}</li>;
  }
  const copy = KIND_COPY[note.kind];
  return (
    <li className="flex gap-2 text-sm">
      <Chip title={copy.hint}>{copy.label}</Chip>
      <div className="min-w-0">
        <p className="break-words">{note.text}</p>
        <p className="text-xs text-muted-foreground">
          {note.source}
          {note.at && note.at !== '-' ? ` · ${note.at}` : ''}
          {note.id && note.id !== '-' ? ` · ${note.id}` : ''}
        </p>
      </div>
    </li>
  );
}

export function NotesSection({
  slug,
  phase,
  enabled = true,
}: {
  slug: string;
  phase: number;
  enabled?: boolean;
}) {
  const { data, isPending, isError } = usePhaseNotes(slug, phase, enabled);
  if (!enabled || isPending || isError) return null;
  const notes = data?.notes ?? [];
  // Nothing left for this phase is the ordinary case and it is not a finding:
  // a section that renders "no notes" on every phase of every plan is a
  // section people learn to skip, and then miss the phase that has one.
  if (!notes.length) return null;
  const real = notes.filter((note) => note.kind !== 'trailer');
  return (
    <section aria-label="Notes for this phase" className="space-y-2">
      <h4 className="text-sm font-medium">
        Notes for this phase <span className="text-muted-foreground">({real.length})</span>
      </h4>
      <p className="text-xs text-muted-foreground">
        Its boot prompt carries these, in this order. Each was left by a phase that has finished.
      </p>
      <ul className="space-y-2">
        {notes.map((note, index) => (
          <NoteRow key={`${note.kind}:${note.id}:${index}`} note={note} />
        ))}
      </ul>
    </section>
  );
}
