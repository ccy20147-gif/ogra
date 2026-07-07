import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** When the error happened — used in the fallback UI. */
  at: string | null;
}

/**
 * Top-level React error boundary.
 *
 * Catches any render-time exception thrown by descendants and shows
 * a fallback panel with the error message and a "Reload renderer"
 * button. State outside the renderer (SQLite, secret broker, audit
 * chain, indexed knowledge bases) is unaffected; the user only loses
 * the current in-memory view.
 *
 * Catches:
 *   - uncaught exceptions during render
 *   - uncaught exceptions in lifecycle methods (constructor, setState)
 *   - errors in useEffect / event handlers that bubble
 *
 * Does NOT catch:
 *   - async errors that the user code does not surface
 *   - errors in the main process / preload / IPC handlers
 *
 * For the latter, see `electron/main/main.ts` which writes to
 * OgraCore's audit log on unhandled rejections.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    at: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
      at: new Date().toISOString(),
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Best-effort dev visibility. In production, this would be wired
    // to a renderer-side logger or sent to the main process.
    // The console message is intentionally short so dev tools show
    // the stack without us having to commit a logging library.
    // eslint-disable-next-line no-console
    console.error(
      '[Ogra ErrorBoundary] caught at', this.state.at, '\n',
      'error:', error.message, '\n',
      'stack:', error.stack, '\n',
      'componentStack:', errorInfo.componentStack,
    );
  }

  reload = () => {
    // Reset state and re-mount the tree. Keeps the main process,
    // preload, and Ogra Core fully intact — only the React tree
    // gets a clean slate.
    this.setState({ hasError: false, error: null, at: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return <ErrorFallback error={this.state.error} at={this.state.at} onReload={this.reload} />;
  }
}

interface ErrorFallbackProps {
  error: Error | null;
  at: string | null;
  onReload: () => void;
}

/**
 * Fallback panel. Centered, dark, with the error message in monospace.
 * No callout for stack traces — those are in the dev console.
 */
const ErrorFallback: React.FC<ErrorFallbackProps> = ({ error, at, onReload }) => {
  const message = error?.message ?? 'Unknown render error.';
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        minHeight: '100vh',
        backgroundColor: '#0d1117',
        color: '#e1e4e8',
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        style={{
          maxWidth: '560px',
          padding: '24px',
          border: '1px solid #da3633',
          borderRadius: '8px',
          backgroundColor: '#161b22',
          boxShadow: 'rgba(0, 0, 0, 0.4) 0px 8px 24px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '12px',
          }}
        >
          <span aria-hidden="true" style={{ fontSize: '18px' }}>✕</span>
          <h1
            style={{
              fontSize: '16px',
              fontWeight: 600,
              margin: 0,
              color: '#f85149',
              letterSpacing: '-0.165px',
            }}
          >
            Renderer error
          </h1>
        </div>

        <p
          style={{
            fontSize: '13px',
            color: '#c9d1d9',
            margin: '0 0 12px 0',
            lineHeight: 1.5,
          }}
        >
          Something went wrong while rendering the UI. Your local data,
          audit chain, and provider configuration are unaffected — this
          is purely a React-tree failure.
        </p>

        <pre
          style={{
            margin: 0,
            padding: '12px',
            background: '#0d1117',
            border: '1px solid #21262d',
            borderRadius: '4px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '12px',
            color: '#f0883e',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: '12px',
          }}
        >
          {message}
        </pre>

        {at && (
          <p
            style={{
              fontSize: '11px',
              color: '#586069',
              margin: '0 0 16px 0',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            Caught at: {at}
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={onReload}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid #30363d',
              backgroundColor: '#238636',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Reload renderer
          </button>
          <a
            href="https://github.com/ccy20147-gif/ogra/issues"
            target="_blank"
            rel="noreferrer"
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: '1px solid #30363d',
              backgroundColor: 'transparent',
              color: '#58a6ff',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            Report issue →
          </a>
        </div>
      </div>
    </div>
  );
};
