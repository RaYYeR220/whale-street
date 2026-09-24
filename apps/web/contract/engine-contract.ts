/**
 * Compile-time contract between the engine and the web client: every payload the engine sends
 * must be assignable to the type the web expects, and every message the web sends must be one the
 * engine accepts. Checked by the root `pnpm typecheck` (this folder is in the root tsconfig).
 * If a check fails, the engine is the source of truth: update apps/web/lib/api-types.ts.
 */
import type {
  ClientMessage as EClient,
  ServerMessage as EServer,
} from '../../engine/src/api/protocol';
import type { StatusView as EStatus } from '../../engine/src/engine';
import type {
  FilingView as EFiling,
  IpoUpdate as EIpo,
  TapeView as ETape,
} from '../../engine/src/events';
import type {
  CompanyView as ECompany,
  MarketEntry as EMarket,
} from '../../engine/src/market/state';
import type {
  HolderView as EHolder,
  LeaderboardEntry as ELeader,
  OrderResult as EOrder,
  PortfolioView as EPortfolio,
  QuoteResult as EQuote,
} from '../../engine/src/services/exchange';
import type { IpoView as EIpoView } from '../../engine/src/services/ipo';
import type {
  MirrorOrderView as EMirrorOrder,
  PrepareResult as EPrepare,
  MirrorReceipt as EReceipt,
  MirrorStep as EStep,
} from '../../engine/src/services/mirror';
import type { PlayerView as EPlayer } from '../../engine/src/services/players';
import type * as W from '../lib/api-types';

/** Compiles only when `Engine` is assignable to `Web`. */
type Accepts<Web, Engine extends Web> = [Web, Engine];

export type EngineToWeb = [
  Accepts<W.StatusView, EStatus>,
  Accepts<W.PlayerView, EPlayer>,
  Accepts<W.CompanyView, ECompany>,
  Accepts<W.MarketEntry, EMarket>,
  Accepts<W.FilingView, EFiling>,
  Accepts<W.TapeView, ETape>,
  Accepts<W.IpoUpdate, EIpo>,
  Accepts<W.IpoView, EIpoView>,
  Accepts<W.PortfolioView, EPortfolio>,
  Accepts<W.LeaderboardEntry, ELeader>,
  Accepts<W.HolderView, EHolder>,
  Accepts<W.QuoteView, Extract<EQuote, { ok: true }>>,
  Accepts<W.OrderFilled, Extract<EOrder, { ok: true }>>,
  Accepts<W.ServerMessage, EServer>,
  Accepts<W.PrepareView, Extract<EPrepare, { ok: true }>>,
  Accepts<W.MirrorStep, EStep>,
  Accepts<W.MirrorReceipt, EReceipt>,
  Accepts<W.MirrorOrderView, EMirrorOrder>,
];

export type WebToEngine = [Accepts<EClient, W.ClientMessage>];
