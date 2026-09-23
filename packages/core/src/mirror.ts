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
  if (!(ctx.snapshotAgeMs <= m.maxSnapshotAgeMs))
    refuse('STALE_DATA', 'trader data is older than 60 seconds');
  if (!ctx.coinSupported)
    refuse('COIN_UNSUPPORTED', `${req.coin} cannot be traded through the Nansen Trading API`);
  if (!(req.notionalUsd >= m.minNotionalUsd && req.notionalUsd <= m.maxNotionalUsd)) {
    refuse(
      'NOTIONAL_OUT_OF_RANGE',
      `size must be between $${m.minNotionalUsd} and $${m.maxNotionalUsd}`,
    );
  }
  if (!(ctx.playerOpenMirrors < m.maxOpen))
    refuse('TOO_MANY_OPEN', `at most ${m.maxOpen} open mirrors`);
  if (!(ctx.playerDailyNotionalUsd + req.notionalUsd <= m.dailyCapUsd))
    refuse('DAILY_CAP', `daily mirror cap is $${m.dailyCapUsd}`);
  if (!(slPct > 0 && slPct <= m.maxStopLossPct)) {
    refuse(
      'STOP_LOSS_TOO_LOOSE',
      `stop-loss must risk at most ${Math.round(m.maxStopLossPct * 100)}% of margin`,
    );
  }
  if (!(ctx.hp >= m.minHp))
    refuse(
      'NEAR_LIQUIDATION',
      Number.isFinite(ctx.hp)
        ? `trader is ${Math.round(ctx.hp * 100)}% from liquidation`
        : 'health data unavailable',
    );

  const tp = ctx.traderPosition;
  const hasPos = tp && Number.isFinite(tp.size) && tp.size !== 0;
  const hasValidMark = ctx.mark !== null && Number.isFinite(ctx.mark) && ctx.mark > 0;

  if (!hasPos) refuse('NO_POSITION', `trader has no open ${req.coin} position`);
  if (!hasValidMark) refuse('NO_MARK', 'no live mark price');

  if (hasPos && hasValidMark) {
    const allowedLev = Math.min(tp!.leverage, m.maxLeverage);
    if (!(req.leverage >= 1 && req.leverage <= allowedLev))
      refuse('LEVERAGE_CAP', `leverage is capped at ${allowedLev}x`);
    const long = tp!.size > 0;
    const adverse = long
      ? (ctx.mark! - tp!.entryPx) / tp!.entryPx
      : (tp!.entryPx - ctx.mark!) / tp!.entryPx;
    if (!(adverse < m.antiFomoPct)) {
      refuse(
        'ANTI_FOMO',
        Number.isFinite(adverse)
          ? `you'd enter ${(adverse * 100).toFixed(1)}% worse than the trader — that's how FOMO loses money`
          : 'cannot compare with the trader entry price',
      );
    }
  }

  if (refusals.length > 0 || !hasPos || !hasValidMark) return { allow: false, refusals };

  // At this point, hasPos and hasValidMark are both true, so tp and ctx.mark are valid
  const long = tp!.size > 0;
  const move = slPct / req.leverage;
  return {
    allow: true,
    order: {
      coin: req.coin,
      isBuy: long,
      notionalUsd: req.notionalUsd,
      size: req.notionalUsd / ctx.mark!,
      leverage: req.leverage,
      stopLossPx: long ? ctx.mark! * (1 - move) : ctx.mark! * (1 + move),
      markPx: ctx.mark!,
    },
  };
}
