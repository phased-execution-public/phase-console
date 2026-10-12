/**
 * The line and its stations (design.md §7, quiet-console phase 1). jsdom
 * computes no styles, so the paint is asserted as the classes and attributes a
 * station wears, and the motion as what `track.css` declares.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UI_STATES } from '@shared/status-vocab.js';
import { expectNoAxeViolations } from '@/test/axe';
import { Station } from './station';
import { Track } from './track';

// Through a helper, never `new URL('<literal>', import.meta.url)` inline: Vite
// rewrites that shape as an asset reference, and the path stops being a file.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const CSS = readFileSync(here('./track.css'), 'utf8');
/** The rules as they ship — a sentence about a selector is not the selector. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
// The route map's own sheet: in the map's lazy chunk, and global once loaded.
const MAP_CSS = here('../../screens/plan/map/route-map.css');

function stations(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-station]')];
}

describe('the track', () => {
  it('is a list of stations, each painting through its .state-* class', () => {
    const { container } = render(
      <Track label="Phases">
        {UI_STATES.map((paint, i) => (
          <Station key={paint} paint={paint}>
            {i + 1}
          </Station>
        ))}
      </Track>,
    );
    const list = container.querySelector('[data-track]')!;
    expect(list.tagName).toBe('OL');
    expect(list.getAttribute('role')).toBe('list');
    expect(list.getAttribute('aria-label')).toBe('Phases');
    const items = stations(container);
    expect(items).toHaveLength(UI_STATES.length);
    for (const [i, el] of items.entries()) {
      expect(el.tagName).toBe('LI');
      expect(el.getAttribute('data-state')).toBe(UI_STATES[i]);
      expect(el.className).toContain(`state-${UI_STATES[i]}`);
      // No colour is named on the station or its dot: the class is the whole paint.
      expect(el.getAttribute('style')).toBeNull();
      expect(el.querySelector('.ui-station-dot')!.getAttribute('style')).toBeNull();
      // The identity stands beside the dot, and the dot is decoration.
      expect(el.textContent).toBe(String(i + 1));
      expect(el.querySelector('.ui-station-dot')!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('breathes only over a live running station — a live waiting one, or a running one nobody is watching, is still', () => {
    const { container } = render(
      <Track>
        <Station paint="running" live />
        <Station paint="running" />
        <Station paint="waiting" live />
        <Station paint="done" live settled />
      </Track>,
    );
    const live = stations(container).filter((el) => el.hasAttribute('data-live'));
    expect(live).toHaveLength(1);
    expect(live[0]!.getAttribute('data-state')).toBe('running');
    // …and the pulse is the one continuing motion, on the dot alone.
    expect(CSS).toMatch(/\.ui-station\[data-live\]\s*>\s*\.ui-station-dot\s*\{\s*animation:\s*pulse-soft/);
  });

  it('gives needs-you the summons ring and nothing else', () => {
    const { container } = render(
      <Track>
        <Station paint="needs-you" />
        <Station paint="failed" />
        <Station paint="running" live />
      </Track>,
    );
    const ringed = stations(container).filter((el) => el.hasAttribute('data-summons'));
    expect(ringed).toHaveLength(1);
    expect(ringed[0]!.getAttribute('data-state')).toBe('needs-you');
    // The ring is amber through the accent token — solid, never a pulse.
    expect(CSS).toMatch(/\.ui-station\[data-summons\]\s*>\s*\.ui-station-dot\s*\{[^}]*var\(--accent\)/);
    expect(CSS).not.toMatch(/\.ui-station\[data-summons\][^{]*\{[^}]*animation/);
  });

  it('stops the pulse under prefers-reduced-motion', () => {
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.ui-station\[data-live\]\s*>\s*\.ui-station-dot\s*\{\s*animation:\s*none/,
    );
  });

  it('draws the line neutral and a settled station hollow', () => {
    // Down a centred vertical track, once; across a horizontal one, leg by leg.
    expect(CSS).toMatch(
      /\.ui-track\[data-orientation='vertical'\]::before\s*\{[^}]*background:\s*var\(--track\)/,
    );
    expect(CSS).toMatch(
      /\.ui-track\[data-orientation='horizontal'\] > \.ui-station:not\(:last-child\)::after\s*\{[^}]*background:\s*var\(--track\)/,
    );
    expect(CSS).toMatch(
      /\.ui-station\[data-settled\]\s*>\s*\.ui-station-dot\s*\{\s*background:\s*transparent/,
    );
    const { container } = render(
      <Track orientation="vertical">
        <Station paint="done" settled fill>
          Done
        </Station>
        <Station paint="running" live>
          Now
        </Station>
      </Track>,
    );
    expect(container.querySelector('[data-track]')!.getAttribute('data-orientation')).toBe('vertical');
    const [done, now] = stations(container);
    expect(done!.hasAttribute('data-settled')).toBe(true);
    expect(done!.hasAttribute('data-fill')).toBe(true);
    expect(now!.hasAttribute('data-settled')).toBe(false);
  });

  it('names no size in the track colour family (the theme guard reads var(--track-…) as a colour)', () => {
    expect(CSS).not.toMatch(/var\(--track-/);
  });

  // Once the route map has been opened its sheet is global for the visit: a
  // kit element wearing one of its names would be painted by the map too —
  // faded in, dimmed when done, a label that takes no pointer. `state-*` is
  // theme.css's bridge, which both read on purpose.
  it("wears none of the route map's classes", () => {
    const map = new Set(
      [...readFileSync(MAP_CSS, 'utf8').matchAll(/\.([a-z][\w-]*)/g)]
        .map((m) => m[1]!)
        .filter((name) => !name.startsWith('state-')),
    );
    const { container } = render(
      <>
        <Track label="Phases">
          <Station paint="done" settled fill>
            One
          </Station>
          <Station paint="running" live>
            Two
          </Station>
          <Station paint="needs-you">Three</Station>
        </Track>
        <Track orientation="vertical" align="start" label="Steps">
          <Station
            paint="queued"
            tick={{ checked: false, onChange: () => {}, label: 'Step 1 done', face: '1' }}
          >
            Sign in
          </Station>
        </Track>
      </>,
    );
    const worn = [...container.querySelectorAll('*')].flatMap((el) => [...el.classList]);
    expect(worn.filter((name) => map.has(name))).toEqual([]);
    expect(worn).toContain('ui-station-label');
  });

  it('styles no bare .track or .station on first paint — the 6.x map names are gone from it', () => {
    // theme.css and every sheet it imports are on every visitor's first load;
    // a global `.track`, `.station` or `.station-label` there would paint any
    // element that happened to wear the word.
    const theme = readFileSync(here('../../styles/theme.css'), 'utf8');
    const sheets = [
      theme,
      ...[...theme.matchAll(/@import '\.\/([\w-]+\.css)';/g)].map((m) =>
        readFileSync(here(`../../styles/${m[1]!}`), 'utf8'),
      ),
    ];
    // theme.css and what it imports: the help sheet's strip sheet went with phase 26's rebuild.
    expect(sheets.length).toBeGreaterThan(2);
    for (const sheet of sheets) {
      const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, ' ');
      expect(rules).not.toMatch(/(?<![\w-])\.(?:track|station)(?:-label)?(?![\w-])/);
    }
  });

  it('a horizontal track draws its line leg by leg, AFTER each label — never through the words', () => {
    // "P1 next up" read as struck out when one line ran the track's width at
    // the labels' middle. Each station but the last draws the leg after its
    // words instead, as the start-aligned vertical track does.
    const { container } = render(
      <Track label="Phases">
        <Station paint="done" settled fill>
          4 done
        </Station>
        <Station paint="queued">P5 next up</Station>
        <Station paint="queued" settled>
          3 left
        </Station>
      </Track>,
    );
    // The list draws no line of its own: no horizontal `::before`, and the one
    // vertical line it keeps is a vertical track's alone.
    expect(RULES).not.toMatch(/\[data-orientation='horizontal'\][^{,]*::before/);
    expect(RULES).not.toMatch(/(?<![\w\]-])\.ui-track::before/);
    // The leg is the station's LAST flex item, after the dot and the label —
    // in the flow, never laid over them: no absolute box, no top or inset.
    const leg = RULES.match(
      /\.ui-track\[data-orientation='horizontal'\] > \.ui-station:not\(:last-child\)::after\s*\{([^}]*)\}/,
    )?.[1];
    expect(leg).toBeDefined();
    expect(leg).toMatch(/content:\s*''/);
    expect(leg).toMatch(/flex:\s*1 1 0/);
    expect(leg).toMatch(/min-inline-size:/);
    expect(leg).toMatch(/block-size:\s*var\(--station-line\)/);
    expect(leg).not.toMatch(/position|inset|top|translate/);
    // …so the DOM it follows must end with the words: dot, then label, then (::after) the leg.
    for (const station of stations(container)) {
      const parts = [...station.children].map((el) => el.className);
      expect(parts).toEqual(['ui-station-dot', 'ui-station-label']);
    }
    // The last station ends the line: no rule gives it a leg.
    expect(RULES).not.toMatch(/\[data-orientation='horizontal'\] > \.ui-station:last-child::after/);
    // A filled leg wears the station's paint, ink-faint once settled — on the leg, not over the label.
    expect(RULES).toMatch(
      /\[data-orientation='horizontal'\] > \.ui-station\[data-fill\]:not\(:last-child\)::after\s*\{\s*background:\s*var\(--state\)/,
    );
    expect(RULES).toMatch(
      /\[data-orientation='horizontal'\]\s*> \.ui-station\[data-fill\]\[data-settled\]:not\(\.state-failed\):not\(:last-child\)::after\s*\{\s*background:\s*var\(--ink-faint\)/,
    );
    // And never a ground-coloured box behind the words to hide a line: on a
    // card or a hovered row it is a patch.
    const label = RULES.match(/\.ui-station-label\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(label).not.toMatch(/background/);
  });

  it('a start-aligned vertical track draws its line leg by leg, never past the last station', () => {
    const { container } = render(
      <Track orientation="vertical" align="start" label="Steps">
        <Station paint="done" fill>
          One
        </Station>
        <Station paint="queued">Two</Station>
      </Track>,
    );
    expect(container.querySelector('[data-track]')!.getAttribute('data-align')).toBe('start');
    // The list's own line is off; each station but the last draws the leg below its mark.
    expect(CSS).toMatch(/\[data-align='start'\]::before\s*\{\s*content:\s*none/);
    expect(CSS).toMatch(
      /\[data-align='start'\] > \.ui-station:not\(:last-child\)::after\s*\{[^}]*var\(--track\)/,
    );
    expect(CSS).toMatch(
      /\[data-align='start'\] > \.ui-station\[data-fill\]:not\(:last-child\)::after\s*\{\s*background:\s*var\(--state\)/,
    );
    // A horizontal track has no start: the attribute is a vertical track's alone.
    const flat = render(
      <Track align="start">
        <Station paint="done" />
      </Track>,
    );
    expect(flat.container.querySelector('[data-track]')!.hasAttribute('data-align')).toBe(false);
  });

  it('a tick is a real checkbox under the drawn station, named by its label, its face decoration', async () => {
    const changes: boolean[] = [];
    const { container, rerender } = render(
      <Track orientation="vertical" align="start" label="Steps">
        <Station
          paint="queued"
          tick={{ checked: false, onChange: (v) => changes.push(v), label: 'Step 1 done', face: '1' }}
        >
          Sign in
        </Station>
      </Track>,
    );
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.getAttribute('aria-label')).toBe('Step 1 done');
    expect(box.checked).toBe(false);
    // The tick replaces the dot; its face is not read twice.
    expect(container.querySelector('.ui-station-dot')).toBeNull();
    expect(container.querySelector('.ui-station-tick-face')!.getAttribute('aria-hidden')).toBe('true');
    box.click();
    expect(changes).toEqual([true]);
    rerender(
      <Track orientation="vertical" align="start" label="Steps">
        <Station
          paint="done"
          fill
          tick={{ checked: true, onChange: () => {}, label: 'Step 1 done', face: '1' }}
        >
          Sign in
        </Station>
      </Track>,
    );
    expect(stations(container)[0]!.getAttribute('data-ticked')).toBe('true');
    // Ticked, the station fills with its own paint; on touch the target is a thumb, centred.
    expect(CSS).toMatch(
      /\.ui-station\[data-ticked='true'\] > \.ui-station-tick\s*\{[^}]*background:\s*var\(--state\)/,
    );
    expect(CSS).toMatch(
      /\.ui-station-tick::after\s*\{[^}]*inset:\s*calc\(\(100% - var\(--tap-min\)\) \/ 2\)/,
    );
    await expectNoAxeViolations(container);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Track label="Steps">
        <Station paint="done" settled>
          Sign in
        </Station>
        <Station paint="needs-you">Paste the code</Station>
        <Station paint="queued">Check</Station>
      </Track>,
    );
    await expectNoAxeViolations(container);
  });
});
