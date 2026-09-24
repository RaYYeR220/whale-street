'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * One wallet or engine action at a time. The lock is a ref taken synchronously, before the first
 * await: a double click, a second Enter or two calls in the same tick start one action, whatever
 * React has re-rendered. Whatever the action throws goes to `onError`; the lock and the busy state
 * are always released.
 */
export function useActionLock(): {
  busy: string | null;
  /** True from the synchronous start of an action to its end (no render needed). */
  locked(): boolean;
  run(
    name: string,
    fn: () => Promise<void>,
    onError?: (err: unknown) => void | Promise<void>,
  ): Promise<void>;
} {
  const lock = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (
      name: string,
      fn: () => Promise<void>,
      onError?: (err: unknown) => void | Promise<void>,
    ): Promise<void> => {
      if (lock.current !== null) return;
      lock.current = name;
      setBusy(name);
      try {
        await fn();
      } catch (err) {
        await onError?.(err);
      } finally {
        lock.current = null;
        setBusy(null);
      }
    },
    [],
  );
  const locked = useCallback(() => lock.current !== null, []);
  return { busy, locked, run };
}
