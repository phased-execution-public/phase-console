/**
 * The Settings vocabulary: which sections exist, and the nav that lists them.
 *
 * 2.x Settings was ONE page of fifteen cards — the console's whole
 * configuration surface in a single scroll, with no address for any part of it.
 * "Turn the repository guard off" could only be given as *scroll down Settings
 * until you find Automation*, and a deep link from an errand, a guide page or a
 * push notification had nowhere to point.
 *
 * Three rules hold the split together:
 *
 * 1. **A section is a QUESTION, not a card.** `#/settings/instance` answers "what
 *    is this server doing and how do I replace it" — which needs the process
 *    facts, the start command that Restart refuses without, the launcher and
 *    how the console is reached. Splitting those into four sections would put
 *    one answer behind four addresses; merging them into General would put four
 *    answers behind one.
 * 2. **The id is the address.** `SECTION_IDS` is what `#/settings/:section`
 *    accepts, so an unknown section is a redirect to the index rather than a
 *    blank frame — the `ROUTE_HEADS` discipline, one level down.
 * 3. **The index is a real page, not a redirect to the first section.** On a
 *    phone the list IS the screen; on a desktop it is the rail. An index that
 *    bounced to General would make the back button unusable on the surface
 *    where the list matters most.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { settingsHref } from '@/app/routes';

export interface SettingsSection {
  id: string;
  title: string;
  /** The question this section answers — shown on the index, read aloud by the nav. */
  blurb: string;
}

/**
 * The eight sections, **ordered minimal → advanced**.
 *
 * That order is the fourth rule, and it is the one Phase 7 added. A settings
 * index is read top to bottom by someone who does not yet know which section
 * holds their answer, so the list itself has to be the ladder: what this
 * console is and how it starts (almost everyone), then how it looks, then what
 * it may do by itself, then what it says, then the four surfaces only an
 * operator running work unattended ever opens, and last the two buttons that
 * end it.
 *
 * 2.x ordered them by nothing — `general`, `appearance`, `automation`,
 * `accounts`, `alerts`, `mcp`, `permissions`, `process` — which put Accounts,
 * a thing you touch once, above Alerts, a thing you touch whenever the console
 * says too much or too little, and buried the start command under a heading
 * called *This process*.
 *
 * A retired id is not deleted, it is redirected: `LEGACY_SETTINGS_SECTIONS`.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = Object.freeze([
  {
    id: 'essentials',
    title: 'Essentials',
    blurb: 'What this console reads, how it is started, what it is allowed to do, and the keys.',
  },
  {
    id: 'appearance',
    title: 'Appearance',
    blurb: 'Theme, density, what the plan list shows, and how the terminal paints.',
  },
  {
    id: 'automation',
    title: 'Automation',
    blurb: 'The opening values for every launch, the ladder’s caps, and when a session counts as stalled.',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    blurb: 'Every kind the console announces and where each one lands — console, device, webhook.',
  },
  {
    id: 'accounts',
    title: 'Accounts',
    blurb: 'Which account a session runs as, its usage, and what happens at a wall.',
  },
  { id: 'mcp', title: 'MCP servers', blurb: 'The servers a session may reach, and the catalog to add from.' },
  {
    id: 'permissions',
    title: 'Permissions',
    blurb: 'What a session may run without being asked — one vocabulary, per profile.',
  },
  {
    id: 'instance',
    title: 'This instance',
    blurb: 'Which console is running, how it is reached, and how to replace or stop it.',
  },
] as const);

/** Every valid `#/settings/:section` — the accepted set, not a suggestion. */
export const SECTION_IDS: readonly string[] = SETTINGS_SECTIONS.map((section) => section.id);

/**
 * What is actually IN each section, in the words an operator would type.
 *
 * Giving every section an address made Settings linkable and left it
 * unsearchable: the palette indexed the eight DESTINATIONS, so `⌘K quiet
 * hours` found nothing and the only way to a setting was to guess which of
 * eight nouns contained it. Every noun here names a control that exists —
 * these are search terms, not documentation, and a term for a control that was
 * removed is worse than no term, because it sends someone to a page that does
 * not answer them.
 *
 * Deliberately not derived from the rendered cards. A search index built by
 * walking the DOM can only see the section that is mounted, and the whole
 * point is finding the seven you are not looking at.
 */
export const SECTION_SEARCH_TERMS: Readonly<Record<string, string>> = Object.freeze({
  // A LIST that joins, never a `+` chain: prettier moves a trailing operator to
  // the line above, so a marked region would take the operand and leave the
  // operator behind — a syntax error in the free tree that no Pro test can see.
  essentials: [
    'source directory repository plans folder start command launch flags allow-writes allow-run allow-terminal allow-agent allow-accounts allow-mcp allow-webhooks capabilities engine scripts phase weights session budget keyboard shortcuts keys general',
  ].join(' '),
  appearance: 'theme dark light density comfortable compact terminal webgl renderer plan list documents',
  automation:
    'autopilot converge convergence ladder rungs budget dollars spend cap attempts sweep repo guard worktrees delegated gates boarding schedule quiet hours cron stalled thresholds resume at boot session hook mcp park recovery merged branches default skills',
  notifications:
    'announce alerts routing kinds categories urgent silence mute push devices subscribe quiet hours do not disturb webhooks channels destinations bell inbox delivery',
  accounts: 'claude account login usage meter limit wall switch register rename remove sign in',
  mcp: 'mcp servers registry catalog tools credentials add remove unreachable policy require',
  permissions:
    'permissions policy allow ask deny wall rules strike shipped defaults restore profile guarded trusted bypass auto approve',
  instance: [
    'process restart stop shutdown update interface service worker build revision tailscale remote reach port serving dist',
  ].join(' '),
});

/**
 * The section for an id, or `undefined` — the caller decides what an unknown
 * one means.
 *
 * Live ids only. A retired id is deliberately NOT resolved here: it is
 * redirected in `app/routes.ts` so the address bar stops saying
 * `#/settings/alerts` the moment the page loads (it says `notifications`).
 * Resolving a retired id silently would
 * leave a URL nobody can copy, share or reload into the same place — the
 * `#/plan/x/raw` lesson, one level down.
 */
export function sectionFor(id: string | undefined): SettingsSection | undefined {
  return id ? SETTINGS_SECTIONS.find((section) => section.id === id) : undefined;
}

/**
 * The address of a section, ready for an `href`.
 *
 * Delegates to `settingsHref` rather than re-spelling `#/settings/${id}`:
 * there were three spellings of this one address in the tree — this, the
 * helper in `app/routes.ts`, and a literal `#/notifications/settings` in the
 * bell drawer that only worked because a redirect caught it.
 */
export function sectionHref(id: string): string {
  return settingsHref(id);
}

/**
 * The section list.
 *
 * One component for both layouts: a rail on a desktop (`aside`), a list of
 * cards on a phone. `current` lights the one you are on and marks it
 * `aria-current="page"` — the nav is a real `<nav>` with real links, so
 * cmd-click, middle-click and "copy link address" all work, which is the whole
 * point of giving each section an address.
 */
export function SettingsNav({
  current,
  className,
  variant = 'rail',
}: {
  current?: string;
  className?: string;
  variant?: 'rail' | 'index';
}) {
  return (
    <nav aria-label="Settings sections" className={cn('min-w-0', className)}>
      <ul
        className={cn('min-w-0', variant === 'rail' ? 'flex flex-col gap-0.5' : 'grid gap-2 sm:grid-cols-2')}
      >
        {SETTINGS_SECTIONS.map((section) => (
          <li key={section.id} className="min-w-0">
            <a
              href={sectionHref(section.id)}
              aria-current={current === section.id ? 'page' : undefined}
              className={cn(
                'flex min-h-(--tap-min) min-w-0 flex-col justify-center rounded px-3 py-2',
                'text-sm text-ink-muted hover:bg-raised hover:text-ink',
                'aria-[current=page]:bg-raised aria-[current=page]:text-ink',
                variant === 'index' && 'border border-rule',
              )}
            >
              <span className="truncate font-medium text-ink">{section.title}</span>
              {variant === 'index' && <span className="mt-0.5 text-2xs text-ink-muted">{section.blurb}</span>}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The frame one section renders inside — heading, blurb, and the cards.
 *
 * `<h2>` rather than `<h1>`: the page's `<h1>` is *Settings*, and a section is
 * a part of it. A screen reader walking headings then hears the whole shape.
 */
export function SettingsSectionFrame({
  section,
  children,
}: {
  section: SettingsSection;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`settings-${section.id}`} className="min-w-0">
      <header className="mb-3 min-w-0">
        <h2 id={`settings-${section.id}`} className="font-display text-xl leading-none text-ink">
          {section.title}
        </h2>
        <p className="mt-1.5 text-sm text-ink-muted">{section.blurb}</p>
      </header>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </section>
  );
}
