/**
 * Open a link on the machine this console runs on (control-tower phase 43) —
 * a human step's *Open on the machine*, for the sign-ins whose callback is
 * `localhost` and the dialogs only the host can show.
 *
 * Deliberately narrow, beside `launcher.ts` rather than inside it: it opens an
 * `http` or `https` URL with the platform's own opener (`open`, `wslview`,
 * `xdg-open` — `platform.ts`) and NOTHING else — never a path, never a
 * `file:` or custom-scheme link, never a command. `isOpenableUrl` is asked
 * again here, whatever the caller checked, because this is the one function
 * in the console that hands a string to the desktop. The route in front of it
 * is behind `--allow-terminal` or `--allow-agent`, and it only calls this once
 * the caller has been shown the full URL and sent it back.
 */

import { isOpenableUrl } from '../shared/human-step-model.js';
import { openerCandidates } from './platform.ts';
import { shell } from './shell.ts';

/** What opening answered: whether the desktop took it, with which opener, and why not. */
export type HostOpen = { opened: boolean; opener?: string; detail?: string };

/** The seam a test replaces, so no test ever opens a browser. */
export type HostOpenDeps = {
  candidates?: () => string[];
  run?: (file: string, argv: readonly string[]) => Promise<{ ok: boolean; stderr?: string }>;
};

export async function openUrlOnHost(url: string, deps: HostOpenDeps = {}): Promise<HostOpen> {
  const link = String(url ?? '').trim();
  if (!isOpenableUrl(link)) return { opened: false, detail: 'only an http or https link is opened on the machine' };
  const opener = (deps.candidates ?? openerCandidates)()[0];
  if (!opener) return { opened: false, detail: 'this machine has no desktop opener — open the link yourself' };
  const run = deps.run ?? ((file: string, argv: readonly string[]) => shell(file, argv, {
    channel: 'shell', intent: 'open-link', timeout: 10_000, expectFailure: true,
  }));
  const result = await run(opener, [link]);
  return result.ok
    ? { opened: true, opener }
    : { opened: false, opener, detail: (result.stderr ?? '').trim().slice(0, 200) || `${opener} did not open it` };
}
