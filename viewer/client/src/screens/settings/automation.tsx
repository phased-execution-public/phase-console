/**
 * Settings ▸ Automation (7.0, quiet-console phase 21) — what the console may
 * do by itself, and how much of it, in the order the decisions nest:
 *
 *   1. what every launch opens on — the launch form itself, inline, in its
 *      `defaults` mode, so "the default" and "this launch" are one form —
 *      and the checkouts, watches and the check around it;
 *   2. what happens when a phase stops: the ladder, its caps, the stalls;
 *   3. how fast automatic starts may come (the ceiling);
 *   4. the answers the console gives by itself (policy, relay rules);
 *   5. whether a phase may start at all (the schedule) and in what order
 *      (the queue);
 *   6. the input every one of those acts on (the session hook);
 *   7. the supervisor's own (Pro);
 *   8. last, a reading of everything above: how often it stops for a person.
 *
 * Every key here has exactly one control in this section — held by
 * `automation-coverage.test.tsx` — and every one governs the SERVER process,
 * read back from it, never from a local copy of the intention.
 */

import { AutomationDefaults } from './automation-card';
import { CeilingGroup } from './ceiling';
import { HooksGroup } from './hooks';
import { LadderGroups } from './ladder';
import { PolicyGroup } from './policy';
import { PostureGroup } from './posture';
import { QueueGroup } from './queue';
import { ScheduleGroup } from './schedule';

export function AutomationSection() {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="settings-automation">
      <AutomationDefaults />
      <LadderGroups />
      <CeilingGroup />
      <PolicyGroup />
      <ScheduleGroup />
      <QueueGroup />
      <HooksGroup />
      <PostureGroup />
    </div>
  );
}
