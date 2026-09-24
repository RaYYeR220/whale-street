import { describe, expect, it } from 'vitest';
import { createReplayClock } from '../src/clock';
import { describeConfig, loadConfig } from '../src/config';
import { daysBefore, utcDate } from '../src/dates';

const noFile = () => {
  throw new Error('no file');
};

describe('loadConfig', () => {
  it('defaults to replay without a key', () => {
    const c = loadConfig({}, noFile);
    expect(c).toMatchObject({
      port: 8787,
      host: '0.0.0.0',
      mode: 'replay',
      nansenApiKey: null,
      dataDir: './data',
      replayFile: './replay/session.ndjson',
      record: false,
      corsOrigins: ['http://localhost:3000'],
      publicHosts: [],
      targetCompanies: 20,
      seasonDays: 7,
      trustProxy: 0,
    });
  });

  it('TRUST_PROXY is a hop count (integer >= 0)', () => {
    expect(loadConfig({ TRUST_PROXY: '1' }, noFile).trustProxy).toBe(1);
    expect(() => loadConfig({ TRUST_PROXY: '-1' }, noFile)).toThrow();
    expect(() => loadConfig({ TRUST_PROXY: 'true' }, noFile)).toThrow();
    expect(() => loadConfig({ TRUST_PROXY: '1.5' }, noFile)).toThrow();
  });

  it('auto mode goes live when a key is present; empty values count as unset', () => {
    expect(loadConfig({ NANSEN_API_KEY: 'k1' }, noFile).mode).toBe('live');
    expect(loadConfig({ NANSEN_API_KEY: '' }, noFile).mode).toBe('replay');
    expect(loadConfig({ NANSEN_API_KEY: 'k1', MODE: 'replay' }, noFile).mode).toBe('replay');
  });

  it('reads the key from ENV_FILE when not in the environment', () => {
    const c = loadConfig({ ENV_FILE: '/x/.env' }, (p) => {
      expect(p).toBe('/x/.env');
      return 'OTHER=1\nNANSEN_API_KEY="abc123"\n';
    });
    expect(c.nansenApiKey).toBe('abc123');
    expect(c.mode).toBe('live');
  });

  it('ENV_FILE: an inline # comment is not part of an unquoted key; a quoted key keeps its #', () => {
    const key = (text: string) => loadConfig({ ENV_FILE: '/x/.env' }, () => text).nansenApiKey;
    expect(key('NANSEN_API_KEY=abc123 # my key\n')).toBe('abc123');
    expect(key('NANSEN_API_KEY=abc123#note')).toBe('abc123');
    expect(key('NANSEN_API_KEY="abc#123" # quoted\n')).toBe('abc#123');
    expect(key("NANSEN_API_KEY='abc123'   \r\n")).toBe('abc123');
    expect(key('export NANSEN_API_KEY=abc123\n')).toBe('abc123');
    expect(key('NANSEN_API_KEY= # nothing here\n')).toBeNull();
    expect(key('# NANSEN_API_KEY=commented-out\n')).toBeNull();
  });

  it('refuses MODE=live without a key and parses csv lists and numbers', () => {
    expect(() => loadConfig({ MODE: 'live' }, noFile)).toThrow('MODE=live requires NANSEN_API_KEY');
    const c = loadConfig(
      {
        CORS_ORIGINS: 'https://a.app, https://b.app',
        PORT: '9000',
        RECORD: '1',
        NANSEN_API_KEY: 'k',
      },
      noFile,
    );
    expect(c.corsOrigins).toEqual(['https://a.app', 'https://b.app']);
    expect(c.port).toBe(9000);
    expect(c.record).toBe(true);
    expect(loadConfig({ RECORD: '1' }, noFile).record).toBe(false);
  });

  it('describeConfig never contains the key', () => {
    const c = loadConfig({ NANSEN_API_KEY: 'super-secret-key' }, noFile);
    const s = describeConfig(c);
    expect(s).not.toContain('super-secret-key');
    expect(s).toContain('"nansenApiKey":"set"');
  });
});

describe('replay clock', () => {
  it('loops over [startT, endT) and reports wraps once', () => {
    let wall = 1_000;
    const clock = createReplayClock(500, 600, 1_000, () => wall);
    const wraps: number[] = [];
    clock.onWrap(() => wraps.push(wall));
    expect(clock.now()).toBe(500);
    wall = 1_050;
    expect(clock.now()).toBe(550);
    expect(clock.poll()).toBe(false);
    wall = 1_120;
    expect(clock.now()).toBe(520);
    expect(clock.poll()).toBe(true);
    expect(clock.poll()).toBe(false);
    expect(wraps).toEqual([1_120]);
  });
});

describe('dates', () => {
  it('formats UTC dates', () => {
    expect(utcDate(Date.UTC(2026, 8, 23, 23, 59))).toBe('2026-09-23');
    expect(daysBefore(Date.UTC(2026, 8, 23), 365)).toBe('2025-09-23');
  });
});
