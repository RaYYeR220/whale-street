'use client';

import { useCallback } from 'react';
import type { ApiResult } from '../../lib/api';
import type { OrderBody, OrderFilled } from '../../lib/api-types';
import { orderErrorText } from '../../lib/errors';
import { pct, price, shares, usd } from '../../lib/format';
import { useDrawer } from '../chrome/Drawer';
import { useToast } from '../chrome/Toast';
import { useApi } from '../providers/engine';
import { usePlayer } from '../providers/player';

const PAST = { BUY: 'Bought', SELL: 'Sold', SHORT: 'Shorted', COVER: 'Covered' } as const;

/** Places a play-money order and announces the fill (GACHA!) or the refusal. */
export function useTrade(): (body: OrderBody) => Promise<ApiResult<OrderFilled>> {
  const api = useApi();
  const { token } = usePlayer();
  const toast = useToast();
  const { open } = useDrawer();
  return useCallback(
    async (body: OrderBody) => {
      if (!token)
        return {
          ok: false,
          status: 0,
          error: 'UNAUTHORIZED',
          message: 'Your player is still signing in.',
        } as const;
      const r = await api.placeOrder(token, body);
      if (!r.ok) {
        toast({
          sfx: '✕',
          kana: 'ダメ',
          title: `Not traded: ${body.ticker}`,
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
    [api, token, toast, open],
  );
}
