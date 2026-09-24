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

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  try {
    await app.close();
    await engine.stop();
  } finally {
    runtime.deps.db.close();
  }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
