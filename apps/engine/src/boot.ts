import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { Runtime } from './deps';
import { createEngine, type Engine } from './engine';
import { restartReplay, seedReplayCompanies } from './replay/restart';

/**
 * Composes engine + app from a runtime: REPLAY seeding, street mood and loop restarts; LIVE
 * session recording.
 */
export async function boot(runtime: Runtime): Promise<{ engine: Engine; app: FastifyInstance }> {
  const engine = createEngine(runtime.deps);
  const replay = runtime.replay;
  if (replay) {
    const listed = await seedReplayCompanies(engine, runtime.seeds);
    engine.log.info('replay seeded', { companies: listed });
    replay.mood.onMood((coin, mood, at) => {
      engine.state.mood.set(coin, { ...mood, asOf: at });
      engine.state.moodAt = at;
    });
    replay.clock.onWrap(() => restartReplay(engine, replay));
  }
  const recorder = runtime.recorder;
  if (recorder) {
    const seedOf = (id: string) => {
      const rt = engine.state.get(id);
      if (rt)
        recorder.seed({
          address: rt.id,
          ticker: rt.ticker,
          name: rt.name,
          anchorDate: rt.anchorDate,
          listedAt: rt.listedAt,
        });
    };
    for (const rt of engine.state.listed()) seedOf(rt.id);
    engine.bus.on((ev) => {
      if (ev.t === 'filing' && ev.filing.kind === 'IPO') seedOf(ev.filing.companyId);
      // The derived skews the engine serves (only coins read in this run; a coin whose fetch
      // failed keeps an older reading); the raw Nansen body is never recorded.
      if (ev.t === 'mood')
        for (const [coin, mood] of engine.state.mood)
          if (mood.asOf >= engine.state.moodAt) recorder.mood(coin, mood);
    });
    recorder.attachFeed(
      runtime.deps.hl.feed,
      () => engine.state.heldCoins(),
      () =>
        new Set([...engine.state.listed().map((rt) => rt.id), ...engine.ipo.pendingAddresses()]),
    );
    engine.log.info('recording session', { path: recorder.path });
  }
  const app = await buildApp(engine);
  return { engine, app };
}
