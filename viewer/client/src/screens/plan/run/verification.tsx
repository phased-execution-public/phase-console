/**
 * The Run view's Verification fold (7.0, quiet-console phase 26): what each
 * phase's §Verification came to, read from the plan's two ledgers.
 *
 * ```
 * Phase [Every phase ▾]
 *
 * Phase 12  the api
 * Still owes   npm test   2 failing tests: suite › a, suite › b
 * What its session proved
 *   ● Green  npm test  exit 0  tree 1a2b3c4d  head 5e6f7a8b  2 hours ago
 * The console’s verdicts, newest first
 *   ● Red    npm test  exit 1  took 12s  head 5e6f7a8b  run-7f3a, this run  2 hours ago
 *            Its own: suite › a, suite › b
 * Its baseline at boarding
 *   ● Green  npm test  exit 0  took 11s  head 0c1d2e3f  run-7f3a, this run  3 hours ago
 * ```
 *
 * A phase at a time, the one with the newest news first. What its session
 * proved is the last proof of each command it recorded (`phase-outcome.sh …
 * verified`): the exit as a word, and the tree and HEAD it ran against — a
 * green one at an equivalent tree is honoured instead of running the line.
 * The verdicts and the baseline are the console's own runs of each line, as
 * the ledger keeps them: a red verdict says which of its reds the server
 * charged to THIS phase (`own`) and which its baseline already had.
 *
 * What a phase still owes is the server's word, never this page's: the reds
 * its newest verdict on each line charged it with — unless its session has
 * proved that line green since, which the console honours and ledgers no row
 * for — and the reds other phases' verifications found and named it the owner
 * of (`owed`, on this run's record of it).
 *
 * The ledger answers its newest 200 rows; *Show older* asks for more, up to
 * the server's 2,000. The view reads that first page with the run, so the
 * fold's row can say how much it holds; the proofs, and any narrower or
 * longer read, wait until the fold is open.
 */

import { useId, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OwedRed, PhaseView, RunState } from '@/data/api';
import { runsApi, type VerifyWaiver } from '@/data/api/runs';
import { keys } from '@/data/keys';
import { press } from '@/data/press';
import {
  VERIFICATIONS_PAGE,
  VERIFICATIONS_PAGE_MAX,
  useRunProofs,
  useRunVerifications,
  type RunProof,
  type VerificationRow,
} from '@/data/verification';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import { Button, Duration, Label, Mono, RelativeTime, toast } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { NativeSelect } from '@/ui/native-select';
import { OpsStatus } from '@/ui/status';
import { Textarea } from '@/ui/textarea';

/** The ledger's mark for a red whose output named no test: the whole command (`verify-ledger.ts` `WHOLE_COMMAND`). */
const WHOLE = '*';

/** How many failing tests a line names before the rest are counted. */
const NAMED = 5;

/** How another phase's verification found that this one owns a red (`state.ts` `InheritedRed.how`). */
const OWED_HOW: Readonly<Record<OwedRed['how'], string>> = {
  charged: 'it was charged with it before',
  commit: 'its commits brought it in',
  wip: 'its uncommitted work brought it in',
  'wip-red': 'its wrap-up gate saw the same red',
};

/** A red a phase's newest verdict on a line charged it with. */
interface Owed {
  command: string;
  chain?: string;
  failures: string[];
  at: string;
}

/** One phase's share of the two ledgers. */
interface PhaseShare {
  phase: number;
  /** The newest moment anything here was written, for the order. */
  latest: number;
  proofs: RunProof[];
  /** Newest first, as the ledger answered. */
  verdicts: VerificationRow[];
  baselines: VerificationRow[];
  owes: Owed[];
  owedByOthers: OwedRed[];
  /** The operator's mid-run waivers of this phase's lines (one-pool phase 21, #267). */
  waivers: VerifyWaiver[];
}

const ms = (at: string): number => {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** A line of the plan's §Verification: a chain's member is its own line. */
const lineKey = (row: { command: string; chain?: string | undefined }) =>
  `${row.chain ?? ''}\u0000${row.command}`;

/**
 * The reds a phase's newest verdict on each line charged it with. A run its
 * clock cut, or one this machine could not run, says nothing about the line,
 * so the verdict before it stands; a green proof its session recorded after
 * the verdict is what the console honours instead of a row.
 */
function stillOwed(verdicts: readonly VerificationRow[], proofs: readonly RunProof[]): Owed[] {
  const answered = new Set<string>();
  const out: Owed[] = [];
  for (const row of verdicts) {
    if (row.timedOut || row.environment) continue;
    const key = lineKey(row);
    if (answered.has(key)) continue;
    answered.add(key);
    if (row.ok || !row.own?.length) continue;
    const proof = proofs.find((one) => one.command === (row.chain ?? row.command));
    if (proof && proof.code === 0 && ms(proof.at) > ms(row.at)) continue;
    out.push({
      command: row.command,
      ...(row.chain ? { chain: row.chain } : {}),
      failures: row.own.filter((id) => id !== WHOLE),
      at: row.at,
    });
  }
  return out;
}

/** Every phase with anything on file, the newest news first. */
function sharesOf(
  rows: readonly VerificationRow[],
  proofs: readonly RunProof[],
  owed: ReadonlyMap<number, OwedRed[]>,
  waivers: readonly VerifyWaiver[] = [],
): PhaseShare[] {
  const by = new Map<number, PhaseShare>();
  const share = (phase: number): PhaseShare => {
    let found = by.get(phase);
    if (!found) {
      found = {
        phase,
        latest: 0,
        proofs: [],
        verdicts: [],
        baselines: [],
        owes: [],
        owedByOthers: [],
        waivers: [],
      };
      by.set(phase, found);
    }
    return found;
  };
  for (const waiver of waivers) {
    const one = share(waiver.phase);
    one.waivers.push(waiver);
    one.latest = Math.max(one.latest, ms(waiver.at));
  }
  for (const row of rows) {
    const one = share(row.phase);
    (row.kind === 'baseline' ? one.baselines : one.verdicts).push(row);
    one.latest = Math.max(one.latest, ms(row.at));
  }
  for (const proof of proofs) {
    const one = share(proof.phase);
    one.proofs.push(proof);
    one.latest = Math.max(one.latest, ms(proof.at));
  }
  for (const [phase, reds] of owed) {
    const one = share(phase);
    one.owedByOthers = reds;
    for (const red of reds) one.latest = Math.max(one.latest, ms(red.at));
  }
  for (const one of by.values()) {
    const waived = new Set(one.waivers.map((waiver) => waiver.text));
    one.owes = stillOwed(one.verdicts, one.proofs).filter((red) => !waived.has(red.chain ?? red.command));
  }
  return [...by.values()].sort((a, b) => b.latest - a.latest || b.phase - a.phase);
}

/** The failing tests a line named — the first few, the rest counted; the whole command when it named none. */
function namedTests(ids: readonly string[]): string {
  if (!ids.length) return 'the whole command';
  const rest = ids.length - NAMED;
  return `${ids.slice(0, NAMED).join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/** "2 failing tests: a, b" — or the whole command, when its output named no test. */
function owedWords(ids: readonly string[]): string {
  return ids.length ? `${plural(ids.length, 'failing test')}: ${namedTests(ids)}` : 'the whole command';
}

export function RunVerificationFold({
  slug,
  run,
  planPhases,
}: {
  slug: string;
  run: RunState | null;
  planPhases: readonly Pick<PhaseView, 'phase' | 'title'>[];
}) {
  const id = useId();
  const [phase, setPhase] = useState<number | undefined>(undefined);
  const [limit, setLimit] = useState(VERIFICATIONS_PAGE);
  const proofs = useRunProofs(slug, { phase });
  const ledger = useRunVerifications(slug, { phase, limit });

  const titles = useMemo(() => new Map(planPhases.map((one) => [one.phase, one.title])), [planPhases]);
  const owed = useMemo(() => {
    const out = new Map<number, OwedRed[]>();
    for (const record of Object.values(run?.phases ?? {})) {
      if (record.owed?.length && (phase === undefined || record.phase === phase))
        out.set(record.phase, record.owed);
    }
    return out;
  }, [run, phase]);
  const waivers = useMemo(
    () => (run?.verifyWaivers ?? []).filter((one) => phase === undefined || one.phase === phase),
    [run, phase],
  );
  const shares = useMemo(
    () => sharesOf(ledger.data?.rows ?? [], proofs.data?.proofs ?? [], owed, waivers),
    [ledger.data, proofs.data, owed, waivers],
  );

  const choose = (value: string) => {
    const picked = Number(value);
    setPhase(Number.isInteger(picked) && picked > 0 ? picked : undefined);
    setLimit(VERIFICATIONS_PAGE);
  };
  const page = ledger.data;
  const cut = page?.rows ? Math.max(0, page.total - page.rows.length) : 0;
  const more = Math.min(VERIFICATIONS_PAGE, cut, VERIFICATIONS_PAGE_MAX - limit);
  const reading = ledger.isPending || proofs.isPending;
  const busy = ledger.isPlaceholderData || proofs.isPlaceholderData;

  return (
    <div data-testid="run-verification" className="flex min-w-0 flex-col gap-4">
      {planPhases.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Label htmlFor={`${id}-phase`} className="text-meta font-normal text-ink-muted">
            Phase
          </Label>
          <NativeSelect
            id={`${id}-phase`}
            data-testid="verification-phase-filter"
            value={phase ?? ''}
            onChange={(event) => choose(event.target.value)}
            className="w-auto"
          >
            <option value="">Every phase</option>
            {planPhases.map((one) => (
              <option key={one.phase} value={one.phase}>
                Phase {one.phase} — {one.title}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}

      {ledger.error && (
        <p role="alert" className="text-meta text-failed" data-testid="verification-error">
          The verification ledger could not be read: {ledger.error.message}
        </p>
      )}
      {proofs.error && (
        <p role="alert" className="text-meta text-failed" data-testid="verification-error">
          The sessions’ proofs could not be read: {proofs.error.message}
        </p>
      )}

      {reading ? (
        <p className="text-meta text-ink-muted" data-testid="verification-reading">
          Reading what was verified.
        </p>
      ) : shares.length === 0 ? (
        !ledger.error &&
        !proofs.error && (
          <p className="text-body text-ink-muted" data-testid="verification-empty">
            {phase === undefined
              ? 'Nothing is on file yet: no session recorded a proof and the console verified nothing.'
              : `Nothing is on file for phase ${phase}.`}
          </p>
        )
      ) : (
        <div
          className={cn('flex min-w-0 flex-col gap-6', busy && 'opacity-60')}
          aria-busy={busy || undefined}
        >
          {shares.map((share) => (
            <PhaseVerification
              key={share.phase}
              slug={slug}
              share={share}
              title={titles.get(share.phase)}
              runId={run?.id ?? null}
            />
          ))}
        </div>
      )}

      {page && cut > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-meta text-ink-muted" data-testid="verification-cut">
            The newest <span className="tnum">{page.rows.length}</span> of{' '}
            <span className="tnum">{page.total}</span> runs of a line.
          </p>
          {more > 0 && (
            <Button
              size="sm"
              data-testid="verification-more"
              disabled={busy}
              onClick={() => setLimit(Math.min(limit + VERIFICATIONS_PAGE, VERIFICATIONS_PAGE_MAX))}
            >
              Show {more} older
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** One phase: what it owes, what its session proved, the console's verdicts and its baseline. */
function PhaseVerification({
  slug,
  share,
  title,
  runId,
}: {
  slug: string;
  share: PhaseShare;
  title: string | undefined;
  runId: string | null;
}) {
  const owes = share.owes.length + share.owedByOthers.length;
  return (
    <section
      data-testid="verification-phase"
      data-phase={share.phase}
      aria-label={`Phase ${share.phase}`}
      className="flex min-w-0 flex-col gap-3"
    >
      <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-section font-semibold text-ink">
        <span className="tnum">Phase {share.phase}</span>{' '}
        {title ? (
          <span className="min-w-0 break-words text-body font-normal text-ink-muted">{title}</span>
        ) : null}
      </h3>

      {owes > 0 && (
        <Part title="Still owes" testId="verification-owes">
          {share.owes.map((red) => (
            <li key={`own|${lineKey(red)}`} data-testid="verification-owed" className={LINE}>
              <OpsStatus vocab="verification" word="red" title="Its own red, charged by its newest verdict" />
              <Command command={red.command} chain={red.chain} />
              <span className="min-w-0 break-words text-meta text-ink">{owedWords(red.failures)}</span>
              <When at={red.at} />
              {runId ? (
                <WaiveLine slug={slug} runId={runId} phase={share.phase} line={red.chain ?? red.command} />
              ) : null}
            </li>
          ))}
          {share.owedByOthers.map((red, index) => (
            <li key={`found|${lineKey(red)}|${index}`} data-testid="verification-owed-found" className={LINE}>
              <OpsStatus
                vocab="verification"
                word="red"
                title="Another phase’s verification named this one its owner"
              />
              <Command command={red.command} chain={red.chain} />
              <span className="min-w-0 break-words text-meta text-ink">{owedWords(red.failures)}</span>
              <span className="min-w-0 break-words text-meta text-ink-muted">
                Found by phase <span className="tnum">{red.by}</span>: {OWED_HOW[red.how] ?? red.how}
              </span>
              <When at={red.at} />
            </li>
          ))}
        </Part>
      )}

      {share.waivers.length > 0 && (
        <Part title="Waived by the operator" testId="verification-waivers">
          {share.waivers.map((waiver) => (
            <li key={waiver.fp} data-testid="verification-waiver" className={LINE}>
              <OpsStatus
                vocab="verification-line"
                word="skipped"
                title="Set aside by the operator mid-run, never run"
              />
              <Command command={waiver.text} />
              <span className="min-w-0 break-words text-meta text-ink">
                {waiver.by}: {waiver.reason}
              </span>
              <When at={waiver.at} />
            </li>
          ))}
        </Part>
      )}

      <Part title="What its session proved" testId="verification-proofs">
        {share.proofs.length ? (
          share.proofs.map((proof) => <ProofLine key={proof.command} proof={proof} />)
        ) : (
          <li className="text-meta text-ink-muted">Its session recorded no proof.</li>
        )}
      </Part>

      {share.verdicts.length > 0 && (
        <Part title="The console’s verdicts, newest first" testId="verification-verdicts">
          {share.verdicts.map((row, index) => (
            <RunLine key={`${row.at}|${lineKey(row)}|${index}`} row={row} runId={runId} />
          ))}
        </Part>
      )}

      {share.baselines.length > 0 && (
        <Part title="Its baseline at boarding" testId="verification-baselines">
          {share.baselines.map((row, index) => (
            <RunLine key={`${row.at}|${lineKey(row)}|${index}`} row={row} runId={runId} />
          ))}
        </Part>
      )}
    </section>
  );
}

/**
 * Waive this line (one-pool phase 21, #267): the owner's word that a red is
 * not the phase's, for this phase alone, with a reason. Pressed through the
 * owner door; recorded as a ruling on the plan's ledger and honoured at the
 * phase's next verification.
 */
function WaiveLine({
  slug,
  runId,
  phase,
  line,
}: {
  slug: string;
  runId: string;
  phase: number;
  line: string;
}) {
  const client = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <Button size="sm" data-testid="verification-waive" onClick={() => setOpen(true)}>
        Waive this line
      </Button>
    );
  }
  const waive = async () => {
    setBusy(true);
    try {
      const pressed = await press(() => runsApi.runVerifyWaive(slug, phase, line, reason.trim(), runId));
      if (pressed.state === 'asked') toast(pressed.words, 'info');
      else toast(`Phase ${phase} no longer runs this line — the waiver is on the plan's rulings.`, 'ok');
      setOpen(false);
      setReason('');
    } catch (error) {
      toast(String((error as Error)?.message || 'The waiver was refused and said nothing.'), 'error');
    } finally {
      setBusy(false);
      for (const key of keys.afterRunAct(slug)) void client.invalidateQueries({ queryKey: key });
    }
  };
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5" data-testid="verification-waive-form">
      <Label htmlFor={`${id}-reason`} className="text-meta font-normal text-ink-muted">
        Why is this red not phase {phase}'s? It is recorded as a ruling.
      </Label>
      <Textarea
        id={`${id}-reason`}
        data-testid="verification-waive-reason"
        value={reason}
        rows={2}
        onChange={(event) => setReason(event.target.value)}
      />
      <span className="flex min-w-0 flex-wrap gap-2">
        <Button
          size="sm"
          data-testid="verification-waive-confirm"
          disabled={busy || !reason.trim()}
          onClick={() => void waive()}
        >
          Waive it for phase {phase}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

/** One line of facts that wraps between them, never inside one. */
const LINE = 'flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5';

function Part({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <h4 className="text-meta text-ink-muted">{title}</h4>
      <ul className="flex min-w-0 flex-col gap-2">{children}</ul>
    </div>
  );
}

/** The line as the plan writes it — a chain's member says the chain it was run alone from. */
function Command({ command, chain }: { command: string; chain?: string | undefined }) {
  return (
    <span className="flex min-w-0 flex-col">
      <Mono value={command} words className="text-ink" />
      {chain ? (
        <span className="min-w-0 text-meta text-ink-muted">
          run alone from <Mono value={chain} words />
        </span>
      ) : null}
    </span>
  );
}

function When({ at }: { at: string }) {
  return <RelativeTime at={at} live={false} className="text-meta text-ink-muted" />;
}

/** A commit or tree, short — the whole sha on hover. */
function Sha({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <span className="text-meta text-ink-muted">
      {label} <Mono value={value} chars={8} />
    </span>
  );
}

function ProofLine({ proof }: { proof: RunProof }) {
  return (
    <li data-testid="verification-proof" className={LINE}>
      <OpsStatus
        vocab="verification"
        word={proof.code === 0 ? 'green' : 'red'}
        title={
          proof.code === 0 ? 'Its session ran it green' : 'Its session ran it red — a red proves nothing'
        }
      />
      <Command command={proof.command} />
      <span className="tnum text-meta text-ink-muted">exit {proof.code}</span>
      <Sha label="tree" value={proof.tree} />
      <Sha label="head" value={proof.head} />
      <When at={proof.at} />
    </li>
  );
}

/** One run of one line by the console — a verdict, or the baseline it was held to. */
function RunLine({ row, runId }: { row: VerificationRow; runId: string | null }) {
  const word = row.timedOut ? 'timed-out' : row.environment ? 'skipped' : row.ok ? 'green' : 'red';
  const own = row.own ?? [];
  const inherited = (row.failures ?? []).filter((failure) => !own.includes(failure));
  return (
    <li
      data-testid="verification-run"
      data-kind={row.kind}
      data-word={word}
      className="flex min-w-0 flex-col gap-1"
    >
      <span className={LINE}>
        <OpsStatus
          vocab="verification-line"
          word={word}
          {...(row.timedOut
            ? { title: 'Not judged: its clock cut it, which proves only that it ran past the limit' }
            : row.environment
              ? { title: 'Not judged: this machine could not run it' }
              : {})}
        />
        <Command command={row.command} chain={row.chain} />
        {row.environment ? (
          <span className="min-w-0 break-words text-meta text-ink-muted">
            could not run here: {row.environment}
          </span>
        ) : row.timedOut ? (
          <span className="text-meta text-ink-muted">
            cut at its limit after <Duration ms={row.ms} />
          </span>
        ) : (
          <>
            <span className="tnum text-meta text-ink-muted">exit {row.code}</span>
            <span className="text-meta text-ink-muted">
              took <Duration ms={row.ms} />
            </span>
          </>
        )}
        <Sha label="head" value={row.head} />
        {row.run ? (
          <span className="text-meta text-ink-muted">
            <Mono value={row.run} chars={8} />
            {row.run === runId ? ', this run' : ''}
          </span>
        ) : null}
        <When at={row.at} />
      </span>
      {word === 'red' && row.kind === 'verify' && (
        <span className="min-w-0 break-words text-meta text-ink" data-testid="verification-charge">
          {own.length
            ? `Its own: ${namedTests(own.filter((id) => id !== WHOLE))}.`
            : 'Inherited: its baseline was red on it too.'}
          {inherited.length ? ` Already red at its baseline: ${namedTests(inherited)}.` : ''}
        </span>
      )}
      {word === 'red' && row.kind === 'baseline' && row.failures?.length ? (
        <span className="min-w-0 break-words text-meta text-ink-muted">
          Failing: {namedTests(row.failures)}.
        </span>
      ) : null}
      {row.tail ? (
        <Disclosure label="What it printed" openLabel="Hide what it printed" bodyClassName="pt-1">
          <pre className="max-h-60 min-w-0 overflow-auto rounded-sm border border-rule p-2 font-mono text-meta whitespace-pre-wrap wrap-anywhere">
            {row.tail}
          </pre>
        </Disclosure>
      ) : null}
    </li>
  );
}
