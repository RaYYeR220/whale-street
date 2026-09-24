'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { DeskDrawer } from '../desk/DeskDrawer';
import { EvidenceDrawer } from '../desk/EvidenceDrawer';

export type DrawerRequest =
  | { kind: 'desk' }
  | { kind: 'evidence'; ticker?: string; provenance?: readonly string[] };

interface DrawerApi {
  open(req: DrawerRequest): void;
  close(): void;
}

const DrawerContext = createContext<DrawerApi | null>(null);

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex="0"]';

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DrawerRequest | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  const open = useCallback((r: DrawerRequest) => {
    lastFocus.current = document.activeElement as HTMLElement | null;
    setReq(r);
  }, []);
  const close = useCallback(() => {
    setReq(null);
    lastFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    if (!req) return;
    const t = setTimeout(() => closeBtn.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const f = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (x) => x.offsetParent !== null,
      );
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
    };
  }, [req, close]);

  const title = req?.kind === 'evidence' ? 'Where these numbers come from' : 'Your desk';
  return (
    <DrawerContext.Provider value={{ open, close }}>
      {children}
      <div className={`ws-scrim${req ? ' is-open' : ''}`} onClick={close} aria-hidden="true" />
      <aside
        ref={panel}
        className={`ws-drawer${req ? ' is-open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        aria-hidden={req ? undefined : true}
      >
        <div className="ws-drawer__head">
          <h2 id="drawer-title">{title}</h2>
          <button ref={closeBtn} className="ws-x" type="button" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <div className="ws-drawer__body">
          {req?.kind === 'desk' ? <DeskDrawer onNavigate={close} /> : null}
          {req?.kind === 'evidence' ? (
            <EvidenceDrawer ticker={req.ticker} provenance={req.provenance} />
          ) : null}
        </div>
      </aside>
    </DrawerContext.Provider>
  );
}

export function useDrawer(): DrawerApi {
  const d = useContext(DrawerContext);
  if (!d) throw new Error('useDrawer must be used inside <DrawerProvider>');
  return d;
}

/** The tiny "N" mark next to every number that comes from Nansen; opens the evidence drawer. */
export function NMark({
  label,
  ticker,
  provenance,
}: {
  label: string;
  ticker?: string;
  provenance?: readonly string[];
}): ReactNode {
  const { open } = useDrawer();
  return (
    <button
      className="ws-n"
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        open({ kind: 'evidence', ticker, provenance });
      }}
    >
      N
    </button>
  );
}
