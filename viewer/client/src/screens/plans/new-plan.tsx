/**
 * New plan — the library's one primary act (7.0, quiet-console phase 9).
 *
 * Three ways a plan begins, behind one button so the page names one first
 * move: written with AI (a plan-writing Claude session, `--allow-agent`),
 * scaffolded from the template (`new-plan.sh`, `--allow-writes`), or from the
 * issues it fixes (the Issues desk). A way this console cannot take is still
 * listed, disabled, saying the capability it lacks — a menu that silently
 * lost an item would read as a console that never had it.
 */

import { Suspense, lazy, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown';
import { fromIssuesHref } from './from-issues';
import { ScaffoldPlanDialog } from './write-menu';

/** The wizard's dialog — its own chunk, fetched when somebody asks for it. */
const NewPlanWizard = lazy(() => import('./wizard'));

/** One way in, with what it does — or why this console cannot. */
function Way({ title, said, refused }: { title: string; said: string; refused?: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-body text-ink">{title}</span>
      <span className="text-meta text-ink-muted">{refused ?? said}</span>
    </span>
  );
}

export function NewPlanMenu({ allowAgent, allowWrites }: { allowAgent: boolean; allowWrites: boolean }) {
  const [open, setOpen] = useState<'wizard' | 'scaffold' | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="primary" data-testid="new-plan">
            New plan
            <ChevronDown size={14} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem
            disabled={!allowAgent}
            onSelect={() => setOpen('wizard')}
            data-testid="new-plan-wizard"
          >
            <Way
              title="Write it with AI"
              said="A Claude session drafts the phases with you."
              {...(allowAgent ? {} : { refused: 'This console opens no sessions (no --allow-agent).' })}
            />
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!allowWrites}
            onSelect={() => setOpen('scaffold')}
            data-testid="new-plan-scaffold"
          >
            <Way
              title="Scaffold from the template"
              said="new-plan.sh writes the file; the phases are yours."
              {...(allowWrites ? {} : { refused: 'This console writes nothing (no --allow-writes).' })}
            />
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={fromIssuesHref()} data-testid="new-plan-from-issues">
              <Way
                title="Plan from issues"
                said="Pick the issues on the desk; a plan is written to fix them."
              />
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open === 'wizard' && (
        <Suspense fallback={null}>
          <NewPlanWizard onClose={() => setOpen(null)} />
        </Suspense>
      )}
      {open === 'scaffold' && <ScaffoldPlanDialog onClose={() => setOpen(null)} />}
    </>
  );
}
