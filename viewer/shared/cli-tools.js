/**
 * The tool names Claude Code provides — what a permission rule may name.
 *
 * A rule is `Tool` or `Tool(spec)`, and the syntax accepts any identifier as
 * the tool: `git(:*)` parses, names no tool, and matches nothing for ever
 * (chapter 08 TRS-12 — the live policy carried it under `always`, labelled
 * as enforced). The list is what `parseRule` checks a name against, together
 * with the names this console has actually seen in a session's `system/init`
 * (`toolsSeen`), an `mcp__<server>` prefix and a glob — so a tool from a
 * newer CLI than this list knows is never refused once a session has run
 * under it. A name that is on none of those and does not even look like a
 * tool (lower-case: a COMMAND written where a tool goes) is `ignored`, which
 * the editor refuses; a Pascal-case unknown is merely marked as unseen.
 *
 * Owner of the list; `server/runner/approvals.ts` imports it by identity.
 * @type {readonly string[]}
 */
export const CLI_TOOLS = Object.freeze([
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'Cd',
  'CronCreate',
  'CronDelete',
  'CronList',
  'DesignSync',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'KillShell',
  'LS',
  'ListAgents',
  'ListMcpResources',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'PushNotification',
  'Read',
  'ReadMcpResource',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'SendMessage',
  'SendUserFile',
  'Skill',
  'SlashCommand',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
]);

/**
 * Does `tool` name something a rule can reach? The shipped list, the names
 * this console has seen, an MCP prefix, or a glob.
 * @param {string} tool
 * @param {ReadonlySet<string> | readonly string[] | undefined} [seen]
 * @returns {'known' | 'unseen' | 'none'}
 */
export function toolStanding(tool, seen) {
  if (!tool) return 'none';
  if (tool.includes('*') || tool.startsWith('mcp__')) return 'known';
  if (CLI_TOOLS.includes(tool)) return 'known';
  const known = seen instanceof Set ? seen : new Set(seen ?? []);
  if (known.has(tool)) return 'known';
  return /^[A-Z]/.test(tool) ? 'unseen' : 'none';
}
