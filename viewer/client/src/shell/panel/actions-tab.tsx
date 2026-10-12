import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConsoleState } from '@/data/console';
import { keys } from '@/data/keys';
import { PressRefusal } from '@/data/press';
import { useQueueAct, type QueueMove, type QueueMoveBody } from '@/data/queue';
import { SURFACE } from '@/data/surface';
import { pressVerb, type VerbArgs } from '@/data/verbs';
import { Button, SectionHeading, toast } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { NativeSelect } from '@/ui/native-select';
import {
  lackedFlag,
  verbDoorHref,
  verbOffers,
  type Capabilities,
  type RecordKind,
  type VerbOffer,
} from './verbs';

/**
 * The inspector's Actions tab: every verb the registry knows for this KIND of
 * record (`./verbs`) — its acts, then, for a phase, its place in the queue,
 * then its reads. An act its record's identity is enough for is pressed through
 * the one door (`data/verbs.ts` → `data/press.ts`), exactly as `phase-console
 * run <verb>` presses it, and asks once — press, then confirm — because a wrong
 * act on a run costs a session. One that takes more (words, an account, a
 * decision) is a link to where it is drawn, never a press with an empty body;
 * a read is a link to where it is read. A verb the console cannot press says
 * which flag it lacks.
 */
export function ActionsTab({
  kind,
  args,
  capabilities,
  only,
}: {
  /** The record this tab is about — or, for a plan that has a run, both records. */
  kind: RecordKind | readonly RecordKind[];
  /** Its identity: `{slug}` a plan, `{slug, runId}` a run, `{slug, phase}` a phase, `{id}` a card. */
  args: VerbArgs;
  /** The console's flags — this console's own, read live, when not given. */
  capabilities?: Capabilities | undefined;
  /** `act` verbs only, or `read` only — both by default. */
  only?: 'act' | 'read';
}) {
  const { data: state } = useConsoleState();
  const flags = capabilities ?? (state as Capabilities | undefined);
  const kinds: readonly RecordKind[] = typeof kind === 'string' ? [kind] : kind;
  const offers = verbOffers(kinds, args, flags).filter(
    // A read only a terminal waits on is its line, and a tree whose CLI cannot run it has no row for it.
    (offer) => (!only || offer.kind === only) && (offer.line || !scriptOnly(offer)),
  );
  const acts = offers.filter((offer) => offer.kind === 'act');
  const reads = offers.filter((offer) => offer.kind === 'read');
  const slug = typeof args.slug === 'string' && args.slug ? args.slug : null;
  const phase = Number(args.phase);
  const queue =
    kinds.includes('phase') && only !== 'read' && slug !== null && Number.isSafeInteger(phase) && phase > 0;

  if (!acts.length && !reads.length && !queue) {
    return <p className="text-body text-ink-muted">Nothing to press here.</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="verb-actions">
      {acts.length > 0 && (
        <Group heading="Acts">
          {acts.map((offer) => (
            <OfferRow key={offer.name} offer={offer} />
          ))}
        </Group>
      )}
      {queue && (
        <Group heading="Queue">
          <QueueMoves slug={slug} phase={phase} capabilities={flags} />
        </Group>
      )}
      {reads.length > 0 && (
        <Group heading="Reads">
          {reads.map((offer) => (
            <OfferRow key={offer.name} offer={offer} />
          ))}
        </Group>
      )}
    </div>
  );
}

/** A read no page draws — the registry gives it no door (`wait`, which a script waits on): only ever its line. */
const scriptOnly = (offer: VerbOffer) => offer.kind === 'read' && !offer.door;

/** What an identity field is called in a sentence. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  slug: 'the plan',
  phase: 'the phase',
  id: 'the id',
  runId: 'the run’s id',
};

const failureWords = (error: unknown) =>
  error instanceof PressRefusal ? error.message : String((error as Error)?.message ?? error);

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={heading} className="flex min-w-0 flex-col gap-1.5">
      <SectionHeading as="h3">{heading}</SectionHeading>
      <ul className="flex min-w-0 flex-col gap-1">{children}</ul>
    </div>
  );
}

/** One row: what it is, what it does — or why it cannot be done here — and its one control. */
function Line({
  name,
  mono,
  words,
  children,
}: {
  name: string;
  mono: boolean;
  words: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-1">
      <span className="min-w-0">
        <span className={mono ? 'block font-mono text-body text-ink' : 'block text-body text-ink'}>
          {name}
        </span>
        {words}
      </span>
      {children}
    </li>
  );
}

function OfferWords({ offer }: { offer: VerbOffer }) {
  if (offer.needs) {
    return <span className="block text-meta text-ink-muted">Needs {offer.needs} on this console.</span>;
  }
  const takes =
    offer.mode === 'open'
      ? (offer.takes ?? offer.missing.map((field) => FIELD_WORDS[field] ?? field).join(' and '))
      : '';
  return (
    <>
      {offer.summary && <span className="block text-meta text-ink-muted">{offer.summary}</span>}
      {takes && (
        <span className="block text-meta text-ink-muted">Takes {takes}: open it where it is drawn.</span>
      )}
    </>
  );
}

function OfferRow({ offer }: { offer: VerbOffer }) {
  if (offer.mode === 'press') return <PressRow offer={offer} />;
  const words = <OfferWords offer={offer} />;
  if (scriptOnly(offer) && offer.line) {
    return (
      <Line name={offer.name} mono words={words}>
        <CopyButton text={offer.line} aria-label={`Copy the ${offer.name} line: ${offer.line}`} />
      </Line>
    );
  }
  const href =
    offer.door && !offer.needs ? verbDoorHref(offer.door, offer.identity, { name: offer.name }) : null;
  return (
    <Line name={offer.name} mono words={words}>
      {href ? (
        <Button asChild size="sm">
          <a href={href} aria-label={`Open ${offer.name}`}>
            Open
          </a>
        </Button>
      ) : (
        <Button size="sm" disabled aria-label={`Open ${offer.name}`}>
          Open
        </Button>
      )}
    </Line>
  );
}

/** An act its record's identity is enough for: pressed by name, after a second press to confirm. */
function PressRow({ offer }: { offer: VerbOffer }) {
  const client = useQueryClient();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const fire = async () => {
    setBusy(true);
    try {
      const pressed = await pressVerb(offer.name, offer.args, offer.body);
      if (pressed.state === 'asked') toast(pressed.words, 'info');
      else toast(`${offer.name}: done.`);
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setBusy(false);
      setArmed(false);
      const slug = offer.identity.slug;
      for (const key of typeof slug === 'string' ? keys.afterRunAct(slug) : [keys.approvals()])
        void client.invalidateQueries({ queryKey: key });
    }
  };

  return (
    <Line name={offer.name} mono words={<OfferWords offer={offer} />}>
      <Button
        size="sm"
        variant={armed ? 'primary' : 'default'}
        disabled={Boolean(offer.needs) || busy}
        aria-label={`${armed ? 'Confirm' : 'Press'} ${offer.name}`}
        onClick={() => (armed ? void fire() : setArmed(true))}
        onBlur={() => setArmed(false)}
      >
        {busy ? 'Pressing…' : armed ? 'Confirm' : 'Press'}
      </Button>
    </Line>
  );
}

/* ------------------------------------------------------------------ *
 * A phase's place in the queue
 * ------------------------------------------------------------------ */

interface Move {
  verb: QueueMove;
  label: string;
  summary: string;
  /** What it did, after "Phase N: ". */
  done: string;
}

/** The five moves, in the order an operator reaches for them (`shared/orchestration-model.js`). */
const MOVES: readonly Move[] = [
  {
    verb: 'hold',
    label: 'Hold in the queue',
    summary: 'It stays in the queue and is never admitted until it is released.',
    done: 'held in the queue',
  },
  { verb: 'release', label: 'Release', summary: 'Lifts a hold or a deferral.', done: 'released' },
  {
    verb: 'defer',
    label: 'Defer until…',
    summary: 'A hold that lifts by itself at the time you choose.',
    done: 'deferred',
  },
  {
    verb: 'withdraw',
    label: 'Withdraw',
    summary: 'Out of the queue: the run boards its other phases instead.',
    done: 'withdrawn from the queue',
  },
  {
    verb: 'requeue',
    label: 'Requeue at the front',
    summary: 'Back in the queue, ahead of its seniority.',
    done: 'requeued at the front',
  },
];

/** How far a deferral reaches, from the moment it is pressed. */
const DEFER_FOR: readonly { minutes: number; label: string }[] = [
  { minutes: 30, label: '30 minutes from now' },
  { minutes: 60, label: 'An hour from now' },
  { minutes: 240, label: 'Four hours from now' },
  { minutes: 1440, label: 'A day from now' },
];

/**
 * Hold, release, defer, withdraw and requeue — the queue's word on this one
 * phase (`useQueueAct`, `POST /api/queue/<verb>` with `{slug, phase}`). Durable:
 * the mark is on the phase's record, so it outlives the entry a retry or a
 * restart re-creates. Run class, like every verb that changes what starts.
 */
function QueueMoves({
  slug,
  phase,
  capabilities,
}: {
  slug: string;
  phase: number;
  capabilities: Capabilities | undefined;
}) {
  return (
    <>
      {MOVES.map((move) => (
        <MoveRow
          key={move.verb}
          move={move}
          slug={slug}
          phase={phase}
          needs={lackedFlag(
            SURFACE.find((row) => row.id === `POST /api/queue/${move.verb}`),
            capabilities,
          )}
        />
      ))}
    </>
  );
}

function MoveRow({
  move,
  slug,
  phase,
  needs,
}: {
  move: Move;
  slug: string;
  phase: number;
  needs: string | undefined;
}) {
  const act = useQueueAct();
  const [armed, setArmed] = useState(false);
  const [minutes, setMinutes] = useState(DEFER_FOR[1]!.minutes);

  const fire = async () => {
    const extra: QueueMoveBody =
      move.verb === 'defer'
        ? { until: new Date(Date.now() + minutes * 60_000).toISOString() }
        : move.verb === 'requeue'
          ? { position: 'front' }
          : {};
    try {
      const pressed = await act.mutateAsync({ verb: move.verb, slug, phase, ...extra });
      if (pressed.state === 'asked') toast(pressed.words, 'info');
      else
        toast(
          pressed.result.change?.changed === false
            ? `Phase ${phase} already stood that way: nothing moved.`
            : `Phase ${phase}: ${move.done}.`,
        );
    } catch (error) {
      toast(failureWords(error), 'error');
    } finally {
      setArmed(false);
    }
  };

  const words = needs ? (
    <span className="block text-meta text-ink-muted">Needs {needs} on this console.</span>
  ) : (
    <span className="block text-meta text-ink-muted">{move.summary}</span>
  );
  return (
    <Line name={move.label} mono={false} words={words}>
      <span className="flex shrink-0 items-center gap-2">
        {move.verb === 'defer' && (
          <NativeSelect
            aria-label="Defer until"
            value={minutes}
            disabled={Boolean(needs)}
            onChange={(event) => setMinutes(Number(event.target.value))}
          >
            {DEFER_FOR.map((choice) => (
              <option key={choice.minutes} value={choice.minutes}>
                {choice.label}
              </option>
            ))}
          </NativeSelect>
        )}
        <Button
          size="sm"
          variant={armed ? 'primary' : 'default'}
          disabled={Boolean(needs) || act.isPending}
          aria-label={`${armed ? 'Confirm' : 'Press'} ${move.label.replace('…', '')}`}
          onClick={() => (armed ? void fire() : setArmed(true))}
          onBlur={() => setArmed(false)}
        >
          {act.isPending ? 'Pressing…' : armed ? 'Confirm' : 'Press'}
        </Button>
      </span>
    </Line>
  );
}
