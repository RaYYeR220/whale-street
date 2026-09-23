import { PARAMS, type Params } from './params';
import type { CompanyStatus, Position } from './types';

export interface MirrorRequest {
  coin: string;
  notionalUsd: number;
  leverage: number;
  /** Max loss as a fraction of order margin; defaults to params.mirror.defaultStopLossPct. */
  stopLossPct?: number;
}

export interface MirrorContext {
  companyStatus: CompanyStatus;
  snapshotAgeMs: number;
  coinSupported: boolean;
  traderPosition: Position | null;
  mark: number | null;
  hp: number;
  playerOpenMirrors: number;
  playerDailyNotionalUsd: number;
}

export type MirrorRefusalCode =
  | 'COMPANY_NOT_ACTIVE'
  | 'STALE_DATA'
  | 'COIN_UNSUPPORTED'
  | 'NO_POSITION'
  | 'NO_MARK'
  | 'NOTIONAL_OUT_OF_RANGE'
  | 'TOO_MANY_OPEN'
  | 'DAILY_CAP'
  | 'LEVERAGE_CAP'
  | 'STOP_LOSS_TOO_LOOSE'
  | 'NEAR_LIQUIDATION'
  | 'ANTI_FOMO';

export interface MirrorRefusal {
  code: MirrorRefusalCode;
  message: string;
}

export interface MirrorOrder {
  coin: string;
  isBuy: boolean;
  notionalUsd: number;
  size: number;
  leverage: number;
  stopLossPx: number;
  markPx: number;
}

export type MirrorDecision =
  | { allow: true; order: MirrorOrder }
  | { allow: false; refusals: MirrorRefusal[] };

export function evaluateMirror(
  req: MirrorRequest,
  ctx: MirrorContext,
  params: Params = PARAMS,
): MirrorDecision {
  const m = params.mirror;
  const refusals: MirrorRefusal[] = [];
  const refuse = (code: MirrorRefusalCode, message: string) => refusals.push({ code, message });
  const slPct = req.stopLossPct ?? m.defaultStopLossPct;

  if (ctx.companyStatus !== 'ACTIVE')
    refuse('COMPANY_NOT_ACTIVE', `company is ${ctx.companyStatus.toLowerCase()}`);
  if (
    !(
      Number.isFinite(ctx.snapshotAgeMs) &&
      ctx.snapshotAgeMs >= 0 &&
      ctx.snapshotAgeMs <= m.maxSnapshotAgeMs
    )
  )
    refuse('STALE_DATA', 'trader data is older than 60 seconds');
  if (!ctx.coinSupported)
    refuse('COIN_UNSUPPORTED', `${req.coin} cannot be traded through the Nansen Trading API`);
  if (!(req.notionalUsd >= m.minNotionalUsd && req.notionalUsd <= m.maxNotionalUsd)) {
    refuse(
      'NOTIONAL_OUT_OF_RANGE',
      `size must be between $${m.minNotionalUsd} and $${m.maxNotionalUsd}`,
    );
  }
  if (
    !(
      Number.isFinite(ctx.playerOpenMirrors) &&
      ctx.playerOpenMirrors >= 0 &&
      ctx.playerOpenMirrors < m.maxOpen
    )
  )
    refuse('TOO_MANY_OPEN', `at most ${m.maxOpen} open mirrors`);
  if (
    !(
      Number.isFinite(ctx.playerDailyNotionalUsd) &&
      ctx.playerDailyNotionalUsd >= 0 &&
      ctx.playerDailyNotionalUsd + req.notionalUsd <= m.dailyCapUsd
    )
  )
    refuse('DAILY_CAP', `daily mirror cap is $${m.dailyCapUsd}`);
  if (!(slPct > 0 && slPct <= m.maxStopLossPct)) {
    refuse(
      'STOP_LOSS_TOO_LOOSE',
      `stop-loss must risk at most ${Math.round(m.maxStopLossPct * 100)}% of margin`,
    );
  }
  if (!(Number.isFinite(ctx.hp) && ctx.hp >= m.minHp))
    refuse(
      'NEAR_LIQUIDATION',
      Number.isFinite(ctx.hp)
        ? `trader is ${Math.round(ctx.hp * 100)}% from liquidation`
        : 'health data unavailable',
    );

  const tp = ctx.traderPosition;
  const hasPos = tp && Number.isFinite(tp.size) && tp.size !== 0;
  const hasValidMark = ctx.mark !== null && Number.isFinite(ctx.mark) && ctx.mark > 0;
  const pos = hasPos && tp ? tp : null;
  const mark = hasValidMark ? ctx.mark : null;

  if (!hasPos) refuse('NO_POSITION', `trader has no open ${req.coin} position`);
  if (!hasValidMark) refuse('NO_MARK', 'no live mark price');

  if (pos) {
    const allowedLev = Math.min(pos.leverage, m.maxLeverage);
    if (!(req.leverage >= 1 && req.leverage <= allowedLev))
      refuse('LEVERAGE_CAP', `leverage is capped at ${allowedLev}x`);
  }

  if (pos && mark !== null) {
    const long = pos.size > 0;
    const adverse = long ? (mark - pos.entryPx) / pos.entryPx : (pos.entryPx - mark) / pos.entryPx;
    if (!(adverse < m.antiFomoPct)) {
      refuse(
        'ANTI_FOMO',
        Number.isFinite(adverse)
          ? `you'd enter ${(adverse * 100).toFixed(1)}% worse than the trader — that's how FOMO loses money`
          : 'cannot compare with the trader entry price',
      );
    }
  }

  if (refusals.length > 0) return { allow: false, refusals };
  if (!pos || mark === null) return { allow: false, refusals };

  // At this point, pos and mark are valid
  const long = pos.size > 0;
  const move = slPct / req.leverage;
  return {
    allow: true,
    order: {
      coin: req.coin,
      isBuy: long,
      notionalUsd: req.notionalUsd,
      size: req.notionalUsd / mark,
      leverage: req.leverage,
      stopLossPx: long ? mark * (1 - move) : mark * (1 + move),
      markPx: mark,
    },
  };
}
