/**
 * A boot prompt, the end-of-phase banner or a QA brief, behind one press.
 *
 * Each is an ENGINE SHELL-OUT on the server (`phase-graph.sh --boot-prompt`,
 * `next-phase-prompt.sh`, `phase-graph.sh --qa-prompt`), so the text is fetched
 * only once the fold is open: the `Disclosure` unmounts its body while folded,
 * and the body is what asks. A plan with four ready phases opens without four
 * engine runs (`first-paint.test.tsx`, "opening a plan spends no engine
 * invocations").
 *
 * A caution the reader needs BEFORE copying — another session on the phase,
 * dependencies not met — is drawn outside the fold: hiding it behind the same
 * press would show it only to someone who had already decided to copy.
 */

import { useNextPrompt, usePhasePrompt, useQaPrompt } from '@/data/plans';
import { Banner, Spinner, type Severity } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { Disclosure } from '@/ui/disclosure';

export type PromptKind = 'boot' | 'next' | 'qa';

/** What the fold holds, in the words its controls use: a session is given a prompt, a reviewer a brief. */
const NOUN: Record<PromptKind, string> = { boot: 'prompt', next: 'prompt', qa: 'brief' };

export function PromptFold({
  slug,
  phase,
  kind = 'boot',
  title,
  note,
  banner,
  defaultOpen = false,
}: {
  slug: string;
  phase: number;
  kind?: PromptKind;
  /** What the fold holds, named — "Boot prompt for phase 4". */
  title: string;
  /** What it carries, in a few words, beside the title. */
  note?: string;
  banner?: { severity: Severity; text: string } | undefined;
  defaultOpen?: boolean;
}) {
  const noun = NOUN[kind];
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={`prompt-${kind}-${phase}`}>
      <p className="text-body text-ink">
        {title}
        {note && <span className="ms-2 text-meta text-ink-muted">{note}</span>}
      </p>
      {banner && <Banner severity={banner.severity}>{banner.text}</Banner>}
      <Disclosure label={`Show the ${noun}`} openLabel={`Hide the ${noun}`} defaultOpen={defaultOpen}>
        <PromptBody slug={slug} phase={phase} kind={kind} />
      </Disclosure>
    </div>
  );
}

/** Mounted only while open — mounting is the request. */
function PromptBody({ slug, phase, kind }: { slug: string; phase: number; kind: PromptKind }) {
  const boot = usePhasePrompt(slug, phase, kind === 'boot');
  const next = useNextPrompt(slug, phase, kind === 'next');
  const qa = useQaPrompt(slug, phase, kind === 'qa');
  const { data, error, isPending } = kind === 'boot' ? boot : kind === 'next' ? next : qa;
  const text = data == null ? undefined : String(data).trim();
  if (error) return <Banner severity="error">{(error as Error).message || String(error)}</Banner>;
  if (isPending || text == null) return <Spinner label="Reading the engine" />;
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <CopyButton text={text} label={`Copy the ${NOUN[kind]}`} />
      <pre className="m-0 max-h-96 w-full overflow-auto overscroll-contain rounded-(--radius) bg-ground-deep p-3 font-mono text-meta leading-relaxed whitespace-pre">
        {text}
      </pre>
    </div>
  );
}
