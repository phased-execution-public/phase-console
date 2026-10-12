/**
 * Settings ▸ Automation, the start ceiling (7.0, quiet-console phase 21): how
 * many sessions, and how many dollars of them, the console may start by itself
 * in any one hour (`server/start-ceiling.ts`).
 *
 * ```
 * The start ceiling
 * Automatic starts per hour                            [ 40 ] starts
 * Session spend per hour                              [ 250 ] dollars
 * ```
 *
 * Your own Start, Retry and Continue are never counted, and 0 on either is no
 * limit. The MCP health probe has an hourly budget of its own and is not
 * counted here either (control-tower phase 100).
 */

import { LADDER_PREF_DEFAULTS } from '@/data/api';
import { NumberSetting, SettingsGroup } from './setting';

export function CeilingGroup() {
  return (
    <SettingsGroup
      id="automation-ceiling"
      title="The start ceiling"
      lead="Counted over a sliding hour. Past either number the next automatic start is refused and announced once; your own Start, Retry and Continue are never counted."
    >
      <NumberSetting
        pref="ceilingStartsPerHour"
        label="Automatic starts per hour"
        unit="starts"
        integer
        min={0}
        hint={`Every session this console starts by itself: a boot re-adoption, a wait clock, a converge relaunch, the reviewer. 0 is no limit (shipped: ${LADDER_PREF_DEFAULTS.ceilingStartsPerHour}).`}
      />
      <NumberSetting
        pref="ceilingUsdPerHour"
        label="Session spend per hour"
        unit="dollars"
        min={0}
        step={10}
        hint={`What the sessions that ended in the last hour reported costing, across every run; past it the next automatic start is refused until the hour rolls on. 0 is no limit (shipped: $${LADDER_PREF_DEFAULTS.ceilingUsdPerHour}).`}
      />
    </SettingsGroup>
  );
}
