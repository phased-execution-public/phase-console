/**
 * The guide's content, one markdown file per section.
 *
 * The legacy guide was 504 lines of JS with the prose embedded in `html`
 * template literals, which meant editing a sentence was editing a component and
 * nobody could read the page's text without reading its markup. Here the text is
 * markdown on disk, imported with Vite's `?raw` and rendered through the same
 * sanitized `<Markdown>` every other surface uses — so the guide cannot render
 * anything a handoff could not.
 *
 * `GUIDE_SECTIONS` in `shared/route-meta.js` is the frozen vocabulary; this
 * module supplies a title, a one-line lede and a shape for each id, and
 * `bodies.ts` supplies the prose. A client test asserts all three agree, so a
 * section added to the shared list without content — or content with no route
 * — fails rather than rendering an empty tab.
 *
 * The split is a budget decision, not a tidiness one: the sheet draws its
 * section list from this module the moment it opens, and the `?raw` bodies are
 * ~60 KB of string that ride the section panel's own lazy chunk behind it.
 */

import { GUIDE_SECTIONS } from '@shared/route-meta.js';
import { navItem } from '@/shell/nav';
import { DEFAULT_HEAD, destinationFor, type Route } from '@/shell/routes';

export interface GuideSection {
  id: string;
  /** The tab's word. Short — it has to survive a 390px tab strip. */
  label: string;
  /** One line, under the heading. */
  lede: string;
  /**
   * Whether the cards are a sequence or a set.
   *
   * `route` draws the section as a line — stations on a track, numbered, with a
   * solid station for work the machine does and a ringed one for work that
   * waits for a person. `topic` gets a plain index and a plain stack.
   *
   * The distinction is not decorative: a line over the Reference glossary would
   * claim an order that does not exist, and a reader who trusts it would look
   * for a first step that is not there.
   */
  kind: 'route' | 'topic';
}

export const HELP_SECTIONS: readonly GuideSection[] = [
  {
    id: 'concepts',
    label: 'Concepts',
    lede: 'What a plan is, the two lines a machine reads, and who does which part.',
    kind: 'route',
  },
  {
    id: 'quick-start',
    label: 'Quick start',
    lede: 'From a plan on disk to a running phase — the one screen that starts it, and what to watch.',
    kind: 'route',
  },
  {
    id: 'running',
    label: 'Starting up',
    lede: 'Every way to start the console — and the switches that decide what it may do.',
    // A menu, not a journey: you pick ONE of these ways in, you do not walk
    // them in order.
    kind: 'topic',
  },
  {
    id: 'destinations',
    label: 'Getting around',
    lede: 'The eight places, the three doors every page shares, and what opens over any page.',
    kind: 'topic',
  },
  {
    id: 'tower',
    label: 'Runs home',
    lede: 'What needs you, what is moving, what waits and what is next — one line per run, each with its one action.',
    kind: 'topic',
  },
  {
    id: 'run',
    label: 'A run',
    lede: 'Starting a run, what one phase actually does, and how to watch, ask, pause or stop it.',
    kind: 'route',
  },
  {
    id: 'autopilot',
    label: 'Autopilot',
    lede: 'Answering what needs you, what “verified” means, and the verbs for a phase that stalled.',
    kind: 'topic',
  },
  {
    id: 'halts',
    label: 'Halts',
    lede: 'Why a run stops by itself, the one sentence each halt says, and the one press that brings it back.',
    kind: 'topic',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    lede: 'Work that outlives the browser — plus the recovery and QA sessions the console starts for you, and the shutdown button.',
    kind: 'topic',
  },
  {
    id: 'notifications',
    label: 'Alerts',
    lede: 'One switch per category, governing every way a message could reach you — and how the inbox gets back to zero.',
    kind: 'topic',
  },
  {
    id: 'your-turn',
    label: 'Your turn',
    lede: 'A sign-in, a code or a look only you can do — and doing it from any device.',
    kind: 'topic',
  },
  {
    id: 'permissions',
    label: 'Permissions',
    lede: 'Which layer actually stops an unattended run — and which one fails open.',
    kind: 'topic',
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    lede: 'Attaching tools to a plan, and finding out they are signed in before an hour is spent.',
    kind: 'topic',
  },
  {
    id: 'settings',
    label: 'Skills, plugins and hooks',
    lede: 'What a session can call, what an unattended one loads, every hook it runs, and the rules each plan writes.',
    kind: 'topic',
  },
  {
    id: 'insights',
    label: 'Tokens, cache and trends',
    lede: 'Where the tokens and the money went, whether the cache held, and how the checks and the machine are trending.',
    kind: 'topic',
  },
  {
    id: 'mobile',
    label: 'Mobile setup',
    lede: 'Reaching the console from a phone, end to end, with nothing on the public internet.',
    kind: 'route',
  },
  {
    id: 'troubleshooting',
    label: 'When stuck',
    lede: 'The four ways a run comes to rest, and the things that look broken and are not.',
    kind: 'topic',
  },
  {
    id: 'reference',
    label: 'Reference',
    lede: 'Flags, environment, verbs, gates, paths, and every status word the console can show you.',
    kind: 'topic',
  },
];

const BY_ID = new Map(HELP_SECTIONS.map((s) => [s.id, s]));

/** The default section, and the fallback for an unknown one. */
export const DEFAULT_HELP_SECTION = GUIDE_SECTIONS[0];

export function resolveHelpSection(id: string | undefined): GuideSection {
  return BY_ID.get(id ?? '') ?? BY_ID.get(DEFAULT_HELP_SECTION)!;
}

export const helpSectionIds: readonly string[] = HELP_SECTIONS.map((s) => s.id);

/**
 * The section a page's own help is, by route head — what `?help=` means on
 * that page when it names no section, or one this guide does not hold.
 * Explanations live in Help, reached from the page (design.md §1, principle
 * 10), so the help a page opens is the part of the guide about that page, and
 * `#/guide` (an empty `?help=` over Runs) opens the Runs home's.
 *
 * A head not listed here is a page Getting around describes in one card,
 * headed by the page's rail label (`shell/nav.ts`); its help opens there, at
 * that card.
 */
export const PAGE_HELP_SECTIONS: Readonly<Record<string, string>> = Object.freeze({
  runs: 'tower',
  turn: 'your-turn',
  approve: 'your-turn',
  plan: 'run',
  sessions: 'sessions',
});

/**
 * The addresses whose help is a section of its own when their head's is not —
 * `<head>/<second segment>`, asked before the head (#408): a page's help was
 * chosen by its first segment alone, so a page under Insights opened Getting
 * around at the Insights card rather than its own section.
 */
export const PAGE_HELP_ADDRESSES: Readonly<Record<string, string>> = Object.freeze({
});

/**
 * The heads with a Getting around card of their own that the rail does not
 * list — each is reached from the shell instead (the switcher opens Fleet).
 */
const HEAD_CARDS: ReadonlyMap<string, string> = new Map([
]);

/** Where a sheet opens: a section, and — for a page's own help — the card about the page. */
export interface HelpPlace {
  section: GuideSection;
  /**
   * The label of the card to open at: a card titled exactly this, or this and
   * then more (`Repo — what did the work do to the tree?`). Absent, the section
   * opens at its top.
   */
  cardLabel?: string;
}

/** A page's own help: its address's section, its head's, else Getting around at the card its rail label heads, else the first section. */
export function pageHelp(route: Pick<Route, 'segments'>): HelpPlace {
  const head = route.segments[0] || DEFAULT_HEAD;
  const address = `${head}/${route.segments[1] ?? ''}`;
  if (Object.hasOwn(PAGE_HELP_ADDRESSES, address)) {
    return { section: resolveHelpSection(PAGE_HELP_ADDRESSES[address]) };
  }
  // Own keys only: a head is whatever the address says, `constructor` included.
  if (Object.hasOwn(PAGE_HELP_SECTIONS, head)) {
    return { section: resolveHelpSection(PAGE_HELP_SECTIONS[head]) };
  }
  const label = navItem(head)?.label ?? HEAD_CARDS.get(head) ?? navItem(destinationFor(head))?.label;
  if (!label) return { section: resolveHelpSection(undefined) };
  return { section: resolveHelpSection('destinations'), cardLabel: label };
}

/** What `?help=<asked>` opens over `route`: the section it names, or the page's own help. */
export function helpPlace(route: Pick<Route, 'segments'>, asked: string | undefined): HelpPlace {
  const named = asked ? BY_ID.get(asked) : undefined;
  return named ? { section: named } : pageHelp(route);
}
