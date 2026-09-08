import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CopyButton,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableWrap,
  stickyHeadCell,
  useTableFit,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { RouteMap, type PhaseDriver } from '@/components/dag';
import { PhaseStateChip } from '@/features/runs/phase-row';
import { PromptCard } from '@/components/prompt-card';
import { HealthPanel } from './health-panel';
import { LandingCard } from './landing-card';
import { api } from '@/lib/api';
import { isClosed } from '@/lib/closure';
import { keys } from '@/lib/queries';
import { pad2 } from '@/lib/format';
import { navigate, phaseHref } from '@shared/routes.js';
import type { PhaseEta, PhaseView, PlanDetail } from '@/lib/api';
import { DepsCell, FlagsCell, LockCell, ScopeCell, SizeCell, TitleCell } from './phase-cells';
import { InspectButton, PhaseInspector } from './phase-inspector';
import { usePhone } from '@/lib/media';
import { PhasesTab } from './phases-tab';

/** The estimate for one phase, or nothing on a source with no plan detail. */
const etaFor = (detail: PlanDetail, phase: number) => detail.eta?.perPhase.find((e) => e.phase === phase);

/**
 * The map, drawn only when what it draws has changed.
 *
 * Memoised HERE rather than at its definition because this is the caller that
 * can hold its props still: `route`, `batches` and `budget` come from a query
 * with structural sharing, and `focus` and `onSelect` are stabilised in
 * `RouteTab` below. A `memo` around a component whose caller mints a new
 * `onSelect` every render is a lie that costs a comparison.
 */
const MemoRouteMap = memo(RouteMap);

/** A departures row at rest, in px — a first guess; every row is measured after mount. */
const ROW_ESTIMATE = 52;
/**
 * Rows kept in the DOM beyond each edge of the viewport.
 *
 * It is not a performance dial, it is what keeps the board TABBABLE. A row's
 * focusable things are its phase-number anchor and its Inspect button, so a
 * keyboard user walking the board must always find a next one: focus lands on
 * the last rendered row, the browser scrolls it into view, the scroll extends
 * the window, and the next Tab has somewhere to go. Overscan is the slack that
 * makes that loop continuous instead of a dead end at the fold.
 *
 * ⚠️ Two earlier notes here were wrong and are worth naming so the next one is
 * not. A row has never been one tab stop — `INTERACTIVE` below lists the seven
 * controls it can carry, and all of them are focusable — and MORE stops per row
 * is more slack rather than less, since each row takes more presses to leave.
 * The number is not about how many stops a row has at all. What would break the
 * loop is a row with NONE, or an overscan so small that the last rendered row's
 * focus does not extend the window.
 */
const OVERSCAN = 10;

/**
 * The descendants a row-wide click must keep its hands off.
 *
 * A departures row carries seven of them — the state chip's session link, two
 * dependency links, the QA verdict, the review verdict, the lock chip, and the
 * Inspect button — and every one does something other than open the phase.
 */
const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"]';

/**
 * One departures row — the eight facts, and the two ways into the phase.
 *
 * ---- Why the row is a handler and not an overlay ----
 *
 * The phase number's anchor used to carry `after:absolute after:inset-0`,
 * stretching an invisible pseudo-element over the whole row so a click
 * anywhere opened the phase. It also stretched it over every control in the
 * row: the state chip's link to a live session, both dependency links, the QA
 * and review verdicts. They stayed focusable and stayed keyboard-operable, and
 * a mouse could not press one of them — the overlay took the click and went to
 * the phase page instead. Six pointer-dead controls per row, on the busiest
 * table in the console.
 *
 * So the anchor is an ordinary anchor (still the row's one tab stop, which is
 * what keeps a 31-row board walkable) and the ROW carries a click handler that
 * stands down for anything interactive, for a modified click, and for a drag
 * that turned out to be a text selection.
 *
 * `data-index` and the forwarded `measure` ref are the virtualizer's: it
 * measures each row as it lands, so a row that wraps to two lines is not
 * assumed to be `ROW_ESTIMATE` tall.
 */
const DepartureRow = memo(function DepartureRow({
  slug,
  phase,
  eta,
  rowIndex,
  index,
  measure,
  onInspect,
}: {
  slug: string;
  phase: PhaseView;
  eta: PhaseEta | undefined;
  /** 1-based, and counting the header row — what `aria-rowindex` means. */
  rowIndex: number;
  index: number;
  measure: (node: HTMLElement | null) => void;
  /**
   * Opens the L2 sheet. Takes the phase NUMBER rather than closing over it, so
   * the board can hand every row the same prop — React's own `setInspecting`,
   * which is stable by contract. A per-row arrow would mint a new prop on every
   * render and defeat this component's `memo`, on the busiest list here.
   */
  onInspect: (phase: number) => void;
}) {
  const href = phaseHref(slug, phase.phase);
  return (
    <TR
      ref={measure}
      data-index={index}
      aria-rowindex={rowIndex}
      className="cursor-pointer"
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        // A modified click is the browser's — new tab, new window, download.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if ((event.target as Element | null)?.closest?.(INTERACTIVE)) return;
        // Selecting a title is not choosing the row.
        if (!(window.getSelection()?.isCollapsed ?? true)) return;
        navigate(href);
      }}
    >
      <TD className="font-mono text-lg text-ink-faint">
        <a href={href} className="rounded-sm">
          {pad2(phase.phase)}
        </a>
      </TD>
      <TD>
        <TitleCell phase={phase} />
      </TD>
      <TD>
        <PhaseStateChip slug={slug} phase={phase.phase} state={phase.state} live={phase.live} />
      </TD>
      {/* Both directions, always — this cell used to appear only
          while a phase was held, so the plan's shape was invisible on
          every row that was moving. */}
      <TD>
        <DepsCell slug={slug} phase={phase} />
      </TD>
      {/* Lock and Notes are the two the board can do without at 1024 — see
          `DEPARTURES_FLOOR`. Both are in the row's own L2 sheet, one tap away. */}
      <TD className={DEPARTURES_WIDE}>
        <LockCell lock={phase.lock} />
      </TD>
      <TD>
        <SizeCell phase={phase} eta={eta} />
      </TD>
      {/* Chips, not the raw graph cell. This was the one table of
          three printing Repos as a string. */}
      <TD>
        <ScopeCell phase={phase} />
      </TD>
      <TD className={DEPARTURES_WIDE}>
        <FlagsCell slug={slug} phase={phase} />
      </TD>
      {/* L2 in a COLUMN of its own, and the first attempt is worth recording:
          it shared the Notes cell, justified by "a ninth column would push the
          board past a laptop". That was simply wrong arithmetic — the seven
          declared widths sum to 728px, so a 56px column moves the floor from
          58rem to 62rem, which still fits. What it cost instead was real:
          `FlagsCell`'s root has no `min-w-0` and `Badge` is `whitespace-nowrap`,
          so on a phase carrying a handoff or gate chip the button was pushed
          out past the last cell — a focusable control painted outside the card
          on any window wide enough that the wrapper is not scrolling.
          A `<button>` is also what stands the row's own click handler down
          (`INTERACTIVE`), so reading a phase never costs you your place. */}
      <TD className="text-end">
        <InspectButton onClick={() => onInspect(phase.phase)} label={`Inspect phase ${phase.phase}`} />
      </TD>
    </TR>
  );
});

/**
 * The departures board.
 *
 * Every row is a link. The phase number is the real anchor — keyboard,
 * screen reader and open-in-new-tab all work through it — and the `<tr>`'s
 * own click handler covers the pointer, standing down for any interactive
 * descendant. Never a row-covering `::after`: a positioned overlay paints
 * over every control in the row and leaves them pointer-dead.
 *
 * ---- Windowed against the shell's scroller, not one of its own ----
 *
 * Only the rows near the viewport are in the DOM. The obvious way to do that is
 * to give the table its own bounded scroller, and it is the wrong way here:
 * `TableWrap` carries a written prohibition against a max-height, because
 * `overflow-x` makes computed `overflow-y` auto and a height-capped wrapper
 * becomes a second vertical scroller that eats touch flicks meant for the page.
 * So the virtualizer is pointed at the shell's ONE scroller — `<main>`, which
 * `app/shell/layout.tsx` declares and `app/shell/route-frame.tsx` already
 * addresses the same way — and the rows stay in ordinary page flow.
 *
 * Two things follow from measuring against somebody else's scroller:
 *
 *   - **`scrollMargin` is measured, never guessed.** It is the table body's
 *     offset inside the scroller's content, and everything above it (the health
 *     panel, a closed-plan card, the map) changes height as its queries land.
 *     `offsetTop` cannot answer that — the tbody's `offsetParent` is not the
 *     scroller — so it is computed from the two rects and recomputed by a
 *     `ResizeObserver`. A stale one puts the window at the wrong scroll
 *     position, which reads as "the board is blank until I scroll".
 *   - **The window is spacer ROWS, not absolute positioning.** A `<tr>` moved
 *     out of flow stops being a table row for layout AND for a screen reader.
 *     Two empty rows of the right height keep `<table>` semantics intact, which
 *     is what lets `aria-rowcount`/`aria-rowindex` below tell the truth — the
 *     attributes ARIA allows on a table where a list must use setsize/posinset.
 */
/**
 * The two columns the board drops before it drops its own usability.
 *
 * At 1024 the page box is 746 px and the board's floor was 62rem = 992, so it
 * scrolled sideways at a width it is routinely read at — and a scrolling
 * wrapper cannot hold a sticky header, so thirty phases scrolled their column
 * names away. Lock and Notes are the two whose absence costs least: both are in
 * the row's own L2 sheet, which the Open button on every row opens.
 */
const DEPARTURES_WIDE = 'hidden xl:table-cell';

/**
 * The floor, at both widths, and it is not decoration.
 *
 * Eight of the nine columns declare a width, and under `table-fixed` a browser
 * that cannot fit them scales them all down — including the one column that
 * declared nothing, which is Phase, and which therefore reached ZERO on a
 * 1024px window. The floor is the declared widths plus enough for a title.
 *
 * WARNING: adding a column means moving BOTH numbers, and adding it to
 * `DEPARTURES_WIDE` moves only the second. Below `xl` the seven shown columns
 * declare 33rem, so 45.5rem leaves 12.5rem for the title and fits 746px; at
 * `xl` all nine declare 49rem and 62rem leaves 13rem.
 *
 * THE BAND IT DOES NOT FIT, named rather than implied. This board appears from
 * 900, not 1024 — the gate is `usePhone()`, `max-width: BP_SHELL - 1`
 * (`lib/media.ts`), and below it the phone's `PhasesTab` renders instead. At
 * 900 the page box is 900 − 236 (`--rail-width`) − 40 (the page's own padding)
 * − 2 = 622px, and 45.5rem is 728. So from 900 up to 1005 the wrapper IS a
 * scroll container, `headCell` goes `undefined` and the column names scroll
 * away with the rows — the defect this floor was added to fix, in a 106px band.
 *
 * That is accepted, not overlooked. The alternative is dropping a third column
 * below `xl` (Repos, at 112px, would bring the floor to 38.5rem and fit), and
 * the trade is worse: a phase's scope is the fact that decides what may run
 * beside it, and 900–1005 is a window a person has deliberately made narrow
 * while 1024–1279 — the laptop the board is actually read on — would lose the
 * column too. Scrolling sideways with a visible scrollbar is the honest
 * fallback; a column that left without saying so is not.
 */
const DEPARTURES_FLOOR = 'min-w-[45.5rem] xl:min-w-[62rem]';

function DeparturesBoard({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;
  const phases = detail.phases;
  const body = useRef<HTMLTableSectionElement>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // Eight columns fit a laptop and not a 1024px window. Measured, so the
  // wrapper only becomes a scroll container when it has to — and the header
  // only stops sticking when it cannot.
  //
  // `measured` is destructured because it is USED. This was the one gated table
  // that read `overflows` alone, and the two are not the same question: before
  // the first measurement `overflows` is false, so the wrapper did not scroll
  // while the table already carried its `min-w` floor — a table wider than a
  // box that clips, with no scrollbar anywhere to reach the columns past the
  // edge. Unmeasured is not "it fits"; it is "nobody has asked yet", and the
  // safe answer to that is the scrolling one.
  const { wrapRef, tableRef, overflows, measured } = useTableFit();
  /* Which phase the L2 sheet is open on, by NUMBER rather than by object: a
     stream tick replaces every `PhaseView` in `detail.phases`, and a sheet
     holding the old object would go on showing a phase's state from before the
     tick that changed it. The lookup below re-reads the live record. */
  const [inspecting, setInspecting] = useState<number | null>(null);
  const inspected = inspecting == null ? null : (phases.find((p) => p.phase === inspecting) ?? null);

  /*
   * Resolved lazily inside the getter, NOT in an effect that stores it in
   * state. The virtualizer calls this on mount and on every update, by which
   * time the DOM exists; putting it in state instead cost a render where
   * `getScrollElement()` answered `null`, and a virtualizer with no scroller
   * renders NO rows — a real flash of an empty board on every plan open, not
   * merely a test artefact. The shell's scroller outlives every route, so once
   * found it is never looked up again.
   */
  const getScrollElement = useCallback(() => {
    if (!scroller.current) {
      const main = document.querySelector('main');
      // `document.scrollingElement` is the fallback for a board mounted outside
      // the shell — a test, or a future embed.
      scroller.current =
        main instanceof HTMLElement ? main : (document.scrollingElement as HTMLElement | null);
    }
    return scroller.current;
  }, []);

  // The tbody's offset inside the scroller's content box, by definition. Read
  // after paint and again whenever anything resizes, because the cards above
  // this table grow as their own queries resolve.
  useEffect(() => {
    const node = body.current;
    const box = getScrollElement();
    if (!node || !box) return;
    const measure = () => {
      const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      setScrollMargin((previous) => (Math.abs(previous - top) > 1 ? top : previous));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(node);
    return () => observer.disconnect();
  }, [getScrollElement, phases.length]);

  const virtualizer = useVirtualizer({
    count: phases.length,
    getScrollElement,
    estimateSize: () => ROW_ESTIMATE,
    overscan: OVERSCAN,
    getItemKey: (index) => phases[index].phase,
    scrollMargin,
    /*
     * Seeded so the FIRST render already has a window.
     *
     * The virtualizer binds its scroll element in a layout effect, which runs
     * after the first render — so without a seeded offset it has no range yet
     * and `getVirtualItems()` answers `[]`. That is a board with a header, a
     * total height and no rows at all until a second render lands.
     *
     * The offset `0` is not a guess: `app/shell/layout.tsx` resets the
     * scroller's `scrollTop` on every path change, so a plan page always opens
     * at the top. The height must be non-zero for a different reason — the
     * engine treats an outer size of 0 as "no range at all" and yields no rows
     * — and `innerHeight` errs generously, which on one frame only means a
     * little extra overscan. The real height is measured a frame later.
     */
    initialOffset: 0,
    initialRect: { width: 0, height: typeof window === 'undefined' ? 0 : window.innerHeight },
  });

  // Sticky is the other half of `scrolls`, so it is the same decision.
  const headCell = !overflows && measured ? stickyHeadCell : undefined;
  const rows = virtualizer.getVirtualItems();
  const padTop = rows.length ? rows[0].start - scrollMargin : 0;
  const padBottom = rows.length ? virtualizer.getTotalSize() - (rows[rows.length - 1].end - scrollMargin) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Departures</CardTitle>
        <span className="text-xs text-ink-faint">{phases.length} phases · open a row for the full phase</span>
      </CardHeader>
      {/*
       * `scrolls={false}` and a fixed layout, together.
       *
       * This board already scrolls with `<main>` — that is what the virtualizer
       * targets — so the wrapper never needed to be a second scroll container,
       * and not being one is what lets the header stick to the scroller that
       * actually moves. Thirty phases used to scroll their own column headings
       * off the top of the screen.
       */}
      <TableWrap
        ref={wrapRef}
        scrolls={overflows || !measured}
        className="rounded-none border-0 border-t border-rule"
      >
        {/* `aria-rowcount` counts the header too, and every row's
            `aria-rowindex` is its true position in the whole board — so a
            screen reader says "row 27 of 32" on a table holding twelve. */}
        {/* hand-rolled because: it is windowed. Only the rows in view are in
            the DOM, held in place by two padding rows of computed height, and
            the virtualizer measures each one — `DataTable` renders every row it
            is given. */}
        <Table
          ref={tableRef}
          fixed
          // A table nobody can name is a table nobody can find: the card's own
          // heading is not this element's accessible name, and every other
          // table in the client carries one.
          aria-label="Departures"
          aria-rowcount={phases.length + 1}
          className={DEPARTURES_FLOOR}
        >
          <THead>
            <TR aria-rowindex={1}>
              <TH className={cn('w-14', headCell)}>#</TH>
              <TH className={cn('min-w-0', headCell)}>Phase</TH>
              <TH className={cn('w-28', headCell)}>Status</TH>
              <TH className={cn('w-32', headCell)}>Deps</TH>
              <TH className={cn('w-32', DEPARTURES_WIDE, headCell)}>Lock</TH>
              <TH className={cn('w-16', headCell)}>Size</TH>
              <TH className={cn('w-28', headCell)}>Repos</TH>
              <TH className={cn('w-32', DEPARTURES_WIDE, headCell)}>Notes</TH>
              {/* Named, not blank: `DataTable` gives every column a head and a
                  screen reader announces this one on each row it reads. */}
              <TH className={cn('w-14 text-end', headCell)}>Open</TH>
            </TR>
          </THead>
          <TBody ref={body}>
            {/* `aria-hidden` and no cells: these are height, not content. */}
            {padTop > 0 && <tr aria-hidden="true" className="border-0" style={{ height: padTop }} />}
            {rows.map((row) => (
              <DepartureRow
                key={row.key}
                slug={slug}
                phase={phases[row.index]}
                eta={etaFor(detail, phases[row.index].phase)}
                rowIndex={row.index + 2}
                index={row.index}
                measure={virtualizer.measureElement}
                onInspect={setInspecting}
              />
            ))}
            {padBottom > 0 && <tr aria-hidden="true" className="border-0" style={{ height: padBottom }} />}
          </TBody>
        </Table>
      </TableWrap>
      {/* Mounted once for the whole board, not once per row: forty sheets in
          the tree would be forty dialogs' worth of markup for a surface that
          shows one at a time — and the virtualizer would unmount the open one
          the moment its row scrolled out of the window. */}
      {inspected && (
        <PhaseInspector
          slug={slug}
          phase={inspected}
          eta={etaFor(detail, inspected.phase)}
          open
          onOpenChange={(next) => !next && setInspecting(null)}
        />
      )}
    </Card>
  );
}

/**
 * The station the map should open looking at.
 *
 * Needs-you first, then a failure, then whatever is moving, then the first
 * thing that COULD move — in that order, because they are in that order of
 * urgency and because a map of forty phases is drawn small enough that the one
 * node worth seeing was as likely to be off in a corner as anywhere.
 *
 * `null` on a plan where nothing wants anything: a map that always snapped
 * somewhere would teach the operator that the snap means nothing.
 */
export function focusPhase(detail: PlanDetail): number | null {
  const by = (...states: string[]) => detail.phases.find((p) => states.includes(p.state))?.phase ?? null;
  // `stuck` is a handoff that reads blocked — a person is being asked for.
  return by('stuck') ?? by('in-progress') ?? by('ready');
}

export function RouteTab({ detail }: { detail: PlanDetail }) {
  const phone = usePhone();
  const slug = detail.summary.slug;
  const closed = isClosed(detail.summary);
  const ready = detail.summary.ready;
  // Two walks of every phase that were being redone on every render of this
  // page — including the renders the stream causes, which is most of them.
  const lastDone = useMemo(() => {
    const done = detail.phases.filter((p) => p.state === 'done').map((p) => p.phase);
    return done.length ? Math.max(...done) : null;
  }, [detail.phases]);
  const focus = useMemo(() => focusPhase(detail), [detail]);

  /*
   * The two things the map draws that the ROUTE payload does not carry.
   *
   * `RouteView` is the engine's own projection and stays it — adding fields
   * there would put analysis and process facts inside the topology. Both are
   * already on `detail.phases` for the tables, so they are joined by phase
   * number here and handed to the map beside the route, memoised on the phase
   * list so the SSE stream does not mint a new Map on every tick.
   */
  const critical = useMemo(() => {
    const set = new Set<number>();
    for (const phase of detail.phases) if (phase.analysis?.onCriticalPath) set.add(phase.phase);
    return set.size ? set : null;
  }, [detail.phases]);

  const drivers = useMemo(() => {
    const map = new Map<number, PhaseDriver>();
    for (const phase of detail.phases) {
      if (phase.live || phase.lock) map.set(phase.phase, { live: phase.live, lock: phase.lock });
    }
    return map.size ? map : null;
  }, [detail.phases]);

  // `RouteMap` is memoised below, and a new arrow every render would defeat
  // that on its own — the map is an SVG of every station and every edge, which
  // is the most expensive thing on this page to draw twice for no reason.
  const onSelect = useCallback((phase: number) => navigate(phaseHref(slug, phase)), [slug]);
  const hrefFor = useCallback((phase: number) => phaseHref(slug, phase), [slug]);

  return (
    <div className="flex flex-col gap-3">
      <HealthPanel detail={detail} />

      <MemoRouteMap
        route={detail.route}
        batches={detail.batches}
        budget={detail.summary.budget}
        focus={focus}
        /* The station the map opened on keeps a ring: a map that centred
           somewhere and then said nothing about why has moved for no reason
           the reader can see. Ring only — `focus` never dims the network. */
        selected={focus}
        critical={critical}
        drivers={drivers}
        onSelect={onSelect}
        hrefFor={hrefFor}
      />

      {/* `--session-plan` answers a closed plan with its CLOSED banner and "No
          sessions to plan", so the health panel's batching simply vanishes. Say
          why instead: an absent card on a plan that still shows unfinished
          phases reads as the console failing to compute one. */}
      {closed && (
        <Card>
          <CardHeader>
            <CardTitle>No sessions to plan</CardTitle>
            <span className="text-xs text-ink-faint">this plan is closed</span>
          </CardHeader>
          <CardBody className="text-sm text-ink-muted">
            {detail.summary.closedReason ? <p className="mb-1">{detail.summary.closedReason}</p> : null}
            <p>
              The engine stops batching a closed plan, so there is nothing to suggest. The route above is kept
              in full — it is the record of where the work stopped. Reopen the plan to put its remaining
              phases back on the board.
            </p>
          </CardBody>
        </Card>
      )}

      {/* The 8-column nowrap table cannot be true on a phone; the Phases tab's
          state-grouped list is the same facts, one thumb wide. The DAG above
          stays — its touch stack is the good part. */}
      {phone ? <PhasesTab detail={detail} /> : <DeparturesBoard detail={detail} />}

      {/* `--boot-prompt` has no closure guard of its own — it will happily write
          a full prompt for an abandoned plan's phase — so the gate has to be
          here. A card headed "Boot prompt — phase 4" with a Copy button beside
          it is the single most direct invitation this console makes; offering
          one for a plan the operator has closed is the ready board's defect
          wearing a different card. */}
      {/* ⚠️ `collapsed` is what makes these free, and it is not cosmetic.
          `PromptCard` fetches on `enabled: open`, and each prompt is an ENGINE
          SHELL-OUT server-side — so an expanded card per ready phase meant
          opening a plan with four ready phases spawned four `phase-graph.sh`
          runs before anyone had asked for a prompt, on the same page load as
          everything else. The board below already says which phases are ready;
          the prompt is what you want AFTER deciding, and one press is the whole
          cost of asking. The end-of-phase banner card below has been collapsed
          for exactly this reason since it was written. */}
      {!closed && ready.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {ready.map((phase) => (
            <PromptCard
              key={phase}
              title={`Boot prompt — phase ${phase}`}
              collapsed
              queryKey={keys.prompt(slug, phase)}
              load={() => api.prompt(slug, phase)}
            />
          ))}
        </div>
      )}

      {/* The same board, as the terminal prints it.
          It was the Analysis tab's last card and Analysis is gone; the board is
          not analysis, it is this route in the other rendering — the one you
          paste into a message or diff against `phase-graph.sh` output. Collapsed,
          because the map above is the better answer to the same question for
          anyone who is looking at a screen. */}
      {detail.boardText && (
        <Card>
          <CardHeader>
            <CardTitle>What the terminal shows</CardTitle>
            <CopyButton text={detail.boardText} label="Copy board" />
          </CardHeader>
          <details>
            <summary className="cursor-pointer px-4 py-2 text-2xs text-ink-faint">
              <code className="font-mono">phase-graph.sh {slug}</code>
            </summary>
            <pre className="m-0 max-h-96 overflow-auto overscroll-contain border-t border-rule bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre">
              {detail.boardText}
            </pre>
          </details>
        </Card>
      )}

      {/* The last thing a plan owes its operator. Below the board and the boot
          prompts, because it is what you reach for when there is nothing left
          to board — and open by default only once every phase is done. */}
      <LandingCard detail={detail} />

      {lastDone != null && (
        <PromptCard
          title={`End-of-phase banner — after phase ${lastDone}`}
          note="board · batching advice · every ready prompt"
          collapsed
          queryKey={keys.nextPrompt(slug, lastDone)}
          load={() => api.nextPrompt(slug, lastDone)}
        />
      )}
    </div>
  );
}
