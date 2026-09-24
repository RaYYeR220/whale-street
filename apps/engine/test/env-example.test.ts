import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const text = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
const documented = [...text.matchAll(/^# ([A-Z_]+)=([^\r\n]*)/gm)].map((m) => ({
  key: m[1] ?? '',
  value: m[2] ?? '',
}));

describe('.env.example', () => {
  it('documents every engine setting', () => {
    expect(documented.map((d) => d.key).sort()).toEqual(
      [
        'CORS_ORIGINS',
        'DATA_DIR',
        'ENV_FILE',
        'HOST',
        'MODE',
        'NANSEN_API_KEY',
        'PORT',
        'PUBLIC_HOSTS',
        'RECORD',
        'REPLAY_FILE',
        'SEASON_DAYS',
        'TARGET_COMPANIES',
        'TRUST_PROXY',
      ].sort(),
    );
  });

  it('its example values load and reproduce the defaults (REPLAY without a key)', () => {
    const env = Object.fromEntries(
      documented.filter((d) => d.key !== 'ENV_FILE' && d.value !== '').map((d) => [d.key, d.value]),
    );
    const fromExample = loadConfig(env, () => '');
    expect(fromExample).toEqual(loadConfig({}, () => ''));
    expect(fromExample.mode).toBe('replay');
  });
});
