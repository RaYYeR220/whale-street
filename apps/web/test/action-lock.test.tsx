// @vitest-environment jsdom
/**
 * The Mirror ticket's one-action-at-a-time lock, on its own: two calls in the same tick (before any
 * re-render could disable or unmount a button) start one action.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useActionLock } from '../components/mirror/useActionLock';

function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

describe('action lock', () => {
  it('starts one action however many calls arrive before a re-render', async () => {
    const { result } = renderHook(() => useActionLock());
    const g = gate();
    const started: string[] = [];
    let first: Promise<void> = Promise.resolve();
    act(() => {
      const { run } = result.current;
      first = run('send', async () => {
        started.push('send');
        await g.promise;
      });
      void run('send', async () => {
        started.push('send again');
      });
      void run('approve', async () => {
        started.push('approve');
      });
    });
    expect(started).toEqual(['send']);
    expect(result.current.busy).toBe('send');
    await act(async () => {
      g.open();
      await first;
    });
    expect(result.current.busy).toBeNull();
    await act(async () => {
      await result.current.run('approve', async () => {
        started.push('approve');
      });
    });
    expect(started).toEqual(['send', 'approve']);
  });

  it('hands a failure to the error handler and always releases the lock', async () => {
    const { result } = renderHook(() => useActionLock());
    const errors: unknown[] = [];
    await act(async () => {
      await result.current.run(
        'send',
        async () => {
          throw new Error('signing failed');
        },
        (err) => {
          errors.push(err);
        },
      );
    });
    expect((errors[0] as Error).message).toBe('signing failed');
    expect(result.current.busy).toBeNull();
  });
});
