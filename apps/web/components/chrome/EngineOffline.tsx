import Link from 'next/link';

/** Rendered on the server when the engine cannot be reached: say so, show nothing invented. */
export function EngineOffline({ what, message }: { what: string; message: string }) {
  return (
    <main className="ipo" id="main">
      <section className="ws-panel ws-panel--flat">
        <div className="ws-offline" role="alert">
          <h1>Cannot load {what}</h1>
          <p>
            The engine did not answer ({message}). Nothing here is shown until it does; no number on
            Whale Street is ever guessed.
          </p>
          <Link className="ws-btn ws-btn--quiet" href="/floor">
            Back to the floor
          </Link>
        </div>
      </section>
    </main>
  );
}
