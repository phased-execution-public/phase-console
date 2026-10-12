/**
 * The engine's own words about a plan — the foot of the Source view (7.0,
 * quiet-console phase 10).
 *
 * Three readings every other surface draws second-hand, each the engine's
 * answer to one question, with the command that asks it:
 *
 *   - the board as a terminal prints it (`phase-graph.sh <slug>`);
 *   - the machine block (`--memory-block`) — the one board read the runner
 *     parses, so what an unattended run will see can be checked by eye;
 *   - the session plan (`--session-plan [model]`) — how the engine would batch
 *     what is left into sessions at a model's budget. Unnamed, the model is
 *     the plan's own target model, which is what the server asks for then.
 *
 * Each is a shell-out on the server, so each fold's open state IS its query's
 * `enabled`: opening a plan, or its Source view, spends no engine call, and a
 * fold that is never opened is never asked.
 */

import { useId, useState, type ReactNode } from 'react';
import { useConsoleState } from '@/data/console';
import { useBoardText, useMemoryBlock, useSessionPlan } from '@/data/plans';
import { Button, Empty, Mono, SectionHeading, Spinner } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';
import { NativeSelect } from '@/ui/native-select';

/** The engine's script, as a person types it at the docs root. */
const ENGINE = 'phase-graph.sh';

/** What a read came to — the parts of a query result a fold draws. */
interface EngineRead {
  text: string | null | undefined;
  error: unknown;
  isPending: boolean;
  refetch: () => unknown;
}

/** A refusal in the server's own words; the honest floor when it said nothing. */
const words = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'The engine read failed and said nothing.';

export function EngineFold({ slug, targetModel }: { slug: string; targetModel?: string | undefined }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} data-testid="engine-fold" className="flex min-w-0 flex-col gap-3">
      <SectionHeading id={heading}>From the engine</SectionHeading>
      <BoardFold slug={slug} />
      <MemoryFold slug={slug} />
      <SessionPlanFold slug={slug} targetModel={targetModel} />
    </section>
  );
}

function BoardFold({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const { data, error, isPending, refetch } = useBoardText(slug, open);
  return (
    <EngineReading
      name="Board text"
      command={`${ENGINE} ${slug}`}
      open={open}
      onOpenChange={setOpen}
      read={{ text: data, error, isPending, refetch }}
      empty="The engine printed no board for this plan."
      testId="engine-board"
    />
  );
}

function MemoryFold({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const { data, error, isPending, refetch } = useMemoryBlock(slug, open);
  return (
    <EngineReading
      name="Memory block"
      command={`${ENGINE} ${slug} --memory-block`}
      open={open}
      onOpenChange={setOpen}
      read={{ text: data, error, isPending, refetch }}
      empty="The engine printed no machine block for this plan."
      testId="engine-memory"
    />
  );
}

function SessionPlanFold({ slug, targetModel }: { slug: string; targetModel?: string | undefined }) {
  const [open, setOpen] = useState(false);
  // '' asks for the plan's own model — the server's default, so the cache key
  // stays the one an unnamed ask has always used. Until a model is picked here
  // the fold opens on the person's own (Settings ▸ Appearance, `model`).
  const { data: state } = useConsoleState();
  const [picked, setModel] = useState<string | null>(null);
  const model = picked ?? state?.prefs?.model ?? '';
  const { data, error, isPending, refetch } = useSessionPlan(slug, model || undefined, open);
  const asked = model || targetModel;
  return (
    <EngineReading
      name="Session plan"
      command={`${ENGINE} ${slug} --session-plan${asked ? ` ${asked}` : ''}`}
      open={open}
      onOpenChange={setOpen}
      read={{ text: data === null ? null : data?.raw, error, isPending, refetch }}
      empty="This plan has no phase graph, so there are no sessions to plan."
      testId="engine-session-plan"
      controls={<ModelPicker value={model} onChange={setModel} targetModel={targetModel} />}
    />
  );
}

/**
 * Which model's budget the session plan batches at. The server's own list of
 * the models it will start a phase on — never a copy of one here.
 */
function ModelPicker({
  value,
  onChange,
  targetModel,
}: {
  value: string;
  onChange: (model: string) => void;
  targetModel?: string | undefined;
}) {
  const { data: state } = useConsoleState();
  const id = useId();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <label htmlFor={id} className="text-meta text-ink-muted">
        Model
      </label>
      <NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">
          {targetModel ? `The plan’s target model, ${targetModel}` : 'The plan’s target model'}
        </option>
        {(state?.models ?? []).map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/** One fold: the command it runs, and — only once opened — what the engine answered. */
function EngineReading({
  name,
  command,
  open,
  onOpenChange,
  read,
  empty,
  testId,
  controls,
}: {
  name: string;
  command: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  read: EngineRead;
  /** What an answer with nothing in it means, in words. */
  empty: string;
  testId: string;
  controls?: ReactNode;
}) {
  return (
    <div data-testid={testId} className="min-w-0">
      <Disclosure
        label={
          <>
            {name} <Mono value={command} className="wrap-anywhere" />
          </>
        }
        openLabel={`Hide the ${name.toLowerCase()}`}
        open={open}
        onOpenChange={onOpenChange}
        bodyClassName="flex min-w-0 flex-col items-start gap-2 pt-2 ps-4"
      >
        <Mono value={command} copyable className="max-w-full wrap-anywhere" />
        {controls}
        <Answer read={read} empty={empty} />
      </Disclosure>
    </div>
  );
}

function Answer({ read, empty }: { read: EngineRead; empty: string }) {
  const again = (
    <Button size="sm" variant="ghost" onClick={() => void read.refetch()}>
      Read it again
    </Button>
  );
  if (read.error) return <Empty title={words(read.error)} action={again} />;
  if (read.isPending) return <Spinner label="Asking the engine" />;
  const text = read.text?.replace(/\s+$/, '') ?? '';
  if (!text) return <Empty title={empty} action={again} />;
  return (
    <>
      <CopyButton text={text} label="Copy the output" />
      <pre className="m-0 w-full overflow-x-auto rounded-(--radius) bg-ground-deep p-3 font-mono text-meta leading-relaxed whitespace-pre">
        {text}
      </pre>
    </>
  );
}
