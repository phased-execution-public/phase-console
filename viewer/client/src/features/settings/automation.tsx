/**
 * Automation — what the autopilot may do by itself, and how much of it.
 *
 * Three cards, in the order the decisions nest. **Defaults** are the opening
 * values every launch surface starts from (`RunSetup` in `defaults` mode — the
 * same component, words and order as the launch dialog, so "the default" and
 * "this launch" are visibly one form rather than two that happen to agree).
 * **The ladder** is what happens when a phase stops: how far the console climbs
 * on its own, what it may spend doing so, and when a session counts as stalled.
 * **The session hook** is what lets it see the sessions it shares the
 * repository with — the input the other two act on.
 *
 * **Asking less** closes the section with the reading none of the four can
 * give alone: how often this console stops and waits for a person. It is a
 * read-out — every setting it names has exactly one control, above — and it is
 * the group the automation-posture sweep lands its new preferences in.
 *
 * Every knob here governs the SERVER process and is rendered from
 * `/api/state`, never from a local copy of the intention. That is the line
 * between this section and Appearance, whose preferences live in this browser.
 */

import { SettingsSectionFrame, sectionFor } from './nav';
import { AutomationCard } from './automation-card';
import { LadderCard } from './ladder';
import { ScheduleCard } from './schedule-card';
import { SessionHookCard } from './hooks';
import { PostureCard } from './posture';

export function AutomationSection() {
  const section = sectionFor('automation')!;
  return (
    <SettingsSectionFrame section={section}>
      <AutomationCard />
      <LadderCard />
      {/* After the ladder and before the hook: the ladder is what happens when
          a phase stops, the schedule is whether one may start at all, and the
          hook is the input both act on. */}
      <ScheduleCard />
      <SessionHookCard />
      {/* Last, because it is a reading of everything above it. */}
      <PostureCard />
    </SettingsSectionFrame>
  );
}
