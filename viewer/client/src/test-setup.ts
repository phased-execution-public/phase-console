import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';

// `waitFor` polls until its expectation holds, and gives up after
// `asyncUtilTimeout` — testing-library's own bound, stock 1000 ms, which
// `testTimeout` in vite.config.ts does NOT govern. Raised for the reason that
// one was: on a loaded machine (load average 10 on 14 cores, a full gate and
// two foreign suites running) the second of three sequential clicks in
// `runs/board.test.tsx` lost the race at 1 s, with the same file green in
// isolation under the same load. A liveness bound on the harness, never an
// assertion about the app: a passing `waitFor` returns the moment its
// expectation holds, a wrong expectation still fails identically, only later,
// and the bound stays well inside the 20 s test budget so three waits in one
// test still report as a `waitFor` timeout rather than the test's own.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no matchMedia, and the shell asks for it on first render to decide
// whether it is a phone. Default: not a phone, no listeners — a test that cares
// overrides this per case.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// Nor `scrollIntoView`, which jsdom leaves unimplemented because it has no
// layout. The guide uses it in two places — bringing the active tab into a
// ten-tab strip, and landing on a `?card=` deep link — and neither has anything
// to assert in a DOM with no viewport. A no-op keeps those paths exercised
// rather than guarded in app code for a test environment's benefit.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// Neither does it have EventSource. The data plane opens exactly one on boot.
if (!('EventSource' in globalThis)) {
  class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 0;
    url: string;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {
      this.readyState = 2;
    }
  }
  Object.defineProperty(globalThis, 'EventSource', { value: FakeEventSource, writable: true });
}

// Nor visualViewport. lib/viewport.ts mirrors its height into --app-height;
// tests that exercise the mirror swap in their own mutable fake.
if (!('visualViewport' in window) || !window.visualViewport) {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: {
      height: window.innerHeight,
      width: window.innerWidth,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

// Nor Element.scrollTo — the shell's one scroller resets on navigation, and a
// test asserts the reset RAN. The recorder keeps the calls inspectable.
if (!Element.prototype.scrollTo) {
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: function scrollTo(this: Element & { __scrollToCalls?: unknown[] }, ...args: unknown[]) {
      (this.__scrollToCalls ??= []).push(args);
    },
  });
}

// Nor ResizeObserver, which Radix measures open tooltip content with — the
// hover path never opens in jsdom, so this only surfaced when InfoTip's tap
// path actually rendered a Content.
if (!('ResizeObserver' in globalThis)) {
  class FakeResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { value: FakeResizeObserver, writable: true });
}
