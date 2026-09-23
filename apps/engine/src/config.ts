import { readFileSync } from 'node:fs';
import { z } from 'zod';

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    );

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  HOST: z.string().min(1).default('0.0.0.0'),
  NANSEN_API_KEY: z.string().min(1).optional(),
  ENV_FILE: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).default('./data'),
  MODE: z.enum(['auto', 'live', 'replay']).default('auto'),
  REPLAY_FILE: z.string().min(1).default('./replay/session.ndjson'),
  RECORD: z.enum(['0', '1']).default('0'),
  CORS_ORIGINS: csv('http://localhost:3000'),
  PUBLIC_HOSTS: csv(''),
  TARGET_COMPANIES: z.coerce.number().int().positive().default(20),
  SEASON_DAYS: z.coerce.number().int().positive().default(7),
});

export interface Config {
  port: number;
  host: string;
  /** Never logged, never persisted, never sent anywhere except the Nansen `apikey` header. */
  nansenApiKey: string | null;
  mode: 'live' | 'replay';
  dataDir: string;
  replayFile: string;
  record: boolean;
  corsOrigins: string[];
  /** Extra hostnames (besides localhost) accepted in Host/Origin headers on /mcp. */
  publicHosts: string[];
  targetCompanies: number;
  seasonDays: number;
}

function keyFromEnvFile(path: string, readFile: (p: string) => string): string | null {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    throw new Error(`ENV_FILE is not readable: ${path}`);
  }
  const m = text.match(/^\s*NANSEN_API_KEY\s*=\s*(.+?)\s*$/m);
  const raw = m?.[1]?.replace(/^["']|["']$/g, '') ?? '';
  return raw.length > 0 ? raw : null;
}

export function loadConfig(
  env: Record<string, string | undefined>,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): Config {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') cleaned[k] = v;
  const e = EnvSchema.parse(cleaned);
  const key = e.NANSEN_API_KEY ?? (e.ENV_FILE ? keyFromEnvFile(e.ENV_FILE, readFile) : null);
  if (e.MODE === 'live' && !key) throw new Error('MODE=live requires NANSEN_API_KEY');
  const mode = e.MODE === 'auto' ? (key ? 'live' : 'replay') : e.MODE;
  return {
    port: e.PORT,
    host: e.HOST,
    nansenApiKey: key,
    mode,
    dataDir: e.DATA_DIR,
    replayFile: e.REPLAY_FILE,
    record: e.RECORD === '1' && mode === 'live',
    corsOrigins: e.CORS_ORIGINS,
    publicHosts: e.PUBLIC_HOSTS,
    targetCompanies: e.TARGET_COMPANIES,
    seasonDays: e.SEASON_DAYS,
  };
}

/** Safe one-line description for startup logs: the API key is reduced to set/unset. */
export function describeConfig(c: Config): string {
  return JSON.stringify({ ...c, nansenApiKey: c.nansenApiKey ? 'set' : 'unset' });
}
