// @vitest-environment jsdom
/** The landing page has no app chrome, but it must say when its numbers are not live. */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LandingView } from '../components/landing/LandingView';
import { companyView, status, T0 } from './helpers';
import { testRuntime, Wrap } from './render';

class Quiet {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', Quiet);
  vi.stubGlobal('IntersectionObserver', Quiet);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('landing data-health banners', () => {
  it('says it is reconnecting and that marks are delayed, like every app page', () => {
    const rt = testRuntime();
    render(
      <Wrap runtime={rt}>
        <LandingView initialCompanies={[companyView()]} denied={null} />
      </Wrap>,
    );
    expect(document.querySelector('[data-banner]')).toBeNull();
    act(() => {
      rt.store.setConnection('reconnecting');
      rt.store.dispatch({ t: 'status', status: status({ marksDelayed: true }) }, T0);
    });
    const banners = [...document.querySelectorAll('[data-banner]')].map((b) =>
      b.getAttribute('data-banner'),
    );
    expect(banners).toEqual(['ws', 'marks']);
    expect(screen.getByText(/Reconnecting to the floor/)).toBeTruthy();
    // The landing keeps its own header: no app top bar, tab bar or breaking tape.
    expect(document.querySelectorAll('header.ws-topbar')).toHaveLength(1);
    expect(document.querySelector('.ws-tabbar, .ws-breaking')).toBeNull();
  });

  it('says the demo server is waking up first, and only calls the engine unreachable after 90s', () => {
    vi.useFakeTimers();
    const rt = testRuntime();
    render(
      <Wrap runtime={rt}>
        <LandingView initialCompanies={[]} denied={null} />
      </Wrap>,
    );
    act(() => rt.store.setConnection('connecting'));
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.getByText(/Waking the demo server \(free hosting\)/)).toBeTruthy();
    expect(screen.queryByText(/Cannot reach the engine/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(84_000);
    });
    expect(screen.getByText(/Cannot reach the engine/)).toBeTruthy();
    expect(screen.queryByText(/Waking the demo server/)).toBeNull();
    vi.useRealTimers();
  });

  it('labels a replay and the credit saver', () => {
    const rt = testRuntime();
    render(
      <Wrap runtime={rt}>
        <LandingView initialCompanies={[]} denied={null} />
      </Wrap>,
    );
    act(() => {
      rt.store.dispatch(
        { t: 'status', status: status({ mode: 'replay', synthetic: true, creditSaver: true }) },
        T0,
      );
    });
    expect(screen.getByText(/REPLAY/)).toBeTruthy();
    expect(screen.getByText(/CREDIT-SAVER/)).toBeTruthy();
  });
});
