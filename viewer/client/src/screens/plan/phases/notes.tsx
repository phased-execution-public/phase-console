/**
 * "Notes for this phase" — what earlier phases left for one that has not run.
 *
 * The block itself is built in bash and lives inside the phase's boot prompt,
 * where only the session that boards will ever read it. That is the right home
 * for it and the wrong home for an operator: the one question a person asks
 * about a forward note is *did it get through?*, and the only other way to
 * answer it is to board the phase and read its transcript.
 *
 * So this renders exactly what `phase-graph.sh --notes N` answers — the same
 * arm, through `GET /api/plans/<slug>/notes/<N>`, never a second reading of
 * the same three files. A page that parsed the handoffs itself would sooner or
 * later show a note the prompt did not carry, which is the failure the whole
 * feature exists to prevent.
 *
 * It fetches for itself, and only while `enabled`: notes are a subprocess on
 * the server and they belong to a phase somebody opened, not to every row of a
 * forty-phase board.
 */

import type { NoteKind, PhaseNote } from '@/data/api';
import { usePhaseNotes } from '@/data/plans';
import { Mono, RelativeTime, SectionHeading } from '@/ui';

/**
 * What each kind is, in one word and one sentence.
 *
 * The three are genuinely different promises and an operator reading the list
 * needs to know which they are looking at: a handoff bullet is a person
 * writing for a person, a deferral is a session's own record of what it left,
 * and a message is mail somebody addressed and can be told landed.
 */
const KIND_WORDS: Record<Exclude<NoteKind, 'trailer'>, { label: string; hint: string }> = {
  handoff: { label: 'handoff', hint: 'A bullet from an earlier phase’s Notes for later phases.' },
  deferral: { label: 'deferral', hint: 'A session recorded that it left this deliberately.' },
  message: { label: 'mail', hint: 'A peer addressed this to the phase; it is acknowledged by its id.' },
};

/** `-` is the engine's placeholder for "it never said" — a blank, never a fact. */
const said = (value: string | undefined): value is string => Boolean(value) && value !== '-';

function NoteRow({ note }: { note: PhaseNote }) {
  // The bound's own row: how a reader learns the list was cut.
  if (note.kind === 'trailer') return <li className="text-meta text-ink-muted">{note.text}</li>;
  const words = KIND_WORDS[note.kind];
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <p className="min-w-0 break-words text-body text-ink">
        <span className="me-2 text-meta text-ink-muted" title={words.hint}>
          {words.label}
        </span>
        {note.text}
      </p>
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-meta text-ink-muted">
        <Mono value={note.source} />
        {said(note.at) && <RelativeTime at={note.at} />}
        {said(note.id) && <Mono value={note.id} title="The id it is acknowledged by" />}
      </p>
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
  /** The fetch is the caller's to allow — a closed sheet asks for nothing. */
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
    <section aria-label="Notes for this phase" className="flex min-w-0 flex-col gap-2">
      <SectionHeading as="h3" count={real.length}>
        Notes for this phase
      </SectionHeading>
      <p className="max-w-(--measure) text-meta text-ink-muted">
        Its boot prompt carries these, in this order. Each was left by a phase that has finished.
      </p>
      <ul className="flex min-w-0 max-w-(--measure) flex-col gap-3">
        {notes.map((note, index) => (
          <NoteRow key={`${note.kind}:${note.id}:${index}`} note={note} />
        ))}
      </ul>
    </section>
  );
}
