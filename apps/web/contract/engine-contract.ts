/**
 * Compile-time contract between the engine and the web client, checked by the root
 * `pnpm typecheck` (this folder is in the root tsconfig) and by the web's own typecheck:
 * - every payload the engine sends is assignable to the type the web expects;
 * - every key the engine sends, at any depth, is one the web type declares (a field the engine
 *   adds fails here until the web says what it does with it);
 * - the error codes the web words for players are exactly the engine's;
 * - every message the web sends is one the engine accepts.
 * The engine types are imported, never copied; the few REST shapes api/rest.ts assembles inline
 * are derived from the rows they map, and test/engine-shapes.test.ts pins their keys at runtime
 * against the real routes. If a check fails, the engine is the source of truth: update
 * apps/web/lib/api-types.ts.
 */
import type {
  ClientMessage as EClient,
  ServerMessage as EServer,
} from '../../engine/src/api/protocol';
import type {
  NansenCallRow as ECall,
  NavPointRow as ENavPoint,
  PlayerRow as EPlayerRow,
  SeasonRow as ESeason,
  SeasonResultRow as ESeasonResult,
  TradeRow as ETrade,
} from '../../engine/src/db/repos';
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
import type {
  ApplyErrorCode as EApplyError,
  IpoView as EIpoView,
} from '../../engine/src/services/ipo';
import type {
  MirrorErrorCode as EMirrorError,
  MirrorOrderView as EMirrorOrder,
  PrepareResult as EPrepare,
  MirrorReceipt as EReceipt,
  MirrorStep as EStep,
  MirrorService,
} from '../../engine/src/services/mirror';
import type {
  LinkErrorCode as ELinkError,
  PlayerView as EPlayer,
} from '../../engine/src/services/players';
import type * as W from '../lib/api-types';

/** Compiles only when `Engine` is assignable to `Web`. */
type Accepts<Web, Engine extends Web> = [Web, Engine];

/** The members of the web union that accept this engine value. */
type MatchOf<W, E> = W extends unknown ? (E extends W ? W : never) : never;
/**
 * Every key path the engine type has that the web type does not declare ("StatusView.loop"),
 * through nested objects, arrays and union members; never when the web knows every field.
 */
type UnknownKeys<W, E, P extends string> = unknown extends W
  ? never
  : E extends readonly (infer EI)[]
    ? UnknownKeys<W extends readonly (infer WI)[] ? WI : never, EI, `${P}[]`>
    : E extends object
      ? MatchOf<W, E> extends infer M
        ? [M] extends [never]
          ? never
          : {
              [K in keyof E & string]-?: K extends keyof M
                ? UnknownKeys<M[K], E[K], `${P}.${K}`>
                : `${P}.${K}`;
            }[keyof E & string]
        : never
      : never;
/** A web type mirrors an engine one: assignable, and no key the web does not know. */
type Mirrors<Name extends string, Web, Engine extends Web> = [
  Web,
  Engine,
  UnknownKeys<Web, Engine, Name>,
];
/** Compiles only when no engine key is unknown to the web; the error lists the missing paths. */
type NoUnknownKeys<Paths extends never> = Paths;

/** GET /api/mirror/builder-fee answers with the status MirrorService.builderStatus resolves to. */
type EBuilderFee = Extract<
  Awaited<ReturnType<MirrorService['builderStatus']>>,
  { ok: true }
>['status'];
/** POST /api/mirror/prepare: the route answers a policy refusal as `{ ...result, ok: false }`. */
type EPrepareOk = Extract<EPrepare, { ok: true }>;
type EPrepareWire =
  | Exclude<EPrepareOk, { refusals: unknown }>
  | (Omit<Extract<EPrepareOk, { refusals: unknown }>, 'ok'> & { ok: false });
/** The shapes api/rest.ts assembles inline from repository rows. */
// GET /api/companies/:ticker/history → points.map(({ t, nav, price }) => ({ t, nav, price }))
type EHistoryPoint = Pick<ENavPoint, 't' | 'nav' | 'price'>;
// GET /api/players/:handle → trades.map((t) => ({ ...t, ticker }))
type ETradeView = ETrade & { ticker: string };
// GET /api/seasons/:id → results.map((r) => ({ rank, netWorth, handle, kind }))
type ESeasonResultView = Pick<ESeasonResult, 'rank' | 'netWorth'> &
  Pick<EPlayerRow, 'handle' | 'kind'>;

// GET /api/players/:handle → player: { ...playerView(row) minus walletAddress, walletLinked }
type EPublicPlayer = Omit<EPlayer, 'walletAddress'> & { walletLinked: boolean };

export type EngineToWeb = [
  Mirrors<'StatusView', W.StatusView, EStatus>,
  Mirrors<'PlayerView', W.PlayerView, EPlayer>,
  Mirrors<'PublicPlayerView', W.PublicPlayerView, EPublicPlayer>,
  Mirrors<'CompanyView', W.CompanyView, ECompany>,
  Mirrors<'MarketEntry', W.MarketEntry, EMarket>,
  Mirrors<'FilingView', W.FilingView, EFiling>,
  Mirrors<'TapeView', W.TapeView, ETape>,
  Mirrors<'IpoUpdate', W.IpoUpdate, EIpo>,
  Mirrors<'IpoView', W.IpoView, EIpoView>,
  Mirrors<'PortfolioView', W.PortfolioView, EPortfolio>,
  Mirrors<'LeaderboardEntry', W.LeaderboardEntry, ELeader>,
  Mirrors<'HolderView', W.HolderView, EHolder>,
  Mirrors<'QuoteView', W.QuoteView, Extract<EQuote, { ok: true }>>,
  Mirrors<'OrderFilled', W.OrderFilled, Extract<EOrder, { ok: true }>>,
  Mirrors<'ServerMessage', W.ServerMessage, EServer>,
  Mirrors<'PrepareView', W.PrepareView, EPrepareWire>,
  Mirrors<'MirrorStep', W.MirrorStep, EStep>,
  Mirrors<'MirrorReceipt', W.MirrorReceipt, EReceipt>,
  Mirrors<'MirrorOrderView', W.MirrorOrderView, EMirrorOrder>,
  Mirrors<'BuilderFeeStatus', W.BuilderFeeStatus, EBuilderFee>,
  Mirrors<'SeasonRow', W.SeasonRow, ESeason>,
  Mirrors<'SeasonResultRow', W.SeasonResultRow, ESeasonResult>,
  Mirrors<'SeasonResultView', W.SeasonResultView, ESeasonResultView>,
  Mirrors<'TradeRowView', W.TradeRowView, ETradeView>,
  Mirrors<'NansenCallView', W.NansenCallView, ECall>,
  Mirrors<'HistoryPoint', W.HistoryPoint, EHistoryPoint>,
];

export type EngineKeysKnown = NoUnknownKeys<EngineToWeb[number][2]>;

export type WebToEngine = [Accepts<EClient, W.ClientMessage>];

/** Error codes the web words for players: the same set as the engine's, in both directions. */
export type SameCodes = [
  Accepts<W.LinkErrorCode, ELinkError>,
  Accepts<ELinkError, W.LinkErrorCode>,
  Accepts<W.IpoApplyErrorCode, EApplyError>,
  Accepts<EApplyError, W.IpoApplyErrorCode>,
  Accepts<W.MirrorErrorCode, EMirrorError>,
  Accepts<EMirrorError, W.MirrorErrorCode>,
];
