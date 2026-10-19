/**
 * The person's last look at Your turn, kept in this browser — what the
 * handled count is counted since. One module, because the page and the card
 * it opens in the panel must ask `GET /api/turn` with the same key.
 */

const SEEN_KEY = 'turn:seen';

export function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function writeSeen(at: string): void {
  try {
    window.localStorage.setItem(SEEN_KEY, at);
  } catch {
    /* private mode: the count falls back to the last day */
  }
}
