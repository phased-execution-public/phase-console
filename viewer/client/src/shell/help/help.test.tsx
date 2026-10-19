/**
 * The help sheet.
 *
 * The property worth a test is **totality in both directions**. `GUIDE_SECTIONS`
 * lives in `shared/route-meta.js` because it is the frozen URL vocabulary; the
 * content lives in `client/src/content/guide/*.md`. A section added to one and
 * forgotten in the other is either a section that renders nothing or content
 * nothing can reach — neither of which is visible in a screenshot of the ones
 * that do work.
 *
 * The deep links are the second: `?help=mobile` has to land on Mobile setup,
 * because `#/guide/mobile` — which redirects to exactly that — is the URL the
 * phone-setup instructions tell people to open. And a `?help=` that names no
 * section opens the page's own help: explanations live in Help, reached from
 * the page.
 *
 * No case here names a heading of the guide's prose: each asserts against the
 * section's own outline, so editing a sentence never breaks the build.
 */

import { homedir, hostname, userInfo } from 'node:os';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESTINATIONS, GUIDE_SECTIONS } from '@shared/route-meta.js';
import { SURFACE } from '@/data/surface';
import { queryClientConfig } from '@/data/keys';
import { navItem } from '@/shell/nav';
import { MemoryRouterProvider } from '@/shell/router';
import { closeOverlaysHref, helpHref, settingsHref, type Route } from '@/shell/routes';
import { expectNoAxeViolations } from '@/test/axe';
import { HELP_BODIES } from './bodies';
import { HelpCard } from './card';
import { SHORT_CODE_CHARS, StatusProse, wearStatusWord } from './prose';
import { PageRoutes, pageSurface } from './route-strip';
// Loaded up front, so the sheet's `lazy()` resolves from the module cache and
// no case waits on a cold import under a full suite's load.
import './section';
import {
  HELP_SECTIONS,
  PAGE_HELP_SECTIONS,
  helpPlace,
  helpSectionIds,
  pageHelp,
  resolveHelpSection,
} from './sections';
import { HelpSheet } from './sheet';
import { cardsOf, splitGuide } from './split';

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: vi.fn(async (path: string) => {
      if (path === '/api/state') return { autopilot: true, allowRun: true };
      throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
    }),
  };
});

/**
 * Viewport width, per test.
 *
 * `lib/media.ts` memoises each `MediaQueryList` in a module-level cache, so
 * swapping `window.matchMedia` after import changes nothing — the first query
 * of a run wins for the whole file. Mocking the hook is the honest way to ask
 * "what does this render on a phone".
 */
let phone = false;
vi.mock('@/lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media')>();
  return { ...actual, usePhone: () => phone };
});

afterEach(() => {
  phone = false;
});

const routeOf = (segments: string[], query: Record<string, string> = {}): Route => ({
  segments,
  query,
  path: segments.join('/'),
});

/**
 * The sheet, open over a page. `?help=` is the open state, so "the guide at
 * mobile setup" is `renderHelp('mobile')` — and `renderHelp()` is the bare
 * `#/guide` the help key produces, which opens the page's own section.
 */
function renderHelp(
  section?: string,
  query: Record<string, string> = {},
  segments: string[] = ['runs'],
  onNavigate?: (path: string) => void,
) {
  const client = new QueryClient(queryClientConfig);
  const route = routeOf(segments, { help: section ?? '', ...query });
  return {
    route,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouterProvider onNavigate={onNavigate}>
          <HelpSheet route={route} />
        </MemoryRouterProvider>
      </QueryClientProvider>,
    ),
  };
}

/** The sheet itself — every query below is scoped to it, not to the page. */
const panelOf = () => screen.findByRole('dialog');

const bodyOf = (id: string) => HELP_BODIES[id] ?? '';
const outlineOf = (id: string) => splitGuide(bodyOf(id));
const cardsIn = (id: string) => cardsOf(outlineOf(id));

/** A section's cards have arrived — the panel is behind the sheet's `lazy()`. */
async function cardsShown(id: string): Promise<HTMLElement> {
  const panel = await panelOf();
  await within(panel).findByRole('heading', { level: 3, name: cardsIn(id)[0]!.title });
  return panel;
}

describe('the help section registry', () => {
  it('holds every frozen GUIDE_SECTIONS id, and a body for each, in every direction', () => {
    const frozen = [...GUIDE_SECTIONS].sort();
    expect([...helpSectionIds].sort()).toEqual(frozen);
    expect(Object.keys(HELP_BODIES).sort()).toEqual(frozen);
  });

  it('gives every section a label, a lede and real content', () => {
    for (const section of HELP_SECTIONS) {
      expect(section.label, section.id).toBeTruthy();
      expect(section.lede, section.id).toBeTruthy();
      // `?raw` returning '' is exactly what a renamed or deleted markdown file
      // looks like — the import succeeds and the tab is blank.
      expect(bodyOf(section.id).length, section.id).toBeGreaterThan(400);
      expect(bodyOf(section.id), section.id).toMatch(/^##? /m);
    }
  });

  it('falls back to the first section for an unknown or missing id', () => {
    expect(resolveHelpSection(undefined).id).toBe(GUIDE_SECTIONS[0]);
    expect(resolveHelpSection('nope').id).toBe(GUIDE_SECTIONS[0]);
  });

  it('names no private host, repo or path', () => {
    // The guide ships in a public repository. Placeholders only.
    //
    // `127.0.0.1` and `0.0.0.0` are deliberately allowed: they are the two
    // literals the security model is *about*, and a guide that could not print
    // them could not explain itself. Everything else that looks like an address
    // is somebody's actual machine.
    const addresses = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
    const ALLOWED = new Set(['127.0.0.1', '0.0.0.0']);
    // Whoever is running this, derived — never written down. A test that spells
    // out the name it forbids leaks it to everyone who reads the test.
    // A generic machine account is nobody's identity: on a CI box the username
    // is literally `runner`, and forbidding it would forbid the word this
    // guide's autopilot chapter is made of.
    const GENERIC = new Set(['runner', 'ci', 'build', 'agent', 'admin', 'user', 'root', 'ubuntu']);
    const local = [userInfo().username, hostname(), homedir()].filter(
      (s) => s.length >= 3 && !GENERIC.has(s.toLowerCase()),
    );
    const forbidden = [/\.ts\.net\/[a-z]/i, /\/Users\//, /\/home\/[a-z]/i];
    // As a token, never a bare substring: a hostname can be `Mac`, and the
    // guide is full of the word "machine". A leak names the identity alone.
    const names = (body: string, secret: string) =>
      new RegExp(`(?<![A-Za-z0-9])${secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(
        body,
      );

    for (const section of HELP_SECTIONS) {
      for (const pattern of forbidden) {
        expect(bodyOf(section.id), `${section.id} matched ${pattern}`).not.toMatch(pattern);
      }
      for (const secret of local) {
        expect(names(bodyOf(section.id), secret), `${section.id} names local identity`).toBe(false);
      }
      for (const found of bodyOf(section.id).match(addresses) ?? []) {
        expect(ALLOWED.has(found), `${section.id} names ${found}`).toBe(true);
      }
      // Placeholder hostnames only — never a real tailnet.
      for (const host of bodyOf(section.id).match(/[\w.-]+\.ts\.net/g) ?? []) {
        expect(host, section.id).toBe('your-machine.your-tailnet.ts.net');
      }
    }
  });

  it('warns against the one flag that would undo the whole security model', () => {
    expect(bodyOf('mobile')).toMatch(/--host 0\.0\.0\.0/);
    expect(bodyOf('mobile')).toMatch(/127\.0\.0\.1|loopback/);
  });
});

describe("a page's own help", () => {
  it('names only sections the guide holds', () => {
    for (const [head, id] of Object.entries(PAGE_HELP_SECTIONS)) {
      expect(helpSectionIds, `${head} → ${id}`).toContain(id);
    }
  });

  it('opens the Tower over Runs, Your turn over Your turn, and the run section over a plan', () => {
    expect(pageHelp(routeOf(['runs'])).section.id).toBe('tower');
    expect(pageHelp(routeOf([])).section.id).toBe('tower');
    expect(pageHelp(routeOf(['turn', 'item-1'])).section.id).toBe('your-turn');
    expect(pageHelp(routeOf(['plan', 'demo', 'run'])).section.id).toBe('run');
    expect(pageHelp(routeOf(['sessions'])).section.id).toBe('sessions');
    expect(pageHelp(routeOf(['runs'])).cardLabel).toBeUndefined();
  });

  it('opens every other destination on Getting around, at a card its rail label heads', () => {
    const cards = cardsIn('destinations');
    for (const head of DESTINATIONS.filter((d) => !(d in PAGE_HELP_SECTIONS))) {
      const place = pageHelp(routeOf([head]));
      const label = navItem(head)!.label;
      expect(place.section.id, head).toBe('destinations');
      expect(place.cardLabel, head).toBe(label);
      expect(
        cards.some((card) => card.title === label || card.title.startsWith(`${label} `)),
        `no Getting around card is headed "${label}"`,
      ).toBe(true);
    }
  });

  it('gives way to a section the address names, and ignores one the guide does not hold', () => {
    expect(helpPlace(routeOf(['repo']), 'mobile')).toEqual({ section: resolveHelpSection('mobile') });
    expect(helpPlace(routeOf(['repo']), 'nope')).toEqual(pageHelp(routeOf(['repo'])));
    // A head is whatever the address says: an object's own key is no page's.
    expect(pageHelp(routeOf(['constructor']))).toEqual(pageHelp(routeOf(['no-such-page'])));
  });

  it('over Repo, opens Getting around at the Repo card — even on a phone, where the rest stay folded', async () => {
    phone = true;
    renderHelp(undefined, {}, ['repo', 'issues']);
    const panel = await cardsShown('destinations');
    const label = navItem('repo')!.label;
    const repo = cardsIn('destinations').find((card) => card.title.startsWith(`${label} `))!;
    await waitFor(() =>
      expect(panel.querySelector<HTMLDetailsElement>(`#card-${CSS.escape(repo.id)}`)!.open).toBe(true),
    );
    const current = within(panel).getByRole('link', { current: 'page' });
    expect(current.textContent).toBe(resolveHelpSection('destinations').label);
  });
});

describe('the help sheet', () => {
  it('renders the section the address names, not the page’s', async () => {
    renderHelp('mobile');
    const panel = await panelOf();
    // Against the section's OWN first card rather than a heading spelled out
    // here: a test that names a heading turns editing prose into breaking the
    // build.
    const first = outlineOf('mobile').groups[0]!.cards[0]!;
    expect(await within(panel).findByRole('heading', { name: first.title })).toBeTruthy();
  });

  it('draws the sections as real links, and marks the open one current so a reload lands there', async () => {
    const { route } = renderHelp('mcp');
    const panel = await panelOf();
    const nav = within(panel).getByRole('navigation', { name: 'Guide sections' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(HELP_SECTIONS.length);
    const mcp = within(nav).getByRole('link', { name: resolveHelpSection('mcp').label });
    expect(mcp.getAttribute('aria-current')).toBe('page');
    expect(mcp.getAttribute('href')).toBe(helpHref('mcp', undefined, route));
  });

  it('opens the page’s own section when none is named — #/guide over Runs is the Tower', async () => {
    renderHelp();
    const panel = await panelOf();
    const nav = within(panel).getByRole('navigation', { name: 'Guide sections' });
    expect(within(nav).getByRole('link', { current: 'page' }).textContent).toBe(
      resolveHelpSection('tower').label,
    );
    expect(await within(panel).findByText(/Runs are enabled on this console/i)).toBeTruthy();
  });

  it('renders nothing at all when the URL does not ask for it', () => {
    render(
      <QueryClientProvider client={new QueryClient(queryClientConfig)}>
        <HelpSheet route={routeOf(['runs'])} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes onto the same page with every overlay key gone', async () => {
    const onNavigate = vi.fn();
    const { route } = renderHelp('concepts', { card: 'x' }, ['repo', 'issues'], onNavigate);
    const panel = await panelOf();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(onNavigate).toHaveBeenCalledWith(closeOverlaysHref(route));
  });

  it('rises from the bottom on a phone and stands at the end edge on a desk', async () => {
    phone = true;
    const { unmount } = renderHelp('concepts');
    expect((await panelOf()).className).toMatch(/\brounded-t-lg\b/);
    unmount();
    phone = false;
    renderHelp('concepts');
    const desk = await panelOf();
    expect(desk.className).toMatch(/\bend-0\b/);
    expect(desk.className).not.toMatch(/\brounded-t-lg\b/);
  });

  it('renders markdown through the sanitizer — a table becomes a real table', async () => {
    renderHelp('concepts');
    const panel = await panelOf();
    expect((await within(panel).findAllByRole('table')).length).toBeGreaterThan(0);
  });

  it('draws the reference glossary words as the status family draws a word, with the hover help', async () => {
    renderHelp('reference');
    const panel = await panelOf();

    // The decoration runs in an effect after the sanitizer fills the DOM.
    await waitFor(() => {
      const halted = [...panel.querySelectorAll('code')].find((el) => el.textContent === 'halted');
      expect(halted, 'the glossary names halted as inline code').toBeTruthy();
      // A halted run is the status model's quiet wait — amber is a summons, and
      // a word alone never is one. The word paints by `--state`, never a colour
      // of its own: the dot carries the hue.
      expect(halted!.className, "painted as the run's own paint").toContain('state-waiting');
      expect(halted!.className).not.toContain('state-needs-you');
      expect(halted!.querySelector('[aria-hidden="true"]')?.className).toContain('bg-state');
      expect(halted!.getAttribute('title')).toMatch(/must not be automated past/);
    });

    // The eight UI states are words in the same glossary, and wear themselves.
    const done = [...panel.querySelectorAll('code')].find((el) => el.textContent === 'done');
    expect(done, 'done appears as inline code in the eight-states table').toBeTruthy();
    expect(done!.className).toContain('state-done');
    expect(done!.getAttribute('title')).toMatch(/Finished/);

    // A code word that is NOT a status stays a plain code span — only kept whole when short (#335).
    const flag = [...panel.querySelectorAll('code')].find((el) => el.textContent?.startsWith('--allow'));
    if (flag) expect(flag.className).toMatch(/^(whitespace-nowrap)?$/);
  });
});

describe('the section is cards, not a wall', () => {
  it('breaks the reference glossary into separate cards', async () => {
    renderHelp('reference');
    const panel = await cardsShown('reference');
    expect(within(panel).getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(6);
  });

  // #247: this used to render every section, one case each, and the case
  // outran its 20 s bound under a full gate's load. What names a card is its
  // title, so the totality is read off the outlines — no render — and one
  // render shows a summary's heading is named by exactly that title.
  it('gives every card in every section a title to be named by, and an id of its own', () => {
    for (const section of HELP_SECTIONS) {
      const cards = cardsIn(section.id);
      expect(cards.length, `${section.id} has no cards`).toBeGreaterThan(1);
      for (const card of cards) expect(card.title.trim(), `${section.id}/${card.id}`).toBeTruthy();
      expect(new Set(cards.map((card) => card.id)).size, `${section.id}: a card id twice`).toBe(cards.length);
    }
  });

  it('names a card’s summary heading by its title — a status word as well', () => {
    const plain = cardsIn('reference')[0]!;
    const word = HELP_SECTIONS.flatMap((s) => cardsIn(s.id)).find(
      (card) => !wearStatusWord(card.title) && wearStatusWord(card.title.toLowerCase()),
    );
    for (const card of word ? [plain, word] : [plain]) {
      const { unmount } = render(<HelpCard card={card} href="#" open onToggle={() => {}} />);
      const heading = screen.getByRole('heading', { level: 3, name: card.title });
      expect(heading.closest('summary'), card.id).toBeTruthy();
      unmount();
    }
  });

  it('renders a group band as a real heading above its cards', async () => {
    const banded = HELP_SECTIONS.find((s) => outlineOf(s.id).groups.some((g) => g.banded));
    if (!banded) return; // Most files are flat; this guards the shape, not the content.
    renderHelp(banded.id);
    const panel = await cardsShown(banded.id);
    const group = outlineOf(banded.id).groups.find((g) => g.banded)!;
    expect(within(panel).getByRole('heading', { level: 2, name: group.title })).toBeTruthy();
  });

  it('opens every card on a desktop, except the bulky ones', async () => {
    renderHelp('reference');
    const panel = await cardsShown('reference');
    // No reference card is bulky — a glossary you cannot Cmd-F is not a
    // glossary — so every one of them is open at desktop width.
    for (const card of panel.querySelectorAll('details')) {
      expect((card as HTMLDetailsElement).open).toBe(true);
    }
  });

  it('opens only the first card on a phone', async () => {
    phone = true;
    renderHelp('reference');
    const panel = await cardsShown('reference');
    const cards = [...panel.querySelectorAll('details')] as HTMLDetailsElement[];
    expect(cards.length).toBeGreaterThan(1);
    // Asserted on `open`, not on a role query: whether jsdom exposes content
    // inside a closed `<details>` depends on its UA stylesheet.
    expect(cards[0]!.open).toBe(true);
    expect(cards.some((c) => !c.open)).toBe(true);
  });

  it('draws a sequence’s stops on the line, painted by who acts, and a stop opens its card', async () => {
    phone = true;
    const route = HELP_SECTIONS.find((s) => s.kind === 'route' && cardsIn(s.id).some((c) => c.actor))!;
    const cards = cardsIn(route.id);
    renderHelp(route.id);
    const panel = await cardsShown(route.id);
    const line = within(panel).getByRole('list', { name: 'Stops in this section' });
    const stations = [...line.querySelectorAll('[data-station]')];
    expect(stations).toHaveLength(cards.length);
    for (const [i, card] of cards.entries()) {
      const want = card.actor === 'machine' ? 'done' : card.actor === 'person' ? 'needs-you' : 'queued';
      expect(stations[i]!.getAttribute('data-state'), card.id).toBe(want);
    }
    // The key names only the marks the line draws.
    const key = panel.querySelector('[data-slot="legend"]')!;
    if (cards.some((c) => c.actor === 'person')) expect(key.textContent).toContain('You do this');
    if (cards.some((c) => c.actor === 'machine')) expect(key.textContent).toContain('The machine does this');

    const last = cards[cards.length - 1]!;
    const card = panel.querySelector<HTMLDetailsElement>(`#card-${CSS.escape(last.id)}`)!;
    expect(card.open).toBe(false);
    fireEvent.click(within(line).getAllByRole('button').at(-1)!);
    await waitFor(() => expect(card.open).toBe(true));
  });

  it('gives a set a plain index, never a line', async () => {
    renderHelp('mcp');
    const panel = await cardsShown('mcp');
    expect(within(panel).getByRole('navigation', { name: 'In this section' })).toBeTruthy();
    expect(within(panel).queryByRole('list', { name: 'Stops in this section' })).toBeNull();
  });
});

describe('deep links to a card', () => {
  it('opens the card named by ?card=', async () => {
    phone = true;
    const target = outlineOf('reference').groups[3]!.cards[0]!;
    renderHelp('reference', { card: target.id });
    const panel = await cardsShown('reference');
    const card = panel.querySelector<HTMLDetailsElement>(`#card-${CSS.escape(target.id)}`);
    expect(card, `no card with id ${target.id}`).toBeTruthy();
    expect(card!.open).toBe(true);
  });

  it('ignores an unknown ?card= rather than rendering nothing', async () => {
    // Card ids come from prose, so they are deliberately NOT frozen vocabulary
    // — which means a stale link has to degrade, not break.
    renderHelp('concepts', { card: 'no-such-card' });
    const panel = await cardsShown('concepts');
    expect(within(panel).getAllByRole('table').length).toBeGreaterThan(0);
  });

  it('carries the page underneath in every card’s permalink', async () => {
    const { route } = renderHelp('concepts', {}, ['repo', 'issues']);
    const panel = await cardsShown('concepts');
    const first = cardsIn('concepts')[0]!;
    const link = within(panel).getAllByRole('link', { name: 'Link to this card' })[0]!;
    expect(link.getAttribute('href')).toBe(helpHref('concepts', first.id, route));
    expect(link.getAttribute('href')).toMatch(/^#\/repo\/issues\?/);
  });

  /**
   * An overlay has to own focus, name itself and be escapable: a dialog is
   * exactly where a missing accessible name goes unnoticed. Mounted OPEN with
   * real prose — a sequence, its line and its key, over a page whose route
   * strip is unfolded — so the assertion is about what an operator meets.
   */
  it('opens with no axe violations, on real prose', async () => {
    const route = HELP_SECTIONS.find((s) => s.kind === 'route')!;
    renderHelp(route.id, {}, ['repo', 'issues']);
    const panel = await cardsShown(route.id);
    fireEvent.click(within(panel).getByRole('button', { name: /What this page reads and presses/ }));
    await expectNoAxeViolations(panel);
  });

  it('opens with focus on its title, never with a ring on the first control in it', async () => {
    // Help is read before anything in it is pressed: the route strip's toggle
    // is the first control, and a sheet opened at `?help=` wore the ring on
    // it (quiet-console phase 26's pictures, fixed in 27).
    renderHelp('tower');
    const panel = await cardsShown('tower');
    const title = within(panel).getByRole('heading', { name: 'Help' });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(title).toHaveAttribute('tabindex', '-1');
    expect(within(panel).getByRole('button', { name: /What this page reads and presses/ })).not.toBe(
      document.activeElement,
    );
  });

  it('opens with no axe violations on a card permalink, a status word for a title among its cards', async () => {
    const id = 'troubleshooting';
    const target = cardsIn(id)[1]!;
    renderHelp(id, { card: target.id });
    await expectNoAxeViolations(await cardsShown(id));
  });
});

describe('the route strip', () => {
  it('lists the rows of the registry whose door is this page, and none of the shell’s', () => {
    const surface = pageSurface(routeOf(['repo', 'issues']));
    const rows = [...surface.reads, ...surface.presses, ...surface.settings];
    const want = SURFACE.filter(
      (row) =>
        row.door &&
        row.door.place !== 'Shell' &&
        row.door.head === 'repo' &&
        (row.door.section === undefined || row.door.section === 'issues'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.id).sort()).toEqual(want.map((row) => row.id).sort());
    expect(surface.reads.every((row) => row.kind === 'sse' || row.method === 'GET')).toBe(true);
    expect(surface.presses.every((row) => row.kind === 'verb' || row.method !== 'GET')).toBe(true);
    // The shell's own rows ride every page; they are no page's.
    const runs = pageSurface(routeOf(['runs']));
    const shell = SURFACE.filter((row) => row.door?.place === 'Shell').map((row) => row.id);
    for (const row of [...runs.reads, ...runs.presses, ...runs.settings]) expect(shell).not.toContain(row.id);
  });

  it('reads a page’s section as the page does: History is #/repo, and a plan opens on its phases', () => {
    const history = pageSurface(routeOf(['repo']));
    const historyIds = [...history.reads, ...history.presses].map((row) => row.id);
    const want = SURFACE.filter((row) => row.door?.head === 'repo' && row.door.section === 'history');
    for (const row of want) expect(historyIds).toContain(row.id);
    const plan = pageSurface(routeOf(['plan', 'demo']));
    const phases = SURFACE.filter((row) => row.door?.head === 'plan' && row.door.section === 'phases');
    const planIds = [...plan.reads, ...plan.presses, ...plan.settings].map((row) => row.id);
    for (const row of phases) expect(planIds).toContain(row.id);
  });

  it('folds what a page reads, presses and is governed by under one line, each setting a search of Everything', () => {
    const route = routeOf(['settings', 'accounts']);
    const { reads, presses, settings } = pageSurface(route);
    render(<PageRoutes route={route} />);
    const fold = screen.getByRole('button', { name: /What this page reads and presses/ });
    expect(fold.textContent).toContain(`(${reads.length + presses.length + settings.length})`);
    fireEvent.click(fold);
    for (const row of reads.filter((r) => r.kind === 'route')) {
      expect(screen.getAllByText(`${row.method} ${row.path}`).length, row.id).toBeGreaterThan(0);
    }
    const flagged = presses.find((row) => row.flag);
    if (flagged) expect(screen.getAllByText(flagged.flag!).length).toBeGreaterThan(0);
    const linked = settings.find((row) => !/^(?:browser\.|run\.|flag )/.test(row.key!));
    if (linked) {
      expect(screen.getByRole('link', { name: linked.key }).getAttribute('href')).toBe(
        settingsHref('everything', { q: linked.key! }),
      );
    }
  });

  it('draws nothing for a page the registry gives no rows', () => {
    const route = routeOf(['no-such-page']);
    const { reads, presses, settings } = pageSurface(route);
    expect(reads.length + presses.length + settings.length).toBe(0);
    const { container } = render(<PageRoutes route={route} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('inline code in the guides', () => {
  it('keeps a short token whole and lets a long path break (#335)', async () => {
    const long = 'viewer/client/src/screens/plan/run/verification.tsx';
    expect(long.length).toBeGreaterThan(SHORT_CODE_CHARS);
    const { container } = render(<StatusProse text={`Open \`?bay=\` or \`${long}\`.`} />);
    await waitFor(() => expect(container.querySelectorAll('code').length).toBe(2));
    const [short, path] = [...container.querySelectorAll('code')];
    await waitFor(() => expect(short!.className).toContain('whitespace-nowrap'));
    expect(path!.className).not.toContain('whitespace-nowrap');
  });
});
