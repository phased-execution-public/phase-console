/**
 * An `EventSource` a test can push frames into.
 *
 * Extracted from `tail.test.ts` (Phase 10, QA round 3) so the page test can
 * drive the rendered tail the way the hook test drives the hook — one fake,
 * not two that drift. Install it by ASSIGNMENT (`globalThis.EventSource =
 * DriveableEventSource`): `test-setup.ts`'s stand-in is writable but not
 * configurable, so `defineProperty` throws.
 */
export type Listener = (event: MessageEvent) => void;

/** An `EventSource` a test can push frames into. */
export class DriveableEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: DriveableEventSource | null = null;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  url: string;
  closed = false;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    DriveableEventSource.last = this;
  }

  addEventListener(name: string, fn: Listener): void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
  }

  removeEventListener(name: string, fn: Listener): void {
    this.listeners.get(name)?.delete(fn);
  }

  close(): void {
    this.readyState = 2;
    this.closed = true;
  }

  /** Push one frame, the way the server would. */
  emit(name: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }

  open(): void {
    this.readyState = 1;
    for (const fn of this.listeners.get('open') ?? []) fn({} as MessageEvent);
  }
}
