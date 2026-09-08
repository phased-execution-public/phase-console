# Phase Console 4.0 — the design file ("Departures")

This is the identity every 4.0 phase obeys, extracted from what `client/src/styles/theme.css` and
its guards already enforce and extended with the 4.0 decisions. A session that has never seen the
repaint plan must be able to build a conforming page from this file alone. Where this file and a
guard test disagree, the guard is right and this file has rotted — fix the file.

**The subject.** An instrument console for autonomous engineering work: one operator supervising
plans that execute themselves — boards, runs, lanes, locks, gates, QA verdicts, sessions, money.
**The data is the hero.** The console's job is a fast honest glance that survives drilling into.
The identity is called *Departures*: the departure-board / transit-map language the app already
speaks (plans are lines, phases are stations, the board tells you what is moving and what needs
you) carried through type, color and the signature motif.

**The one aesthetic risk, and where it is spent:** the type. Everything else stays quiet.

---

## 1. The invariant — minimal surface, total recall

Four disclosure levels, used everywhere. "Minimal" NEVER means fewer facts; it means calm
arrangement of all of them.

| Level | What | Surface |
|---|---|---|
| **L0** | The glance. The calm default a page opens on. | The page itself |
| **L1** | Expand in place. More of the same record, where it stands. | `Disclosure`, `DataTable` row detail, folded columns |
| **L2** | The inspector. Full structured detail of ONE record. | `Inspector` (a `Sheet`: right on desk, bottom on phone) |
| **L3** | Raw. The record as the machine holds it. | `Inspector`'s `raw` slot ("Raw record"), a journal line, a file |

Exit criteria for every redesigned page (from the plan, restated because they are design law):
*no datum the page shows today is removed; every datum reachable in ≤ 2 interactions; an L3 raw
view exists; the persisted density preference is honored.*

## 2. The voices — type

Two variable files, three faces (SIL OFL 1.1; notices in `client/src/assets/fonts/OFL.txt`;
vendored, hashed by Vite, zero network):

| Token | Face | File | Clamp | Job |
|---|---|---|---|---|
| `--font-sans` | Instrument Sans | `instrument-sans-var.woff2` (wght 400–700) | `font-stretch: 100%` | Everything read as sentences and labels |
| `--font-display` | Instrument Sans Display | *same file* | `font-stretch: 80%` | Names and figures: page titles, card titles, Tile numerals |
| `--font-mono` | Martian Mono | `martian-mono-var.woff2` (wght 100–800) | `font-stretch: 87.5%` | Data: shas, ids, money, durations, paths, code, kbd |

Why these: the console's character lives in its data — half of every screen is telemetry — so the
mono carries the identity (Martian Mono: sturdy, tall x-height, built for engineering readouts).
The display voice is the *width axis* of the UI face, clamped condensed by a second `@font-face`
over the same bytes: the timetable flavor 3.0 bought with a separate condensed file, now one file.
The UI face is clamped at 100% so body text can never inherit a stray narrow width.

Rules:
- **Weights:** body 400, emphasis/`font-medium` 500, headings and `font-semibold` 600, 700 sparingly.
- **Sizes:** the `--text-*` scale only. Display sizes (`lg`–`3xl`) are fluid clamps; reading sizes
  are fixed. **The floor is 12px** (`--text-2xs`, badges/counters only); `--text-xs` is the
  smallest a sentence may be set.
- **Numerals are tabular everywhere** (body default + `.tnum` for opt-back-in). A column of
  ticking figures must not jitter.
- **Ligatures are off in mono** (`--font-mono--font-feature-settings`): `->` in a command is two
  characters, and pretending otherwise is a lie about the bytes.
- Headings get `letter-spacing: -0.01em` from base — do not re-track them locally.
- Never add a face, a file, or an unclamped width. The theme guard pins all of it.

## 3. The room — color

**One room, two lights.** Both themes sit on one hue family (≈ h 220): Paper is the room lit,
Night is the room dimmed. Every color token is declared ONCE via `light-dark()`; the theme switch
is a `color-scheme` flip. (3.0's green-tinged light theme beside a blue night was an accident of
history, retired in 4.0.)

Surfaces, lightest meaning "closest to the reader" in Paper and inverted at Night:
`--ground` (the page) · `--ground-deep` (recessed bands) · `--surface` (cards, sheets) ·
`--surface-raised` (hover, raised chrome) · `--rule`/`--rule-strong` (borders) · `--track`
(what marks sit against). Ink: `--ink` · `--ink-muted` · `--ink-faint` (true metadata only).

**Status is a system, not a color.** Eight UI states from `shared/status-vocab.js`, one hue each,
all at ONE OKLCH weight per theme (Paper 48%/0.08 · Night 75%/0.12; the neutrals `queued` and
`skipped` keep L, drop C) so no state can shout by accident. AA is machine-checked
(`styles/contrast.test.ts`): ≥ 4.5:1 as text on every surface, ≥ 3:1 as a mark on the track, both
themes.

**Amber is rationed.** `--accent` = `--action` = `--focus` = `--status-needs-you`. Amber means
*a person is needed*, and nothing else may reach for it — every other hue keeps ≥ 40° away.
There is no second accent and no brand color; the brand is the arrangement.

How color is consumed — the only three doors:
1. Tailwind utilities from `@theme inline` (`text-running`, `bg-needs-you/12`, `border-rule`).
2. The state indirection: a `.state-<ui>` class sets `--state`; descendants paint `text-state` /
   `bg-state` without knowing which state they show. `StatusBadge` + those classes are the only
   two places a hue is read.
3. `var(--token)` in the three component stylesheets (`prose.css`, `route-map.css`, `console.css`).

Never: a literal hex (lint bans it client-wide), a utility spelled from the raw namespace
(`bg-status-done` compiles to NOTHING — the ghost-utility guards hunt these), a new hue.

## 4. Space & density

Spacing is Tailwind's `--spacing` scale. Two padding families are **density-switched wholesale**
by `data-density` on the root (the persisted preference `prefs.density`):

| Token | Comfortable | Compact | Read by |
|---|---|---|---|
| `--pad-x` / `--pad-y` | 16 / 12 px | 12 / 8 px | Card headers & bodies, sections, `Inspector` body |
| `--tile-pad-x` / `--tile-pad-y` | 12 / 10 px | 10 / 6 px | Tiles, `TH`/`TD` cell padding |

Density buys space out of padding, **never out of ink** — no type size changes. The rule for new
work: a primitive that pads content consumes these tokens, never a literal `p-*`; a page that
stacks sections uses the same rhythm. If density "doesn't reach" a surface, that surface is
wearing a literal.

## 5. Shape, elevation, motion

- **Radii (4.0, one step tighter than 3.0):** `--radius-sm` 2px (chips, badges, focus ring),
  `--radius` 5px (controls), `--radius-lg` 8px (cards, sheets, tables). A machined instrument,
  not an app-store card.
- **Elevation:** `--shadow-card` (a hairline + a soft drop; inset top-light at Night) and
  `--glow-action` (the amber halo for the one thing to do now). Nothing else casts.
- **Motion is a closed vocabulary of three.** `fade` 120ms and `rise` 260ms are entrances;
  `pulse-soft` 2.4s is the only continuing motion and is **reserved for a live `running` state**
  — it exists to distinguish "thinking" from "stale page", the one fact that changes while you
  watch. Nothing decorative may breathe. `--ease-transit` for transitions, with `duration-fast|medium` (backed by
  `--transition-duration-*` — the namespace Tailwind v4 actually reads; the bare
  `--duration-*` trio exists for `var()` consumers); reduced-motion kills
  everything globally. Adding a fourth animation is an identity change, not a tweak.

## 6. Breakpoints & layout

Exactly three: **640** (phone: one thumb, one column) · **900** (the rail gives way to the phone
shell) · **1200** (wide: detail pages stop being two columns). `lib/media.ts` ⇄ `theme.css`,
test-enforced; a stray `md:` cannot even compile (the default namespace is cleared). Branch on
nothing else. The shell owns the one scroller; `--app-height` (never `dvh`) sizes overlays;
`--z-*` tokens are the whole stacking order; touch floors: `--tap-min` 44px targets,
`--text-input` 16px inputs.

### 6.1 What each surface does when it runs out of width

The three numbers say *when* a layout changes. This says *what it changes into* — one line per
surface that has an answer, because "responsive" as a wish produces a different guess per page.

| Surface | Below 900 (phone shell) | Below 640 (one column) |
|---|---|---|
| **Shell** | rail → top bar + tab bar + More sheet; tab bar hides while a software keyboard is up | — |
| **Tables** | `DataTable` → **CardList**, one card per record. Branches, working trees and settle history reached the primitive in Phase 7 and get one. Commit history is the one exception left, and it says so in its own source | — |
| **Route map** | pan + pinch + zoom, floor 0.45; non-interactive below that it is a picture the page scrolls past | — |
| **Commit graph** | real `<tr>` rows; the leftmost cell is the ≤128px `aria-hidden` lane gutter, the subject and its control are the cell after it | sideways scroll inside its own box |
| **Log explorer** | `DataList`, one vertical scroller sized by `--app-height` | row wraps; message takes its own line |
| **Terminal** | 80-col pty floor; key bar is a grid, never a scroller | — |
| **Patch pane** | sideways only — the height cap is `lg:` and above | — |
| **Overlays** | sized by `--app-height`, never `dvh`, never `100vw` | — |

**The structural guarantees** — each is a rule stated where it is *decided*, so no surface has to
remember it. They are pinned in `styles/touch.test.ts`:

- **One scroller, one axis.** `<main>` is `overflow-x-hidden overflow-y-auto`. An over-wide child is
  **clipped, not scrollable** — which is what makes every rule below a containment failure instead of
  an app that slides sideways, and why `table.tsx` and `layout.tsx` are one decision and may not be
  changed alone.
- **A row that can grow may shrink and wrap** — `min-w-0 flex-wrap`, never `shrink-0`. `flex-wrap`
  alone does not save it: a row that may not shrink has nothing to wrap into.
- **A control reaches `field`/`fieldSurface`** — which carry the coarse-pointer 44px floor and the
  `min-w-0` that stops a `<select>` sizing to its widest option. Reaching the class is the rule; not
  copying the constant was only ever a proxy for it.
- **Text the app did not write can break.** Paths and slugs get `break-words`. In a *narrow* column
  a dotted, space-free token (`runner.phase.verify.failed`) wants `break-all`: both break an
  over-long token, but `break-words` only once the token has claimed a line of its own — which in a
  narrow column is the line something else needed. The bug is having no rule at all.
- **A row that is the only way into a record carries `min-h-(--tap-min)`**, released at `sm` so
  desktop density is unaffected — *unless the row already has a fixed height*, in which case take
  the padding off the **cell** (`py-0`) and let the floor on the control resolve to the row's own
  height. The commit graph is the case: its row is exactly `ROW_H` because the lane SVG is drawn at
  that height, so a floor added on top of the cell's padding grows the row and breaks the lane lines
  at every boundary. Growing the control's box instead (negative margin + equal padding) keeps the
  row still but lands *under* the floor — 40px comfortable, 32px compact. Fill by removing padding,
  not by adding it.
- **A table reaches `DataTable`, or writes down why it cannot.** Not a preference — a table that
  weighed the primitive and rejected it and a table written before the primitive existed look
  identical, and the Phase 6 register found twenty render sites of which not one said which it was.
  The reason is a `// hand-rolled because:` comment naming what the primitive cannot do here (a
  continuous lane drawing across row boundaries, collapsible group bodies, a windowed body, live
  form controls, a diff), and `styles/touch.test.ts` checks it per SITE — the nearest marker above
  each `<Table>`, so one reason cannot excuse two tables.
- **A column declares ONE number and the layout uses it.** `min` is the cut's budget *and* the
  track under `table-fixed` (`trackOf`), and it is measured against the widest real content the
  column can hold, not guessed. Under-declaring it is not a small error: a chip four pixels wider
  than its track does not widen the column, it escapes it, `useTableFit` reads the table over its
  box, and the whole table drops to scroll mode and loses its sticky header. Thirteen pixels cost
  the issues board exactly that. `whitespace-nowrap` inside a declared track is the same defect
  written on purpose — widen the `min`.
- **A column that takes the remainder still says what it is worth.** Under `table-fixed` "the rest"
  can be nothing: a runs table's Plan column resolved to 0 px at 1024, so the pinned identity
  cell had no width and its neighbour painted over it. Give the flex column a floor, expressed as a
  `min-width` on the TABLE (a `min-width` on a `display: table-cell` box is undefined in CSS 2.1)
  and derived from the declared tracks so it cannot drift from them.
- **The pinned rail is a RUN of columns, not one column.** Everything up to and including the
  identity column travels together, each offset by the tracks in front of it. A table whose identity
  is column two pinned the identity to the left edge and let the pick box in front of it slide away
  underneath — the row being ticked and the tick being pressed were two different rows.
- **A record's name declares a floor.** `min-w-0` beside `shrink-0` does not mean "shrink me last",
  it means "shrink me to nothing", and next to something that cannot shrink at all that is what
  happens — a plan card whose name kept 113px so two chips could stay whole, a phase row whose title
  kept 33px beside four. The identity gets a `min-w-*`; the chips wrap under it. This is the same
  rule as a column's `min`, one layer out.
- **The thumb floor is a HIT AREA, not a box.** `tap-area` (a control that is a box) and `tap-line`
  (a control that is text in a sentence) put a transparent pseudo-element centred on the control and
  sized from `--tap-min`; the drawn box never moves, because a 44px checkbox is a different control
  and a 44px line of prose is not prose. Under a fine pointer they do nothing. Never hand-derive an
  inset from one control's height — that is what these replaced. Where controls are dense enough
  that 44px areas would overlap (≈60 rule chips, each striking a permission), change the LAYOUT so
  each has a row of its own instead.
  Measuring this needs BOTH forms. `document.elementsFromPoint` (plural) answers "is the control in
  the stack", which is the right question for a border box that is not a hit area — a register that
  measures the box files the same false finding forever. But it cannot answer the question that
  decides whether the floor is real, which is **"does the control WIN"**: `document.elementFromPoint`
  (singular), at the four corners and at the centre of the control's own drawn box. A hit area
  another control owns is not a hit area.
  **And ownership has exactly one honest predicate: `hit === el || el.contains(hit)`.** The clause
  that must not be in it is `hit.contains(el)` — an ANCESTOR answering. Three shipped defects were
  scored as passing by a probe that counted an ancestor's answer as the control's, and an ancestor
  answering is precisely what a clip produces: where the ancestor hides the child, the ancestor is
  what the point hits. Read `hit.contains(el)` as evidence of the next bullet, never as a pass.
- **A control an ancestor clips does not have a floor, and no hit-test alone can tell you.** The
  third question, after "is it in the stack" and "does it win", is **"does its own box survive its
  ancestors?"** — intersect the border box with the border box of every ancestor that CLIPS on the
  axis in question, and compare what is left with `min(w, 44) × min(h, 44)`.
  **"Clips" means `hidden` or `clip`, not merely "not `visible`".** An ancestor whose overflow is
  `auto` or `scroll` on that axis defers rather than fails: the control is off screen, not gone, and
  a thumb reaches it by scrolling. Take the literal reading and the plan-detail tab strip
  (`components/ui/tabs.tsx`, `flex items-stretch gap-1 overflow-x-auto`) reports five failing
  controls at 360 — `Source` 0px of 69.2 visible — which is exactly the noise that teaches the next
  tour to ignore the question. Two shapes to know: `overflow-x: auto` makes the computed
  `overflow-y` `auto` too, so a scroller trims the last pixel off its children's height (44 → 43) —
  not a finding; and a scroller nested inside a `hidden` ancestor is still clipped by that ancestor,
  so defer on the scroller, keep walking.
  Measured, the whole class in one control: `Button` declares `[@media(hover:none)]:min-w-(--tap-min)`,
  a `ButtonGroup` was `inline-flex overflow-hidden` and shrinkable, and inside a non-wrapping
  `CardHeader` at 360 it shrank to 50px around two 44px children — the second one drawn 5px wide, its
  centre answering `<main>`, and every probe that asked only "is it in the stack" said yes. A floor
  declared on a control is therefore a claim about its ANCESTORS too: nothing between a control and
  the viewport may clip it, and a box that both clips and shrinks will eventually do exactly that.
  `components/ui/surfaces.test.tsx` pins it on the mounted primitives ("a clipping box may not
  squash what it clips") and `styles/touch.test.ts` sweeps the tree for the same shape.
- **An overlay floor has two failure modes, and neither is visible to the plural probe.** *The host
  clips it*: the `::before` is positioned against the host, so `truncate` (`overflow: hidden`) cuts
  the 44px area back to the drawn box — measured, a `tap-line truncate` link missed all four corners
  of its own intended square. Put the clip on an inner span. *It covers a neighbour*: the overlay
  overhangs the host by `(44 − height) / 2` at each end and, being a positioned descendant,
  hit-tests above non-positioned siblings — measured, the approve card's link took the bottom 5px of
  Allow / Deny / Stop, and Insights' 20px list rows at a 24px pitch each covered 8px of the VISIBLE
  text of the row above. So an overlay is for a link inside a SENTENCE. **A control with controls
  above or below it takes the floor as its BOX** — `tap-row` (44 tall, its own width) or `tap-cell`
  (44 both ways). That grows the drawn box, which is the trade the overlay pair exists to avoid and
  the right trade in a list: a list of links a thumb is meant to use is a list of 44px rows.
- **Focus stays visible.** `:focus-visible` paints one ring globally. A page may not suppress it; a
  primitive that manages its own focus may, and must then draw its own `focus-visible:` indicator.
- **Motion is a preference, and CSS alone cannot honour it.** `theme.css` flattens every animation
  and transition, but an explicit `behavior: 'smooth'` in JS *overrides* CSS `scroll-behavior` — so
  an imperative scroll asks `scrollBehavior()` (`lib/media.ts`), never hard-codes the word.

## 7. The signature — track & stations

The route map is the console's monogram: **a plan is a line; phases are its stations.** The
grammar, kept consistent wherever progress or structure is drawn (`route-map.css`,
`SegmentBar`, `Meter`, the board):

- The **track** is the neutral bed (`--track`); segments paint by state via the indirection.
- A **station** is a dot (7px, `StatusDot`); the identity of the record it marks sits beside it —
  color is never the only carrier (WCAG 1.4.1: label + icon always).
- **`verifying` is running's family**: a *dashed* line-style tells them apart at a glance; the
  label and icon do the rest.
- **`needs-you` gets the amber halo** (`--glow-action`), never a pulse — pulse means "alive right
  now", and a gate waiting on a person is not alive.
- The motif may appear small (a progress strip, a tab underline on the route map page) but never
  as decoration on surfaces that carry no phase structure. Restraint is what keeps it a signature.

## 8. Components — the kit contract

One import for every view: `@/components/ui`. The load-bearing specs:

- **`StatusBadge` / `StatusDot`** — the ONE place hue+icon are read (with the `.state-*` classes).
  Every status word everywhere goes through `shared/status-vocab.js`. `pulse` only when live.
- **`Badge`** — tones are the vocabulary's tone families + `state` (indirection) + `solid`;
  a toneless badge is grey on purpose (visibly wrong beats invisibly wrong).
- **`Card` / `CardHeader` / `CardTitle` / `CardBody` / `Tile`** — the card surface; `cardClass`
  for elements that cannot be a `<Card>`. Tile numerals are display-face, tabular.
- **`DataTable` / `Column`** — one column array yields the wide table, the folded cut, and the
  phone `CardList`. Declare `priority` (1 = never dropped), `min`, one `flex` column, one
  `identity` column, `card` role. **Extend the `Column` API; never fork the table.** The
  conditional scroll wrapper + sticky rules are load-bearing (see the file header); the `empty`
  slot takes an `Empty`.
- **`Disclosure`** — L1. The label NAMES what appears ("All 12 options", "Raw record"), never
  "More…"; the count is drawn while folded; content unmounts when folded.
- **`Inspector` / `InspectorSection`** — L2. Title always visible; `meta` identity row first;
  body on the density tokens; `raw` slot is the L3 rung behind "Raw record" (give it
  `font-mono text-2xs`). Sections signpost with the band eyebrow.
- **`Empty` / `PageError` / `CardSkeleton`** — the three pre-content states. An empty screen is
  an invitation to act (`action` is part of the shape); an error is the server's own words plus a
  way out ("Try again"); a skeleton only where nothing has ever loaded.
- **`SectionHeading`** — the eyebrow (`band`) and the section title (`title`); heading LEVEL is an
  outline decision, size is not.
- **Data atoms** — `MonoId` (short form drawn, full value one hover/copy away), `MoneyAmount`,
  `Duration`, `RelativeTime`, `Kbd`. All mono, all tabular.

**The field system (P3 ruling).** The kit's Radix controls (`Select`, `Combobox`, `RadioGroup`,
`Switch`, …) are the canonical *controls*; `features/run-setup/fields.tsx` is the canonical *form
layer* — its `SetupField`/`Provenance` add the one thing no kit has: **where a value came from**
(`from defaults` / `from this run` / `from the plan` / `changed here`). Phase 5 rehouses the
native `<select>`s onto the kit controls when it builds the options surface. Two pins that must
not move: `ToggleField` STAYS a checkbox and `PressField` stays a button — the QA launcher's bare
`getByRole('checkbox')` assertion must not go vacuous. Anything still unused after Phases 5–7
adopt their controls is deleted in Phase 11.

## 8.1 The launch flow (Phase 8)

The one form that starts, continues or reconfigures a run (`features/run-setup/`) is a **departure
notice**: it says what will happen, where every value came from, what it can cost and where it
stops — before the one amber button. Four stages, drawn as a station track (§7 — a flow somebody
moves along is a line):

| Stage | What it carries | Where the fields come from |
|---|---|---|
| **What runs** | the plan, the phases ready now (state · gate · claim · scope), the engine's session batches, what will hold; then the scope and the chain | `stages.ts` `STAGE_OF` → `what` |
| **How it runs** | model and effort with the per-phase matrix, the profile with the deny wall stated under it, the branch and what happens to it, who pays with their meters, skills, MCP servers, the reviewers, QA | → `how` |
| **Money and stops** | opens on the sentence — *the run halts and asks when …* — then the ceilings and the stop conditions | → `money` |
| **Review** | the departure line, every value that is not the shipped default with its source and a way back to its stage, every boarding-preflight finding, what will hold, the ceilings as arithmetic | `summary.ts`, `facts.ts` |

The rules, each stated where it is decided:

- **The form owns the values; the stages are arrangement.** `RunSetup` seeds, validates and posts
  (`modes.ts` untouched, so the payload is byte-identical to the flat dialog's —
  `launch-flow.test.tsx` pins the bytes); `sections.tsx` writes each control once; `stages.ts` says
  which stage each field is on and which modes are staged at all (a run door is staged, a ticket
  door is flat; inline on a page is always flat). A new mode adds one row to three tables there —
  that is the extension point Phase 9's `qa-fix` uses.
- **Provenance is six words, and the review reads them.** `from defaults` · `from Settings` ·
  `from this run` · `from the plan` · `from your last launch` · `changed here` (`fields.tsx`).
  The precedence is the run's record → this browser's last launch of the plan
  (`launch-memory.ts`, posture only, never a scope) → a Settings preference → the shipped default
  (`seed.ts`, and `BASELINE` is what a fresh console launches with, computed through the seed rather
  than written down). A row is listed on the review when it is not the baseline OR was changed
  here — a value changed back to the default is still a decision.
- **Two layouts, one frame.** Below the shell breakpoint the flow is a full-screen `Sheet`
  (`side="full"`): title, stage bar and buttons fixed, only the stage scrolls, the whole thing
  exactly `--app-height` tall so the footer sits on the keyboard. On a desk it is a `frame`
  `Dialog` with two panes — the stages left, the live ticket right (the same review, cut short) —
  and the panes merge on the review. Launch is the ONE amber button: on every stage of a desk (the
  ticket has already said what will happen), on the review alone on a phone.
- **`Stepper`** (`components/ui/stepper.tsx`) is a Radix tab list drawn as a track with a station
  per stage — equal columns at every width, never a scroller, the phone reading a short name.
  Current = filled ink a size up, passed = filled muted, ahead = hollow. Ink, never a status hue:
  a stage is not a state. It switches on click as well as on mousedown and focus, because a switch
  device and a test dispatch only the click.
- **A native `<select>` cuts what it cannot fit** (register rows 433–440), so an option is a NAME
  and the rest goes under the control: the account option is who it is and its windows are real
  `Meter`s beneath it, worst first; the profile option is `Guarded`/`Trusted`/`Bypass` with the
  qualifier and the deny wall — its size from the policy the console holds — under it.
- **The honest states are banners above the stage bar**, so they are read on every stage: a
  console without `--allow-run` says so and offers the exact start line to copy; a live claim
  refuses with who holds it; a recorded verdict is quoted; a gated phase says who clears it (`a
  person approves it` · `the session clears it at boarding` · `checked at boarding`).
- **The pickers have no scroller of their own** (register rows 445–448): a list inside the
  dialog's scroller lays out in it, capped at twelve rows per group with the search as the way to
  the rest, and every row is a `tap-row`.

## 9. Copy — the console's voice

Words are design material. The register: plain verbs, sentence case, no filler, the operator's
side of the screen.

- **Name what the user controls, not how it is built** ("Notifications", not "webhook config").
- **A control says exactly what happens** ("Approve gate", "Try again", "Show everything") and
  keeps the same name through the whole flow. "More…", "Submit", "OK" name nothing.
- **Provenance in the hint, never the label** — a label is the accessible NAME.
- **Errors**: what went wrong, in the server's own words, and a way out. Errors do not apologize
  and never invent a reason ("The read failed and said nothing." is the honest floor).
- **Empty states direct**: what this will hold and how to put the first thing in it.
- **Status words explain themselves on hover** (`uiStateTitle`), but hover is a hint, never the
  only carrier.
- Uppercase is structural (eyebrows, table heads) — never for emphasis in prose.

## 10. Do-nots (each one is a guard, an incident, or both)

1. No fourth breakpoint; no width branches off 640/900/1200 (±1 for max-width).
2. No literal hex in client code; no raw-namespace paint (`bg-status-*`, undeclared `var(--…)`).
3. No second amber; nothing within 40° of the accent hue; `pulse` on nothing but live `running`.
4. No new animation, easing, shadow, radius step, z-index, or font file without amending this
   file AND the guards in the same change.
5. No `dvh`, no `100vw`, no `scrollIntoView` (the shell owns scrolling), no sticky header inside
   an overflow-x wrapper, no overlay painted over another cell to fake a row link (`rowHref`).
6. No hover-only affordances; no tap target under `--tap-min`; no input under 16px.
7. No un-tokened padding in primitives (density must reach everything).
8. No `npm run build` outside the cutover phase — the live console serves this checkout's
   `client/dist` per request. `npm run verify:dist` is the phase-safe gate.
9. Type floor 12px, tabular numerals, mono ligatures off — non-negotiable.
10. Fonts: two files, three faces, clamps intact, OFL notices shipped in the tarball.

## 11. Building a conforming page (the recipe)

1. Open on L0: the calm glance — identity, state, the numbers that decide "do I care".
2. Every further fact is ≤ 2 interactions away: fold detail into `Disclosure`/row detail (L1),
   give every record an `Inspector` (L2) with a `raw` slot (L3).
3. Tables are `DataTable` column arrays — declare priorities and an identity column; pass an
   `Empty` with an action.
4. Paint state ONLY through the vocabulary (badge, dot, `.state-*`); label + icon beside color.
5. Consume the pad tokens; check both densities, both themes, all three breakpoints.
6. Write the copy in §9's voice; run the guards (`test:client`, `typecheck:client`,
   `lint:client`, `verify:dist`) before calling it done.
