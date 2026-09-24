'use client';

import { useCallback } from 'react';
import type { ApiResult } from '../../lib/api';
import type { OrderBody, OrderFilled } from '../../lib/api-types';
import { orderErrorText } from '../../lib/errors';
import { pct, price, shares, usd } from '../../lib/format';
import { useDrawer } from '../chrome/Drawer';
import { useToast } from '../chrome/Toast';
import { useEngineRuntime } from '../providers/engine';
import { usePlayer } from '../providers/player';

const PAST = { BUY: 'Bought', SELL: 'Sold', SHORT: 'Shorted', COVER: 'Covered' } as const;
/** The engine's suggested wait when a MARKET_PAUSED reply does not say (it sends 2 s). */
export const PAUSED_RETRY_MS = 2_000;

export interface TradeOptions {
  /**
   * The engine refused with MARKET_PAUSED (idle, marks delayed, or not ticked since boot): the
   * refused order itself wakes it, and the order is sent once more after its delay. `label` says
   * which ("Market waking up…" after an idle stretch, "Market opening…" otherwise).
   */
  onPaused?(label: string): void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Places a play-money order and announces the fill (GACHA!) or the refusal. A MARKET_PAUSED
 * refusal is retried once after the engine's retryAfterMs; a second one is shown as the refusal.
 */
export function useTrade(): (body: OrderBody, o?: TradeOptions) => Promise<ApiResult<OrderFilled>> {
  const { api, store } = useEngineRuntime();
  const { token } = usePlayer();
  const toast = useToast();
  const { open } = useDrawer();
  return useCallback(
    async (body: OrderBody, o: TradeOptions = {}) => {
      if (!token)
        return {
          ok: false,
          status: 0,
          error: 'UNAUTHORIZED',
          message: 'Your player is still signing in.',
        } as const;
      // Read before sending: the order wakes an idle engine, and its status changes at once.
      const wasIdle = store.getState().status?.idle ?? false;
      let r = await api.placeOrder(token, body);
      if (!r.ok && r.error === 'MARKET_PAUSED') {
        const label = wasIdle ? 'Market waking up…' : 'Market opening…';
        if (o.onPaused) o.onPaused(label);
        else
          toast({
            sfx: '…',
            kana: 'まって',
            title: label,
            sub: `Prices are catching up. Your ${body.ticker} order is sent again in a moment.`,
          });
        await wait(r.retryAfterMs ?? PAUSED_RETRY_MS);
        r = await api.placeOrder(token, body);
      }
      if (!r.ok) {
        // A timeout may have traded: the engine got the order and did not answer in time.
        toast({
          sfx: '✕',
          kana: 'ダメ',
          title:
            r.error === 'TIMEOUT' ? `No answer yet: ${body.ticker}` : `Not traded: ${body.ticker}`,
          sub: orderErrorText(r.error, r.message),
        });
        return r;
      }
      const f = r.data.fill;
      const buying = f.side === 'BUY' || f.side === 'COVER';
      toast({
        sfx: 'GACHA!',
        kana: 'ガチャ',
        title: `${PAST[f.side]} ${shares(f.qty)} ${f.ticker} at ${price(f.avgPrice)}`,
        sub: `${usd(f.cash)} ${buying ? 'from cash' : 'to cash'}. Your trade moved the price ${pct(f.multiplierAfter / f.multiplierBefore - 1, 2)}.`,
        action: { label: 'Open your desk', onClick: () => open({ kind: 'desk' }) },
      });
      return r;
    },
    [api, store, token, toast, open],
  );
}
