/**
 * Settings — one place for everything this console can be told (7.0,
 * quiet-console phase 21).
 *
 * ```
 * Automation
 * What every launch opens on, how far the console repairs by itself, …
 * [Find a setting      ]   Launch defaults
 * Essentials               …
 * Appearance               The ladder
 * Automation               Repair attempts per phase          [ 3 ]
 * …                        …
 * Everything
 * ```
 *
 * `#/settings` is the list of sections, each with the question it answers;
 * `#/settings/<section>` is one, with the rail beside it from 1200 up and the
 * way back to the list below that — one navigation on screen at a time. The
 * search is on every address (`?q=`): it answers with the sections that hold
 * the words AND the keys themselves, each with its own control, so a setting
 * is found and changed in one place. On Everything it narrows the keys in
 * place instead.
 *
 * The values, their defaults and where each came from are the server's
 * settings schema (`GET /api/prefs/schema`); a save moves the word beside the
 * control, which is how a save says it landed. Every section is 7.0's since
 * quiet-console phase 23; the heavy ones are reached when opened.
 */

import { Suspense, lazy, useMemo, type ElementType } from 'react';
import { useConsoleState, usePrefsSchema, type PrefSchemaRow } from '@/data/console';
import { navigate, settingsHref, type Route } from '@/shell/routes';
import { Button, Empty, Page, Skeleton } from '@/ui';
import { ToolbarSearch } from '@/ui/toolbar';
import { AppearanceSection } from './appearance';
import { AutomationSection } from './automation';
import { EssentialsSection } from './essentials';
import { EverythingSection, KeyRow, groupBySection } from './everything';
import { SettingsIndexList, SettingsRail, sectionOfGroup, sectionTitle, settingsSectionOf } from './nav';
import { searchSettings } from './search';
import { SettingsGroup } from './setting';

/**
 * The sections reached when opened: their devices, meters, editors and dialogs
 * are not what a person who opened Settings to flip a theme should download.
 * MCP servers and Permissions keep chunks of their own by basename (`mcp-*`,
 * `permissions-*`), and License is never in the Settings chunk — `check-dist`
 * holds all three.
 */
const NotificationsSection = lazy(() =>
  import('./notifications').then((m) => ({ default: m.NotificationsSection })),
);
const AccountsSection = lazy(() => import('./accounts').then((m) => ({ default: m.AccountsSection })));
const McpServersSection = lazy(() => import('./mcp').then((m) => ({ default: m.McpServersSection })));
const PermissionSettingsSection = lazy(() =>
  import('./permissions').then((m) => ({ default: m.PermissionSettingsSection })),
);
const InstanceSection = lazy(() => import('./instance').then((m) => ({ default: m.InstanceSection })));
const HooksSection = lazy(() => import('./hooks').then((m) => ({ default: m.HooksSection })));

/** Every section's body, by id. */
const BODIES: Readonly<Record<string, ElementType<{ query: string }>>> = {
  essentials: EssentialsSection,
  appearance: AppearanceSection,
  automation: AutomationSection,
  notifications: NotificationsSection,
  accounts: AccountsSection,
  mcp: McpServersSection,
  hooks: HooksSection,
  permissions: PermissionSettingsSection,
  instance: InstanceSection,
  everything: EverythingSection,
};

const isSet = (row: PrefSchemaRow) => row.source !== 'default';

/** The list's one sentence: the console's name, and how much of it is not a shipped default. */
function situation(name: string, rows: readonly PrefSchemaRow[] | undefined): string {
  if (!rows) return `The settings of ${name}.`;
  const here = rows.filter((row) => row.source === 'instance' || row.source === 'config').length;
  const profile = rows.filter((row) => row.source === 'profile').length;
  const keys = (n: number) => `${n} ${n === 1 ? 'key' : 'keys'}`;
  if (!here && !profile) return `${name} runs on the shipped defaults: no key is set.`;
  const parts = [
    here ? `${keys(here)} set here` : '',
    profile ? `${keys(profile)} from the machine profile` : '',
  ]
    .filter(Boolean)
    .join(' and ');
  return `${name} runs with ${parts}; every other key is its shipped default.`;
}

export default function SettingsPlace({ route }: { route: Route }) {
  const section = settingsSectionOf(route.segments[1]);
  const query = route.query.q ?? '';
  const searching = query.trim() !== '' && section?.id !== 'everything';
  const schema = usePrefsSchema();
  const { data: state } = useConsoleState();
  const rows = schema.data?.rows;

  const search = (next: string) =>
    navigate(settingsHref(section?.id, next ? { q: next } : undefined), { replace: true });
  const searchBox = (
    <ToolbarSearch value={query} onChange={search} label="Search the settings" placeholder="Find a setting" />
  );

  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const row of rows ?? [])
      if (isSet(row)) by[sectionOfGroup(row.group)] = (by[sectionOfGroup(row.group)] ?? 0) + 1;
    return by;
  }, [rows]);

  if (!section) {
    return (
      <Page
        title="Settings"
        lead={situation(state?.instance?.name ?? 'This console', rows)}
        data-testid="settings-page"
        data-section="index"
      >
        <div className="flex min-w-0 max-w-(--measure) flex-col gap-5">
          {searchBox}
          {searching ? <SearchResults query={query} /> : <SettingsIndexList counts={counts} />}
        </div>
      </Page>
    );
  }

  const Body = BODIES[section.id];
  return (
    <Page title={section.title} lead={section.blurb} data-testid="settings-page" data-section={section.id}>
      <div className="grid min-w-0 gap-x-10 gap-y-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <a
            href={settingsHref()}
            className="tap-line self-start text-body text-ink-muted underline decoration-ink-faint underline-offset-2 hover:text-ink lg:hidden"
          >
            All settings
          </a>
          {searchBox}
          <SettingsRail current={section.id} className="hidden lg:block" />
        </div>
        <div className="min-w-0">
          {searching ? (
            <SearchResults query={query} />
          ) : (
            <Suspense fallback={<Opening />}>{Body && <Body query={query} />}</Suspense>
          )}
        </div>
      </div>
    </Page>
  );
}

function Opening() {
  return (
    <div className="flex min-w-0 flex-col gap-3" aria-busy="true" aria-label="Opening the section">
      <Skeleton className="h-6 max-w-xs" />
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
    </div>
  );
}

/** At most this many keys answer a search on the page; the rest are one link away in Everything. */
const KEYS_SHOWN = 30;

/**
 * What the search found: the sections whose words match, then the keys, each
 * with its own control — so a key found is a key changed, without a second
 * page.
 */
function SearchResults({ query }: { query: string }) {
  const schema = usePrefsSchema();
  const found = searchSettings(query, schema.data?.rows ?? []);
  const shown = found.keys.slice(0, KEYS_SHOWN);
  const nothing = !found.sections.length && !found.keys.length && !schema.isPending;
  const said = `${found.sections.length} ${found.sections.length === 1 ? 'section' : 'sections'} and ${
    found.keys.length
  } ${found.keys.length === 1 ? 'key' : 'keys'} match`;

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="settings-results">
      <p role="status" className="text-meta text-ink-muted">
        {schema.isPending ? 'Reading the keys.' : nothing ? '' : said}
      </p>
      {nothing && (
        <Empty
          title={`Nothing in Settings matches “${query.trim()}”.`}
          action={
            <Button size="sm" asChild>
              <a href={settingsHref('everything')}>Open every key</a>
            </Button>
          }
        />
      )}
      {found.sections.length > 0 && (
        <nav aria-label="Sections that match" className="min-w-0">
          <ul className="flex min-w-0 flex-col">
            {found.sections.map((section) => (
              <li key={section.id} className="min-w-0">
                <a
                  href={settingsHref(section.id)}
                  className="group flex min-w-0 flex-col justify-center gap-0.5 py-2 [@media(hover:none)]:min-h-(--tap-min)"
                >
                  <span className="text-body font-medium text-ink decoration-ink-faint underline-offset-2 group-hover:underline">
                    {section.title}
                  </span>
                  <span className="text-meta text-ink-muted">{section.blurb}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {schema.isPending && <Skeleton className="h-16" aria-busy="true" />}
      {shown.length > 0 && (
        <div className="flex min-w-0 flex-col gap-6">
          {groupBySection(shown).map((group) => (
            <SettingsGroup
              key={group.id}
              id={`found-${group.id}`}
              title={sectionTitle(group.id)}
              aside={
                group.id === 'everything' ? undefined : (
                  <a
                    href={settingsHref(group.id)}
                    className="tap-line text-meta text-ink-muted underline decoration-ink-faint underline-offset-2 hover:text-ink"
                  >
                    Open {sectionTitle(group.id)}
                  </a>
                )
              }
            >
              {group.rows.map((row) => (
                <KeyRow key={row.key} row={row} files={schema.data?.files} />
              ))}
            </SettingsGroup>
          ))}
        </div>
      )}
      {found.keys.length > shown.length && (
        <p className="text-meta text-ink-muted">
          {found.keys.length - shown.length} more{' '}
          {found.keys.length - shown.length === 1 ? 'key matches' : 'keys match'}.{' '}
          <a
            href={settingsHref('everything', { q: query })}
            className="tap-line text-ink underline decoration-ink-faint underline-offset-2"
          >
            See every match in Everything
          </a>
        </p>
      )}
    </div>
  );
}
