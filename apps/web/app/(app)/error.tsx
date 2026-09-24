'use client';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="ipo" id="main">
      <section className="ws-panel ws-panel--flat">
        <div className="ws-offline" role="alert">
          <h1>This page stopped</h1>
          <p>
            Something failed while drawing it ({error.digest ?? error.message}). No number is shown
            rather than a wrong one.
          </p>
          <button className="ws-btn ws-btn--quiet" type="button" onClick={reset}>
            Try again
          </button>
        </div>
      </section>
    </main>
  );
}
