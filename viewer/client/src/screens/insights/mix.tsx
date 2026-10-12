/**
 * On what — which repositories the work touches, which skills it uses and
 * which models it is sized for.
 *
 * Three ranked figures rather than three numbers, because each is a
 * distribution whose SHAPE is the fact: "9 repos" says nothing, "two thirds of
 * every phase is in one repo" says concurrency is not available here (same
 * repo, serialized). Skills and models read the same way: a plan whose phases
 * name no skill is one nobody told what to use, and a portfolio spread over
 * four models is four different session budgets.
 *
 * Each list is a handoff or plan field, so a missing one is a gap in the
 * writing rather than a zero — the empty lines say which.
 */

import type { Portfolio } from '@/data/api';
import { Mono } from '@/ui';
import { BarList } from '@/ui/figures/lazy';
import { FigureBlock } from './parts';

export function MixPanel({ stats }: { stats: Portfolio }) {
  return (
    <div className="grid min-w-0 gap-6 md:grid-cols-2 xl:grid-cols-3" data-testid="insights-mix">
      <FigureBlock caption="Repositories touched, phases by scope">
        <BarList
          label="repos"
          items={stats.repos.map((row) => ({ name: row.repo, value: row.count }))}
          empty={
            <>
              No plan declares a Repos column, so every phase reads as <Mono value="all" /> and runs alone.
            </>
          }
        />
      </FigureBlock>
      <FigureBlock caption="Skills used, from the handoffs">
        <BarList
          label="skills"
          items={stats.skills.map((row) => ({ name: row.skill, value: row.count }))}
          empty="No handoff records a skill yet."
        />
      </FigureBlock>
      <FigureBlock caption="Target models, what each plan is sized for">
        <BarList
          label="models"
          items={stats.models.map((row) => ({ name: row.model, value: row.count }))}
          empty="No plan names a target model in its session budget."
        />
      </FigureBlock>
    </div>
  );
}
