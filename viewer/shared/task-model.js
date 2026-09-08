/**
 * What a session's task list IS — one vocabulary, imported by identity.
 *
 * Three producers write the same list and three surfaces paint it, so the words
 * live here and nowhere else: `scripts/phase-tasks.sh` (the channel the CLI
 * cannot take away), the CLI's own `TaskCreate`/`TaskUpdate`, and the CLI's
 * `TodoWrite` whole-list rewrite. All three arrive at `foldTaskEvent` as one
 * shape, so a list built by a shell script and a list built by a tool call fold
 * identically — and the server's fold (which sees every line) and the browser's
 * (which sees a bounded replay) cannot disagree about what a list means.
 *
 * The alternative had already happened once: `MAX_TODOS` was 60 in `spawn.ts`
 * and 80 in `console-model.js`, so a long list was silently two different
 * lengths depending on which end of the wire you asked.
 *
 * ## The identity contract
 *
 * `foldTaskEvent` RETURNS THE ARRAY IT WAS GIVEN when an event changes nothing.
 * `shared/console-model.js` holds its state in React and bails out of a
 * re-render on reference equality — the same rule `activity()` documents. Never
 * copy the result "to be safe".
 */

/** Rows kept. A phase's list is a dozen; this is the guard, not the target. */
export const MAX_TASKS = 80;
/** One line of a task list. A pasted paragraph is not a task title. */
export const MAX_TASK_TEXT = 200;

/**
 * The three states a task is in, worst-first the way the panel reads them.
 *
 * Deliberately the CLI's own spelling (`in_progress`, not `in-progress`): these
 * words arrive from `TodoWrite` payloads as well as from our own script, and a
 * vocabulary that had to translate at one of its two doors would translate at
 * neither the day someone added a third.
 */
export const TASK_STATUSES = ['pending', 'in_progress', 'completed'];

/**
 * What each status is CALLED and how it is DRAWN — the paint table, living
 * beside the vocabulary that owns the words.
 *
 * It used to be a two-entry literal inside the panel:
 *
 *     const TODO_TONE = { completed: 'text-done', in_progress: 'text-progress' };
 *
 * against a vocabulary of three. So `pending` fell through the `?? 'text-ink-faint'`
 * fallback and painted **identically to a status the panel did not recognise at
 * all** — the one case a reader cannot tell from a rendering bug. Here the table
 * is total, and `viewer/test/console-model.test.ts` holds it so: its keys are
 * asserted equal to `TASK_STATUSES`, in order, so a fourth status added above
 * turns the suite red until it is given a mark here. (The claim used to name a
 * `task-model.test.js` that did not exist — a guarantee stated and not written,
 * which is the same defect as a paint table stated and not total.)
 *
 * Three fields, three jobs:
 *   - `label` — what a legend and a screen reader call it. Human words, not the
 *     CLI's `in_progress`, which is the KEY and stays the wire spelling.
 *   - `ui` — a `UI_STATES` member from `shared/status-vocab.js`, so a task list
 *     is painted from the same eight hues as every badge, bar and station on
 *     the screen beside it rather than from a palette of its own.
 *   - `mark` — the SHAPE, so the three are distinguishable without colour.
 *     Colour was the sole channel, on a dot marked `aria-hidden`.
 */
export const TASK_STATUS_META = Object.freeze(
  /** @type {const} */ ({
    pending: { label: 'To do', ui: 'queued', mark: 'hollow' },
    in_progress: { label: 'Doing', ui: 'running', mark: 'live' },
    completed: { label: 'Done', ui: 'done', mark: 'solid' },
  }),
);

/**
 * Not a state — a tombstone. An `update` carrying it removes the row, which is
 * why `create` refuses it: a task cannot be born deleted.
 */
export const TASK_DELETED = 'deleted';

/**
 * The CLI's own task tools — the ones that stopped being provisioned.
 *
 * Named so their ABSENCE is a fact the console records rather than a silence it
 * lives with: the init event lists what a session was given, and an empty
 * intersection with this set is B1 happening again, visible on the first
 * session rather than after ten days of empty panels.
 */
export const TASK_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate'];

/** The transitions the wire format carries. `reset` clears; the rest are rows. */
export const TASK_OPS = ['reset', 'create', 'update'];

export function isTaskStatus(word) {
  return typeof word === 'string' && TASK_STATUSES.includes(word);
}

/**
 * Anything unrecognised reads as `pending`.
 *
 * A status this console does not know is a task that has NOT been reported
 * finished, and painting it as `completed` would let an unknown word close a
 * row nobody closed. Falling back to the safe end of the vocabulary is the same
 * posture the status vocabulary takes.
 */
export function normalizeTaskStatus(word) {
  return isTaskStatus(word) ? word : 'pending';
}

function text(value) {
  return typeof value === 'string' && value ? value.slice(0, MAX_TASK_TEXT) : undefined;
}

/**
 * Fold one transition into a task list.
 *
 * `event` is the stream shape both producers reach this through:
 *   `{ op, taskId?, call?, content?, status?, activeForm? }`
 *
 * `taskId` is the id an update names. `call` is the CLI-only case where the id
 * does not exist yet — `TaskCreate` returns it in the tool RESULT, so the row is
 * created keyed by the call and adopts its id later (`console-model.js`
 * `tool-result`). `phase-tasks.sh` never needs that: it chooses the id at the
 * create, which is the whole reason a session can update a task without reading
 * anything back.
 */
export function foldTaskEvent(tasks, event) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!event || typeof event !== 'object') return list;

  if (event.op === 'reset') {
    // A reset of an empty list is not a change — see the identity contract.
    return list.length ? [] : list;
  }

  if (event.op === 'create') {
    const content = text(event.content);
    if (!content) return list;
    return [
      ...list,
      {
        // `null` rather than absent: a row whose id has not arrived yet is a
        // state the panel renders, not a field that happens to be missing.
        id: typeof event.taskId === 'string' && event.taskId ? event.taskId : null,
        ...(event.call ? { key: event.call } : {}),
        content,
        ...(text(event.activeForm) ? { activeForm: text(event.activeForm) } : {}),
        status: normalizeTaskStatus(event.status),
      },
    ].slice(-MAX_TASKS);
  }

  if (event.op !== 'update') return list;
  const id = typeof event.taskId === 'string' && event.taskId ? event.taskId : null;
  if (!id) return list;

  const index = list.findIndex((task) => task.id === id);

  if (index < 0) {
    // An ORPHAN update — the create it names is not here. It used to be dropped
    // in silence, and the measured cause was the replay: a 400-entry transcript
    // tail excluded every create in a real run (0 of 85 inside the window), so
    // the panel showed a list that never changed after it was written. The
    // seeding from `PhaseRecord.tasks` is the real fix; this is what is left.
    //
    // When the update carries a subject we know what the task IS, so adopt it —
    // a row late is better than a row lost. When it carries only a status we do
    // not, and inventing "task p8.task3" as a title would be the console making
    // something up, which is the one thing it must not do.
    const content = text(event.content);
    if (!content) return list;
    return [
      ...list,
      {
        id,
        content,
        ...(text(event.activeForm) ? { activeForm: text(event.activeForm) } : {}),
        status: normalizeTaskStatus(event.status),
      },
    ].slice(-MAX_TASKS);
  }

  if (event.status === TASK_DELETED) return list.filter((_, i) => i !== index);

  // Only what the update states. An absent key means UNCHANGED — writing
  // `pending` over every status-less update would silently un-complete a task.
  const status = isTaskStatus(event.status) ? event.status : undefined;
  const content = text(event.content);
  const activeForm = text(event.activeForm);
  if (status === undefined && content === undefined && activeForm === undefined) return list;

  return list.map((task, i) =>
    i === index
      ? {
          ...task,
          ...(status ? { status } : {}),
          ...(content ? { content } : {}),
          ...(activeForm ? { activeForm } : {}),
        }
      : task,
  );
}

/**
 * The id a `TaskCreate` hands back in its RESULT — "Task #4 created
 * successfully: …" — bound onto the row that call created.
 *
 * The CLI's create does not carry an id in its INPUT, so the only moment a
 * created row can learn the name every later update will call it by is the
 * result of its own tool call. Miss it and the list is written once and never
 * changes again, because every update afterwards matches nothing.
 *
 * Lives here rather than in either consumer because BOTH need it now: the
 * browser folds the live stream and the server folds the same events into
 * `PhaseRecord.tasks`, and two implementations of one adoption rule is how the
 * record and the panel end up disagreeing about which task is in progress.
 *
 * `phase-tasks.sh` never needs it — it chooses the id at the create.
 */
export function adoptTaskId(tasks, call, detail) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!call || typeof detail !== 'string' || !detail) return list;
  const found = /(?:^|\s)#(\d+)\b/.exec(detail);
  if (!found) return list;
  const index = list.findIndex((task) => task.key === call && task.id == null);
  if (index < 0) return list;
  return list.map((task, i) => (i === index ? { ...task, id: found[1] } : task));
}

/**
 * A whole-list rewrite — `TodoWrite`'s shape — normalised into rows.
 *
 * Kept apart from `foldTaskEvent` because it is a different verb: this replaces
 * the list rather than transitioning it, and an EMPTY array is a legitimate,
 * meaningful write (the session finished or abandoned its plan). Treating empty
 * as "nothing to see" is what left the panel showing a completed list forever.
 */
export function tasksFromList(items) {
  if (!Array.isArray(items)) return null;
  return items
    .slice(0, MAX_TASKS)
    .map((item) => ({
      id: null,
      content: text(item?.content) ?? '',
      ...(text(item?.activeForm) ? { activeForm: text(item.activeForm) } : {}),
      status: normalizeTaskStatus(item?.status),
    }))
    .filter((task) => task.content);
}

/**
 * `3/7 · Wiring the runner` — what a row on Sessions, a card on Now and a
 * phase row on the run page each show instead of the whole list.
 *
 * `active` is the task being worked on, in its `activeForm` when the session
 * gave one ("Wiring the runner" reads as a state; "wire the runner" reads as an
 * instruction). Null rather than a guess when nothing is in progress — a
 * summary that names the next PENDING task would claim work that has not
 * started.
 */
export function taskSummary(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const total = list.length;
  const done = list.filter((task) => task.status === 'completed').length;
  const current = list.find((task) => task.status === 'in_progress');
  const active = current ? current.activeForm || current.content || null : null;
  return {
    total,
    done,
    active,
    label: total ? `${done}/${total}${active ? ` · ${active}` : ''}` : null,
  };
}
