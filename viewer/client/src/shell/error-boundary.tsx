/**
 * One destination failing must not take the console with it.
 *
 * React unmounts the WHOLE tree when a render throws and nothing catches it —
 * so a single bad field in one panel would replace the shell, the rail, the
 * tab bar and every other destination with a blank page. On an unattended
 * console that is indistinguishable from "the server died". A boundary per
 * destination turns that into a banner: the nav stays painted, the other
 * destinations stay reachable, and the error says what it was.
 *
 * It is a class because `getDerivedStateFromError`/`componentDidCatch` have no
 * hook equivalent — the one component in the shell that cannot be a function.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Banner, Button } from '@/ui';

/** What a caught render error looks like once it is a banner and not a blank page. */
export function ErrorCard({ title, error, onRetry }: { title: string; error: Error; onRetry?: () => void }) {
  return (
    <Banner severity="error" role="alert">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-body font-semibold text-ink">{title}</p>
        <p className="max-w-(--measure) text-body text-ink-muted">
          This part of the console failed to render. The rest of it still works, and the navigation still goes
          everywhere it did.
        </p>
        <pre className="max-h-40 overflow-auto rounded border border-rule bg-ground-deep p-2 font-mono text-meta text-ink-muted">
          {error.message || String(error)}
        </pre>
        <div className="flex flex-wrap gap-2">
          {onRetry && (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload the console
          </Button>
        </div>
      </div>
    </Banner>
  );
}

interface Props {
  children: ReactNode;
  /** Named in the banner, so "which part broke" is answerable without a stack. */
  label: string;
  /**
   * Changing this resets the boundary. `RouteFrame` passes the route path, so
   * navigating away from a broken destination and back gives it a fresh try.
   */
  resetKey?: string;
}

interface State {
  error: Error | null;
  /** The key the current error belongs to, so a reset is a real change. */
  key?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.error && state.key !== undefined && state.key !== props.resetKey) {
      return { error: null, key: props.resetKey };
    }
    if (state.error && state.key === undefined) return { key: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The browser console is the one place an operator looks after a blank
    // page, and a caught error is otherwise swallowed entirely.
    console.error(`[console] ${this.props.label} failed to render`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="px-(--pad-x) py-(--pad-y)">
        <ErrorCard
          title={`${this.props.label} could not be shown`}
          error={error}
          onRetry={() => this.setState({ error: null })}
        />
      </div>
    );
  }
}
