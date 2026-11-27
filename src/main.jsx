import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AccountShell from './components/AccountShell.jsx';
import './index.css';

class AppErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('SignSpeak encountered an unexpected rendering error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
          <section className="max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-8 text-center">
            <h1 className="text-2xl font-bold">SignSpeak hit an unexpected error</h1>
            <p className="mt-3 text-slate-300">
              Reload the app to recover. If this keeps happening, check the browser console for details.
            </p>
            <button
              className="mt-6 rounded-lg bg-cyan-700 px-5 py-3 font-semibold hover:bg-cyan-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              type="button"
              onClick={() => window.location.reload()}
            >
              Reload SignSpeak
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((error) => {
      console.error('Unable to register SignSpeak as an installable app:', error);
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AccountShell>
        <App />
      </AccountShell>
    </AppErrorBoundary>
  </React.StrictMode>,
);
