// `phase-console report [instance] --since <iso> [--until <iso>] [--replay] [--json]`
// — the verb, shared by the Pro bin (`bin/phase-console.mjs`) and the free
// tree's override, which import it by path so neither carries a second copy.
//
// The week in numbers (control-tower phase 64, AUD-37): what the autopilot-week
// audit measured with forty throwaway scripts, over any window, from the state
// directory alone. `--replay` re-derives the streak, spend, ETA and holder
// numbers with today's models over the same journals, which is how the plan's
// acceptance targets are measured without waiting a week.
//
// It reads and never writes, and it never asks a live console: a report is a
// measurement of what the journals say, so it answers the same with the
// console up or down — and it ships in both editions for that reason.
//
// Imports only leaves at module load; the report itself is imported inside the
// verb, so no console identity is resolved by loading this file.

import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = [
  'phase-console report [instance] --since <iso> [--until <iso>] [--replay] [--json]',
  '',
  '  What the autopilot-week audit measured, over any window, read from the',
  '  instance’s state directory: how long runs sat stopped and who ended each',
  '  stop, the stops today’s rules would not make, failure-streak and',
  '  verify-failed halts, phantom spend, the queue, the holder and phase ETAs,',
  '  stall cards on finished lanes, resumes cut by the closeout cap, phases',
  '  closed with an unrun verification, and the model each phase ran on.',
  '',
  '  --replay   re-derive the streak, spend, ETA and holder numbers with today’s',
  '             models over the same journals',
  '  --until    the window’s end (default: now)',
  '  --json     print the report as JSON',
  '',
  '  Reads only. A console need not be running.',
  '',
].join('\n');

/**
 * The verb. `ctx.root` is the package root the bin resolved; `ctx.preferBuilt`
 * picks the shipped `.js` twin under node_modules and the `.ts` elsewhere.
 */
export async function reportVerb(argv, ctx) {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  let since;
  let until;
  let replay = false;
  let json = false;
  let selector;
  let rootArg;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--since') { since = args[++i]; continue; }
    if (arg === '--until') { until = args[++i]; continue; }
    if (arg === '--replay') { replay = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--instance') { selector = args[++i]; continue; }
    if (arg === '--root' || arg === '-r') { rootArg = args[++i]; continue; }
    if (!arg.startsWith('-') && selector === undefined && rootArg === undefined) {
      const looksLikePath = arg.includes('/') || arg.startsWith('.') || arg.startsWith('~') || existsSync(resolve(arg));
      if (looksLikePath) rootArg = arg; else selector = arg;
      continue;
    }
    process.stderr.write(`phase-console report: unknown argument ${arg}\n${USAGE}`);
    return 2;
  }
  if (!since || !Number.isFinite(Date.parse(since)) || (until !== undefined && !Number.isFinite(Date.parse(until)))) {
    process.stderr.write(`phase-console report: --since <iso> is required, and --until must be an instant too\n${USAGE}`);
    return 2;
  }

  const instances = await import(pathToFileURL(join(ctx.root, 'viewer', 'shared', 'instances.mjs')).href);
  const home = process.env.HOME ?? '';
  const found = rootArg
    ? instances.selectRoot(resolve(rootArg.startsWith('~') ? join(home, rootArg.slice(1)) : rootArg))
    : instances.selectInstance(selector, process.cwd());
  if (!found || (found.kind !== 'registered' && found.kind !== 'candidate')) {
    process.stderr.write(`phase-console report: ${instances.selectionError(found)}\n`);
    return 1;
  }
  // `runs/` lives under the SHARED state home, keyed by the root's instance id.
  const runsDir = join(instances.stateHome(), 'runs', instances.instanceId(found.root));

  const analysisDir = join(ctx.root, 'viewer', 'server', 'analysis');
  const week = await import(pathToFileURL(ctx.preferBuilt(analysisDir, 'week-report')).href);
  let result;
  try {
    result = week.weekReportFromDir(runsDir, {
      instance: found.name ?? basename(found.root),
      since,
      ...(until ? { until } : {}),
      replay: replay ? week.REPLAY_RULES : [],
      factsOf: week.planFactsReader(found.root, join(ctx.root, 'scripts')),
    });
  } catch (error) {
    process.stderr.write(`phase-console report: ${error?.message ?? error}\n`);
    return 2;
  }
  if (!existsSync(runsDir)) process.stderr.write(`phase-console report: no runs under ${runsDir} — every number is zero\n`);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : week.formatWeekReport(result));
  return 0;
}
