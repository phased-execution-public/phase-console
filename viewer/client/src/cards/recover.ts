/**
 * The run-verb half of a recovery action, performed — with the one refusal
 * that matters handled the way `start-recovery.ts` taught: a 409 carrying a
 * sessionId means an agent recovery already holds this phase, and the useful
 * response is to go look at it, not to error.
 *
 * No query invalidation on success: every one of these verbs makes the server
 * emit `run:state`, and the SSE plane is what keeps the pages honest — the
 * same contract the old one-off buttons relied on. The one performer every
 * recovery surface presses through (`screens/launch/single-source.test.ts`
 * holds the run verbs to this file); in `cards/` since quiet-console phase 5.
 */

import type { RunRecoverVerb } from '@/lib/run-recover-verbs';
import { ApiError, api, type RetryEdits, type RunEnvelope } from '@/data/api';
import { press } from '@/data/press';
import { navigate } from '@/shell/router';
import { sessionsHref } from '@/shell/routes';
import { toast } from '@/ui';

export type { RunRecoverVerb };

const CONFIRMATIONS: Record<RunRecoverVerb, string> = {
  'auto-recover': '', // recoverPlan answers with its own steps — toasted below.
  recheck: 'Re-checking — board, verification and validate.sh.',
  closeout: "Resuming the phase's session to finish the closeout.",
  resume: "Resuming the phase's session with your instruction.",
  delegate:
    "Delegated — the phase's session resumes with the acts as its own, and a ruling records that you handed them over.",
  'errand-answered': 'Answered — the phase re-boards with your note.',
  retry: 'Cleared the failure — the run continues from here.',
  'retry-edits': 'Re-boarding with your edits — they apply to this attempt only.',
  skip: 'Skipped. The board still reads it as not done.',
  'mcp-continue': 'Carrying on without the servers that would not connect.',
};

/**
 * A press on the phase's own session whose answer says it boarded a FRESH one
 * (`launched.session === null`): the session was not worth resuming, so the
 * resume brief carries the words instead (control-tower phase 53, #54, #55).
 */
const BOARDED_FRESH: Partial<Record<RunRecoverVerb, string>> = {
  closeout: 'Boarded fresh with the resume brief to finish the closeout',
  resume: 'Boarded fresh with the resume brief and your instruction',
  delegate: 'Delegated — boarded fresh with the resume brief and your words',
};

/** What to say once the press answered: what it launched, in the verb's words. */
function confirmation(verb: RunRecoverVerb, answer: RunEnvelope | undefined): string {
  const launched = answer?.launched;
  const fresh = launched && launched.session === null ? BOARDED_FRESH[verb] : undefined;
  if (!fresh) return CONFIRMATIONS[verb];
  return launched?.why ? `${fresh} — its session was not resumed: ${launched.why}.` : `${fresh}.`;
}

/** The request a verb makes, as the run's own route spells it. */
function callFor(
  verb: Exclude<RunRecoverVerb, 'auto-recover'>,
  { slug, phase }: { slug: string; phase?: number },
  opts: { instruction?: string; edits?: RetryEdits },
): () => Promise<RunEnvelope | unknown> {
  if (verb === 'mcp-continue') return () => api.runMcpContinue(slug);
  if (phase == null) throw new Error('this action needs a phase');
  if (verb === 'recheck') return () => api.runRecheck(slug, phase);
  if (verb === 'closeout') return () => api.runCloseout(slug, phase);
  if (verb === 'resume') return () => api.runResumePhase(slug, phase, opts.instruction ?? '');
  if (verb === 'delegate') return () => api.runDelegate(slug, phase, opts.instruction ?? '');
  if (verb === 'errand-answered') return () => api.runErrandAnswered(slug, phase, opts.instruction ?? '');
  if (verb === 'retry') return () => api.runRetry(slug, phase);
  // The same verb with a payload. One call site, so the two cannot drift into
  // meaning different things about what a retry resets.
  if (verb === 'retry-edits') return () => api.runRetry(slug, phase, opts.edits);
  return () => api.runSkip(slug, phase);
}

/**
 * Perform one recovery verb through the owner door (`data/press.ts`): a press
 * the owner must confirm comes back ASKED, and is said so — never read as
 * done. Resolves whether the verb did what it says.
 */
export async function runRecoverVerb(
  verb: RunRecoverVerb,
  target: { slug: string; phase?: number },
  opts: { instruction?: string; edits?: RetryEdits } = {},
): Promise<boolean> {
  try {
    if (verb === 'auto-recover') {
      // The one verb that reports its own story: every step the server took,
      // then the outcome in its own tone.
      const pressed = await press(() => api.runRecover(target.slug));
      if (pressed.state === 'asked') {
        toast(pressed.words, 'info', 8000);
        return false;
      }
      const report = pressed.result;
      for (const step of report.steps) toast(step, 'ok');
      toast(report.detail, report.outcome === 'errand' ? 'warn' : 'ok');
      return report.outcome !== 'errand';
    }
    const pressed = await press(callFor(verb, target, opts));
    if (pressed.state === 'asked') {
      toast(pressed.words, 'info', 8000);
      return false;
    }
    toast(confirmation(verb, pressed.result as RunEnvelope | undefined), 'ok');
    return true;
  } catch (error) {
    const running = liveSessionFrom(error);
    if (running) {
      toast('A recovery session already holds this phase — opening it.', 'warn');
      navigate(sessionsHref(running));
      return false;
    }
    toast((error as Error).message, 'error');
    return false;
  }
}

/** The session id a busy-refusal carries, if this was one. */
function liveSessionFrom(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const id = (error.body as { sessionId?: unknown } | null)?.sessionId;
  return typeof id === 'string' && id ? id : undefined;
}
