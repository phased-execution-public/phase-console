/**
 * One destination failing must not take the console with it.
 *
 * React unmounts the WHOLE tree when a render throws and nothing catches it —
 * so a single bad field in one panel replaced the shell, the rail, the tab bar
 * and every other destination with a blank white page. On an unattended console
 * that is indistinguishable from "the server died": there is no message, no
 * address bar change and no way back except a reload, and the operator's next
 * move is usually to restart something that was working.
 *
 * A boundary per destination turns that into a card. The nav stays painted, the
 * other destinations stay reachable, and the error says what it was.
 *
 * It is a class because `getDerivedStateFromError`/`componentDidCatch` have no
 * hook equivalent — this is the one component here that cannot be a function.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui';

/** What a caught render error looks like once it is a card and not a blank page. */
export function ErrorCard({ title, error, onRetry }: { title: string; error: Error; onRetry?: () => void }) {
  return (
    <Card role="alert" className="state-failed">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="max-w-prose text-sm text-ink-muted">
          This part of the console failed to render. The rest of it is still working — the navigation beside
          this card still goes everywhere it did.
        </p>
        <pre className="max-h-40 overflow-auto rounded border border-rule bg-ground-deep p-2 text-2xs text-ink-muted">
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
      </CardBody>
    </Card>
  );
}

interface Props {
  children: ReactNode;
  /** Named in the card, so "which part broke" is answerable without a stack. */
  label: string;
  /**
   * Changing this resets the boundary. `RouteFrame` passes the route path, so
   * navigating away from a broken destination and back gives it a fresh try —
   * without it, one throw would poison that destination until a full reload.
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
    // The console is the one place an operator looks after a blank page, and a
    // caught error is otherwise swallowed entirely.
    console.error(`[console] ${this.props.label} failed to render`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="p-3 md:p-5">
        <ErrorCard
          title={`${this.props.label} could not be shown`}
          error={error}
          onRetry={() => this.setState({ error: null })}
        />
      </div>
    );
  }
}
