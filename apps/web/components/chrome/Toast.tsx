'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export interface ToastInput {
  sfx: string;
  kana: string;
  title: string;
  sub: string;
  action?: { label: string; onClick(): void };
  ms?: number;
}

interface ToastState extends ToastInput {
  id: number;
  leaving: boolean;
}

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const show = useCallback((t: ToastInput) => {
    setToast({ ...t, id: Date.now(), leaving: false });
  }, []);
  useEffect(() => {
    if (!toast || toast.leaving) return;
    const id = setTimeout(
      () => setToast((cur) => (cur && cur.id === toast.id ? { ...cur, leaving: true } : cur)),
      toast.ms ?? 5_200,
    );
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (!toast?.leaving) return;
    const id = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), 260);
    return () => clearTimeout(id);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite">
        {toast ? (
          <div
            className={`ws-toast${toast.leaving ? ' is-leaving' : ''}`}
            role="status"
            key={toast.id}
          >
            <span className="ws-toast__sfx" aria-hidden="true">
              <span>
                {toast.sfx}
                <small>{toast.kana}</small>
              </span>
            </span>
            <span className="ws-toast__b">
              <b>{toast.title}</b>
              <span>{toast.sub}</span>
              {toast.action ? (
                <button className="ws-link" type="button" onClick={toast.action.onClick}>
                  {toast.action.label}
                </button>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (t: ToastInput) => void {
  const t = useContext(ToastContext);
  if (!t) throw new Error('useToast must be used inside <ToastProvider>');
  return t;
}
