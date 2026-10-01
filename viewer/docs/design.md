# Phase Console 6.0 — the design file (“Control Tower”)

This is the law every page of the console obeys, written from what `client/src/styles/theme.css`,
the typed status family and their guards hold today, and rewritten whole for 6.0 (control-tower
phase 31). A session that has never seen the plan must be able to build a conforming page from this
file alone. Where this file and a guard disagree, the guard is right and this file has rotted — fix
the file in the same commit as the guard that moved. §12 names every guard and what it holds.

**The subject.** A control room for engineering work that runs itself: one expert, impatient
operator supervising plans that execute on their own — runs, lanes, locks, gates, QA verdicts,
sessions, money — from a side monitor at the desk, or from a phone when a push says something
stopped. The console has one job: answer *does anything need me?* in two seconds, let the operator
fix it in one move, and keep everything else one expansion away. The data is the hero.

**The analogue** is the tower the codename names, carried on from 4.0's *Departures* board. A run is
a flight-progress **strip**; the Tower sorts strips into **bays** by urgency — Needs you, Live,
Waiting, Queued, Ready to start, Settled (`BAYS`); the **annunciator** lights one lamp per halt
family, nine of them (`HALT_CATEGORIES`); the alerting levels are the **attention** axis every
status carries; and the route map — a plan is a line, its phases its stations — stays the signature.

**The boldness is spent twice**: in the type (4.0's voices, kept whole — §2) and in the strip (6.0's
one bold shape — §7). Everything else stays quiet. Refused by name: interchangeable SaaS cards (a
strip, a tile, a table and an inspector are four shapes with four jobs), gradient washes, a second
accent, middle-dot meta strings on a glance, arrows on links, and mono set for decoration.

**The shape of the app** (control-tower phase 21). `#/runs` is the home — the Tower — and Now is
gone: every address it had lands on a bay (`#/now?focus=inbox` → `#/runs?bay=needs-you`, `#/ready`
→ `#/runs?bay=ready`). The rail is slim, 80 px (`--rail-width`): a glyph over each destination's
name, Runs first. The situation line — *3 need you · 2 live · 1 waiting · $41 today*, drawn as
separate words — rides the shell header on every page; on a desk each figure links to its bay, on a
phone it is a plain row. The phone's tab bar is Runs · Plans · Sessions · Insights, then More.

---

## 1. The invariant — minimal surface, total recall

Four disclosure levels, used everywhere. *Minimal* never means fewer facts; it means a calm
arrangement of all of them.

| Level | What | Surface |
|---|---|---|
| **L0** | The glance. The calm default a page opens on. | The page itself; on Runs, a strip |
| **L1** | Expand in place. More of the same record, where it stands. | `Disclosure`, a strip opened in place, the run page's folds, `DataTable` row detail, folded columns |
| **L2** | The inspector. Full structured detail of ONE record. | `Inspector` (a `Sheet`: right on a desk, bottom on a phone) |
| **L3** | Raw. The record as the machine holds it. | `Inspector`'s `raw` slot ("Raw record"), a journal line, a file; for a figure, the table it was drawn from |

**The law**, kept from 4.0 in the words the ledgers cite: *No datum removed · every datum within 2
interactions · a raw view exists · density honoured.*

**The datum ledger** proves it (control-tower phases 19 and 24). Each redesigned surface — the strip,
the run page, the plan detail, Sessions, Repo, Insights, the halt card, the human-step card — has a
`*.datums.test.tsx` whose rows are the old surface's facts, each with the press count at which the
new one must show it: 0 on the glance, 1 expanded in place, 2 in the inspector. A fact that moves
deeper or disappears fails its row by name; the raw record is asserted whole. Folded content
UNMOUNTS (a fold is not a cache), so a ledger presses folds open through `client/src/test/expand.ts`.

**An expansion is remembered per person**: open strips, the run page's open sections and its
collapsed phase groups persist in `lib/prefs.ts` (`stripsOpen`, `runSectionsOpen`,
`runPhasesCollapsed`). A fold's label NAMES what opening it shows and, folded, how much is in it.

## 2. The voices — type

Two variable files, three faces (SIL OFL 1.1; notices in `client/src/assets/fonts/OFL.txt`, which
the tarball ships; vendored, hashed by Vite, zero network):

| Token | Face | File | Clamp | Job |
|---|---|---|---|---|
| `--font-sans` | Instrument Sans | `instrument-sans-var.woff2` (wght 400–700) | `font-stretch: 100%` | Everything read as sentences and labels |
| `--font-display` | Instrument Sans Display | *same file* | `font-stretch: 80%` | Names and figures: page titles, card titles, `Tile` numerals |
| `--font-mono` | Martian Mono | `martian-mono-var.woff2` (wght 100–800) | `font-stretch: 87.5%` | A machine's values: shas, ids, money, durations, paths, code, keys |

The mono carries the identity, because half of every screen is telemetry. The display voice is the
UI face's *width axis*, clamped condensed by a second `@font-face` over the same bytes; the UI face
is clamped at 100% so body text can never inherit a stray narrow width.

- **Weights:** body 400, `font-medium` 500, headings and `font-semibold` 600, 700 sparingly.
- **Sizes:** the `--text-*` scale only — display sizes (`lg`–`3xl`) are fluid clamps, reading sizes
  fixed (`md` 15 px, `sm` 14, `xs` 13, `2xs` 12). **The floor is 12 px** (`--text-2xs`, badges and
  counters); `--text-xs` is the smallest a sentence may be set.
- **Fewer and larger figures at a glance** (a `Tile`'s numeral is display-face; the rest folds), and
  **mono for machine values only** — a sha, an id, a sum, a path, a command; never for flavour.
- **Numerals are tabular everywhere** (the body's default; `.tnum` to opt back in), and **ligatures
  are off in mono** (`--font-mono--font-feature-settings`): `->` in a command is two characters.
- Headings get `letter-spacing: -0.01em` from base; do not re-track them locally. Never add a face,
  a file or an unclamped width — `theme.test.ts` pins all of it.

## 3. The room — colour

**One room, two lights.** Both themes sit on one hue family (≈ h 220): Paper is the room lit, Night
the room dimmed. Every colour token is declared ONCE via `light-dark(paper, night)`, and the theme
switch is a `color-scheme` flip. Surfaces, lightest meaning "closest to the reader" in Paper:
`--ground` (the page) · `--ground-deep` (recessed bands) · `--surface` (cards, sheets) ·
`--surface-raised` (hover, raised chrome) · `--rule` / `--rule-strong` · `--track` (what marks sit
against) · `--hatch` (a hatch fill in the waiting hue).

**Three inks, and all three are text** — each clears AA's 4.5:1 on all four text surfaces in both
themes, because each is read at 12 px somewhere:

| Ink | Paper L | Night L | For | Lowest contrast, Paper · Night |
|---|---|---|---|---|
| `--ink` | 21.36% | 95.17% | body, names, figures | 13.03 on ground-deep · 12.12 on surface-raised |
| `--ink-muted` | 43% | 74.72% | labels, secondary text, an idle control | 5.98 on ground-deep · 6.24 on surface-raised |
| `--ink-faint` | 49% | 68% | true metadata only: timestamps, ids, hints | 4.62 on ground-deep · 4.87 on surface-raised |

Faint held only the large-text 3:1 until phase 31, when the tour's axe found it read at 12 px (§6.3)
— so the token moved, not the pages, and muted moved a step darker on Paper so the three stay three.
Faint is for metadata, and an affordance never is: a control whose word is its only door is muted.

**Status is a system, not a colour.** Eight UI states (`UI_STATES`, `shared/status-vocab.js`, worst
first: needs-you, failed, running, verifying, waiting, queued, skipped, done), one hue each, all at
ONE OKLCH weight per theme — Paper 48% / 0.08, Night 75% / 0.12; the neutrals `queued` and `skipped`
drop the chroma — so no state shouts by accident. `contrast.test.ts` holds each at ≥ 4.5:1 as text
on the four text surfaces and ≥ 3:1 as a mark on the track, both themes, inside sRGB. `verifying` is
running's family, told apart by a dashed line and its own icon; `running` alone may pulse.

**Amber is a summons** (tokens 6.0, control-tower phase 16). `--accent` = `--status-needs-you` is the
ONE door to amber, and amber means *a person is needed*; every other hue keeps ≥ 40° away. `--action`
(the primary button) and `--focus` (the ring) are high-contrast **ink**: a primary button, a focused
control and the page you are on (the rail's and the tab bar's marks) are not summons. The one amber
button is `variant="attention"`, from the allowlist in `ui/button-attention.test.ts`. `theme.test.ts`
follows every token to its root and fails any focus mark in amber; `contrast.test.ts` holds the ring
at ≥ 3:1 and the primary button's label at ≥ 4.5:1 on its fill. No brand colour: the brand is the
arrangement.

Colour has three doors: Tailwind utilities from `@theme inline` (`text-running`, `bg-needs-you/12`,
`border-rule`); the state indirection — a `.state-<ui>` class sets `--state` and descendants paint
`text-state` / `bg-state` without knowing which state they show, and the typed status family (§3.1,
§8) and these classes are the only places a hue is chosen for a status; and `var(--token)` in the
three component stylesheets (`prose.css`, `route-map.css`, `console.css`).

Never: a literal hex (ESLint bans it; the terminal's ANSI slots are the one file excused), a utility
from the raw namespace (`bg-status-done` compiles to NOTHING), an undeclared colour name, a new hue.

### 3.1 The signal law — one model, one family

**Status model v2** (`shared/status-model.js`, control-tower phase 16) gives every word of every
vocabulary the console paints one row in `WORD_ROWS` — a precise label, an icon, a paint that is one
of the eight hues — on three axes: **tense** (`live` · `standing` · `settled`; settled things lose
their colour), **outcome** (for a settled thing: `ok`, `partial`, `failed`, `stopped`, `superseded`,
`unknown`) and **attention** (`none`, then the inbox's own severities `fyi` · `needs-you` · `urgent`,
derived from `INBOX_SEVERITIES` so a badge and the inbox cannot disagree about loudness).

It decides with a table, never a word alone. `describeWord(vocab, word)` is a pure lookup, and a
word the vocabulary does not hold — `null`, empty, a word ANOTHER vocabulary owns — is the
first-class **Unknown** (`circle-question-mark`, no colour, never Waiting). `describeRun(run, ctx)`
is a first-match table: overtaken, resolved or on a closed plan → settled and quiet; finished → done,
or partial with a red count when a phase it touched did not settle well; stopped by the operator →
queued, saying who; a live loop → running; a wait → what it waits on and until when (amber only for
a person); a stop → amber only with an open inbox item (red when urgent), recovering while ladder
rungs are left, dormant after a week (`STALE_AFTER_MS`). `describePhase(record, ctx)` lets the board
saying done win over any record and reads a record claiming a session with none behind it as a
claim. `bayOf(view)` puts a view in its bay, urgency first. A **fact** (`FACT_KINDS`: `plan-closed`,
`resolved`, `overtaken`, `failed-count`, `recovering`, `dormant`, `waiting-on`, `no-session`) stands
beside a status in its own icon and paint (`FACT_META`), and never carries attention.

**The law of amber.** Amber is never derived from a status word: it comes from an open inbox item,
or from a word that IS a person-actor situation, listed in `PERSON_WORDS` with the reason only a
person can move it (`phase:awaiting-verification`, `mcp:needs-auth`, `decision:outstanding`, …).
`test/status-model.test.ts` holds every row to its owner list and the amber rows to those words.

**What 6.0 retired, and what stands in its place** — phase 31 finished what phase 16 began:

| Retired | In its place |
|---|---|
| `StateChip`, the 2.x board chip over the legacy badge | `PhaseStatusBadge` — a board word, a run record, or both |
| the 2.x `Chip` tone words `busy`, `warn`, `gate`, `stuck` | the `Badge` tone families — `neutral`, `ok`, `live`, `wait`, `bad`, `accent` — plus `state` and `solid` |
| the `--line-*` CSS aliases of the 2.x board palette, their colour names (`text-blocked`, `bg-progress`, `border-gated`, …) and the board-word classes (`.state-ready`, `.state-blocked`, …) | the `--status-*` tokens, their utilities (`text-failed`, `bg-running`, `border-needs-you`) and the eight `.state-<ui>` classes |
| a raw `StatusBadge` / `StatusDot` import on a page | the typed family; ESLint refuses an import of `status-badge` outside `components/ui/status/**` |
| `test/status-vocab.test.ts`'s "twelve words" assertions — a floor on how many words the server writes, and a pin of where each landed in the one-question map | the decision table, held row by row by `status-model.test.ts`; `status-vocab.test.ts` keeps totality and identity, and adds that every run and phase word the server writes has a row |

**The ratchet holds at zero.** `components/ui/status/ratchet.test.ts` counts each legacy status site
per file — `<StatusBadge`, `<StatusDot`, `<StateChip`, `statusBadgeClass(`, `decorateStatusWord(`,
`uiState(` and the `…UiState(` calls, `STATE_META[`, a `state-${word}` the model did not paint — and
holds `status-ratchet.json` both ways: 90 sites in 37 files at phase 16, the last 47 taken to zero by
phase 31. The snapshot is empty, so any site at all fails as a regression; the same file’s source
scan holds the retired names of the table above gone from code (comments may keep the history).

**What survives, on purpose.** `shared/status-vocab.js` still owns the eight UI states (`UI_STATES`,
`STATE_META`) and the one-question maps the server and the paint tables read (`RUN_STATUS_UI`,
`PHASE_STATUS_UI`, `BOARD_STATE_UI`, `BOARD_BUCKETS`, `isLiveStatus`); the model paints through them.

## 4. Space & density

Spacing is Tailwind's `--spacing` scale. Two padding families are **density-switched wholesale** by
`data-density` on the root (the persisted preference `prefs.density`):

| Token | Comfortable | Compact | Read by |
|---|---|---|---|
| `--pad-x` / `--pad-y` | 16 / 12 px | 12 / 8 px | Card headers & bodies, sections, `Inspector` body |
| `--tile-pad-x` / `--tile-pad-y` | 12 / 10 px | 10 / 6 px | Tiles, `TH`/`TD` cell padding |

Density buys space out of padding, **never out of ink** — no type size changes. A primitive that pads
content consumes these tokens, never a literal `p-*`; a page that stacks sections uses the same
rhythm. If density "doesn't reach" a surface, that surface is wearing a literal.

## 5. Shape, elevation, motion

- **Radii:** `--radius-sm` 2px (chips, badges, the focus ring), `--radius` 5px (controls),
  `--radius-lg` 8px (cards, sheets, tables) — a machined instrument, not an app-store card.
- **Elevation:** `--shadow-card` (a hairline and a soft drop; an inset top-light at Night) and
  `--glow-action` (the halo for the one thing to do now — ink since 6.0, because it follows
  `--action`). Nothing else casts.
- **Motion answers actions, and is a closed vocabulary.** `fade` 120ms and `rise` 260ms are
  entrances; `pulse-soft` 2.4s, the only continuing motion, is **reserved for a live `running` state
  over an observed fact** — it tells "thinking" from "stale page". The route map keeps its own in
  `route-map.css`: its lines draw in on `--duration-draw` (620ms), and a station breathes only over a
  live phase. `--ease-transit`, with `duration-fast|medium|draw` backed by `--transition-duration-*`
  (the namespace Tailwind v4 reads). Reduced motion kills it all; a new animation is an identity change.
- **The expand is a transition, not an animation** (control-tower phase 19): a region that opens in
  place grows its one grid row from `0fr` to `1fr` on `duration-medium` (`.expand-region`, whose
  `@starting-style` gives a region that MOUNTS as it opens its first frame). No script measures a
  height, no motion library exists, and a focus ring inside still paints. `rise` is for what ARRIVES.

## 6. Breakpoints & layout

Exactly three: **640** (phone: one thumb, one column) · **900** (the rail gives way to the phone
shell) · **1200** (wide: detail pages stop being two columns) — `sm:`, `md:`, `lg:`, with Tailwind's
defaults cleared so `xl:` compiles to nothing, and `lib/media.ts` ⇄ `theme.css` test-enforced.
Branch on nothing else. The shell owns the one scroller; `--app-height` (never `dvh`) sizes overlays;
`--z-*` is the whole stacking order (`base` 1, `sticky` 20, `shell` 40, `scrim` 60, `toast` 70). Touch
floors: `--tap-min` 44px targets; `--text-input` 16px inputs, restated unlayered under a coarse
pointer so no `text-sm` beats it.

### 6.1 What each surface does when it runs out of width

The three numbers say *when* a layout changes. This says *what it changes into* — one line per
surface that has an answer, because "responsive" as a wish produces a different guess per page.

| Surface | Below 900 (phone shell) | Below 640 (one column) |
|---|---|---|
| **Shell** | rail → top bar + tab bar + More sheet; tab bar hides while a software keyboard is up | — |
| **Tables** | `DataTable` → **CardList**, one card per record. Branches, working trees and settle history reached the primitive and get one. Commit history is the one exception left, and it says so in its own source | — |
| **Phase table** | ONE `DataTable` of phases for the plan page and the run page (`features/runs/phase-table.tsx`, `PHASE_COLUMNS`), read four ways — `run`, `plan`, `plan-qa`, `plan-handoffs`, each a `tableId` and the columns it leads with, the rest folded into the row, never removed. Grouped by need (Done folded), plan order or scope; past 40 rows a window. Below 900 it is the CardList, one card per phase, its View sheet holding the filter, the grouping and the columns | — |
| **Route map** | the Phases tab's Map view (`?view=map`); pan + pinch + zoom, floor 0.45; locked (the default) it is a picture the page scrolls past, and unlocked a vertical swipe is still the page's (`pan-y`, no `overscroll-behavior`). A plan too big to show whole at the floor opens fit-to-width — every row across the frame — draws only what the window shows, and carries a minimap and a station search; its stations are one tab stop the arrow keys walk (control-tower phase 30, `e2e/route-map.spec.ts`) | — |
| **Commit graph** | real `<tr>` rows; the leading cell is the ≤128px `aria-hidden` lane gutter, the subject and its control are the cell after it | sideways scroll inside its own box |
| **Log explorer** | `DataList`, one vertical scroller sized by `--app-height` | row wraps; message takes its own line |
| **Terminal** | 80-col pty floor; key bar is a grid, never a scroller | — |
| **Patch pane** | sideways only — the height cap is `lg:` and above | — |
| **Tab strip** | one row that scrolls sideways, never wraps; its trailing edge fades (flipped under `rtl:`) and the active tab scrolls itself into view | — |
| **Overlays** | sized by `--app-height`, never `dvh`, never `100vw` | — |


**The structural guarantees** — each a rule stated where it is *decided*, so no surface has to
remember it; pinned in `styles/touch.test.ts`, and measured in the browser by the register (§6.3):

- **One scroller, one axis.** `<main>` is `overflow-x-hidden overflow-y-auto`: an over-wide child is
  **clipped, not scrollable**, so every rule below is a containment failure rather than an app that
  slides sideways — and `table.tsx` and `layout.tsx` are one decision.
- **A row that can grow may shrink and wrap** — `min-w-0 flex-wrap`, never `shrink-0`. Text the app
  did not write can break: `break-words` for paths and slugs, `break-all` for a dotted, space-free
  token (`runner.phase.verify.failed`) in a narrow column.
- **A control reaches `field`/`fieldSurface`** — the coarse-pointer 44px floor and the `min-w-0` that
  stops a `<select>` sizing to its widest option — or declares its own floor and a width it cannot
  grow past.
- **A thumb floor is released by a pointer, never by a width.** `[@media(hover:none)]:min-h-(--tap-min)`
  is the floor and `[@media(hover:hover)]:sm:min-h-0` the compact row a mouse keeps; a bare
  `sm:min-h-0` drops it on a touch tablet. The sites still spelled so are named in
  `WIDTH_RELEASED_FLOORS`, held both ways.
- **A row that is the only way into a record carries `min-h-(--tap-min)`** — unless its height is
  fixed (the commit graph's `ROW_H`, which its lane SVG is drawn at): then take the padding off the
  cell and let the floor resolve to the row. Fill by removing padding, not by adding it.
- **A table reaches `DataTable`, or says why it cannot** (`// hand-rolled because:`, checked per
  `<Table>` site). **A column declares ONE number and the layout uses it**: `min` is the cut's budget
  and the `table-fixed` track (`trackOf`), measured against the widest real content — under-declared,
  a chip escapes its track and the table drops to scroll mode. The flex column states a floor as the
  TABLE's `min-width`; the identity carries `FOLD_AFFORDANCE` for the row's `+N`; the pinned rail is
  a RUN of columns up to the identity; a record's name declares a `min-w-*`, and its chips wrap under.
- **The thumb floor is a HIT AREA, not a box.** `tap-area` (a box) and `tap-line` (text in a
  sentence) centre a transparent pseudo-element sized from `--tap-min`; the drawn box never moves,
  and a fine pointer gets nothing. An overlay is for a link in a SENTENCE: its host must not clip it,
  and among stacked controls it would cover a neighbour — there a control takes the floor as its
  BOX, `tap-row` (44 tall) or `tap-cell` (44 both ways).
- **A floor is real only if the control wins its own box.** The probes ask three questions (§6.3):
  is it in the hit stack (`elementsFromPoint`); does it WIN at its centre and four corners
  (`elementFromPoint`, owned only as `hit === el || el.contains(hit)` — an ANCESTOR answering is what
  a clip produces, and three shipped defects were scored as passing by counting it); does its box
  survive every ancestor that CLIPS it (`hidden` or `clip`; `auto` and `scroll` defer, though a
  scroller inside a `hidden` ancestor is still clipped by it). A floor is a claim about the
  control's ANCESTORS, which is why `ButtonGroup` neither shrinks nor clips (`surfaces.test.tsx`).
- **6.0's three, from the phase 31 register.** A control a scroll box holds stays inside it: the tab
  strip's triggers reached 1px over the list's border (`-mb-px`) and lost their corners, so the rule
  under the strip is now an inset shadow nothing reaches. A child under a rounded clip takes the
  radius: the help card's `<summary>` inherits it (`rounded-[inherit]`). And no control sits inside a
  control (axe's `nested-interactive`): the help card's permalink left its `<summary>`.
- **Focus stays visible** — one ink `:focus-visible` ring, globally; a page may not suppress it, and
  a primitive that manages its own focus draws its own. **Motion is a preference CSS alone cannot
  honour** — an explicit `behavior: 'smooth'` in JS overrides `scroll-behavior`, so an imperative
  scroll asks `scrollBehavior()` (`lib/media.ts`).

### 6.2 Logical sides — right-to-left is a switch away

Since 6.0 (control-tower phase 31) the kit (`components/ui/**`) and the shell (`app/shell/**`) set
every horizontal margin, padding, inset, border, corner and alignment logically — `ms-`/`me-`,
`ps-`/`pe-`, `start-`/`end-`, `border-s`/`border-e`, `rounded-s`/`rounded-e`, `text-start`/`text-end`
— and the four stylesheets declare `margin-inline-*`, `padding-inline-*`, `inset-inline-*`,
`border-inline-*` and `text-align: start | end`. A physical side decides for every reader where text
starts; a logical one lets the document decide, so `dir="rtl"` flips the rail, the pinned column, the
toast tray and every icon-then-label gap with no second stylesheet. A paint whose direction no
logical property carries says `rtl:` itself (the tab strip's trailing fade).

`styles/logical.test.ts` is the ratchet: over both trees and the four stylesheets it fails an `ml-`,
`pr-`, `left-`, `border-r`, `rounded-l` or `text-left` — or its arbitrary-property or inline-style
twin — outside `KEPT`, a short list held both ways whose every entry is physical by nature: a
centring pair (`left-1/2` with `-translate-x-1/2`), a variant the API names by its edge (the
`Sheet`'s `right` side), a device's safe-area insets (`.px-safe`; a notch does not flip).
`e2e/rtl.spec.ts` throws the switch on the tour's home stop in all four viewports, checks that the
document and `<main>` compute `rtl`, and fails on a wider document or any overflow or escape. The
pages under `features/` are not in the sweep yet; a translated interface is its own plan, and this is
the floor it would stand on.

### 6.3 Proven in a real browser — the register, the build, the policy

jsdom computes no layout and paints no colour, so the rules above are measured where a person meets
them — in Chromium, by the Playwright harness under `viewer/e2e/`.

**The tour.** A sandboxed console (`e2e/fixture/console.ts`: temporary XDG homes, a seeded plan
library, a stub `claude` — never the operator's) is visited at every stop — each destination
`shared/route-meta.js` declares, each plan tab, `#/approve`, the three overlays — in four viewports
(`e2e/lib/shots.ts`): `phone-360` (360 × 740) and `tablet-768` (768 × 1024), touch, with a coarse
pointer and no hover; `desk-1024` (1024 × 768) and `desk-1280` (1280 × 800). A stop is measured once
it stops moving, and `tour.spec.ts` leaves its picture in `e2e/.shots/`, never diffed, to be READ.

**Seven finding classes** (`e2e/lib/probes.ts`): `overflow` (past the viewport, unclipped),
`escape` (past `<main>`, which clips it — invisible to a screenshot), `touch-present`, `touch-wins`
and `touch-survives` (§6.1's three questions, touch viewports), `axe` (WCAG A and AA with colour
contrast, both themes) and `focus` (a focus that paints no ring, on the desks).
`probes.selftest.spec.ts` shows each probe a page broken the ways this console has been broken.

**The register is EMPTY** (control-tower phase 31). `register.spec.ts` holds every finding to
`e2e/baseline.json` both ways, and that file is `[]`: any finding at any stop in any viewport fails.
It held 798 when phase 31 began — 768 from axe (colour contrast, a control nested in another,
targets too small), 27 lost hit tests, 2 unpainted rings, 1 escape — and each was fixed. **A finding
is fixed, never banked**: `test:e2e:baseline` can still write one, and a phase that does changes this
law in its commit, not a count.

**Dist mode — the client a person meets.** With `PHASE_CONSOLE_DIST_DIR` naming a production build,
`playwright.config.ts` starts no Vite: the fixture console serves that build itself
(`server/config.ts` `DIST_DIR`) under its real headers. `npm run test:e2e:dist` builds as
`verify:dist` does, keeps the scratch build (`client/.dist-verify`) and tours it. So does
`scripts/gates.sh`: `stage_build` keeps it (`verify:dist -- --keep`), `stage_e2e` tours it with
`PHASE_CONSOLE_DIST_DIR` and removes it, `--build` tours `client/dist`, and with no build the stage
refuses rather than falling back to Vite (`tests/unit/gates.bats`). `npm run test:e2e` keeps Vite in
front of the fixture, for a person iterating on a page.

**The policy is part of the page.** In dist mode `smoke.spec.ts` asserts the served page carries the
console's own CSP (`script-src 'self'`, no `unsafe-eval`), loads every stop under it and fails on a
single `securitypolicyviolation` — so axe is EVALUATED over the DevTools protocol, never injected as
a `<script>` the policy would refuse. Beside the register: `status.spec.ts` (no status in colour
alone; every focus ring the resolved `--ink`), `rtl.spec.ts` (§6.2), and specs for the heavier
surfaces (`route-map`, `figures`, `launch`, `tables`, `strip`, `tower`, `halts`, `human-step`).

## 7. The signature — track & stations

The route map is the console's monogram: **a plan is a line; phases are its stations.** The grammar
holds wherever progress or structure is drawn (`route-map.css`, `SegmentBar`, `Meter`, the Tower):

- The **track** is the neutral bed (`--track`); segments paint by state through the indirection.
- A **station** is a dot (7 px at the map's floor) with the identity of its record beside it —
  colour is never the only carrier (WCAG 1.4.1: a label and an icon, always).
- **`verifying` is running's family**, told apart by a *dashed* line; label and icon do the rest.
- **`needs-you` wears the summons ring** — solid, heavier, the one amber on the map — never a pulse:
  a pulse means "alive right now", and a gate waiting on a person is not alive.
- **The grammar holds at plan scale** (control-tower phase 30). The map never opens below its 0.45
  zoom floor (the 7 px dot is 15 plan units × 0.45); a plan too big for the frame at that size is
  reached by a minimap, a station search and the arrow keys, never drawn smaller. `verifying` wears
  running's ring cut short and close (`2 3` against running's `6 5`) with a lens for its glyph,
  joined from the run's own record; `route-map.test.tsx` holds the dot, the rings and the fit.
- The motif may appear small (a progress strip, the rail's mark), never as decoration on a surface
  with no structure: restraint is what keeps it a signature.
- **A run is a flight strip** (control-tower phase 19) — the track at the size of a row, and the one
  place the redesign spends its boldness (`features/runs/tower/strip.tsx`): its leading EDGE is the
  run's paint (`describeRun`'s, never a word's), then its word and icon, the attention mark, the name
  (never under `--strip-name-floor`, 12ch — the row wraps first), the phase TRACK (`RunStrip`), ONE
  labelled clock whose verb says what it measured (`running 12m 03s`, `halted 4m ago` —
  `clockWords`), the cost with the session in flight counted, and ONE action chosen by bay
  (`strip-model.ts`). Everything else expands in place. The badge breathes only over an OBSERVED
  live lane, never a `running` word alone; settled strips lose their colour with their paint.

## 8. Components — the kit contract

One import for every view, `@/components/ui` — ONE modulepreloaded chunk every visitor downloads
before the first frame, so four things stay OUT of it: the grid (`@/components/data-table`), the long
list (`@/components/ui/data-list`), the typed status family (`@/components/ui/status`) and the peek
(`components/peek.tsx`); `check-dist` fails the one that reaches first paint (190 KB served):

- **The typed status family** (control-tower phase 16) — `RunStatusBadge`, `PhaseStatusBadge`,
  `PlanStatusBadge`, `QaBadge`, `OpsBadge`, `AccountBadge`, `McpBadge`, `FactBadge`,
  `AttentionMark`, and `ViewBadge`, the ONE renderer they all draw through. A wrapper accepts only
  its own vocabulary (`WordOf<V>`): a QA word handed to `RunStatusBadge` is a type error, and
  `OpsBadge` names its vocabulary beside the word (`vocab="probe"` takes `ok`, `fail`, `skip`).
  `ViewBadge` ALWAYS draws an icon and a precise word, carries `data-status`, `data-paint` (worn as
  `.state-<paint>`) and `data-attention`, says the word, its fact and its ask on hover (`viewTitle`),
  and sets a view's fact INSIDE the badge behind a rule. `AttentionMark` draws the attention axis
  alone through the inbox's `SEVERITY_UI`, and nothing for `none`; `pulse` breathes only a live view
  painted running. `status/family.test.tsx` holds every member, the icon map and the family's axe.
- **Notes and toasts** (`StatusStack`, `Banner`, `toast`) take their severity, paint and icon from
  `NOTE_ROWS` (`shared/status-notes.js`) and `ui/status/note-icons.ts`, never the model: they are
  first paint, and `check-dist` keeps the word tables out of it.
- **The halt-card family** (`components/halt-card.tsx`, control-tower phase 17) — a card that asks
  something of a person: its family as a quiet mark (an icon and a word, never amber — a family is
  not a summons) · ONE sentence in the reader's words · the one recommended action, first ·
  everything else one press away, with a raw view; `variant="row"` folds it to a line that expands in
  place. **The human-step card joins it** (`components/human-step-card.tsx`, phase 42): a person's
  turn — a ledger step, or a card folded into its family (a sign-in, an MCP sign-in, the verification
  card, a plan to approve, a gate, a relayed question, a QA verdict, a protected edit) — is ONE card:
  the kind's icon and label from `KIND_META` alone · a WHERE badge (*At the machine* / *Any device*)
  · numbered steps · a device code large, mono and selectable · ONE primary action by kind
  (`PRIMARY_ACT`) · then *Open again*, *Check now*, *Snooze*, *I can't do this* · every datum one
  press in, the raw record one more. A link opens in a new tab; a secret leaves the page once sent.
- **`Badge`** — tones are the vocabulary's families (`neutral`, `ok`, `live`, `wait`, `bad`,
  `accent`) plus `state` (the indirection) and `solid`; a toneless badge is grey on purpose (visibly
  wrong beats invisibly wrong). The 2.x `Chip` alias is gone: every former chip is the `Badge` it
always rendered.
- **`Button`** — `default`; `action`, the primary, ink-solid, ONE per screen; `attention`, amber, from
  its allowlist only (today the permission card, where a session is parked until a person answers);
  `ghost`; `danger`, in the failed hue. Thumb-sized on touch in BOTH directions (`min-h-` and
  `min-w-(--tap-min)` under `[@media(hover:none)]`); `ButtonGroup` neither shrinks nor clips.
- **`Card` / `CardHeader` / `CardTitle` / `CardBody` / `Tile`** — the card surface; `cardClass` for
  what cannot be a `<Card>`. Tile numerals are display-face, tabular.
- **`DataTable` / `Column`** (`@/components/data-table`) — one column array yields the wide table,
  the folded cut and the phone `CardList`: declare `priority` (1 = never dropped), `min`, one `flex`
  and one `identity` column, a `card` role — **extend the `Column` API, never fork the table.** The
  grid (control-tower phase 18) adds, per column, a meaning (`value`), a `filter` (`text`, `facet`,
  `range`), `groupable` and `hideable`, and per table `toolbar` (a filter and ONE "View" sheet),
  `groupBy` (heading ROWS), `selection` (a pick is a row KEY, so a sort cannot move it), `virtual`
  (past 150 rows only a window is drawn, against `<main>`) and `tableId` (the view, kept in
  `lib/prefs.ts`). **A hidden column FOLDS** into the row's detail — no datum removed. TanStack Table
  v9 is imported by `data-table/engine.ts` ONLY and loaded on demand; a table asking for none of this
  never loads it.
- **`Disclosure`** — L1. The label NAMES what appears ("All 12 options", "Raw record"), never
  "More…"; the count is drawn while folded; content unmounts when folded.
- **`Inspector` / `InspectorSection`** — L2. Title always visible; the `meta` identity row first; the
  body on the density tokens; `raw` is the L3 rung behind "Raw record" (`font-mono text-2xs`).
- **`Tabs`** — Radix owns the roving tabindex. The strip is §6.1's row: the active trigger scrolls
  into view by moving the list's own `scrollLeft`, only when the active tab changed; its underline is
  ink (`border-action`), and the rule under the strip an inset shadow on the list.
- **`Empty` / `PageError` / `CardSkeleton`** — an empty screen invites an act (`action` is part of
  the shape); an error is the server's own words and a way out; a skeleton only where nothing loaded.
- **`SectionHeading`** — the eyebrow (`band`) and the title (`title`); LEVEL is an outline decision.
- **Data atoms** — `MonoId` (the short form drawn, the full value one hover or copy away),
  `MoneyAmount`, `Duration`, `RelativeTime`, `Kbd`. All mono, all tabular.

**The field system.** The kit's Radix controls (`Select`, `Combobox`, `RadioGroup`, `Switch`, …) are
the canonical *controls*; `features/run-setup/fields.tsx` is the canonical *form layer*, whose
`SetupField`/`Provenance` add **where a value came from** (§8.1). `field` and `fieldSurface`
(`components/ui/field.ts`, defined once) are the control class in its two looks — inset on a raised
surface, raised on the page ground. Two pins: `ToggleField` STAYS a checkbox and `PressField` a
button — the QA launcher's bare `getByRole('checkbox')` assertion must not go vacuous.

## 8.1 The launch flow — the quick view (control-tower phase 22)

The one form that starts, continues or reconfigures a run (`features/run-setup/`) is a **departure
notice**: what will happen, where every value came from, what it can cost and where it stops —
before the one ink primary button. A staged launch (start, continue, one phase, the live settings,
fix & re-QA) is **one screen**, read top to bottom; 4.0's five stages and their `Stepper` retired
from it.

| Part | What it carries | Where it comes from |
|---|---|---|
| **What runs** | the departure line; the plan, its phases (state · gate · claim · scope), the sessions, what will hold and every boarding finding per phase one fold away | `review.tsx` `useDeparture`, `what-runs.tsx`, `BoardingNotes` |
| **Findings** | banners sorted blocking → warning → advice, each with its own action: a decision open, the plan's git lines unanswered, a probe failing, no delivery channel, phases that will park, another run holding a tree (with *Give this run its own checkout*) | `quick.tsx` `useFindings`, the prelude, `facts.ts` |
| **Preset** | Careful · Balanced · Hands-off · Last launch — a partial value set laid over the seed; Balanced IS the baseline | `shared/launch-presets.js`, `presets.ts` |
| **Nine tiles** | Scope · Engine · Safety · Git · Money and stops · Review and QA · Tools · Accounts · Decisions — each an icon, a few badges of what it is set to, the dominant provenance word and a *changed n* count, and one verb | `categories.ts` `CATEGORY_OF`, `category-tile.tsx` |
| **What differs** | *n values differ from a fresh console*, every one with its source and a Change link to its tile; every value the launch sends one fold further | `review.tsx` `ValuesDiffer`, `summary.ts` |

- **The form owns the values; the quick view is arrangement.** `RunSetup` seeds, validates and posts
  (`modes.ts`; the default launch posts the same bytes — `launch-flow.test.tsx`); `sections.tsx`
  writes each control once; each field sits in one category and each category inside exactly one old
  stage (`CATEGORY_OF`, `STAGE_OF`) — `categories.test.ts` fails a field that has no row.
- **Every control is within two interactions of the quick view** — its tile's Edit, then at most the
  sibling that makes it exist — in every staged mode (`reachability.test.tsx`).
- **One tile open at a time, in place.** On a desk its panel is its own grid row under the tile's
  row, growing `grid-rows` 0fr → 1fr from the moment it mounts; a folded tile draws no control.
- **The summons.** A blocking decision turns the Decisions tile amber with *Answer* as its verb and
  holds Launch with the reason in its title and the footer; the plan's git lines (#18) do the same to
  the Git tile. Amber stays a summons and nothing else.
- **Provenance is seven words**: `from defaults` · `from Settings` · `from this run` · `from the
  plan` · `from your last launch` · `from preset` · `changed here` (`fields.tsx`), in the precedence
  record → this browser's last launch of the plan (`launch-memory.ts`, posture only) → a Settings
  preference → the shipped default (`seed.ts`, `BASELINE`), with a chosen preset a seed layer under
  the operator's own edits. *What differs* lists a row that is not the baseline or was changed here.
- **Two layouts, one frame.** Below the shell breakpoint the launch is a full-screen `Sheet`
  (`side="full"`) exactly `--app-height` tall — title and buttons fixed, the body the ONE scroller,
  the footer on the keyboard, the tiles a one-column list of `tap-row`s pushing their controls as a
  sub-view (`e2e/launch.spec.ts`); on a desk, a `frame` `Dialog`. Launch is the ONE ink primary.
- **A native `<select>` cuts what it cannot fit**, so an option is a NAME and the rest goes under it:
  an account is who it is and the login it answers as, its windows as `Meter`s beneath, worst first;
  a profile is `Guarded`/`Trusted`/`Bypass`, with its qualifier and deny wall.
- **The honest states are banners above everything**, read whichever tile is open: a console without
  `--allow-run` offers the exact start line to copy; a live claim refuses with who holds it; a
  recorded verdict is quoted; a gated phase says who clears it.
- **The pickers have no scroller of their own** — twelve rows per group, the search as the way to
  the rest, every row a `tap-row`. **A flat mode** (a QA review, a recovery, the Automation defaults,
  any other launch of one session) stacks the same sections in the stages' order (`FlatForm`).

## 8.2 Figures and marks — where the chart library line sits

The decision #32 gap 2 asked for, made in control-tower phase 29 and written down so the next chart
does not re-argue it. `charts.tsx` owns a closed split (`CHART_FIGURES` / `CHART_MARKS`, held by
`charts.test.tsx`); the split is also where the library line runs.

| What | Drawn by | Why |
|---|---|---|
| The marks — `LoadMeter`, `RouteStrip`, `RunStrip` | hand-rolled, in `charts.tsx` | One datum of a row. No axis, no zoom, no readout: the row beside a mark IS its table. They sit in cells on nearly every destination, so any library behind them is first-paint weight for a 6 px bar. |
| The figures — `Bars`, `Calendar`, `BarList`, `StackBar` | visx, in `components/figures/bars.tsx` | A crosshair, a zoom and keyboard reach are axis work. The picture is lazy (`figures/lazy.tsx`); the figure's name, its `ChartNumbers` table and its colours stay in `charts.tsx`. |
| The run's time axis — the Gantt's lanes | hand-rolled `components/swimlane.tsx` on `figures/scales.ts` | The lanes' geometry, hatch and `.state-*` bridge were already right. What they lacked was a shared axis, a present and a zoom, which they now take from the figures. |
| The run's cost strip | visx, in `components/figures/run-chart.tsx` | A second reading on the lanes' own axis, with a dollar scale of its own. |

**What moved to visx:** `@visx/scale` (the linear map and 1-2-5 ticks behind `figures/scales.ts`,
the one axis primitive — the duration ladder `ticksFor` stays ours because it labels elapsed time),
`@visx/axis` (tick layout and labels), `@visx/shape` (bars and rules) and `@visx/event` (a pointer in
an SVG's own units). About 27 KB gzipped in lazy chunks; first paint did not move (189.2 KB then).

**What was named and not taken:**

- `@visx/zoom` binds drag, pinch and a plain wheel on its container, and cannot see a pinch without
  `touch-action: none`, which takes the page's vertical scroll away over every figure. Zoom is a 1-D
  window in `figures/use-figure.ts` instead.
- `@visx/responsive` throws where there is no `ResizeObserver` (jsdom). `useWidth` in
  `figures/paint.ts` is fifteen lines with the guard the rest of the client already uses.
- `@visx/tooltip` is a floating box for a pointer. The readout line under each figure serves a phone
  and a keyboard too, and the crosshair's `aria-valuetext` gives a screen reader the same words.
- `@visx/xychart` ships its own theme and palette, which is the colour vocabulary `charts.tsx` was
  written to refuse.

**Rules that did not move, each held by a test:**

1. Paint is a state token. Figures resolve through `toneVar`; every axis is drawn with `AXIS_PAINT`,
   so visx's `#222` and Arial never reach the page (`charts.test.tsx`'s literal-colour sweep).
2. Every figure keeps its numbers, and the drawing equals them: each datum carries
   `data-datum`/`data-value`, and `figures/run-chart.test.tsx` holds it to the `ChartNumbers` rows —
   a figure's L3, built in rather than offered.
3. The page keeps its scroll. A plain wheel and a vertical swipe are the page's; ⌃/⌘ + wheel (what a
   trackpad pinch sends) or a two-finger pinch zooms, and every figure surface is `touch-action:
   pan-y` (`e2e/figures.spec.ts`).
4. The crosshair is a `role="slider"`: arrows step, Home/End jump, `+` / `−` zoom, `0` resets. The
   Reset button sits outside the slider, because a control inside a control cannot be reached.
5. The drawings stay lazy. `scripts/check-dist.mjs` finds them by their `data-figure` attribute and
   fails a static importer or a modulepreload. A lazy drawing must not import a module the entry
   also uses (`lib/format` was the one caught here): the bundler splits that module into a chunk of
   its own, and the document then preloads it.

## 9. Copy — the console's voice

Words are design material. The register: plain verbs, sentence case, no filler, the operator's side
of the screen.

- **Name what the operator controls, not how it is built** ("Notifications", not "webhook config").
- **A control says exactly what happens** ("Approve gate", "Try again", "Sign in again") and keeps
  the same name through the whole flow. "More…", "Submit", "OK" name nothing.
- **A status is a precise word** — "Halted", "Paused by you" — the model's label, its fact beside it.
- **A sentence appears only where a person must read it to act**: a halt card's cause is ONE
  sentence in the reader's words (`CAUSE_SENTENCE`); a glance is words and figures, not prose.
- **Separate data are separate words** — two facts with a gap between them, or a status and its fact
  behind a rule; never one string glued with middle dots, which the eye reads as one datum and a
  screen reader as one run-on word.
- **Provenance in the hint, never the label** — a label is the accessible NAME.
- **Errors**: what went wrong, in the server's own words, and a way out. Errors do not apologize and
  never invent a reason ("The read failed and said nothing." is the honest floor).
- **Empty states direct**: what this will hold and how to put the first thing in it. **Status words
  explain themselves on hover** (`viewTitle`), but hover is a hint, never the only carrier.
- **Sentence case, everywhere a person reads.** 6.0 retires ALL-CAPS labels and tracked-out
  uppercase eyebrows: no new label, button, tab or heading is set in capitals, and capitals are never
  emphasis. The law is ahead of its sweep — `uppercase` is still spelled in 45 shipped files, among
  them the kit's two structural signposts, `SectionHeading`'s `band` eyebrow and `THead`, which
  `kit.test.tsx` and `inspector.test.tsx` still pin. The retirement lands in those primitives, a line
  each with their tests; until then a page copies neither spelling by hand.

## 10. Do-nots (each one is a guard, an incident, or both)

1. No fourth breakpoint; no width branches off 640/900/1200 (±1 for max-width).
2. No literal hex in client code; no raw-namespace paint (`bg-status-*`); no undeclared colour.
3. No amber that is not a summons: nothing within 40° of the accent hue, no amber button outside
   its allowlist, no amber focus mark, and `pulse` on nothing but an observed live `running`.
4. No status outside the typed family: no legacy site (the ratchet is zero), no `status-badge`
   import outside `components/ui/status/**`, no status in colour alone.
5. No new animation, easing, shadow, radius step, z-index or font file without amending this file
   AND the guards in the same change.
6. No `dvh`, no `100vw`, no `scrollIntoView` (the shell owns scrolling), no sticky header inside an
   overflow-x wrapper, no overlay painted over another cell to fake a row link (`rowHref`).
7. No hover-only affordance, tap target under `--tap-min`, input under 16px, or floor a width releases.
8. No physical side in the kit or the shell outside `KEPT`; no un-tokened padding in a primitive.
9. No finding banked: the register is `[]`, and a finding is fixed.
10. No inline script, no `eval`, no resource the policy does not name — the console's CSP refuses
    it, and the dist-mode smoke counts every refusal.
11. No `npm run build` in a phase — a console serving this checkout serves its `client/dist` per
    request; `verify:dist` and `test:e2e:dist` build into a scratch directory.
12. Type floor 12px, tabular numerals, mono ligatures off; two font files, three faces, clamps
    intact, OFL notices in the tarball — non-negotiable.

## 11. Building a conforming page (the recipe)

1. Open on L0: the calm glance — identity, state, the few numbers that decide "do I care".
2. Every further fact is ≤ 2 interactions away: fold detail into `Disclosure`/row detail (L1), give
   every record an `Inspector` (L2) with a `raw` slot (L3), and write the datum ledger
   (`*.datums.test.tsx`) the moment the page replaces one that showed facts.
3. Tables are `DataTable` column arrays — declare priorities and an identity column; pass an `Empty`
   with an action.
4. Paint status ONLY through the typed family and the `.state-*` indirection; an icon and a word
   beside every colour; amber only for a summons.
5. Consume the pad tokens and spell sides logically; check both densities, both themes, all three
   breakpoints; write the copy in §9's voice.
6. Run the guards — `test:client`, `typecheck:client`, `lint:client`, `verify:dist` — then the real
   browser: `npm run test:e2e:dist` tours the production build under the console's own CSP (what
   `scripts/gates.sh` runs), `npm run test:e2e` the dev build while iterating. Every stop at 360, 768,
   1024 and 1280 is held to the EMPTY register: the fix is the page, never the baseline. Open the
   pictures in `e2e/.shots/` and READ them — a row `<main>` clips is invisible to "did it render".

## 12. The guards — what holds each rule

Paths are from `viewer/`; `tests/unit/gates.bats` is the repository root's.

| Guard | What it holds |
|---|---|
| `client/src/styles/theme.test.ts` | three breakpoints, in step with `lib/media.ts`; every colour declared once as `light-dark()`; the status palette at one OKLCH weight; amber reached only through `--accent`, followed to its root, and never a focus mark; a `.state-<ui>` class per state; the 12 px floor and tabular numerals; two font files, three faces, their clamps and the OFL notices in the tarball; no ghost utility; no stray width anywhere in `src/` |
| `client/src/styles/contrast.test.ts` | every status ≥ 4.5:1 as text on ground, ground-deep, surface and surface-raised and ≥ 3:1 as a mark on the track, inside sRGB; every ink ≥ 4.5:1 on the four text surfaces; the focus ring ≥ 3:1; primary-button text ≥ 4.5:1 on its fill — both themes; the ground hexes `index.html` and the manifest carry |
| `client/src/styles/touch.test.ts` | the input floor that wins on touch; one field class, reached by every hand-written control; `--app-height`, never `dvh`; no hover-only reveal; no clipping host under `tap-area`/`tap-line`; box floors where controls stack; floors released by a pointer (`WIDTH_RELEASED_FLOORS`, both ways); selects that cannot size to their options; tables that say whether they scroll, reach `DataTable` or say why, and keep their measured tracks; one scroller, one axis; a ring no page suppresses; scrolls that ask `scrollBehavior()` |
| `client/src/styles/logical.test.ts` | the kit, the shell and the four stylesheets spell their sides logically; `KEPT`, both ways |
| `components/ui/status/ratchet.test.ts` · `status-ratchet.json` | legacy status sites per file, both ways — zero since phase 31; the first-paint gate at 190 KB or less |
| `components/ui/status/family.test.tsx` | every member draws an icon, a word and the three `data-*` attributes; the icon map total; Unknown for a foreign word; a foreign vocabulary is a type error; no axe violation |
| `components/ui/button-attention.test.ts` | the amber button only from its allowlist, through the accent token; the action button ink-solid |
| `components/ui/kit.test.tsx`, `surfaces.test.tsx` | the kit's spellings, the eyebrow among them; on the mounted primitives, a clipping box may not squash what it clips |
| `components/charts.test.tsx`, `components/route-map.test.tsx` | the closed figure/mark split and no literal colour in a chart; the signature grammar at plan scale |
| `*.datums.test.tsx` | the datum ledger: every fact within two presses, the raw record whole (§1) |
| `test/status-model.test.ts` | the decision table: every row held to its owner list, amber only from `PERSON_WORDS` or an inbox item, the audit's corpus, every bay reachable |
| `test/status-vocab.test.ts`, `test/vocab-owners.test.ts` | the eight UI states, and a row for every word the server writes; each vocabulary imported by identity, never re-spelled |
| `test/docs-parity.test.ts` | §8.2 names every chart, every installed `@visx/*` module and the four refused |
| `eslint.config.js` | no literal hex; no `scrollIntoView`; the table engine's one door; `status-badge` imported only inside `components/ui/status/**` |
| `scripts/check-dist.mjs` | first paint ≤ 190 KB served; the table engine, the figures, the peek, the status word tables and every other lazy chunk off first paint; `sw.js` at the root |
| `e2e/register.spec.ts` · `e2e/baseline.json` | the seven finding classes at every stop in four viewports, held to `[]` |
| `e2e/smoke.spec.ts` | the harness itself — touch viewports have no hover — and, in dist mode, the console's CSP on every stop with zero violations |
| `e2e/rtl.spec.ts`, `e2e/status.spec.ts` | the home stop under `dir="rtl"` with no overflow; no status in colour alone, every focus ring ink |
| `e2e/tour.spec.ts`, `e2e/probes.selftest.spec.ts` | every stop renders with no error and is photographed; every probe fails on the defect it exists for |
| `tests/unit/gates.bats` | the gate's e2e stage tours a production build in dist mode, and refuses when there is none |
