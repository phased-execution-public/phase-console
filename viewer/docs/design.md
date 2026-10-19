# Phase Console 7.0 — the design file (“Quiet”)

This is the law every page of the console obeys, rewritten whole for 7.0 (quiet-console phase 1)
from what `client/src/styles/theme.css`, the kit under `client/src/ui/` and their guards hold. A
session that has never seen the plan must be able to build a conforming page from this file alone.
Where this file and a guard disagree, the guard is right and this file has rotted — fix the file in
the same commit as the guard that moved. §12 names every guard and what it holds. Nothing of the
6.x client remains (quiet-console phase 29): every page is built on this file.

**The subject.** A control room for engineering work that runs itself: one expert operator
supervising autonomous Claude sessions executing phased plans — from a side monitor, and from a
phone when a push says something stopped. One job: *does anything need me?* answered in two
seconds, fixed in one move; everything else one expansion away. **The data is the hero; the chrome
is silent.**

**The one bold thing: the line and its stations.** A plan is a line, its phases are stations — a
transit motif drawn from the subject, because phases really are sequential stops. It is the only
graphic in the console: a run row's phase track, a plan's route map, a guide's step track, the
phase table's spine (`client/src/ui/track/`, §7). Everything else is type, space and rules.

**Refused by name**, so no page re-argues them: a warm paper with a serif and a clay accent; a
near-black ground with one acid accent; a broadsheet of hairlines and square corners; the SaaS card
kit (content chopped into identical rounded cards, one radius on everything, one soft shadow under
each, gradient washes); and template chrome — a tracked-out capital eyebrow above every heading,
meta strings glued with middle dots, `WORD — fragment` labels, a tinted near-black standing in for
black, a mono face for small labels, an arrow appended to a link. The boldness is spent once, on the
line.

---

## 1. The grammar — one column, one line per thing, three doors

Ten principles; each is held by a guard named in §12.

1. **One column, top to bottom.** A page is one calm column of rows ordered by what matters now;
   text measures at most 72 ch (`--measure`); tables take the width. No tile grids on a glance.
2. **One line per thing.** A run, a plan, a phase, a session, a turn item is one line: a status
   mark and its word · the name · one fact · one clock · one action (`ui/row.tsx`). Nothing else at
   the glance.
3. **Three doors to depth, the same on every page.** **Expand** — in place, remembered per person
   (`ui/disclosure.tsx`, a `Row`'s children, the `.expand-region` transition). **Inspect** — the
   full account of one record in four tabs, Overview · Actions · History · Raw
   (`ui/inspector.tsx`): the right panel at 1200 and up, an end sheet from 900 to 1200, a bottom
   sheet below. **Everything** — a per-page persisted switch that turns essentials into all
   columns, all facts, all sections, all keys (`useEverything(page)` in `ui/everything.ts`, kept
   in `prefs.everything` by page id; the toolbar's last slot draws it, `EverythingSwitch`).
   *No datum removed; every datum within two interactions* stays law, proven by the datum ledgers.
4. **Status is a dot and a word, or a badge** (§3.1). The eight hues at one OKLCH weight paint a
   6 px dot, a track segment, a row's leading edge or a badge's outline — never a filled chip
   behind text. The **badge** (`chrome="badge"`, one-pool phase 17, #361 — the owner's ruling of
   2026-10-14 reverses 7.0's "never a chip" for this one shape) is the same view as an OUTLINED
   pill: the status's icon and word in its hue on the page's own ground, a border at 60 % of the
   hue, no fill. It draws the status of a plan or a phase where that status is the row's headline
   (Plans cards and list, the plan header, the Phases table, the Run view's phase rows, Sessions).
   A settled dot is hollow and loses its hue; a settled badge keeps its hue at a 30 % border so
   Done and Complete do not read as grey text; a bad ending keeps its red. Amber is the one summons.
5. **Mono for machine values only** — shas, paths, commands, keys, ids (`Mono`). Money, durations,
   counts and percentages are the sans with tabular numerals (`Money`, `Duration`, `RelativeTime`).
6. **Four sizes on a page.** Title 22/600 · section 15/600 · body 14/400 · meta 12.5/400; the 12 px
   floor stands. Sentence case everywhere: no eyebrows, no capital labels, no tracked-out labels.
7. **Space is structure.** Rows are separated by space; a hairline rule only between groups; a card
   only around a thing that is acted on as a unit (a turn item, a halt). Surfaces differ by tone,
   not by shadow — one shadow exists, for overlays.
8. **One toolbar grammar:** search · filter · group · sort · view · ⋯ · Everything, in that order,
   on every list page; below 900 the search and one View sheet holding the other six in the same
   order and words (`ui/toolbar.tsx`). A page hands each slot as a panel; the desk shows it in a
   popover under the slot's button, the phone as a section of the sheet — one set of controls.
9. **Motion answers an act:** the expand (grid rows 0fr → 1fr), one arrival (`rise`; `fade` for an
   overlay's scrim and box), one live pulse on an observed running thing. Reduced motion kills all
   three.
10. **Copy is for acting.** A sentence appears only where a person must read it to act; empty
    states are one line and an action; explanations live in Help, reached from the page.

**The law of the glance**, kept from 4.0 in the words the ledgers cite: *No datum removed · every
datum within 2 interactions · a raw view exists · density honoured.* Each rebuilt screen carries a
`*.datums.test.tsx` whose rows are the old surface's facts, each with the press count at which the
new one must show it: 0 on the glance, 1 expanded in place, 2 in the inspector.

## 2. Type — one sans, one width, four sizes

One file for everything a person reads, one for what a machine says (SIL OFL 1.1; notices in
`client/src/assets/fonts/OFL.txt`, which the tarball ships; vendored, hashed by Vite, zero network):

| Token | Face | File | Width | Job |
|---|---|---|---|---|
| `--font-sans` | Instrument Sans (variable, wght 400–700) | `instrument-sans-var.woff2` | `font-stretch: 100%` | everything read: body, titles, labels, figures |
| `--font-mono` | Martian Mono (variable, wght 100–800) | `martian-mono-var.woff2` | `font-stretch: 87.5%` | a machine's values: shas, ids, paths, commands, keys, code |

7.0 retired the condensed display face 4.0 clamped out of the sans file (`font-stretch: 80%`):
titles are the UI face at 600, and `theme.test.ts` fails the day a clamp or a `--font-display`
comes back (it is shown its own negative). The mono carries ligatures off
(`--font-mono--font-feature-settings`): `->` in a command is two characters.

**The four sizes** (`@theme`): `--text-title` 1.375 rem (22 px, line-height 1.25) · `--text-section`
0.9375 rem (15, 1.4) · `--text-body` 0.875 rem (14, 1.5) · `--text-meta` 0.78125 rem (12.5, 1.45).
The body is set in `--text-body`. Title and section are 600, the rest 400; `font-medium` (500) is
a control's label. No page wears the 6.x scale (`--text-2xs` 12 · `xs` 13 · `sm` 14 · `md` 15 ·
fluid `lg`–`3xl`); it stays in `@theme` only because `styles/prose.css` sizes rendered markdown from
it. **The floor is 12 px.**
Numerals are tabular everywhere (the body's default; `.tnum` to opt back in). Headings carry
`letter-spacing: -0.01em` from base; nothing re-tracks them. Never a capital label, never a
tracked-out eyebrow (`ui/kit.test.tsx` scans the kit for `uppercase` and `tracking-[`).

## 3. Colour — one room, two lights

Both lights sit on one cool neutral family at hue 230 with low chroma: Paper is the room lit, Night
the room dimmed. Every colour token is declared ONCE as `light-dark(paper, night)` and the theme
switch is a `color-scheme` flip (`data-theme`); `theme.test.ts` holds every token to one line and
every surface and ink to hue 230 at chroma ≤ 0.02.

| Token | Paper | Night | For |
|---|---|---|---|
| `--ground` | oklch(98% 0.004 230) | oklch(18% 0.012 230) | the page |
| `--ground-deep` | 96% 0.006 | 15.5% 0.010 | a recessed band |
| `--surface` | 100% 0 0 | 21% 0.013 | a sheet, a dialog, a card that is acted on |
| `--surface-raised` | 99% 0.002 | 25% 0.014 | hover, a raised row |
| `--rule` / `--rule-strong` | ink at 8 % / 16 % | ink at 10 % / 20 % | a hairline between groups; a control's edge |
| `--track` | 89% 0.010 | 33% 0.018 | the line the stations sit on |
| `--hatch` | the waiting hue at 18 % | at 22 % | a hatched fill on a time axis |

**Three inks, and all three are text** — each clears AA's 4.5:1 on all four text surfaces in both
lights, because each is read at the meta size somewhere. `contrast.test.ts` settled the L of each
(quiet-console phase 1), holds them a step apart and in the right order for their light:

| Ink | Paper L | Night L | For | Lowest contrast, Paper · Night |
|---|---|---|---|---|
| `--ink` | 20% | 95% | body, names, figures, a status word | 16.11 on ground-deep · 13.81 on surface-raised |
| `--ink-muted` | 42% | 77% | labels, secondary lines, a settled word | 7.50 on ground-deep · 7.73 on surface-raised |
| `--ink-faint` | 52% | 67% | true metadata: a clock, an id, a hint — never an affordance | 4.88 on ground-deep · 5.36 on surface-raised |

The document and the manifest carry the two `--ground` hexes the browser chrome needs — Paper
`#f6f9fb`, Night `#0c1316` — and `contrast.test.ts` recomputes them from the tokens.

**Status is a system, not a colour.** Eight UI states (`UI_STATES`, `shared/status-vocab.js`,
worst first: needs-you, failed, running, verifying, waiting, queued, skipped, done), one hue each,
all at ONE OKLCH weight per light — Paper 48 % / 0.08, Night 75 % / 0.12; the neutrals `queued` and
`skipped` drop the chroma — so no state shouts by accident. `contrast.test.ts` holds each at
≥ 4.5:1 as text on the four text surfaces and ≥ 3:1 as a mark on the track, in both lights, inside
sRGB. `verifying` is running's family, told apart by a dashed segment; `running` alone may pulse.

**Amber is a summons.** `--accent` = `--status-needs-you` is the ONE door to amber, and amber means
*a person is needed*; every other hue keeps ≥ 40° away. `--action` (the primary button) and
`--focus` (the ring) are high-contrast **ink**: a primary button, a focused control, a selection and
the page you are on are not summons. There is no amber button in the kit. `theme.test.ts` follows
every token to its root and fails any focus mark in amber; `contrast.test.ts` holds the ring at
≥ 3:1 and the primary button's label at ≥ 4.5:1 on its fill. No brand colour: the brand is the
arrangement.

Colour has three doors: Tailwind utilities from `@theme inline` (`text-ink-muted`, `bg-surface`,
`border-rule`); the state indirection — a `.state-<ui>` class sets `--state` and descendants paint
`text-state` / `bg-state` / `border-state` without knowing which state they show, and the typed
family (§3.1) and these classes are the only places a hue is chosen for a status; and `var(--token)`
in the stylesheets (`prose.css`, `console.css`, `ui/track/track.css`, the route map's
`screens/plan/map/route-map.css`).

Never: a literal hex (ESLint bans it; the terminal's ANSI slots are the one file excused), a
utility from the raw namespace (`bg-status-done` compiles to NOTHING), an undeclared colour name, a
new hue, a `var(--track-…)` for anything but the colour (`track` is a colour family, and the theme
guard reads any other name in it as an undeclared colour — the track's sizes are `--station-*`).

### 3.1 The signal law — one model, one family, a dot and a word

**Status model v2** (`shared/status-model.js`) gives every word of every vocabulary the console
paints one row in `WORD_ROWS` — a precise label, an icon, a paint that is one of the eight hues — on
three axes: **tense** (`live` · `standing` · `settled`), **outcome** (for a settled thing: `ok`,
`partial`, `failed`, `stopped`, `superseded`, `unknown`) and **attention** (`none`, then the inbox's
own severities `fyi` · `needs-you` · `urgent`). It decides with a table, never a word alone:
`describeWord`, `describeRun`, `describePhase`, `bayOf`; a word the vocabulary does not hold is the
first-class **Unknown**. **The law of amber:** amber is never derived from a status word; it comes
from an open inbox item or a word in `PERSON_WORDS`. `test/status-model.test.ts` holds every row.

**The typed family draws it** — `client/src/ui/status/`, imported as `@/ui/status`, deliberately
NOT in the first-paint barrel. `DotWord` is the ONE renderer (`ui/status/dot-word.tsx`, imported
only inside the family — ESLint refuses it elsewhere):
a 6 px dot wearing `.state-<paint>` and a precise word in ink, with `data-status`, `data-paint`,
`data-attention`, `data-vocab` and `data-tense`. The members accept only their own vocabulary
(`WordOf<V>`; a QA word handed to `RunStatus` is a type error):

| Member | Draws | Words |
|---|---|---|
| `RunStatus` | `describeRun(run, ctx)` | the run words |
| `PhaseStatus` | `describePhase(record, {boardState})` | the phase-record and board words |
| `PlanStatus` | a plan's `status:` | the plan words |
| `QaStatus` | a verdict (`result`) or a regime (`mode`), one of the two | `qa-result` · `qa-mode` |
| `AccountStatus` | a login (`auth`) or an entitlement, one of the two | `auth` · `entitlement` |
| `McpStatus` | a server's connection | `mcp` |
| `OpsStatus` | `vocab="…" word="…"` — every other vocabulary, typed by the one named beside it | the rest |
| `FactMark` | a fact beside a status (a count, a reason), its own icon and paint, never attention | `FACT_KINDS` |
| `AttentionMark` | the attention axis alone, through the inbox's `SEVERITY_UI`; nothing for `none` | `ATTENTION_LEVELS` |
| `SeverityMark` | an inbox item's kind as the word, its severity as the dot — FIRST PAINT, reads no table; import it by its own path | the inbox severities |

**What the dot says.** Live or standing: filled with the hue. Settled: hollow — and *quiet* (the
ring `--ink-faint`, the word `--ink-muted`) unless the outcome was `failed` or `partial`, which keep
their hue, because a bad ending is still a signal. Unknown: hollow and dashed. A summons
(`attention` other than `none`) paints the WORD in the hue too, so "needs you" reads from across the
room; every other word stays ink, which is what keeps the page calm. A view's fact is drawn after a
thin rule, in its own paint (`Finished, 1 failed`). `live` on a member breathes the dot only for a
live view painted `running` — the one continuing motion on a page. `statusIcon(name)` and
`STATUS_ICONS` resolve the model's icon names for the places a glyph is wanted beside the word (an
inspector's title, a kind mark); the dot chrome draws none.
**The badge.** Every member takes `chrome="badge"` (`Chrome` in `ui/status/view.tsx`): the same view,
drawn by the same `DotWord`, as an outlined pill carrying `data-chrome="badge"` and the same `data-*`
facts — the view's icon (`statusIcon(view.icon)`) and word in `text-state`, a `border-state/60` outline
(`/30` when settled and quiet, dashed `--ink-faint` when Unknown), no fill. The hue as text clears AA on
every surface in both lights (`contrast.test.ts`), which is why the word may wear it here and not in
the dot chrome, where ink keeps the page calm. `ui/status/family.test.tsx` holds
every member, the icon map, Unknown, the quiet rule and the family's axe.

**The ratchet holds at zero.** `ui/status/ratchet.test.ts` counts every legacy status site per
file under `src/` — `<StatusBadge`, `<StatusDot`, `statusBadgeClass(`, `uiState(`, `STATE_META[`, a
`state-${word}` the model did not paint — and its snapshot (`status-ratchet.json`) is empty, so any
site is a regression; its source scan holds the retired names — the 2.x chip and its tones, the
`--line-*` aliases, the 6.x `StatusBadge`/`StatusDot`/`ViewBadge` — gone from every source file.

## 4. Space and density

Spacing is Tailwind's 4 px scale. Two padding families are **density-switched wholesale** by
`data-density` on the root (the persisted preference `prefs.density`):

| Token | Comfortable | Compact | Read by |
|---|---|---|---|
| `--pad-x` / `--pad-y` | 16 / 12 px | 12 / 8 px | the page frame, sections, the inspector body |
| `--tile-pad-x` / `--tile-pad-y` | 12 / 10 px | 10 / 6 px | table cells |

Density buys space out of padding, **never out of ink** — no type size changes. A primitive that
pads content consumes these tokens, never a literal `p-*`.

## 5. Shape, elevation, motion

- **Radii:** `--radius-sm` 3 px (a dot's halo, a keycap, the focus ring), `--radius` 6 px
  (controls, menus), `--radius-lg` 10 px (sheets, dialogs, the toast).
- **Elevation:** ONE shadow, `--shadow-overlay`, for what floats over the page — a sheet, a
  dialog, a menu, a popover, a toast. Nothing in the page casts: a card is a tone, a row is space.
  `theme.test.ts` holds the `--shadow-*` set to exactly `overlay`.
- **Motion is a closed vocabulary.** `rise` 260 ms is the one arrival (a toast, a bottom sheet
  arriving in the page); `fade` 120 ms is an overlay's scrim and box; `pulse-soft` 2.4 s is the only
  *continuing* motion, reserved for a live `running` thing that is being observed. The expand is a
  TRANSITION, not an animation: `.expand-region` grows its one grid row from `0fr` to `1fr` on
  `duration-medium`, and `@starting-style` gives a region that mounts as it opens its first frame.
  `--ease-transit` throughout; `duration-fast|medium|draw` backed by `--transition-duration-*`.
  The route map keeps its draw-in on `--duration-draw` (620 ms) in its own `route-map.css`, and its
  one breath is `pulse-soft` over a live running station. Reduced motion kills it all (the global
  rule, and `track.css`'s and the map's own); a new animation is an identity change.

## 6. Breakpoints and layout

Exactly three: **640** (phone: one thumb, one column) · **900** (the rail gives way to the phone
shell) · **1200** (wide: the right panel docks beside the page) — `sm:`, `md:`, `lg:`, with
Tailwind's defaults cleared so `xl:` compiles to nothing, and `lib/media.ts` ⇄ `theme.css`
test-enforced. Branch on nothing else. The shell owns the one scroller; `--app-height` (never
`dvh`) sizes overlays; `--z-*` is the whole stacking order (`base` 1, `sticky` 20, `shell` 40,
`scrim` 60, `toast` 70). Touch floors: `--tap-min` 44 px targets (as a hit area through `tap-area`
and `tap-line`, as the box through `tap-row` and `tap-cell`); `--text-input` 16 px inputs, restated
unlayered under a coarse pointer so no size utility beats it.

### 6.1 What each surface does when it runs out of width

| Surface | Below 1200 | Below 900 (phone shell) | Below 640 (one column) |
|---|---|---|---|
| **Row** | — | — | the fact and the clock drop under the name; the action stays on the first line |
| **Inspect** | an end `Sheet` | a bottom `Sheet` | — |
| **Dialog** | centred in `--app-height`, never wider than the viewport less 2 rem | — | — |
| **Tabs** | — | one row that scrolls sideways, never wraps; its trailing edge fades (flipped under `rtl:`), the active tab scrolls itself into view by moving the list's own `scrollLeft` | — |
| **Table** | — | scrolls inside its own box only when measured to overflow (`TableWrap scrolls`); a sticky header reaches `<main>` only on the branch that does not scroll | — |
| **Grid** | folds what the box cannot fit into the row's counted `+N`, lowest priority first; with Everything on, nothing folds and the wrapper scrolls with the identity pinned | the same column array as a list of records: one line each — the headline, the quiet `meta` line, the one action — every other column one press away in the record's fold | — |
| **Toolbar** | — | the search and one View sheet; the slots' panels become its sections, in order | — |
| **Toast** | the bottom end corner | above the tab bar and the keyboard (`--bottom-bars`, `--app-height`) | — |

**The structural guarantees** — each stated where it is decided, pinned in `styles/touch.test.ts`
over every tree a surface is written in, and measured in the browser by the register (§6.3):
one scroller, one axis (`<main>` clips sideways overflow, so every rule below is a containment
failure rather than a page that slides); a row that can grow may shrink and wrap (`min-w-0`, never
`shrink-0`; `break-words` for text the app did not write); a control reaches `field` /
`fieldSurface` (`ui/field.ts`, the one definition) or declares its own floor; a thumb floor is released by a pointer, never by a width; the thumb floor
is a HIT AREA, not a box, except among stacked controls; a floor is real only if the control wins
its own box (the three probe questions); no control sits inside a control; focus stays visible —
one ink `:focus-visible` ring, globally, and a page may not suppress it; an imperative scroll asks
`scrollBehavior()`.

### 6.2 Logical sides — right-to-left is a switch away

The kit (`client/src/ui/**`), the cards, the shell and the screens set every horizontal margin,
padding, inset, border, corner and alignment logically — `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`,
`border-s`/`border-e`, `rounded-s`/`rounded-e`, `text-start`/`text-end` — and the stylesheets
declare `margin-inline-*`, `padding-inline-*`, `inset-inline-*`, `border-inline-*` and `text-align:
start | end`. The sheet's sides are `end`, `bottom` and `full` — a logical word, so no call site
names a physical edge. `styles/logical.test.ts` is the ratchet: it fails an `ml-`, `pr-`, `left-`,
`border-r`, `rounded-l` or `text-left` — or its arbitrary-property or inline-style twin — and holds
`KEPT`, a short list of sides physical by nature (a centring pair, a device's safe-area insets),
both ways. **No file of the client has an entry in it**, and the test says so. `e2e/rtl.spec.ts` throws the
switch on every stop of the tour in all four viewports (quiet-console phase 27).

**Prose finds its own direction.** Every element that holds text — `p`, `h1`–`h6`, `li`, `dt`, `dd`,
`th`, `td`, `caption`, `figcaption`, `legend`, `summary`, `blockquote`, `div`, `span`, `label`, `a`,
`button` — is `unicode-bidi: plaintext` (theme.css's base layer): its base direction comes from its
first strong letter, as `dir="auto"` would, so English reads left to right in a right-to-left
document (a leading number stays first, a full stop stays last) and Persian right to left in a
left-to-right one, while `direction` — and with it every logical side — stays the document's. All
but `button` are also `text-align: match-parent`: a run's ORDER is its own, its ALIGNMENT the
page's, so a column of figures keeps one edge and a Persian title in a list of English ones stays at
the column's start. `code`, `kbd`, `samp` and `pre` are `direction: ltr`
and isolated, because a flag or a path read the other way is a different one. Text inside an element
that declares its own `dir` keeps it. Separate boxes — a label and its count drawn as two flex
items — trade places under RTL as any row does; `e2e/rtl.spec.ts` reads each run of text inside one
box, on four pages at two widths. A count beside a title takes its gap on BOTH sides (`mx-2`),
because the title and the count are one left-to-right run whichever way the document reads, and a
start margin would land outside it.

### 6.3 Proven in a real browser — the register, the build, the policy

jsdom computes no layout and paints no colour, so the rules above are measured where a person meets
them — in Chromium, by the Playwright harness under `viewer/e2e/`. A sandboxed console is visited at
every stop in four viewports (`e2e/lib/shots.ts`: `phone-360`, `tablet-768`, touch; `desk-1024`,
`desk-1280`) and photographed into `e2e/.shots/`, to be READ by the phase that built the screen.
Seven finding classes (`e2e/lib/probes.ts`: `overflow`, `escape`, `touch-present`, `touch-wins`,
`touch-survives`, `axe`, `focus`), and **the register is EMPTY**: `register.spec.ts` holds every
finding to `e2e/baseline.json`, and that file is `[]`. A finding is fixed, never banked; a spec leg
that cannot pass mid-way is a `test.fixme('quiet-console phase N')` the named phase removes.
`npm run test:e2e:dist` tours a production build under the console's own CSP (`smoke.spec.ts`
counts every refusal); `scripts/gates.sh` runs the same stage.

## 7. The signature — the line and its stations

`client/src/ui/track/`: `Track` is a list (`<ol role="list">`, horizontal or vertical) that draws
one neutral line in `--track`; `Station` is an item on it — a 6 px dot painted through
`.state-<paint>` with the identity of its record beside it (`children`), because colour is never
the only carrier. The grammar:

- The **line is neutral**; only a station carries a state, and the stations sit at equal intervals.
- The **line never runs through a station's words.** A horizontal track draws it leg by leg: each
  station but the last draws the leg after its label, on to the next dot. A vertical track draws it
  beside the words (a start-aligned one leg by leg too). Never a ground-coloured box behind the
  words to hide a line under them — on a card or a hovered row that box is a patch.
- A **settled** station (`settled`) is hollow and has lost its hue — `--ink-faint` — unless it is
  `failed`, which keeps its red. A `fill` paints the segment after a station in the station's own
  paint (a ticked step, a leg already travelled), ink-faint once settled.
- **`live`** breathes the dot — the one continuing motion — and only when the station is painted
  `running`; a live waiting station is still. `prefers-reduced-motion` stops it in `track.css`.
- **`needs-you` wears the summons ring** — solid, heavier, the one amber on the line — never a
  pulse: a gate waiting on a person is not alive.
- The sizes are the track's own properties, `--station-size` (6 px), `--station-line` (2 px) and
  `--station-ground` (the halo that cuts the line around a dot); a map may raise the first.
- Every side is logical; a right-to-left page mirrors the line.
- The motif may appear small (a run row's track, the rail's mark), never as decoration on a surface
  with no structure: restraint is what keeps it a signature.

**A plan's line is drawn in proportion** (one-pool phase 17, #360; `screens/plans/track-bar.tsx`,
`PlanTrack`). On Plans' cards and list, the panel, the plan's glance and Your turn's *Where the plans
stand*, a plan is one 6 px bar on the track's ground: each board bucket a segment whose length is
its share of the phases, painted `.state-<paint>` from `BOARD_STATE_UI`, in one order — done, held
by QA, in progress, stuck, next up, waiting, then what no bucket accounts for as the bare track. Under
it, one worded legend names every non-zero count in that order and the percentage (`41 done · 1 held
by QA · 1 in progress · 2 stuck · 3 waiting · 25 left · 56 %`); the whole is one `role="img"` whose
name reads the same counts, so colour is never the only carrier. The counts are `countsOf` over the
`/api/plans` row, no fetch of its own, and the segments always sum to the phase count. The two
overlays never double-count: a phase QA failed is carved out of done as its own segment (QA's fail
paint), and a gated phase stays in its bucket, the gate a needs-you hatch drawn over next up and
waiting. A closed plan draws what got done and what never ran (`skipped`); an unread board its last
good reading and the rest hatched, its legend the shared reading (#96) — never a bar at 0 %.

`ui/track/track.test.tsx` holds the paint through `.state-*`, the pulse, the ring, the
reduced-motion rule and the legs. **The route map** (`screens/plan/map/`: `dag.tsx`, `map-view.tsx`,
`route-map.css`) is the line at plan scale, ported with its own grammar kept — each state a drawn
glyph and a ring treatment, so no state is told by hue; the 0.45 zoom floor; the minimap and the
station search of a crowded plan; one tab stop and the arrow keys — on these tokens: four sizes,
sentence case, numbers in the sans, `pulse-soft` over a live running station, the gate's amber
through `--accent`, a keyboard focus in the focus ring's ink. Its stylesheet rides the map's lazy
chunk and styles only `route-` names (or names under one); loaded, it is global for the visit, so
the kit's classes are `ui-` names and the test holds the kit to none of the map's. Its tools (one-pool
phase 16, #376, `map/tools.tsx`) are the address, never state: filter chips with counts dim what they
leave out and remove nothing; a selection traces the whole chain both ways; a colour by repository,
size, cost or time paints `--state` from the status tokens and keeps the glyph saying the state; the
layers, the three layouts (left to right, top to bottom, one lane per repository) and *Hide done*
are held to the same collision guard as the default drawing; a click inspects, a second click or
Enter opens; on a desk the hover card (`map/hover-card.tsx`) replaces the native tooltip; export
writes the current view as an SVG painted inline, and a PNG of it (`map/export.ts`).

## 8. Components — the kit contract

The kit is `client/src/ui/`. **The LIGHT barrel** `@/ui` (`ui/index.ts`) is ONE modulepreloaded
chunk every visitor downloads before the first frame, so it carries only what the first frame
draws, and `check-dist` fails the build whose first paint passes 170 KB served:

| Export | What |
|---|---|
| `Button`, `ButtonGroup`, `buttonVariants` | `default` (a hairline, the surface tone) · `primary` (ink-solid, ONE per screen) · `ghost` · `danger` (the failed hue; still confirms). Thumb-high and thumb-wide on touch; `asChild` for a link. No amber button exists |
| `Kbd`, `KbdChord` | a keycap; keys pressed together |
| `Mono` | a machine value: the short form drawn, the whole value on hover or one copy away |
| `RelativeTime`, `Duration`, `isoDuration`, `Money` | the sans with tabular numerals; a sum over its budget reads failed |
| `Skeleton`, `Empty`, `Spinner` | a shape where nothing loaded; one line and an action; a quiet ring that says "Loading" |
| `Banner`, `NoteIcon`, `Severity` | a note about the screen — a leading rule in the severity's paint, no fill; reads `shared/status-notes.js` and `ui/status/note-icons.ts` only |
| `toast`, `dismissToast`, `useToasts`, `Toaster`, `copy` | the toast store (module-level, raised from anywhere) and the tray above every bottom bar and the keyboard |
| `field`, `fieldSurface` | THE control class in its two looks, defined once |
| `Input`, `Label` | a text input wearing `field`; a control's name with its hint under it |
| `SectionHeading` | 15/600, sentence case, a count beside it, one control at the end — no eyebrow |
| `KeyValue` | facts in two columns, one on a phone; an empty row is not drawn |
| `Page` | the frame: the title (22/600), the situation in words, the page's controls, then the rows; pads on the density tokens |
| `Row` | one line per thing — mark · name · fact · clock · action — with its leading edge in the thing's paint and its children expanding in place |
| `EVERYTHING_PREF`, `Everything`, `EverythingPref`, `useEverything` | the third door: its preference key (page id → on), its type, and the page's switch, kept per page id |

**The heavy pieces are imported by path, never re-exported** (`ui/kit.test.tsx` holds the barrel
to it): `ui/dialog.tsx` (`Dialog`, `DialogContent` with `frame`, `DialogFooter`; centred in
`--app-height` with no physical side), `ui/sheet.tsx` (`Sheet`, `SheetContent` with `side` `end` ·
`bottom` · `full`), `ui/popover.tsx`, `ui/dropdown.tsx` (the `⋯` menu; a destructive item says so),
`ui/command.tsx` (cmdk; `CommandDialog` is the palette shape), `ui/tooltip.tsx` (`Tooltip`,
`InfoTip` — nothing load-bearing rides in a hover), `ui/select.tsx`, `ui/combobox.tsx`,
`ui/tabs.tsx`, `ui/table.tsx` (`TableWrap scrolls`, `Table`, `THead` in sentence case, `TBody`,
`TR`, `TH`, `TD`, `stickyHeadCell`, `stickyIdentityCell`), `ui/markdown.tsx` (`Markdown`,
`MarkdownInline`, `toFragment`, `sweep` — the sanitizer is the 6.x one VERBATIM, because a
sanitizer is the one place "identical" is worth everything), `ui/disclosure.tsx`, `ui/inspector.tsx`
(`Inspector` with `host` `sheet` · `inline`, four tabs), `ui/checkbox.tsx` (three states; ink when
ticked, never amber), `ui/native-select.tsx` (the platform's own picker, for a short list of plain
words), `ui/confirm.tsx` (`ConfirmButton`: the button and its question as one decision, on an alert
dialog that keeps the button's own words and shares `dialogBox` with `ui/dialog.tsx`),
`ui/toolbar.tsx` (`Toolbar`, `ToolbarSearch`, `EverythingSwitch`: the seven-slot grammar of §1,
principle 8), `ui/data-list.tsx` (`DataList`: the long list, windowed in a scroller of its own),
the typed family `ui/status/` (§3.1), the line `ui/track/` (§7), and **the grid** `ui/grid/`:
`Grid` over one `Column<T>[]` (`column.ts` — `min` required, `priority`, the `identity`, a `card`
role of `title` · `meta` · `action` · `none`, `everything` for the columns only Everything draws,
`filter` · `groupable` · `sort` over a plain `value`), the wide table, its folded cut and the
phone's records from that one array; the operator's view kept by `tableId` (`view.ts`); the
toolbar filled from the columns (`toolbar.tsx`, the panels in `view-sheet.tsx`); and the row
model, TanStack Table in `engine.ts`, reached only through `import()` — its own `engine-*` chunk,
which a grid asking for no filter, group, pick or window never fetches. Every overlay sizes by `--app-height`, never by `dvh` or `100vw`, and
every item in a menu or a list is thumb-high on touch (`touch.test.ts` names the six overlay files).

**The doors.** Five rules hold over the whole of `client/src` (`eslint.config.js`), each carving out
exactly the one file or folder that IS the door: no hand-written `#/…` address (a template literal or
a string) outside `shell/routes.ts`; `useQuery`, `useQueries`, `useInfiniteQuery`, `useSuspenseQuery`
and `useMutation` imported only inside `data/`; `DotWord` imported only inside `ui/status/**`; an
`EventSource` opened only by `data/live.ts` and the Logs tail (`screens/logs/tail.ts`); and TanStack
Table imported only by `ui/grid/engine.ts`, which is itself reached only through `import()`.
`ui/boundary.test.ts` runs the repository's own ESLint config over virtual files in every top folder
and holds each rule both ways. The 6.x client is gone, and `sweep.test.ts` holds it gone: no path of
it, no file importing, loading or mocking one, no door file, and one exported name per thing across
the client (`data/`'s wire types aside).

## 8.2 Figures and marks — where the chart library line sits

Kept from 6.0 (control-tower phase 29) and written down so the next chart does not re-argue it.
Since quiet-console phase 19 every drawing lives under `ui/figures/`, and the figures' one door,
`ui/figures/lazy.tsx`, owns a closed split (`FIGURES` / `MARKS`, held by `ui/figures/figures.test.tsx`
against the door's own exports); the 6.x charts and figures modules are gone. The split
is also where the library line runs.

| What | Drawn by | Why |
|---|---|---|
| The mark — `LoadMeter` | hand-rolled, in `ui/track/meter.tsx`, on the line's own tokens | One datum of a row, a real `role="meter"`. No axis, no zoom, no readout: the words beside a mark ARE its table, and any library behind it is first-paint weight for a 6 px bar. `RouteStrip` and `RunStrip` retired into the line in phase 19: a run's route is the kit `Track`, which the run row's glance already draws. |
| The figures — `Bars`, `Calendar`, `BarList`, `StackBar`, `Series` | visx, in `ui/figures/bars.tsx` | A crosshair, a zoom and keyboard reach are axis work. The drawing is lazy behind `ui/figures/lazy.tsx`, its only importer; the figure's name, its numbers table (`FigureNumbers`, `ui/figures/numbers.tsx`) and its paint stay at the door. A `StackBar`'s key is the kit's `ui/legend.tsx`, the route map's own key. A `Series` (one-pool phase 10) is small multiples: a strip per row on one shared time axis, one scale and one crosshair — the row named in words, never a hue — so "spend over time by account" needs no categorical palette. |
| The run's time axis — the Gantt's lanes and each phase's clock split | hand-rolled `ui/figures/swimlane.tsx` on `ui/figures/scales.ts` | The lanes' geometry, hatch and `.state-*` bridge were already right; they take a shared axis, a present and a zoom from the figures. |
| The run's cost strip | visx, in `ui/figures/run-chart.tsx` | A second reading on the lanes' own axis, with a dollar scale of its own. Lazy behind the same door (`RunCostFigure`). |
| The plan's schedule and the lock map (one-pool phase 16, #376 #364) | the swimlane, in `ui/figures/schedule.tsx` and `screens/sessions/lock-map.tsx` | Rows of bars on one time axis is the swimlane's job: what ran (the run record) and what is expected (estimates over dependencies, the chain that sets the finish outlined), and a claim's lease per repository lane, a lapsed one hatched. Both read their arithmetic from a pure function (`scheduleOf`, `lockLanes`). |
| The plan's burn-up (one-pool phase 16, #376) | hand-rolled, in `ui/figures/burnup.tsx` | Two step lines (phases and weight done, as a share of the whole) and the forecast's band: a dozen SVG elements on `linear`, state tokens only. Its arithmetic is `burnupOf`. |
| The time figures' zoom (one-pool phase 16, #376) | `ui/figures/zoom-controls.tsx` over `useFigure`'s `zoomBy`/`zoomTo` | − / + said on the figure, and on a run's axis the quick ranges (last hour, 6 h, 24 h, all) — kept in the address as `?zoom=` (a token, or `<from>~<to>` seconds from the axis's start); a wheel or a pinch writes no history. |

**What moved to visx:** `@visx/scale` (the linear map and 1-2-5 ticks behind `ui/figures/scales.ts`),
`@visx/axis` (tick layout and labels), `@visx/shape` (bars and rules) and `@visx/event` (a pointer
in an SVG's own units). About 27 KB gzipped in lazy chunks (`bars-*`, `run-chart-*`); first paint
did not move.

**What was named and not taken:** `@visx/zoom` binds drag, pinch and a plain wheel on its container
and cannot see a pinch without `touch-action: none`, which takes the page's vertical scroll away —
zoom is a 1-D window in `ui/figures/use-figure.ts` instead; `@visx/responsive` throws where there is no
`ResizeObserver` (jsdom) — `useWidth` in `ui/figures/paint.ts` is fifteen lines with the guard the
client already uses; `@visx/tooltip` is a floating box for a pointer — the readout line under each
figure serves a phone and a keyboard too; `@visx/xychart` ships its own theme and palette, which is
the colour vocabulary the figures were written to refuse.

**Rules that hold, each by a test:** paint is a state token (a figure's tone is a UI state by name,
painted through `.state-<tone>` and `var(--state)`; every axis is drawn with `AXIS_PAINT`;
`ui/figures/figures.test.tsx` sweeps for a literal colour); every figure keeps its numbers and the
drawing equals them (`data-datum`/`data-value`); the page keeps its scroll (a plain wheel and a
vertical swipe are the page's, every figure surface is `touch-action: pan-y`); the crosshair is a
`role="slider"`; the drawings stay lazy (`check-dist` finds them by `data-figure`). The figures' SVG
axis labels are still 9 px, under the 12 px floor; phase 27's sweep raises them with the gutters.

## 9. Copy — the console's voice

Words are design material. The register: plain verbs, sentence case, no filler, the operator's side
of the screen.

- **Name what the operator controls, not how it is built** ("Notifications", not "webhook config").
- **A control says exactly what happens** ("Approve gate", "Try again", "Sign in again") and keeps
  the same name through the whole flow. "More…", "Submit", "OK" name nothing.
- **A status is a precise word** — "Halted", "Paused by you" — the model's label, its fact beside it.
- **A sentence appears only where a person must read it to act**; a glance is words and figures.
- **Separate data are separate words** — two facts with a gap between them, or a status and its
  fact behind a rule; never one string glued with middle dots.
- **Provenance in the hint, never the label** — a label is the accessible NAME (`Label hint`).
- **Errors**: what went wrong, in the server's own words, and a way out. Errors do not apologize
  and never invent a reason ("The read failed and said nothing." is the honest floor).
- **Empty states direct**: one line and an action (`Empty`). **Status words explain themselves on
  hover** (`viewTitle`), but hover is a hint, never the only carrier.
- **Sentence case, everywhere a person reads.** No label, button, tab, heading or table header is
  set in capitals, and capitals are never emphasis; the kit spells no `uppercase`.

## 10. Do-nots (each one is a guard, an incident, or both)

1. No fourth breakpoint; no width branches off 640/900/1200 (±1 for max-width).
2. No literal hex in client code; no raw-namespace paint (`bg-status-*`); no undeclared colour; no
   `var(--track-…)` but the colour.
3. No amber that is not a summons: nothing within 40° of the accent hue, no amber button, no amber
   focus mark, no amber selection, and a pulse on nothing but an observed live `running`.
4. No status outside the typed family: no legacy site (the ratchet is zero), no `dot-word` import
   outside `ui/status/**`, no filled chip behind a status word (the outlined badge is the family's
   own `chrome="badge"`, never a page's), no status in colour alone.
5. No second face, no width clamp on the sans, no `--font-display`; no second shadow, no card
   shadow; no new animation, easing, radius step, z-index or font file without amending this file
   AND the guards in the same change.
6. No `dvh`, no `100vw`, no `scrollIntoView` (the shell owns scrolling), no sticky header inside an
   overflow-x wrapper, no overlay painted over another cell to fake a row link.
7. No hover-only affordance, tap target under `--tap-min`, input under 16 px, or floor a width
   releases.
8. No physical side anywhere in the client; no un-tokened padding in a primitive.
9. No capital label, no tracked-out eyebrow, no middle-dot meta string, no mono for anything but a
   machine value, no arrow on a link.
10. No path of the 6.x client, no hand-written `#/` address outside `shell/routes.ts`, no query
    hook outside `data/`.
11. No finding banked: the register is `[]`, and a finding is fixed.
12. No inline script, no `eval`, no resource the policy does not name — the console's CSP refuses
    it, and the dist-mode smoke counts every refusal.
13. No `npm run build` in a phase — `verify:dist` and `test:e2e:dist` build into a scratch directory.
14. Type floor 12 px, tabular numerals, mono ligatures off; two font files, two faces, OFL notices in
    the tarball — non-negotiable.

## 11. Building a conforming page (the recipe)

1. Open on the glance: a `Page` with its title and the situation in words; a column of `Row`s, each
   a mark (`@/ui/status`), a name, one fact, one clock, one action; a hairline only between groups.
2. Every further fact is ≤ 2 interactions away: expand in place (`Row` children, `Disclosure`),
   inspect (`Inspector`: Overview · Actions · History · Raw), Everything; write the datum ledger
   (`*.datums.test.tsx`) the moment the page replaces one that showed facts.
3. Paint status ONLY through the typed family and the `.state-*` indirection; a word beside every
   dot; amber only for a summons.
4. Reach data through `data/` and addresses through `shell/routes.ts`; import nothing old.
5. Consume the pad tokens, spell sides logically, set type in the four sizes; check both densities,
   both lights, all three breakpoints; write the copy in §9's voice.
6. Run the guards — `test:client`, `typecheck:client`, `lint:client`, `verify:dist` — then the real
   browser: `npm run test:e2e:dist` tours the production build under the console's own CSP. Every
   stop at 360, 768, 1024 and 1280 is held to the EMPTY register: the fix is the page, never the
   baseline. Open the pictures in `e2e/.shots/` and READ them.

## Your turn — the card's law

Turn-by-turn phase 8 drew every item on Your turn as ONE card in the anatomy of the Owner To-Do Board.
A card wraps an item because the item is acted on as a unit (§1, principle 7). The server decides
every word: `GET /api/turn` gives each item its type, the person's status, whether it is due, where
a press goes and the composed words. The card only draws them (`client/src/cards/item-card.tsx` and
its parts under `client/src/cards/turn/`). Each rule names its guard.

**The anatomy, top to bottom** (`client/src/cards/turn/head.tsx`, `timing.tsx`, `verdict.tsx`,
`steps.tsx`, `act.tsx`):

1. **The head.** NOW, or NOT YET with its *when* in words. The type's mark: a glyph and a word,
   Approval, Task, Decision or Heads-up (`TYPE_META`). The person's status as a dot and a word. Inspect.
   Readiness is drawn only while the act is still the person's (`readinessShown`: To do or Redo). The
   status and the readiness are the typed family's `turn` member, `TurnStatus` and `TurnReadiness`
   (`client/src/ui/status/turn.tsx`). Their words are rows of `shared/status-model.js` (vocabularies
   `turn` and `readiness`), and their labels are `PERSON_STATUS_LABEL` and `READINESS_LABEL`, held
   equal by `test/status-model.test.ts`. Amber paints only To do, Redo and Now.
2. **The title**, which names the act, and **the meta**: plan, phase, run, what it unblocks and
   the effort. Each is its own fact and a link where it can be. Never a dotted string.
3. **The timing grid**, on one page clock. *Assigned*, *Do it* and *Deadline* are always drawn: a
   missing deadline reads "None set". *Open until*, *You sent it* and *Checked* are drawn when the
   item has them. The window is *Open until* and is never called a deadline. A deadline carries
   what is left (or how overdue, in the failed hue) and a bar from assigned to deadline, which is
   the line's mark `LoadMeter`.
4. **Why, once.** "Only you:" with the reason's sentence, or the composer's need on a projected
   item. Never both.
5. **The verdict, BEFORE the steps.** A verdict changes what the steps are for. Redo shows what the
   check found and the exact fixes, numbered. A running check says the verdict lands here. A settled
   item says how it ended, by whom and when. Back with the person, the box wears the summons as a
   leading rule, never a filled band.
6. ***From the AI***: what it tried first and its last word.
7. **The numbered steps on the line.** These are the guide's track (§7). The card uses the authored
   guide whole, else the composer's steps. A plan item and the session item that covers it are
   linked ("Steps from Phase N's session") and never merged.
8. ***How it's checked***, in words, then ***Goes to*** (`ROUTE_META`, with who resumes) and
   ***Checked by*** (`CHECKED_BY_LABEL`).
9. **ONE act form**, by the move table.
10. **The history**, one press in, and **the raw record**, one more (the datum ledger).

**The move table** (`client/src/cards/turn/moves.ts`, `cardMoveOf`) is the contract. Every type ×
status × readiness × record has exactly one primary:

| When | The one primary |
|---|---|
| Passed, Not doing, Closed | none (settled) |
| a Heads-up | *Got it* |
| Checking | a ledger item's *Undo: I'm not finished*, and nothing else; a projected item, none |
| Waiting for the owner | the request's first pressable action |
| NOT YET | none until it is due, said in words |
| an Approval | *Approve*, with *Deny* beside it; a permission's through its grant |
| a Decision | its options, then *Send my decision* |
| a Task | *I've done this — check*, or *I've redone it* on Redo, never the opener or a terminal; a projected Task, its row's first pressable action |

**The act form per type** (`client/src/cards/turn/act.tsx`, `client/src/cards/decision-card.tsx`):

- **Task.** The check, with a note for it. Never a note on an item whose answer is a secret or a
  code: a field there invites the value. The opener (*Open sign-in*, *Open in terminal*) sits beside
  the check. *Attach evidence*. Then three folded choices. *Not doing this* appears where the
  raiser allows it. *Snooze* offers an hour, four hours or until tomorrow. *Hand it back* offers the
  phase that raised it, a question for its session, or "I can't do this".
- **Decision.** Radio options, each with what choosing it means. The recommended one is named in
  words and never pre-selected. Then a note and *Send my decision*. A projected decision's option
  that takes words opens its own box. A flagged option is disabled and names its flag.
- **Approval.** *Approve* and *Deny*, with a note. A run request's raise of money says beside the note
  that the note is the amount. A permission is its own card's approval: *Approve* at a scope, the
  risk, the typed rule for a high grant, and *Deny* (`client/src/screens/turn/permission-card.tsx`).
- **Heads-up.** *Got it*, a mark kept in this browser. Nothing checks a heads-up or waits on it.

Terminal presses (Approve, Deny, Not doing this, Send my decision) wait out the undo window on the
page (`client/src/data/undo-window.ts`). An action the console's flags switch off is drawn
disabled, with the flag that turns it on, and is never the primary.

**One command block** (`client/src/ui/code-block.tsx`) shows every command a person is meant to
run, in a guide step, on a step's own card, in the terminal sheet and in Settings ▸ Reach. It reads
left to right in any page and scrolls in its own focusable, named box. It offers *Copy* and *Copy
for Claude Code* (behind `!`), never a way to run. A command holding a `<placeholder>` is a
template. It says "Fill in <name> first", marks each placeholder, and offers *Copy the template*,
never a plain *Copy*. A shell redirect is never read as a placeholder.

**One page clock** (`client/src/ui/clock.ts`). Every figure reads one module-level `now` through
`useSyncExternalStore`, so a tick re-renders the figures that read it and never the card or the page.
The clock ticks every second while a timing grid is on screen (an IntersectionObserver, through
`useFineClock`) and every thirty seconds otherwise. It runs no timer when nothing reads it. Under
`prefers-reduced-motion: reduce` it never takes the one-second tick: a second-by-second countdown
is motion, and the figures say minutes.

**The page** (turn-by-turn phase 9; organised as a page a person works FROM by one-pool phase 14,
#377 #366, `client/src/screens/turn/`). The headline is the heading, and it counts rather than
quotes ("1 to do now · 5 coming up · 6 done today"). The strip under it is words with figures on
one line, never tiles: *to do*, *checking* and *passed today*, then the round as the live line and
*Next deadline*, which reads the page clock. Then the tabs — *Open* · *Done* · *Handled by the AI*
· *All*, each with its count — so what is over stops lengthening the open list. One toolbar row
follows: search, Filter (Status, Time, Plan, Type, Goes to), Group, Sort, View, ⋯ (Export, Print),
Everything. On a desk every filter is also a row of chips with counts under the toolbar
(`FilterChips`): a filter in sight is a filter used. The address is the page's whole state:

```
#/turn[/<id>]?tab=open|done|handled|all
             &view=list|board|cards|timeline
             &group=asked|plan|type|deadline|status
             &sort=oldest|newest|deadline
             &status=…&time=…&plan=…&type=…&to=…  (run, kind, why, risk under Everything; q)
```

Each default is no parameter at all, the words are `shared/turn-model.js`'s (`TURN_TABS`,
`TURN_VIEWS`, `TURN_GROUPINGS`, `TURN_BOARD_COLUMNS`), and 7.1's `?view=compact` reads as the list.

- **The list** (the default) is principle 2 kept: one line per item — NOW or NOT YET, the type's
  mark, the short title, then the person's status, the plan and the phase as two facts, and one
  clock (the deadline, overdue in the failed hue, else how long it has waited). Pressing a line
  SELECTS it: the address names it and its whole card opens in the panel (`panel-card.tsx`, which
  reads the turn itself, so a press there redraws it in place) — the column at 1200 and up, the end
  sheet from 900, the bottom sheet, which is the card's own page, on a phone. ↑/↓ and j/k move the
  selection. A row's checkbox picks it for the bulk bar: *Not doing* (one reason, held in the undo
  window like the card's own terminal press), *Hand back*, *Snooze*; only ledger items take them,
  and the bar names what it skips.
- **The board** is the Owner To-Do Board's shape: five columns by the person's status, To do ·
  Checking · Redo · Waiting for the owner · Done; grouped, one lane per group. A tile is the line
  folded into a box; it is a view a person asks for, never the glance (principle 1).
- **The cards** are 7.1's page: every item drawn whole.
- **The timeline** is the line again: a bar per item from when it was raised to its deadline (to
  now, dashed and open, when none is set), a ring at when it is due, a rule at now, on one clock.
- **Empty groups fold into one line** ("Nothing to approve, to do now or to decide."); a group the
  filters emptied keeps its heading and says how many they hid.
- **Titles** are the composer's (`shortTitle`, `server/turn/compose.ts`): at most 80 characters,
  sentence case unless they lead with a name, never a path list; the long form is the card's
  muted `headline`, an errand's ref a chip, a landing's files a folded list by repository.

*Handled by the AI*, the heads-ups and *Where the plans stand* (one line per plan) follow on Open
and All. In the cards view `#/turn/<id>` marks its card and opens the panel only where the panel
stands beside the page: below 1200 a sheet would cover the card the push landed on. In every
other view the card is not on the page, so the panel opens wherever it stands.

**Its place.** Your turn is the eighth destination, second in the work band (Runs · Your turn ·
Plans · Sessions), and wears the one summons count (`needsYou`). On a phone it holds the second
tab: Runs · Your turn · Plans · Sessions · More in Free; in Pro the Supervisor takes the fourth
slot and Sessions — a terminal, the least of a phone's jobs — waits in More (`TAB_BAR`). Every plan
has the same page as a fourth view, `#/plan/<slug>/turn` (`PLAN_TABS`), scoped to the plan, with
its open count: one source (`GET /api/turn`), no second model. The bell's drawer is a preview of
it — *Open Your turn*, at most five one-line rows, "N more on Your turn".

Guards: `screens/turn/page.test.tsx` (TP-v2, TP-14), `page-model.test.ts` (PM-v2, PM-14),
`shell/nav.test.ts`, `screens/plan/tabs.test.ts`, `shell/bell/drawer.test.tsx`, `e2e/turn.spec.ts`.

**Every other surface speaks the card's words** (turn-by-turn phase 10). An inbox row carries the
card's type, readiness and NOT YET's *when*, and sits in the group its card sits in (`withRowWords`,
`server/turn/fold.ts`). The Runs home's Your turn rows and the bell's needs-you rows lead with NOW or
NOT YET and the type's mark, then the composer's title (`client/src/cards/turn/row-words.tsx`); no
surface writes a word of its own for an item. A push's lock screen is chosen by type
(`lockScreenOf`, `server/push/actions.ts`): a Task gets *Open* and *I did it*, a run request *Approve*
and *Deny* only where the console runs with `--allow-run`, any other Approval or a Decision *Open*.

**No card is ever half a card** (turn-by-turn phase 11). `test/turn-cards-coverage.test.ts` walks every
item the console can raise — every kind in every ledger state from every birth, and every projected
source — in both editions, and fails the item that lacks a type, a status, a readiness while it is the
person's, a route its edition may say, *Checked by*, a check in words, or, while open, a step, its
options or its approval block; and any machine word a person would read.

**Its guards.** `client/src/cards/item-card.test.tsx` holds IC-v2 (the table, and the card drawing
exactly its one primary over every type × status, ledger and projected) and IC-7 to IC-11.
`client/src/cards/item-card.datums.test.tsx` holds every fact within two presses.
`client/src/cards/turn/timing.test.tsx` holds the grid, NOT YET's *when*, the tick that re-renders
no page, overdue, and the clock's rule. `client/src/cards/turn/card.a11y.test.tsx` holds axe in every
type × status in both lights, the mirror under `dir="rtl"`, and the thumb floor.
`client/src/ui/code-block.test.tsx` and `client/src/cards/guide.test.tsx` hold the command block.
`client/src/ui/status/family.test.tsx` holds the `turn` member. `test/turn-surfaces-scan.test.ts`
names `client/src/cards/turn/` in the family that may draw a person's ask. In the browser,
`e2e/register.spec.ts`, `e2e/rtl.spec.ts` and `e2e/doors.spec.ts` measure the card at 360, 768, 1024
and 1280.



## 12. The guards — what holds each rule

Paths are from `viewer/`; `tests/unit/gates.bats` is the repository root's.

| Guard | What it holds |
|---|---|
| `client/src/styles/theme.test.ts` | three breakpoints, in step with `lib/media.ts`; every colour declared once as `light-dark()`; the room at hue 230, low chroma; the status palette at one OKLCH weight; amber reached only through `--accent`, followed to its root, never a focus mark, never a selection; a `.state-<ui>` class per state; the 12 px floor, the four sizes, tabular numerals; two font files, two faces, ONE sans at 100 % with no display clamp (shown its own negative); radii 3/6/10; the one overlay shadow; the OFL notices in the tarball; no ghost utility; no stray width anywhere in `src/` |
| `client/src/styles/contrast.test.ts` | every status ≥ 4.5:1 as text on ground, ground-deep, surface and surface-raised and ≥ 3:1 as a mark on the track, inside sRGB; the three inks ≥ 4.5:1 on the four text surfaces, three and ordered; the focus ring ≥ 3:1; primary-button text ≥ 4.5:1 on its fill — both lights; the ground hexes `index.html` and the manifest carry |
| `client/src/styles/touch.test.ts` | over `ui/ cards/ shell/ screens/`: the input floor that wins on touch; one field class, the kit's; overlays by `--app-height`, never `dvh` or `100vw`; the toast above every bar; no hover-only reveal; no clipping host under a hit area; floors released by a pointer; selects that cannot size to their options; tables that say whether they scroll, and reach the grid or say why; the grid's own table rules (a sticky header only outside a scroll container, an opaque pinned identity on the logical side, a declared `min` per column); one scroller, one axis; a ring no page suppresses; a track of arbitrary content lets it break (`wrap-anywhere`), and a nowrap cell names its closed vocabulary |
| `client/src/styles/logical.test.ts` | the kit, the cards, the shell, the screens and the five stylesheets spell their sides logically; `KEPT` both ways, with no entry for the tree |
| `client/src/styles/bidi.test.ts` | the base layer's text direction: text holders `unicode-bidi: plaintext`, both `text-align` spellings (`-webkit-match-parent` first — Chromium drops the standard one), code read LTR and isolated, and the `[dir]:not([data-dir-mirror])` exemption that lets a page's own `dir` win over a kit mirror (§6.2) |
| `client/src/ui/status/family.test.tsx` | every member draws a dot, a word and the three `data-*` attributes; the icon map total; Unknown for a foreign word, hollow and dashed; settled hollow and quiet unless it ended badly; the pulse only for an observed live running thing; a summons's word in the hue; a foreign vocabulary is a type error; no axe violation |
| `client/src/ui/track/track.test.tsx` | stations paint through `.state-*` and name no colour; only a live running station pulses; `needs-you` wears the ring and never a pulse; reduced motion stops the pulse; the line is neutral and a settled station hollow; a horizontal line drawn leg by leg after each label, never through the words; no `var(--track-…)` size; none of the route map's names worn, and no bare `.track` or `.station` on first paint |
| `client/src/ui/boundary.test.ts` · `eslint.config.js` | the five doors over the whole client, each refused in every top folder and let through at its one door: one navigation door; one data door; one status renderer; one stream; the table engine's one door; and no literal hex, no `scrollIntoView` |
| `client/src/sweep.test.ts` | no path of the 6.x client (app, features, components, lib/api, lib/queries) and no file importing, loading or mocking one; no views folder, no legacy route, loader or door file; every destination a `screens/<d>/index.tsx`; one exported name per thing across the client; the live-run vocabulary never re-spelled |
| `client/src/ui/grid/table-sites.test.ts` | every table render site reaches the grid or its file says why it is hand-rolled; no `tap-*` host clips its own hit area |
| `client/src/data/lifecycle.test.ts` · `client/src/cards/halt-single-source.test.ts` · `client/src/screens/launch/single-source.test.ts` | one place presses a run's lifecycle verbs, and the frozen banner the fleet's; one lane body; the lifecycle's sentences say what the server did; one card reads a halt's reason; one form starts a run, one renderer offers a remedy |
| `client/src/ui/grid/grid.test.tsx` · `card-list.test.tsx` · `columns.test.ts` · `rail.test.tsx` | one column array: the wide table, the folded cut (counted, every folded column under its head), Everything's reading (nothing withheld, nothing cut), a hidden column in the row's details, groups as rows of one table, picks by key, the window, the engine late or lost; the phone's one-line records and their fold; the cut's and the rail's arithmetic, a 7.0 column's required `min`, the rail pinned opaque on the logical side |
| `client/src/ui/toolbar.test.tsx` · `client/src/ui/everything.test.ts` | the seven slots in order; one View sheet below 900 holding the other six, in order, counted; each slot named in words; the `⋯` verb that cannot be pressed says why; Everything kept per page id, a real switch, its sentence spoken from a live region drawn empty |
| `client/src/ui/kit.test.tsx` | the light barrel re-exports no heavy piece and carries every name the plan lists; the kit spells no capital label, eyebrow, second face or card shadow; no amber button; every primitive mounts with no axe violation; a row expands in place and unmounts what it hides; money, durations and clocks are the sans and a machine value is mono |
| `client/src/ui/status/ratchet.test.ts` · `status-ratchet.json` | legacy status sites per file under `src/` — zero, the snapshot empty; the retired status names gone from every source file; the first-paint gate at 170 KB or less |
| `*.datums.test.tsx` | the datum ledger: every fact within two presses, the raw record whole (§1) |
| `test/status-model.test.ts` | the decision table: every row held to its owner list, amber only from `PERSON_WORDS` or an inbox item, every bay reachable |
| `test/status-vocab.test.ts`, `test/vocab-owners.test.ts` | the eight UI states, and a row for every word the server writes; each vocabulary imported by identity, never re-spelled, in the server, the shared modules and the whole client |
| `test/docs-parity.test.ts` | §8.2 names every chart, every installed `@visx/*` module and the four refused; every backticked path in this document, `viewer/README.md` and its twin, CLAUDE.md, `docs/`, `references/` and the guides resolves |
| `client/src/ui/figures/figures.test.tsx` | the closed figure/mark split against the door's exports; no literal colour in a figure, its key or its numbers; every figure's numbers table, and the drawing equal to it; the crosshair a slider, the zoom's way back outside it, the page's own scroll |
| `client/src/ui/track/meter.test.tsx` | the mark: a real meter read as words, its fill clamped to the track, paint through a state, a reading and no bar when there is no whole |
| `screens/plan/map/dag.test.tsx`, `screens/plan/map/map.test.tsx` | the route map: the zoom floor's derivation, windowed drawing, the minimap, the station search, every station by the arrow keys, no state told by hue, the Phases view's joins; its sheet on the tokens — no hue outside `.state-*` but the machine's own marks, amber through `--accent`, four sizes, one pulse, `--app-height`, no bare 6.x name |
| `screens/plan/map/tools.test.tsx` · `ui/figures/collide.test.tsx` · `ui/figures/{schedule,burnup}.test.tsx` · `screens/sessions/locks.test.tsx` | the map's tools in the address and back after a reload, the trace's chain, click inspects and a second click opens, the hover card's facts, SVG and PNG export; every layout and layer free of text over text; the schedule's and the burn-up's arithmetic and their numbers; the lock map's lanes, stacks and lease bars |
| `scripts/check-dist.mjs` · `scripts/gates.sh` (`verify-free`) | first paint ≤ 170 KB served, in this build and the free tree's own; the table engine, the figures, the status word tables and every other lazy chunk off first paint; `sw.js` at the root |
| `test/surface-parity.test.ts` · `test/route-coverage.test.ts` | the surface registry (`client/src/data/surface.ts`) against the server both ways: every route, server event, settings key and operator verb has a row, every row a door a page reaches or an exemption naming its caller, nothing unassigned; every route has a caller under `client/src/data/` or a true reason |
| `e2e/register.spec.ts` · `e2e/baseline.json` | the seven finding classes at every stop in four viewports, held to `[]` |
| `e2e/smoke.spec.ts` | the harness itself — touch viewports have no hover — and, in dist mode, the console's CSP on every stop with zero violations |
| `e2e/rtl.spec.ts`, `e2e/status.spec.ts` | every stop under `dir="rtl"` in four viewports with no overflow, and English prose in its own order there; no status in colour alone, every focus ring ink |
| `e2e/doors.spec.ts` | the three doors by thumb, at 360 and 768, on every destination and the two heads a person acts on most: a record expanded in place, the inspector risen as a bottom sheet with its tabs taking the tap, Everything flipped in the View sheet — each measured as it left the page (the layout and every touch question); a focused search above the keyboard; and the three motions and the expand recorded as they start, under both answers to `prefers-reduced-motion` |
| `client/src/shell/motion.test.tsx` | three motions and one transition, exactly: the tokens, the keyframes and the class lists agree; the blanket reduced-motion rule in the base layer; every animating stylesheet states its own stop; the loading marks by file; an imperative scroll asks the preference |
| `client/src/shell/a11y.test.tsx` | every head the routes name has a word, and is announced by it — with focus moved into the page — when a person arrives at it |
| `e2e/tour.spec.ts`, `e2e/probes.selftest.spec.ts` | every stop renders with no error and is photographed; every probe fails on the defect it exists for |
| `tests/unit/gates.bats` | the gate's e2e stage tours a production build in dist mode, and refuses when there is none |
