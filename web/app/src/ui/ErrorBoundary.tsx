import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button";

// Contains a render error to the part of the page that hit it. Without a
// boundary, React unmounts the whole root on any render error and the
// page goes blank; with one, that part shows a short notice (or nothing)
// and the rest keeps working. Styles in ui/error.css.

type Props = {
  /** What this wraps, for the console and the notice ("the chat", "message 42"). */
  label: string;
  children?: ReactNode;
  /** Replaces the notice: a node, null for nothing, or a function given a retry. */
  fallback?: ReactNode | ((retry: () => void) => ReactNode);
  /** A new value clears the error and renders the children again (new data). */
  resetKey?: unknown;
};
type State = { error: Error | null; key: unknown };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { key: props.resetKey, error: null } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[" + this.props.label + "] " + (error && error.message), info.componentStack || "");
  }

  retry = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    const { fallback, label } = this.props;
    if (typeof fallback === "function") return fallback(this.retry);
    if (fallback !== undefined) return fallback;
    return (
      <div className="err-box" role="alert">
        <span>Something went wrong showing {label}.</span>
        <Button type="button" size="sm" onClick={this.retry}>
          Try again
        </Button>
      </div>
    );
  }
}
