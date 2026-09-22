/**
 * The poll-loop guard: which tool calls are status checks, and when a run of
 * them has become a loop (autopilot-token-drain phase 2).
 *
 * Run `deadaff9`'s phase 3 spent 311 of its 434 tool calls on status checks —
 * `ListAgents` and `date`, one every four seconds, at 790k–947k of context —
 * and 270M of its 342M context tokens with them: every call re-reads the whole
 * context, so a status check costs what an edit costs. Phase 1 gave every
 * surface one wait procedure; this module is the mechanical backstop behind it.
 *
 * The rule, measured over 357 transcripts and 36,012 tool calls (it fires on
 * exactly three sessions, all real loops, and on nothing else):
 *
 * - A STATUS CHECK is `ListAgents`, `BashOutput`, a `TaskOutput` that does not
 *   block, or a `Bash` command that is either made only of clock and process
 *   probes and reads of a log or task output (`isProbeCommand`) or a repeat —
 *   digits folded — of any Bash command seen in the last two minutes. Every
 *   other call is work, `Read` included: paging one file by offset is reading.
 * - A LOOP is six status checks inside two minutes with no other call between.
 *   The sixth is the first refused, and every status check after it is refused
 *   too — the EPISODE — until the session makes another call or goes quiet for
 *   two minutes.
 *
 * Only the session's OWN calls count. A subagent's are its business, and the
 * callers enforce that: the PreToolUse hook skips a body carrying `agent_id`,
 * the stream skips an event carrying `parent`.
 *
 * Dependency-free ESM. `server/runner/liveness.ts` keeps one tracker per lane,
 * `server/service.ts` asks it at the hook, `server/runner/approvals.ts` widens
 * the hook's matcher with `POLL_STATUS_TOOLS`, and `scripts/replay-poll-guard.mjs`
 * replays real transcripts through exactly this code.
 *
 * @typedef {{ name: string, input?: unknown }} PollCall
 * @typedef {{ calls: number, windowMs: number, tools: string[], firstAt: number }} PollEpisode
 *   what a refusal reports: status checks in the streak so far, the span from
 *   the first to this one, the tools seen (first-seen order), the first's time
 * @typedef {{ status: boolean, deny: boolean, episodeStart: boolean, episode: PollEpisode | null }} PollVerdict
 * @typedef {{ calls: number, status: number, denied: number, episodes: number }} PollCounts
 * @typedef {{ count: number, firstAt: number, lastAt: number, recent: number[], tools: string[] }} PollStreak
 * @typedef {{
 *   streak: PollStreak | null,
 *   commands: { at: number, folded: string, digits: number[] }[],
 *   inEpisode: boolean,
 *   counts: PollCounts,
 * }} PollLoopState
 */

/**
 * The tools that are nothing BUT a status check. `Bash` is the fourth tool the
 * guard reads, and the only one that may or may not be one.
 * @type {readonly string[]}
 */
export const POLL_STATUS_TOOLS = Object.freeze(['ListAgents', 'TaskOutput', 'BashOutput']);

/** The tuning: `threshold` status checks inside `windowMs`. */
export const POLL_LOOP = Object.freeze({ threshold: 6, windowMs: 120_000 });

/** Probes that need no argument to be one. */
const CLOCK_PROBES = new Set(['date', 'pgrep', 'ps', 'sleep']);
/** Reads that are a probe only when what they read is a log or a task's output. */
const LOG_READS = new Set(['tail', 'cat', 'grep', 'wc', 'ls', 'stat']);
/** How many recent Bash commands the repeat rule remembers — bounded, like every per-lane list. */
const MAX_COMMANDS = 64;

/**
 * Does the guard read this tool at all?
 * @param {string} name
 * @returns {boolean}
 */
export function isStatusCapable(name) {
  return name === 'Bash' || POLL_STATUS_TOOLS.includes(name);
}

/**
 * Every run of digits to one `#`: a poll that counts up — a run id, a byte
 * offset, a line count — is still the same poll.
 * @param {string} text
 * @returns {string}
 */
export function foldDigits(text) {
  return String(text).replace(/\d+/g, '#');
}

/**
 * The digit runs of a command, in order — what `foldDigits` throws away.
 * @param {string} text
 * @returns {number[]}
 */
export function digitRuns(text) {
  return (String(text).match(/\d+/g) ?? []).map(Number);
}

/**
 * Is `next` the next page of the same walk as `prev`?
 *
 * `Read` is exempt from the repeat rule because paging one large file by offset
 * looks exactly like a repeat. The Bash equivalents — `sed -n 'N,Mp' f`,
 * `scripts/view-file f N M` — looked like one too, and were denied (O7).
 *
 * The rule is deliberately NOT "the digits advance". `gh run view 1`,
 * `gh run view 2`, … advances as well, and it is a real poll that nothing else
 * catches: `gh run view` is no probe, so the repeat rule is the only thing that
 * sees it. What distinguishes a page walk is that it is a contiguous RANGE —
 * the last two digit runs, where the next range starts exactly where the last
 * one ended and is non-empty, with everything before it (a path's own digits)
 * unchanged. A single advancing number can never qualify.
 * @param {number[]} prev
 * @param {number[]} next
 */
export function isPageWalk(prev, next) {
  if (prev.length < 2 || next.length !== prev.length) return false;
  const lead = prev.length - 2;
  for (let i = 0; i < lead; i += 1) if (prev[i] !== next[i]) return false;
  return next[lead] === prev[lead + 1] + 1 && next[lead + 1] > next[lead];
}

/**
 * A command's simple commands, each as its words. Separators are `;`, `&&`,
 * `||`, `|`, a lone `&` and newlines — outside quotes, so `pgrep -f "a | b"` is
 * one command. Quotes are removed from a word; `quoted` remembers that it had
 * some, so a quoted `>` is never read as a redirection.
 * @param {string} command
 * @returns {{ text: string, quoted: boolean }[][]}
 */
function simpleCommands(command) {
  /** @type {{ text: string, quoted: boolean }[][]} */
  const out = [];
  /** @type {{ text: string, quoted: boolean }[]} */
  let words = [];
  let text = '';
  let quoted = false;
  let inWord = false;
  /** @type {string | null} */
  let quote = null;
  const endWord = () => {
    if (inWord) words.push({ text, quoted });
    text = '';
    quoted = false;
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) text += command[++i];
      else text += c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      text += command[++i];
      inWord = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      quoted = true;
      inWord = true;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|') {
      if (c === '|' && command[i + 1] === '|') i++;
      endCommand();
      continue;
    }
    if (c === '&') {
      if (command[i + 1] === '&') {
        i++;
        endCommand();
        continue;
      }
      // `2>&1`, `>&2`, `&>file`: part of a redirection, not a separator.
      if (text.endsWith('>') || text.endsWith('<') || command[i + 1] === '>') {
        text += c;
        inWord = true;
        continue;
      }
      endCommand();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      continue;
    }
    text += c;
    inWord = true;
  }
  endCommand();
  return out;
}

/**
 * The words that are not redirections: `>x`, `> x`, `>>x`, `2>&1`,
 * `2>/dev/null`, `&>x`, `<x`.
 * @param {{ text: string, quoted: boolean }[]} words
 * @returns {string[]}
 */
function withoutRedirections(words) {
  /** @type {string[]} */
  const kept = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const redirect = word.quoted ? null : /^(?:\d*|&)(?:>>?|<)(.*)$/.exec(word.text);
    if (!redirect) {
      kept.push(word.text);
      continue;
    }
    if (redirect[1] === '') i++; // the target is the next word
  }
  return kept;
}

/**
 * @param {string} arg
 * @returns {boolean}
 */
function isLogOrTaskOutput(arg) {
  return !arg.startsWith('-') && (/\.(?:log|output)$/.test(arg) || arg.includes('/tasks/'));
}

/**
 * One simple command, judged: a `probe`, `neutral` (an `echo`, a bare
 * assignment — the glue around probes), or `work`.
 * @param {{ text: string, quoted: boolean }[]} words
 * @returns {'probe' | 'neutral' | 'work'}
 */
function judge(words) {
  const plain = withoutRedirections(words);
  let i = 0;
  while (i < plain.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[i])) i++;
  if (i === plain.length) return 'neutral';
  const verb = plain[i].slice(plain[i].lastIndexOf('/') + 1);
  if (verb === 'echo') return 'neutral';
  if (CLOCK_PROBES.has(verb)) return 'probe';
  if (LOG_READS.has(verb) && plain.slice(i + 1).some(isLogOrTaskOutput)) return 'probe';
  return 'work';
}

/**
 * Is this Bash command made only of clock and process probes (`date`, `pgrep`,
 * `ps`, `sleep`) and reads of a log or task output (`tail`, `cat`, `grep`,
 * `wc`, `ls`, `stat` of `*.log`, `*.output` or a `/tasks/` path) — with `echo`
 * and bare assignments allowed around them? Every pipeline stage counts, so
 * `ls x.output | awk …` is work, and a command with no probe at all is not one.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isProbeCommand(command) {
  if (typeof command !== 'string') return false;
  let probes = 0;
  for (const words of simpleCommands(command)) {
    const verdict = judge(words);
    if (verdict === 'work') return false;
    if (verdict === 'probe') probes += 1;
  }
  return probes > 0;
}

/**
 * A fresh tracker: one per lane, so it starts again with every session.
 * @returns {PollLoopState}
 */
export function newPollLoop() {
  return {
    streak: null,
    commands: [],
    inEpisode: false,
    counts: { calls: 0, status: 0, denied: 0, episodes: 0 },
  };
}

/**
 * Is this call a status check? Records a Bash command for the repeat rule
 * whatever the answer, because the first of a repeated poll looks like work.
 * @param {PollLoopState} state
 * @param {PollCall} call
 * @param {number} at
 * @returns {boolean}
 */
function isStatusCall(state, call, at) {
  const input =
    call.input && typeof call.input === 'object' ? /** @type {Record<string, unknown>} */ (call.input) : {};
  switch (call.name) {
    case 'ListAgents':
    case 'BashOutput':
      return true;
    case 'TaskOutput':
      // A blocking read is the wait the procedure asks for, not a poll.
      //
      // The CLI's default for `block` is SETTLED (console-open-findings O8, read
      // back from the live 2.1.274 tool definition, 2026-09-17): it is `true`,
      // and the description says so — "Use block=true (default) to wait for task
      // completion". But `block` is also in that schema's `required` list, so a
      // call that omits it is MALFORMED and the CLI does not produce one. This
      // stays `!== true` deliberately: an absent parameter is unknown input, and
      // the guard's rule for unknown input is to count it (see "a malformed call
      // is work, never a crash"). Reading the default into a call that cannot
      // occur would only widen the one tool a session could then use to poll.
      return input.block !== true;
    case 'Bash': {
      if (typeof input.command !== 'string') return false;
      const command = input.command.trim();
      const folded = foldDigits(command);
      const digits = digitRuns(command);
      state.commands = state.commands.filter((seen) => at - seen.at <= POLL_LOOP.windowMs);
      // Against the MOST RECENT command of the same shape, not any of them: a
      // page walk continues from the previous page, and page 8 is nothing like
      // page 1. Everything else with the same fold is a repeat, as before.
      let repeat = false;
      for (let i = state.commands.length - 1; i >= 0; i -= 1) {
        if (state.commands[i].folded !== folded) continue;
        repeat = !isPageWalk(state.commands[i].digits, digits);
        break;
      }
      state.commands.push({ at, folded, digits });
      if (state.commands.length > MAX_COMMANDS) state.commands.shift();
      return repeat || isProbeCommand(command);
    }
    default:
      return false;
  }
}

/**
 * Fold one main-thread tool call in, in order, and say whether the guard
 * refuses it. `at` is milliseconds, passed in: nothing here reads a clock.
 * @param {PollLoopState} state
 * @param {PollCall} call
 * @param {number} at
 * @returns {PollVerdict}
 */
export function observeCall(state, call, at) {
  const { threshold, windowMs } = POLL_LOOP;
  state.counts.calls += 1;
  if (!isStatusCall(state, call, at)) {
    state.streak = null;
    state.inEpisode = false;
    return { status: false, deny: false, episodeStart: false, episode: null };
  }
  state.counts.status += 1;
  let streak = state.streak;
  if (!streak || at - streak.lastAt > windowMs) {
    streak = state.streak = { count: 0, firstAt: at, lastAt: at, recent: [], tools: [] };
    state.inEpisode = false;
  }
  streak.count += 1;
  streak.lastAt = at;
  streak.recent.push(at);
  if (streak.recent.length > threshold) streak.recent.shift();
  if (!streak.tools.includes(call.name)) streak.tools.push(call.name);

  let episodeStart = false;
  if (!state.inEpisode && streak.recent.length === threshold && at - streak.recent[0] <= windowMs) {
    state.inEpisode = true;
    episodeStart = true;
    state.counts.episodes += 1;
  }
  if (!state.inEpisode) return { status: true, deny: false, episodeStart: false, episode: null };
  state.counts.denied += 1;
  return {
    status: true,
    deny: true,
    episodeStart,
    episode: {
      calls: streak.count,
      windowMs: at - streak.firstAt,
      tools: [...streak.tools],
      firstAt: streak.firstAt,
    },
  };
}

/**
 * A whole sequence through a fresh tracker — how the fixtures and the replay
 * script ask what the guard would have done. `index` is 1-based, the way a
 * transcript's calls are counted.
 * @param {(PollCall & { at: number })[]} calls
 * @returns {{ verdicts: PollVerdict[], episodes: { index: number, at: number }[], counts: PollCounts }}
 */
export function replayCalls(calls) {
  const state = newPollLoop();
  /** @type {PollVerdict[]} */
  const verdicts = [];
  /** @type {{ index: number, at: number }[]} */
  const episodes = [];
  calls.forEach((call, i) => {
    const verdict = observeCall(state, call, call.at);
    verdicts.push(verdict);
    if (verdict.episodeStart) episodes.push({ index: i + 1, at: call.at });
  });
  return { verdicts, episodes, counts: { ...state.counts } };
}
