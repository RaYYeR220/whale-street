import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { crowdOf, StreetMood } from '../components/floor/Rails';
import type { MoodEntry } from '../lib/api-types';
import { T0 } from './helpers';
import { Wrap } from './render';

const mood = (o: Partial<MoodEntry> = {}): MoodEntry => ({
  coin: 'BTC',
  smartSkew: 0.5,
  whaleSkew: -1,
  asOf: T0 - 5 * 60_000,
  ...o,
});

describe('street mood crowds', () => {
  it('draws ten figures split by the skew: (1 + skew) / 2 of them lean long', () => {
    expect(crowdOf(0.5)).toEqual({ long: 8, short: 2, longShare: 0.75 });
    expect(crowdOf(-1)).toEqual({ long: 0, short: 10, longShare: 0 });
    expect(crowdOf(1)).toEqual({ long: 10, short: 0, longShare: 1 });
    expect(crowdOf(0)).toEqual({ long: 5, short: 5, longShare: 0.5 });
  });

  it('draws no crowd without a reading, and never an invented even split', () => {
    expect(crowdOf(null)).toBeNull();
    expect(crowdOf(Number.NaN)).toBeNull();
    expect(crowdOf(1.5)).toBeNull();
  });
});

describe('the street mood panel', () => {
  it('shows each crowd from its skew, the lean and the reading age on engine time', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <StreetMood mood={[mood()]} now={T0} />
      </Wrap>,
    );
    expect(html).toContain('Smart traders on BTC: 75% long, 25% short');
    expect(html).toContain('Whales on BTC: 0% long, 100% short');
    expect(html).toContain('leans long');
    expect(html).toContain('read 5 min ago');
  });

  it('says there is no reading for an unknown side', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <StreetMood mood={[mood({ coin: 'ETH', smartSkew: null, whaleSkew: null })]} now={T0} />
      </Wrap>,
    );
    expect(html).toContain('Smart traders on ETH: no reading');
    expect(html).toContain('Whales on ETH: no reading');
    expect(html).not.toContain('% long');
  });

  it('leaves the age out until engine time is known', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <StreetMood mood={[mood()]} now={null} />
      </Wrap>,
    );
    expect(html).not.toContain('min ago');
  });
});
