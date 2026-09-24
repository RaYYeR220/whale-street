import { boot } from './boot';
import { describeConfig, loadConfig } from './config';
import { buildRuntime } from './deps';
import { consoleLogger } from './log';

const log = consoleLogger();
const config = loadConfig(process.env);
// describeConfig reduces the API key to "set"/"unset"; it is never logged.
log.info('starting whale-street engine', { config: JSON.parse(describeConfig(config)) as unknown });

const runtime = buildRuntime(config, { log });
const { engine, app } = await boot(runtime);
await app.listen({ port: config.port, host: config.host });
engine.start();
log.info('engine listening', { port: config.port, mode: config.mode });

/** A graceful shutdown that takes longer than this is abandoned (exit 1). */
const SHUTDOWN_TIMEOUT_MS = 10_000;

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) {
    log.warn('second signal during shutdown: forcing exit', { signal });
    process.exit(1);
  }
  stopping = true;
  log.info('shutting down', { signal });
  setTimeout(() => {
    log.error('shutdown timed out: forcing exit', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  let code = 0;
  const step = async (name: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      code = 1;
      log.error('shutdown step failed', { step: name, error: String(err) });
    }
  };
  await step('app.close', () => app.close());
  await step('engine.stop', () => engine.stop());
  await step('db.close', () => runtime.deps.db.close());
  process.exit(code);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
