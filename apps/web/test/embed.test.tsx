// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedWidget } from '../components/embed/EmbedWidget';
import { EngineProvider, useEngineRuntime } from '../components/providers/engine';
import { isBarePath, Providers } from '../components/providers/Providers';
import { usePlayer } from '../components/providers/player';
import { portraitSrc } from '../lib/og/og';
import { companyView, entry, market, T0 } from './helpers';
import { testRuntime } from './render';

const nav = vi.hoisted(() => ({ path: '/' as string | null }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));

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

  it('says REPLAY from the server-rendered status before the socket has said anything', () => {
    const rt = testRuntime();
    render(
      <EngineProvider runtime={rt}>
        <EmbedWidget view={companyView()} history={[]} siteUrl="" initialMode="replay" />
      </EngineProvider>,
    );
    expect(screen.getByText('REPLAY')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('aria-label')).toMatch(
      /A recorded session, not live prices/,
    );
  });

  it('credits Nansen on the widget itself', () => {
    render(
      <EngineProvider runtime={testRuntime()}>
        <EmbedWidget view={companyView()} history={[]} siteUrl="" initialMode="live" />
      </EngineProvider>,
    );
    expect(screen.getByText('Powered by Nansen API')).toBeTruthy();
    expect(screen.queryByText('REPLAY')).toBeNull();
    // The card is one link whose label replaces its text: the credit is in the label too.
    expect(screen.getByRole('link').getAttribute('aria-label')).toMatch(/Powered by Nansen API\./);
  });

  it('keeps the REPLAY tag and the Nansen credit on their own line, apart from HP', () => {
    render(
      <EngineProvider runtime={testRuntime()}>
        <EmbedWidget view={companyView()} history={[]} siteUrl="" initialMode="replay" />
      </EngineProvider>,
    );
    const src = screen.getByText('Powered by Nansen API');
    const hp = screen.getByText('HP 80%');
    expect(src.parentElement).toBe(screen.getByText('REPLAY').parentElement);
    expect(hp.parentElement).not.toBe(src.parentElement);
    expect(hp.parentElement?.textContent).toContain('Whale Street');
  });

  it('says it is offline instead of showing a stale HP', () => {
    const rt = testRuntime();
    render(
      <EngineProvider runtime={rt}>
        <EmbedWidget view={companyView()} history={[]} siteUrl="" />
      </EngineProvider>,
    );
    act(() => rt.store.setConnection('reconnecting'));
    expect(screen.getByText('offline').getAttribute('title')).toBe('Reconnecting to Whale Street');
    expect(screen.queryByText(/^HP /)).toBeNull();
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

describe('the embed widget stays anonymous', () => {
  /** Needs the engine and a player; throws when the tree around it has no player. */
  function Probe() {
    useEngineRuntime();
    usePlayer();
    return null;
  }
  const read = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8');

  it('gets the engine from the root providers but no player, so a view signs nobody up', () => {
    nav.path = '/embed/OOH';
    expect(isBarePath('/embed/OOH')).toBe(true);
    expect(() =>
      renderToStaticMarkup(
        <Providers>
          <Probe />
        </Providers>,
      ),
    ).toThrow(/inside <PlayerProvider>/);
  });

  it('gives the app and the landing page their player, from the one root tree', () => {
    for (const path of ['/', '/floor', '/c/OOH', '/embedded-news']) {
      nav.path = path;
      expect(isBarePath(path), path).toBe(false);
      expect(
        () =>
          renderToStaticMarkup(
            <Providers>
              <Probe />
            </Providers>,
          ),
        path,
      ).not.toThrow();
    }
    // Only the root layout mounts the providers: no route group adds a second player tree.
    expect(read('app/layout.tsx')).toContain('<Providers>');
    expect(read('app/(app)/layout.tsx')).not.toMatch(/<\w*Providers?>/);
    expect(read('app/(bare)/embed/[ticker]/page.tsx')).not.toContain('Player');
  });
});
