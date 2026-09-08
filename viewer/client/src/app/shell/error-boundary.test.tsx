/**
 * Containment: one destination failing must not take the console with it.
 *
 * Before this boundary existed, React's own behaviour applied — an uncaught
 * render error unmounts the WHOLE tree. A single bad field in one panel
 * replaced the shell, the rail, the tab bar and every other destination with a
 * blank white page: no message, no address-bar change, no way back but a
 * reload. On an unattended console that reads exactly like a dead server, and
 * the usual next move is to restart something that was working fine.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './error-boundary';

function Boom({ throws }: { throws: boolean }): React.ReactElement {
  if (throws) throw new Error('the panel could not read a field');
  return <p>the panel</p>;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs every caught error itself; the boundary logs its own line. Both
  // are wanted in production and neither is wanted in the test output.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe('the destination boundary', () => {
  it('renders its child when nothing is wrong', () => {
    render(
      <ErrorBoundary label="Insights">
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('the panel')).toBeTruthy();
  });

  it('turns a thrown render into a card that NAMES what broke', () => {
    render(
      <ErrorBoundary label="Insights">
        <Boom throws />
      </ErrorBoundary>,
    );
    // Not a blank page: an alert, the destination's name, and the message.
    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(screen.getByText(/Insights could not be shown/)).toBeTruthy();
    expect(screen.getByText(/could not read a field/)).toBeTruthy();
    // And it says the rest of the console still works, because the operator's
    // first question is whether to restart it.
    expect(screen.getByText(/The rest of it is still working/)).toBeTruthy();
  });

  it('says so in the console too — a caught error is otherwise swallowed', () => {
    render(
      <ErrorBoundary label="Insights">
        <Boom throws />
      </ErrorBoundary>,
    );
    const ours = consoleError.mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes('[console] Insights failed to render'),
    );
    expect(ours.length).toBeGreaterThan(0);
  });

  it('offers a retry that re-renders the child', () => {
    // The flag is flipped by the TEST, not by the render: React re-renders a
    // failing subtree more than once (a concurrent render that throws is
    // retried synchronously), so a "throws only the first time" fixture
    // recovers on its own and proves nothing about the button.
    let broken = true;
    function Flaky() {
      if (broken) throw new Error('transient');
      return <p>recovered</p>;
    }

    render(
      <ErrorBoundary label="Runs">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('resets when the route changes, so a broken destination is not poisoned', () => {
    const { rerender } = render(
      <ErrorBoundary label="Runs" resetKey="runs">
        <Boom throws />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    // Navigating away and rendering something else must not keep the card.
    rerender(
      <ErrorBoundary label="Now" resetKey="now">
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('the panel')).toBeTruthy();
  });

  it('keeps everything AROUND it mounted — the containment claim itself', () => {
    render(
      <div>
        <nav aria-label="Main">
          <a href="#/now">Now</a>
        </nav>
        <ErrorBoundary label="Insights">
          <Boom throws />
        </ErrorBoundary>
        <footer>the shell</footer>
      </div>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    // The nav and the shell are still there. Without a boundary React unmounts
    // this entire tree and both of these queries return null.
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getByText('the shell')).toBeTruthy();
  });
});
