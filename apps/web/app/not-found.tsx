import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="ipo" id="main">
      <section className="ws-panel ws-panel--flat">
        <div className="ws-empty">
          <h1>Nothing is listed here</h1>
          <p>
            That ticker, verdict or player does not exist on this engine. It may have been delisted,
            or the replay restarted.
          </p>
          <Link className="ws-btn" href="/floor">
            Back to the floor
          </Link>
        </div>
      </section>
    </main>
  );
}
