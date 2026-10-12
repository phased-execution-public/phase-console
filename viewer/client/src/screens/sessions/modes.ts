/**
 * What a claude session was STARTED under, in words.
 *
 * Offering a mode is the one launch form's (`PERMISSION_CHOICES`,
 * `screens/launch/model/modes.ts`); this reads one back, for the session's
 * details. `bypassPermissions` is never offered there and refused by the
 * server — it still has a name here, because a QA session started on the
 * bypass PROFILE resolves to it, and the one mode worth noticing must not read
 * as a blank.
 *
 * ⚠️ Data only — no imports.
 */

/** Short names — the mode, not the sentence explaining it. */
const MODE_NAME: Record<string, string> = {
  '': 'default',
  manual: 'default',
  acceptEdits: 'accept edits',
  plan: 'plan',
  auto: 'auto',
  dontAsk: 'don’t ask',
  bypassPermissions: 'bypass',
};

/** An unknown mode is shown as it stands: a mode this console has not heard of is exactly the thing worth showing. */
export function modeName(mode: string | undefined): string {
  if (!mode) return MODE_NAME['']!;
  return MODE_NAME[mode] ?? mode;
}

/**
 * The honest note beside it: ⇧Tab cycles the mode inside the session and
 * tells nobody out here, so the word is a record of how the process STARTED.
 */
export const MODE_TITLE =
  'The mode this session was launched in — cycling modes inside the session does not update this label.';
