// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmbedWidget } from '../components/embed/EmbedWidget';
import { EngineProvider } from '../components/providers/engine';
import { portraitSrc } from '../lib/og/og';
import { companyView, entry, market, T0 } from './helpers';
import { testRuntime } from './render';

afterEach(cleanup);

describe('embed widget', () => {
  it('says REPLAY when the engine replays a recording', () => {
    const rt = testRuntime();
    render(
      <EngineProvider runtime={rt}>
        <EmbedWidget view={companyView()} history={[]} siteUrl="https://whale.example" />
      </EngineProvider>,
    );
    expect(screen.queryByText('REPLAY')).toBeNull();
    act(() => rt.store.dispatch(market(T0, [entry()]), T0));
    expect(screen.getByText('REPLAY')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://whale.example/c/OOH');
    expect(screen.getByRole('link').getAttribute('aria-label')).toMatch(
      /A recorded session, not live prices/,
    );
  });

  it('says it is reconnecting instead of showing a stale HP', () => {
    const rt = testRuntime();
    render(
      <EngineProvider runtime={rt}>
        <EmbedWidget view={companyView()} history={[]} siteUrl="" />
      </EngineProvider>,
    );
    act(() => rt.store.setConnection('reconnecting'));
    expect(screen.getByText('reconnecting')).toBeTruthy();
  });
});

describe('open graph portraits', () => {
  it('embeds a self-contained SVG', () => {
    const src = portraitSrc({ seed: 'OOH', hp: 0.5, size: 360 });
    expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = Buffer.from(src.split(',')[1] ?? '', 'base64').toString('utf8');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toContain('var(');
  });
});
