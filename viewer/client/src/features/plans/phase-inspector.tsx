/**
 * A phase, in full — the disclosure ladder's L2 and L3 for the plan surface.
 *
 * `docs/design.md` §1 makes this law: every record owes a structured account of
 * itself one interaction from wherever it is summarized, and an L3 raw view
 * behind it. Phase 5 built the first two consumers (a run card, a lane); the
 * whole plan surface had NONE. A departures row's only door was a navigation —
 * you left the board, and your place on it, to read one phase — and the phases
 * tab's `<details>` drawer is L1 by construction AND answers a different
 * question: it is "Why is this not done?", a diagnosis it fetches for itself,
 * and it shows no phase prose at all.
 *
 * So this is the L2, and it is deliberately NOT a fourth arrangement of the
 * phase's fields. `PhaseDetails` (`phase-cells.tsx`) is already the one place
 * that says what a phase is beyond its row, and it is what the drawer renders;
 * this wraps it in the kit's `Inspector`, adds the identity row, and hangs the
 * record itself off the `raw` slot. If a field is missing here, it is missing
 * from `PhaseDetails`, and that is where it should be fixed — for both surfaces
 * at once.
 *
 * ⚠️ The raw slot prints `PhaseView` as the CLIENT holds it, which is the
 * server's projection and not the plan file. That is the honest thing to show
 * from a page that renders the projection — the plan's own bytes are the Source
 * tab, one click away, and saying otherwise would invent a provenance.
 */

import { Inspector } from '@/components/ui';
import { plainText } from '@/components/markdown';
import { PhaseStateChip } from '@/features/runs/phase-row';
import { usePlan } from '@/lib/queries';
import { pad2 } from '@/lib/format';
import type { PhaseEta, PhaseView } from '@/lib/api';
import { FlagsCell, LockChip, PhaseDetails, ScopeCell, SizeCell } from './phase-cells';
import { NotesSection } from './notes-section';

/**
 * What the sheet fetches FOR ITSELF, rather than making its host tab pay.
 *
 * `PhaseDetails` renders every prose field (Goal, Read first, Files, Steps,
 * Exit criteria, Verification, Handoff must record) and the handoff's
 * Outstanding section. Those are `?include=prose` and `?include=handoffs`, and
 * the Route and Phases tabs deliberately ask for NEITHER — the board projection
 * is what keeps opening a forty-phase plan cheap, and `tabs.ts` says so at
 * length. Adding them to those tabs would have made every plan open pay for
 * prose nobody had asked to read.
 *
 * So the sheet asks, on open. On the Phase and Autopilot tabs the key is
 * already warm (they ask for exactly this set), so inspecting there costs no
 * request at all; on the board it costs one, once, when somebody actually wants
 * the record.
 *
 * ⚠️ Module-level, and it must stay so: `usePlan` puts the include set in its
 * query key, and a fresh literal per render is a fresh key per render.
 * `tabs.test.ts`'s render-tree guard knows this component is a self-fetching
 * boundary and CHECKS that this list is what it actually asks for — so changing
 * one without the other fails, rather than silently rendering blanks.
 */
export const INSPECTOR_INCLUDES: readonly string[] = ['prose', 'handoffs'];

/**
 * The fetched record and the live one, combined — and a flat spread is WRONG.
 *
 * The live record wins every field it carries, because it is the one the tab's
 * own streaming query feeds. For the top-level prose fields that works by
 * itself: the board projection OMITS them (`PROSE_PHASE_FIELDS`), a key absent
 * from JSON is absent rather than `undefined`, and the spread leaves them
 * alone.
 *
 * ⚠️ `handoff` is the exception, and it cost a QA round. It is a **sub-field**
 * group (`HANDOFF_PROSE_FIELDS`, `shared/projection.js`): the board keeps the
 * reference — `FlagsCell` draws a `handoff <status>` chip from it on every
 * phase row — and strips only `outstanding` from inside it. So the live record
 * has a `handoff` that is PRESENT and LOSSY, and spreading it over the fetched
 * one silently threw away the paragraph this sheet paid a request to get:
 * `PhaseDetails` rendered "Outstanding" permanently blank, and the L3 raw slot
 * printed the same lossy object. Merging the two objects the same way round
 * restores it — the live copy still wins every key it has, and the one key it
 * does not have survives.
 *
 * Exactly the defect class `projection.js` documents beside that constant:
 * `ways-forward.tsx` once asserted a handoff "records no Outstanding section"
 * about a field it had not asked for. Here it HAD been asked for.
 */
function merged(fetched: PhaseView, live: PhaseView): PhaseView {
  const record: PhaseView = { ...fetched, ...live };
  if (fetched.handoff && live.handoff) record.handoff = { ...fetched.handoff, ...live.handoff };
  return record;
}

export function PhaseInspector({
  slug,
  phase,
  eta,
  open,
  onOpenChange,
}: {
  slug: string;
  phase: PhaseView;
  eta?: PhaseEta | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: full } = usePlan(open ? slug : undefined, INSPECTOR_INCLUDES);
  /*
   * MERGED, and the direction matters more than it looks.
   *
   * The caller's `phase` is the LIVE record: it comes from the query the tab
   * itself holds, which the stream updates, so its state, lock, `live` and
   * analysis are current to the last tick. The fetched one is a DIFFERENT
   * query key with its own lifetime — and under this client's
   * `staleTime: Infinity` it is fetched once and never again. Preferring it
   * wholesale (which this did, until a test caught it) froze the sheet's state
   * at the instant it first opened, on the one surface somebody opens
   * precisely to watch a phase move.
   *
   * So the fetch fills in what the board projection does not carry — the prose
   * — and the live record wins every field it has. A key absent from JSON is
   * absent, not `undefined`, so spreading the live record last never blanks a
   * prose field it simply does not know about.
   *
   * Before the fetch lands the caller's record stands alone: never a skeleton.
   * The board's `PhaseView` already answers most of what was asked, and
   * blanking it to wait for the rest is a worse answer than showing what is
   * known.
   */
  const prose = full?.phases.find((p) => p.phase === phase.phase);
  const record = prose ? merged(prose, phase) : phase;
  return (
    <Inspector
      open={open}
      onOpenChange={onOpenChange}
      /* The number is part of the name. A sheet titled with a phase title
         alone is unattributed the moment two plans are open in two tabs. */
      title={`Phase ${pad2(record.phase)} — ${plainText(record.title)}`}
      meta={
        <>
          {/* The same chip the board paints, so the sheet and the row it came
              from cannot disagree about what the phase is doing. It links to a
              live session and pulses only over an observed process — both of
              which are worth having here, where you have stopped to read. */}
          <PhaseStateChip slug={slug} phase={record.phase} state={record.state} live={record.live} />
          <SizeCell phase={record} eta={eta} />
          <LockChip lock={record.lock} compact />
          <ScopeCell phase={record} />
          <FlagsCell slug={slug} phase={record} />
        </>
      }
      raw={
        <pre className="m-0 font-mono text-2xs whitespace-pre-wrap">{JSON.stringify(record, null, 2)}</pre>
      }
    >
      <PhaseDetails slug={slug} phase={record} eta={eta} />
      {/* What earlier phases LEFT for this one. It hangs off the sheet rather
          than off `PhaseDetails` because it is not a field of the phase: it is
          three other files' opinion of it, fetched on open like the prose
          above, and nothing on a board row should pay a subprocess for it. */}
      <NotesSection slug={slug} phase={record.phase} enabled={open} />
    </Inspector>
  );
}

/**
 * The way in — one spelling, on every surface that lists a phase.
 *
 * A word rather than an icon: this sits inside table cells and card control
 * clusters that are already three chips deep, and a sixth glyph in that space
 * is a puzzle. It is a real `<button>`, which is also what keeps the departures
 * row's click handler off it — `route-tab.tsx`'s `INTERACTIVE` selector stands
 * the row down for any button, so pressing this opens the sheet instead of
 * navigating away from the board it was pressed on.
 */
export function InspectButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      /* `--ink-muted`, not `--ink-faint`, and it is the same finding that
         failed the band labels one round earlier. `contrast.test.ts` holds
         `--ink-faint` to the 3:1 LARGE-text floor only — measured 4.19:1 on
         `bg-surface` and 3.44:1 on `--ground` for this 12px word, against the
         4.5:1 AA floor. design.md §3 reserves faint for "true metadata"; this
         is the ONLY door to the inspector on both surfaces this phase built,
         and an affordance is never metadata. */
      className="shrink-0 text-2xs text-ink-muted hover:text-action [@media(hover:none)]:min-h-(--tap-min)"
    >
      inspect
    </button>
  );
}
