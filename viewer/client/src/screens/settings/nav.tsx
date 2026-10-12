/**
 * Settings' sections, as addresses (7.0, quiet-console phase 21).
 *
 * ```
 * #/settings                 the list of sections, and the search over every key
 * #/settings/<section>       one section            ?q= searches from anywhere in Settings
 * #/settings/everything      every key the console stores, from the schema
 * ```
 *
 * A section is a QUESTION, not a card: `#/settings/instance` answers "what is
 * this server doing and how do I replace it". The order is the order the
 * questions arrive in — what this console is, how it looks, what it does by
 * itself, what it says — then the surfaces only an unattended console needs,
 * and last Everything, the registry under all of them. A retired id is not
 * deleted but redirected (`LEGACY_SETTINGS_SECTIONS`, `shell/redirects.ts`), and
 * an id nobody knows is the list rather than a blank frame.
 *
 * The ids are the registry's too (`data/surface.ts` doors, the palette's
 * `settingsActions`): rename one and every door to it moves.
 */

import { cn } from '@/lib/cn';
import { settingsHref } from '@/shell/routes';
import { SectionNav } from '@/shell/section-nav';

export interface SettingsSection {
  id: string;
  title: string;
  /** The question the section answers — the index's line, and the section's lead. */
  blurb: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = Object.freeze([
  {
    id: 'essentials',
    title: 'Essentials',
    blurb: 'What this console reads, what it may do, and the line that starts it.',
  },
  {
    id: 'appearance',
    title: 'Appearance',
    blurb: 'How the console looks in this browser, and what the lists show.',
  },
  {
    id: 'automation',
    title: 'Automation',
    blurb: 'What every launch opens on, how far the console repairs by itself, and when work may start.',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    blurb: 'What the console announces, where each kind lands, and when your turns are said again.',
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
    blurb: 'Every grant and what it changed, the owner keys, and what a session may run unasked.',
  },
  {
    id: 'instance',
    title: 'This instance',
    blurb: 'Which console is running, how it is reached, and how to replace or stop it.',
  },
  {
    id: 'everything',
    title: 'Everything',
    blurb: 'Every key this console stores, where its value came from, and the line that changes it.',
  },
] as const);

/** Every valid `#/settings/:section`. */
export const SECTION_IDS: readonly string[] = SETTINGS_SECTIONS.map((section) => section.id);

/** The section a path segment names, or `undefined` for the list — an unknown id included. */
export function settingsSectionOf(segment: string | undefined): SettingsSection | undefined {
  return segment ? SETTINGS_SECTIONS.find((section) => section.id === segment) : undefined;
}

/**
 * What is IN each section, in the words a person would type. Not walked from the
 * rendered page: a search built from the DOM can only see the section that is
 * mounted, and the point is finding the ones you are not looking at. A term for
 * a control that does not exist sends someone to a page that cannot answer
 * them, so every word here names one.
 */
export const SECTION_TERMS: Readonly<Record<string, string>> = Object.freeze({
  // A LIST that joins, never a `+` chain: prettier moves a trailing operator to
  // the line above, and a marked region would then keep the operand and lose
  // the operator — a syntax error only the free tree would see.
  essentials: [
    'source directory repository plans folder start command launch flags allow-writes allow-run allow-terminal allow-agent allow-accounts allow-mcp allow-webhooks capabilities engine scripts phase weights session budget keyboard shortcuts keys general',
  ].join(' '),
  appearance:
    'theme dark light night paper density comfortable compact terminal webgl renderer screen reader plan list documents session plan model sort order',
  automation: [
    'autopilot converge convergence ladder rungs budget dollars spend cap attempts ceiling starts per hour sweep repo guard worktrees isolation delegated gates boarding schedule quiet hours stalled thresholds resume at boot session hook presence policy answers relay rules queue scheduling seniority blocker critical path load factor check judgement defaults launch model effort asking less',
  ].join(' '),
  notifications:
    'announce alerts routing kinds categories urgent silence mute push devices subscribe quiet hours do not disturb webhooks channels destinations bell inbox delivery reminders your turn human step snooze cadence',
  accounts:
    'claude account login usage meter limit wall switch register rename remove sign in token credits tombstones overage entitlement',
  mcp: 'mcp servers registry catalog tools credentials add remove rename unreachable policy require',
  permissions:
    'permissions policy allow ask deny wall rules strike shipped defaults restore profile guarded trusted bypass auto approve grants granted revoke scope owner key passkey enrol lock sign in',
  instance: [
    'process restart stop shutdown update interface service worker build revision tailscale remote reach port serving dist unit arguments capability flags machine profile autostart',
    'logs retention disk space prune sweep keep delete transcripts journals rulings git trace size bytes',
  ].join(' '),
  everything:
    'everything every key all settings registry schema default provenance source command line cli reset',
});

/**
 * The section that owns a schema group — where a key's control lives. A group
 * with no section of its own in this edition reads in Everything.
 */
export function sectionOfGroup(group: string): string {
  switch (group) {
    case 'essentials':
    case 'appearance':
    case 'automation':
    case 'notifications':
      return group;
    case 'retention':
    case 'profile':
      return 'instance';
    default:
      return 'everything';
  }
}

export const sectionTitle = (id: string): string =>
  SETTINGS_SECTIONS.find((section) => section.id === id)?.title ?? id;

/**
 * The rail beside a section from 1200 up: every section as a real link, the
 * current one marked. Below 1200 the list is the index page and a section
 * carries the way back to it — so one navigation is on screen at a time.
 */
export function SettingsRail({ current, className }: { current: string; className?: string }) {
  return (
    <SectionNav
      vertical
      label="Settings sections"
      current={current}
      className={className}
      sections={SETTINGS_SECTIONS.map((section) => ({
        id: section.id,
        label: section.title,
        href: settingsHref(section.id),
      }))}
    />
  );
}

/**
 * The index: every section with the question it answers, one line each, the
 * registry last behind a rule. `counts` says how many keys each holds that
 * are set rather than shipped defaults, once the schema has answered.
 */
export function SettingsIndexList({ counts }: { counts?: Readonly<Record<string, number>> }) {
  const sections = SETTINGS_SECTIONS.filter((section) => section.id !== 'everything');
  const everything = SETTINGS_SECTIONS.find((section) => section.id === 'everything')!;
  return (
    <nav aria-label="Settings sections" className="min-w-0 max-w-(--measure)">
      <ul className="flex min-w-0 flex-col">
        {[...sections, everything].map((section) => {
          const set = counts?.[section.id] ?? 0;
          return (
            <li
              key={section.id}
              className={cn('min-w-0', section.id === 'everything' && 'mt-2 border-t border-rule pt-2')}
            >
              <a
                href={settingsHref(section.id)}
                data-section-link={section.id}
                className="group flex min-w-0 flex-col justify-center gap-0.5 py-2.5 [@media(hover:none)]:min-h-(--tap-min)"
              >
                <span className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="min-w-0 text-body font-medium text-ink decoration-ink-faint underline-offset-2 group-hover:underline">
                    {section.title}
                  </span>
                  {set > 0 && (
                    <span className="shrink-0 text-meta tabular-nums text-ink-faint">{set} set</span>
                  )}
                </span>
                <span className="min-w-0 text-meta text-ink-muted">{section.blurb}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
