/**
 * Settings ▸ Notifications — what the console announces, where each kind
 * lands, when a person's turn is said again, and the devices and webhooks it
 * reaches (7.0, quiet-console phase 22).
 *
 * ```
 * Everything already announced is in the bell — Open the announcements.
 * What is announced          one switch per kind, and where it lands
 * Reminders for your turns   the series, and each device's quiet window
 * This browser               in this tab · on this device
 * Devices                    every subscribed device: what it hears, its quiet hours, a test
 * What has been reaching you the last announcements' handovers, and the notify command
 * Webhooks                   the same announcements to a channel
 * ```
 *
 * The order is the order of the question: what is said at all, then the two
 * places that narrow it — a device and a webhook — each of which can only
 * narrow what the first allows. What has already been said is not a setting;
 * it is the bell, and the lead points there first.
 */

import { DEFAULT_HEAD, PANEL_KEYS, bellHref, settingsHref } from '@/shell/routes';
import { DeliveryGroup, DevicesGroup, ThisBrowserGroup } from './devices';
import { RemindersGroup } from './reminders';
import { RoutingGroup } from './routing';
import { WebhooksGroup } from './webhooks';

const link = 'tap-line text-ink underline decoration-ink-faint underline-offset-2 hover:decoration-ink';

export function NotificationsSection() {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="settings-notifications">
      <p className="max-w-(--measure) text-body text-ink-muted" data-testid="announcements-pointer">
        Everything the console has announced — the ones that arrived while nothing was open included — is in
        the bell.{' '}
        <a href={bellHref(DEFAULT_HEAD, PANEL_KEYS.announcements)} className={link}>
          Open the announcements
        </a>
        . A device’s quiet hours hold a push back on that device and never the record. The quiet hours that
        decide when a phase may board are in{' '}
        <a href={settingsHref('automation')} className={link}>
          Automation
        </a>
        .
      </p>
      <div className="flex min-w-0 flex-col gap-6">
        <RoutingGroup />
        <RemindersGroup />
        <ThisBrowserGroup />
        <DevicesGroup />
        <DeliveryGroup />
        <WebhooksGroup />
      </div>
    </div>
  );
}
