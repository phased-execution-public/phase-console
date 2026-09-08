/**
 * Stage 2 — How it runs.
 *
 * The model and its per-phase overrides, the guard rails and the wall under
 * them, the branch and what happens to it, who pays and how much room they
 * have, what every session is given (skills, MCP servers), who reviews the
 * work, and QA. Each block is a section with an eyebrow so the stage reads
 * as a list of decisions rather than a column of fields; a block whose
 * fields the mode does not show renders nothing, eyebrow included.
 */

import { SectionHeading } from '@/components/ui';
import { useSetupForm } from './form-context';
import {
  AccountSection,
  BranchSection,
  McpSection,
  ModelSection,
  PerPhaseSection,
  PermissionsSection,
  PromptSection,
  QaSection,
  ReviewersSection,
  SkillsSection,
} from './sections';

function Block({ heading, on, children }: { heading: string; on: boolean; children: React.ReactNode }) {
  if (!on) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionHeading as="h3" tone="muted">
        {heading}
      </SectionHeading>
      {children}
    </section>
  );
}

export function HowItRuns() {
  const f = useSetupForm();
  const on = f.on;
  return (
    <div className="flex flex-col gap-6">
      {/* Each eyebrow is a phrase no control is labelled with, so a query
          for a control's name — a test's or a screen reader's — answers the
          control and never the heading over it. */}
      <Block heading="Model and effort" on={on('model') || on('effort') || on('phaseOptions')}>
        <ModelSection />
        <PerPhaseSection />
      </Block>
      <Block heading="Guard rails" on={on('permissionProfile')}>
        <PermissionsSection />
      </Block>
      <Block heading="Branch and checkout" on={on('gitMode')}>
        <BranchSection />
      </Block>
      <Block heading="Who pays" on={on('accountId')}>
        <AccountSection />
      </Block>
      <Block
        heading="What every session is given"
        on={on('skills') || on('attachDefaultSkills') || on('mcpServers') || on('mcpPolicy')}
      >
        <SkillsSection />
        <McpSection />
      </Block>
      <Block heading="Reviewers" on={on('reviewEachPhase') || on('ultracode') || on('ultraReview')}>
        <ReviewersSection />
      </Block>
      <Block heading="The QA gate" on={on('qa') || on('qaModel') || on('qaEffort') || on('qaMaxRounds')}>
        <QaSection />
      </Block>
      <Block heading="Opening message" on={on('prompt')}>
        <PromptSection />
      </Block>
    </div>
  );
}
