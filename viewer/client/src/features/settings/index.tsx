/**
 * Settings — the destination.
 *
 * `#/settings` is the section index; `#/settings/:section` is one section.
 * 2.x rendered all fifteen cards in one scroll with no address for any of
 * them, so "turn the repository guard off" could only be given as *scroll until
 * you find Automation*, and nothing — an errand, a guide page, a push payload —
 * could link to a setting.
 *
 * The four rules that shape this file:
 *
 * 1. **An unknown section is the index, not a blank frame.** `SECTION_IDS` is
 *    the accepted set; anything else falls through to the list, which is the
 *    `ROUTE_HEADS` discipline one level down. A typo in a bookmark lands
 *    somewhere useful.
 * 2. **A RETIRED section is a redirect, not a fallthrough.** Phase 7 renamed
 *    three; `LEGACY_SETTINGS_SECTIONS` sends the old address to the new one
 *    (`app/routes.ts`), so a push card minted last month still opens the right
 *    page and the address bar then says where the page actually is.
 * 3. **The nav is a `<nav>` of real links** (`nav.tsx`), so every section can be
 *    opened in a new tab and copied as a URL. That is the whole point of giving
 *    each one an address.
 * 4. **Sections are lazy where they are heavy.** Only `mcp` and `permissions`
 *    carry enough of their own (a catalog with a search and an add dialog; a
 *    rule editor) to be worth their own chunk; the rest are cards this chunk
 *    already needs. Settings is a DESTINATION, so this chunk is precached —
 *    everything imported statically here is downloaded on install by everyone.
 */

import { Suspense, lazy } from 'react';
import { cn } from '@/lib/cn';
import { PANEL_KEYS, bellHref, settingsHref } from '@/app/routes';
import type { ViewProps } from '@/app/router';
import { Page } from '@/components/page';
import { Spinner } from '@/components/ui';
import { SETTINGS_SECTIONS, SettingsNav, SettingsSectionFrame, sectionFor } from './nav';
import { EssentialsSection } from './essentials';
import { AppearanceSection } from './appearance';
import { AutomationSection } from './automation';
import { InstanceSection } from './instance';
import { AccountsCard } from './accounts';
import { AnnouncementsPointer, RoutingCard } from './routing';
import { DevicesCard } from './devices';
import { WebhooksCard } from './webhooks';

// The two heavy halves. The permissions editor is a form over a rule grammar;
// the MCP section carries a catalog, a search and an add dialog. Neither is on
// the path of a person who opened Settings to flip a theme.
const McpSection = lazy(() => import('./mcp').then((m) => ({ default: m.McpSection })));
const PermissionsSection = lazy(() =>
  import('./permissions').then((m) => ({ default: m.PermissionsSection })),
);

export default function SettingsView({ route }: ViewProps) {
  const requested = route.segments[1];
  const section = sectionFor(requested);

  return (
    <Page title="Settings" subtitle="Phase Console">
      {/* The rail exists only BESIDE a section. On the index the list IS the
          page, so a rail would be the same eight links twice — which is not
          only redundant, it is ambiguous: two navigations with one accessible
          name is what a screen reader (and `getByRole`) reads as a broken
          landmark, and it is how the section test caught this. */}
      <div className={cn('grid min-w-0 gap-4', section && 'lg:grid-cols-[220px_minmax(0,1fr)]')}>
        {section && <SettingsNav current={section.id} className="hidden lg:block" />}

        <div className="min-w-0">
          {section ? (
            <>
              {/* Where you are, and the way back — a phone has no rail. */}
              <a
                href={settingsHref()}
                className="mb-3 inline-flex min-h-(--tap-min) items-center text-sm text-ink-muted hover:text-ink lg:hidden"
              >
                ← All settings
              </a>
              <Suspense
                fallback={
                  <div className="grid place-items-center py-16">
                    <Spinner />
                  </div>
                }
              >
                <SectionBody id={section.id} route={route} />
              </Suspense>
            </>
          ) : (
            <SettingsIndex />
          )}
        </div>
      </div>
    </Page>
  );
}

/**
 * The index: every section, with the question it answers, in the order the
 * questions arrive.
 *
 * The order is load-bearing and the lead says so, because a list of eight
 * nouns gives a reader no way to guess which one holds their answer. Reading
 * top to bottom is the intended path: what this console is, then how it looks,
 * then what it does by itself, then what it says — and only then the four
 * surfaces that exist because work runs here unattended.
 */
function SettingsIndex() {
  return (
    <div className="min-w-0">
      <p className="mb-3 text-sm text-ink-muted">
        {SETTINGS_SECTIONS.length} sections, ordered from the ones everybody needs to the ones only an
        unattended console does. Each has its own address — link to one from a handoff, a guide page or a
        note.
      </p>
      <SettingsNav variant="index" />
    </div>
  );
}

function SectionBody({ id, route }: { id: string; route: ViewProps['route'] }) {
  switch (id) {
    case 'essentials':
      return <EssentialsSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'automation':
      return <AutomationSection />;
    case 'notifications':
      return <NotificationsSection />;
    case 'accounts':
      return <AccountsSection />;
    case 'mcp':
      return <McpSection route={route} />;
    case 'permissions':
      return <PermissionsSection />;
    case 'instance':
      return <InstanceSection />;
    default:
      return <SettingsIndex />;
  }
}

/* ---------------- the composed sections ---------------- */

function AccountsSection() {
  return (
    <SettingsSectionFrame section={sectionFor('accounts')!}>
      <AccountsCard />
    </SettingsSectionFrame>
  );
}

/**
 * Notifications: what is said and where it lands, then the two places that
 * narrow it — in that order, because the first governs the console and the
 * other two only decide where an already-allowed announcement goes.
 *
 * Reversing them puts the narrower switch above the one that overrides it,
 * which is the confusion the 2.x single card created: its "what to send" list
 * looked global and was per-device, so it silently did nothing on a console
 * with no device. The routing card fixes the deeper half of that — it now says,
 * per kind, which of the three legs it actually reaches.
 */
function NotificationsSection() {
  return (
    <SettingsSectionFrame section={sectionFor('notifications')!}>
      {/* Built, never spelled: the hand-written form carried an HTML entity
          (`&amp;`) inside an href, which the browser un-escapes but nothing
          else does — a URL that only works because it is being read by a
          parser that forgives it. */}
      <AnnouncementsPointer href={bellHref('now', PANEL_KEYS.announcements)} />
      <RoutingCard />
      <DevicesCard />
      <WebhooksCard />
    </SettingsSectionFrame>
  );
}
