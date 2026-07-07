import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      {/*
        Top-level error boundary. Catches any render-time exception in
        the tree and renders a fallback that explains the failure and
        shows the recent error. The user can reload the renderer by
        clicking the button — the main process and Ogra Core state
        are unaffected, so the SQLite db / secret broker / indexed
        data are still there on next launch.
      */}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
