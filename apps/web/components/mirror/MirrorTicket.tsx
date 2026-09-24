'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnect, useConnection, useConnectors, useSignMessage } from 'wagmi';
import { getWalletClient } from 'wagmi/actions';
import type { CompanyView, MirrorOrderView, MirrorReason } from '../../lib/api-types';
import { side } from '../../lib/company';
import { coinPx, pctAbs, shortAddress, usd } from '../../lib/format';
import { isUsable, newAgent } from '../../lib/mirror/agent';
import { type MirrorOutcome, type MirrorProgress, runMirror } from '../../lib/mirror/flow';
import { approveAgentOnHl, approveBuilderFeeOnHl, hlErrorText } from '../../lib/mirror/hl';
import { createIdbKeyStore } from '../../lib/mirror/keystore';
import { linkWallet } from '../../lib/mirror/link';
import {
  checkRows,
  MIRROR,
  mirrorUsage,
  previewContext,
  previewMirror,
} from '../../lib/mirror/policy';
import { BUILDER_FEE_CEILING, walletConfig } from '../../lib/mirror/wallet-config';
import { useDrawer } from '../chrome/Drawer';
import { Hanko } from '../ink/Hanko';
import { useReducedMotion } from '../ink/motion';
import { useSfx } from '../ink/Sfx';
import { useApi, useEngineNow } from '../providers/engine';
import { usePlayer } from '../providers/player';

type Step = 'connect' | 'link' | 'approve' | 'pick' | 'size' | 'check' | 'sign';
const STEPS: Array<[Step, string]> = [
  ['connect', 'Connect your wallet'],
  ['link', 'Link it to your player'],
  ['approve', 'Approve the agent key'],
  ['pick', "Pick the trader's position"],
  ['size', 'Size, leverage and stop'],
  ['check', 'Committee check'],
  ['sign', 'Sign and send'],
];

const TICK = (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle cx="9" cy="9" r="8" fill="#0078bf" />
    <path
      d="M5 9.4 7.8 12 13 6.4"
      fill="none"
      stroke="#f3eee2"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const QMARK = (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle
      cx="9"
      cy="9"
      r="7.8"
      fill="#f3eee2"
      stroke="#005d94"
      strokeWidth="1.8"
      strokeDasharray="3 2"
    />
    <text
      x="9"
      y="13"
      textAnchor="middle"
      fontFamily="Zen Kaku Gothic New,sans-serif"
      fontWeight="900"
      fontSize="11"
      fill="#005d94"
    >
      ?
    </text>
  </svg>
);

const store = typeof window === 'undefined' ? null : createIdbKeyStore();

function hint(r: MirrorReason, view: CompanyView, coin: string): string {
  const p = view.positions.find((x) => x.coin === coin);
  switch (r.code) {
    case 'ANTI_FOMO':
      return p
        ? `The trader got in at ${coinPx(p.entryPx)}. Mirror opens again if ${p.coin} comes back ${side(p) === 'LONG' ? 'under' : 'above'} ${coinPx(side(p) === 'LONG' ? p.entryPx * (1 + MIRROR.antiFomoPct) : p.entryPx * (1 - MIRROR.antiFomoPct))}, or pick a different position.`
        : '';
    case 'NEAR_LIQUIDATION':
      return `Mirror unlocks when ${view.ticker}'s HP is back above ${Math.round(MIRROR.minHp * 100)}%. Copying a trader this close to liquidation is how you get liquidated with them.`;
    case 'COMPANY_NOT_ACTIVE':
      return view.status === 'HALTED'
        ? 'Mirror reopens when trading resumes.'
        : 'A bankrupt company has nothing left to copy.';
    case 'STALE_DATA':
      return 'We only copy positions seen in the last minute. The engine fetches a fresh snapshot when you send.';
    case 'NOTIONAL_OUT_OF_RANGE':
      return `Enter between $${MIRROR.minNotionalUsd} and $${MIRROR.maxNotionalUsd}.`;
    case 'DAILY_CAP':
      return `The daily mirror cap is $${MIRROR.dailyCapUsd}.`;
    case 'TOO_MANY_OPEN':
      return 'Close one of your mirrors on Hyperliquid first.';
    case 'LEVERAGE_CAP':
      return 'Lower the leverage.';
    case 'STOP_LOSS_TOO_LOOSE':
      return `Tighten the stop to ${Math.round(MIRROR.maxStopLossPct * 100)}% of margin or less.`;
    case 'NO_POSITION':
      return 'The trader closed it. Pick another position.';
    case 'COIN_UNSUPPORTED':
      return 'Pick a position in a coin the Nansen Trading API can route.';
    case 'NO_MARK':
      return 'Hyperliquid has no live price for this coin right now. Try again in a moment.';
    case 'BELOW_MIN_SIZE':
      return 'At this price the order rounds below the smallest size Hyperliquid accepts. Raise the amount.';
    case 'POLICY_CHANGED':
      return 'The trader or the market moved between prepare and send. Check the stamps and send again.';
    case 'TRADING_UNAVAILABLE':
      return 'Real orders cannot be placed from the engine’s region right now.';
  }
  return '';
}

/** "Mirror with real money": wallet → link → agent key → position → size → committee → sign → receipt. */
export function MirrorTicket({ view }: { view: CompanyView }) {
  const api = useApi();
  const { token, player, refresh } = usePlayer();
  const now = useEngineNow();
  const reduce = useReducedMotion();
  const { open } = useDrawer();
  const { node: sfx, fire } = useSfx();
  const conn = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const signMessage = useSignMessage();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [agentReady, setAgentReady] = useState<boolean | null>(null);
  const [orders, setOrders] = useState<MirrorOrderView[]>([]);
  const [coin, setCoin] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  const [usdAmt, setUsdAmt] = useState(50);
  const [lev, setLev] = useState(2);
  const [sl, setSl] = useState(MIRROR.defaultStopLossPct);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<MirrorOutcome | null>(null);
  const [progress, setProgress] = useState<MirrorProgress | null>(null);

  const address = conn.address?.toLowerCase() ?? null;
  const linked = !!address && player?.walletAddress === address;

  useEffect(() => {
    let cancelled = false;
    void api.mirrorStatus().then((r) => {
      if (!cancelled) setAvailable(r.ok && r.data.available);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const loadOrders = useCallback(async () => {
    if (!token) return;
    const r = await api.mirrorOrders(token);
    if (r.ok) setOrders(r.data.orders);
  }, [api, token]);
  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    if (!address || !store) {
      setAgentReady(null);
      return;
    }
    let cancelled = false;
    void store.load(address).then((r) => {
      if (!cancelled) setAgentReady(isUsable(r, Date.now()));
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  useEffect(() => {
    if (coin && view.positions.some((p) => p.coin === coin)) return;
    const first = view.positions[0];
    setCoin(first ? first.coin : null);
  }, [view.positions, coin]);

  const pos = view.positions.find((p) => p.coin === coin) ?? null;
  const allowedLev = pos
    ? Math.max(1, Math.min(Math.floor(pos.leverage), MIRROR.maxLeverage))
    : MIRROR.maxLeverage;
  useEffect(() => {
    setLev((l) => Math.max(1, Math.min(l, allowedLev)));
  }, [allowedLev]);

  const usage = useMemo(() => mirrorUsage(orders, now ?? Date.now()), [orders, now]);
  const req = { coin: coin ?? '', notionalUsd: usdAmt, leverage: lev, stopLossPct: sl };
  const ctx = previewContext(view, coin ?? '', now ?? Date.now(), usage);
  const decision = previewMirror(req, ctx);
  const rows = checkRows(req, ctx, decision, view.ticker);
  const fails = rows.filter((r) => r.fail).length;

  const current: Step = !conn.address
    ? 'connect'
    : !linked
      ? 'link'
      : !agentReady
        ? 'approve'
        : !picked
          ? 'pick'
          : 'size';

  const doConnect = async (id: string) => {
    setProblem(null);
    const c = connectors.find((x) => x.uid === id);
    if (!c) return;
    try {
      await connect.mutateAsync({ connector: c });
    } catch (err) {
      setProblem(hlErrorText(err));
    }
  };

  const doLink = async () => {
    if (!token || !address) return;
    setBusy('link');
    setProblem(null);
    const r = await linkWallet(api, token, address, (message) =>
      signMessage.mutateAsync({ message }),
    );
    setBusy(null);
    if (!r.ok) setProblem(r.message);
    else await refresh();
  };

  const doApprove = async () => {
    if (!token || !address || !store) return;
    setBusy('approve');
    setProblem(null);
    try {
      const wallet = await getWalletClient(walletConfig);
      const now0 = Date.now();
      const saved = await store.load(address);
      const rec =
        saved && saved.approvedAt === null && saved.validUntil > now0
          ? saved
          : newAgent(address, now0);
      await store.save(rec);
      await approveAgentOnHl({ wallet }, rec);
      await store.save({ ...rec, approvedAt: Date.now() });
      const fee = await api.builderFee(token);
      if (!fee.ok) throw new Error(fee.message);
      if (!fee.data.approved)
        await approveBuilderFeeOnHl(
          { wallet },
          { builder: fee.data.builderAddress, tenthsBp: BUILDER_FEE_CEILING },
        );
      const reg = await api.registerAgent(token, address, rec.agentAddress);
      if (!reg.ok) throw new Error(reg.message);
      setAgentReady(true);
    } catch (err) {
      setProblem(hlErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const doSend = async () => {
    if (!token || !address || !store || !coin || !decision.allow) return;
    const rec = await store.load(address);
    if (!isUsable(rec, Date.now())) {
      setAgentReady(false);
      return;
    }
    setBusy('send');
    setOutcome(null);
    const out = await runMirror({
      api,
      token,
      body: { ticker: view.ticker, coin, notionalUsd: usdAmt, leverage: lev, stopLossPct: sl },
      privateKey: rec.privateKey,
      onProgress: setProgress,
    });
    setBusy(null);
    setProgress(null);
    setOutcome(out);
    if (out.kind === 'error' && out.code === 'NO_AGENT') setAgentReady(false);
    if (out.kind === 'filled')
      fire({ text: 'GACHA!', kana: 'ガチャ', tone: 'blue', x: '46%', y: '-18px' });
    void loadOrders();
  };

  const recheck = async () => {
    if (!token || outcome?.kind !== 'unknown') return;
    const r = await api.mirrorOrders(token);
    if (!r.ok) return;
    setOrders(r.data.orders);
    const row = r.data.orders.find((o) => o.groupId === outcome.groupId && o.kind === 'order');
    if (row && (row.status === 'FILLED' || row.status === 'RESTING'))
      setOutcome({
        kind: 'filled',
        groupId: outcome.groupId,
        order: outcome.order,
        receipts: outcome.receipts,
        warning: row.error,
      });
    else
      setProblem(
        `Checked again: ${row ? row.status.toLowerCase() : 'no record yet'}. Still no definitive answer.`,
      );
  };

  const leash = (
    <div className="co-leash">
      <p className="co-leash__t">The leash, enforced on our server:</p>
      <span>
        ${MIRROR.minNotionalUsd}–{MIRROR.maxNotionalUsd} an order
      </span>
      <span>{MIRROR.maxOpen} open at most</span>
      <span>${MIRROR.dailyCapUsd} a day</span>
      <span>Leverage up to the trader's, max {MIRROR.maxLeverage}x</span>
      <span>Stop required</span>
      <span>Within {Math.round(MIRROR.antiFomoPct * 100)}% of the trader's entry</span>
      <span>Trader HP {Math.round(MIRROR.minHp * 100)}% or more</span>
    </div>
  );
  const head = (
    <header className="co-mirror__head">
      <h2 id="mirror-h">Mirror with real money</h2>
      <p>
        Copy one of {view.ticker}'s positions on Hyperliquid with your own USDC. Every order passes
        the committee before it's sent.
      </p>
    </header>
  );

  if (available === null)
    return (
      <section className="co-ticket co-mirror" aria-labelledby="mirror-h">
        {head}
        <p style={{ padding: 16, margin: 0 }} role="status">
          Asking the engine whether Mirror is available…
        </p>
      </section>
    );
  if (!available)
    return (
      <section className="co-ticket co-mirror" aria-labelledby="mirror-h" data-testid="mirror-off">
        {head}
        {leash}
        <div className="co-steps" style={{ padding: 16 }}>
          <div className="co-closed">
            <b>Mirror is off on this engine</b>
            <span>
              It runs without a Nansen key (REPLAY or a paused live engine), so it cannot place real
              orders. The floor, the committee and play-money trading work the same.
            </span>
          </div>
        </div>
      </section>
    );

  const stepState = (key: Step): 'done' | 'now' | 'bad' | 'future' => {
    const order: Step[] = STEPS.map((s) => s[0]);
    const ci = order.indexOf(current === 'size' ? 'size' : current);
    const ki = order.indexOf(key);
    if (current === 'size' && (key === 'size' || key === 'sign'))
      return key === 'sign' ? (outcome ? 'now' : 'future') : 'now';
    if (current === 'size' && key === 'check') return decision.allow ? 'now' : 'bad';
    if (ki < ci) return 'done';
    if (ki === ci) return 'now';
    return 'future';
  };

  const body = (key: Step) => {
    switch (key) {
      case 'connect': {
        if (conn.address) return null;
        const list = connectors.filter((c, i, a) => a.findIndex((x) => x.name === c.name) === i);
        return (
          <>
            <p>
              Connect the Hyperliquid wallet you'll mirror from. Mirror orders use its USDC, never
              your play money.
            </p>
            {list.length === 0 ? (
              <p className="ws-v-red">
                No browser wallet found. Install MetaMask or Rabby and reload.
              </p>
            ) : (
              list.map((c) => (
                <button
                  key={c.uid}
                  className="ws-btn"
                  type="button"
                  onClick={() => void doConnect(c.uid)}
                >
                  Connect {c.name === 'Injected' ? 'wallet' : c.name}
                </button>
              ))
            )}
          </>
        );
      }
      case 'link':
        if (!conn.address || linked) return null;
        return (
          <>
            <p>
              Sign one message so the engine knows {shortAddress(address)} belongs to your player.
              It costs nothing and moves no funds.
              {player?.walletAddress
                ? ` This player is linked to ${shortAddress(player.walletAddress)} now.`
                : ''}
            </p>
            <button
              className="ws-btn"
              type="button"
              disabled={busy === 'link'}
              onClick={() => void doLink()}
            >
              {busy === 'link' ? 'Waiting for your wallet…' : 'Sign to link'}
            </button>
          </>
        );
      case 'approve':
        if (current !== 'approve') return null;
        return (
          <>
            <p>One time only. Approve a Whale Street agent key on Hyperliquid:</p>
            <ul className="co-rl co-rl--inline">
              <li>
                {TICK}
                <span>
                  <b>Can</b> place and cancel orders on your account
                </span>
              </li>
              <li>
                {TICK}
                <span>
                  <b>Can't</b> withdraw, transfer or change your wallet
                </span>
              </li>
              <li>
                {TICK}
                <span>
                  <b>Revoke</b> it any time on Hyperliquid; it expires by itself in 180 days
                </span>
              </li>
            </ul>
            <p className="co-sub" style={{ margin: 0 }}>
              The key is created and kept in this browser. Your wallet also approves Nansen's
              builder fee once (0.08% at most), if it hasn't already.
            </p>
            <button
              className="ws-btn"
              type="button"
              disabled={busy === 'approve'}
              onClick={() => void doApprove()}
            >
              {busy === 'approve' ? 'Waiting for your wallet…' : 'Approve agent key'}
            </button>
          </>
        );
      case 'pick':
        if (current !== 'pick') return null;
        if (view.positions.length === 0) return <p>{view.ticker} has no open positions to copy.</p>;
        return (
          <>
            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="ws-sr">Position to mirror</legend>
              <div className="co-pick">
                {view.positions.map((p) => {
                  const mk = p.mark;
                  const adv = mk
                    ? side(p) === 'LONG'
                      ? (mk - p.entryPx) / p.entryPx
                      : (p.entryPx - mk) / p.entryPx
                    : null;
                  const bad = adv !== null && adv >= MIRROR.antiFomoPct;
                  return (
                    <label key={p.coin}>
                      <input
                        type="radio"
                        name="mpos"
                        value={p.coin}
                        checked={coin === p.coin}
                        onChange={() => setCoin(p.coin)}
                      />
                      <span>
                        <b>
                          {side(p)} {p.coin} {Math.round(p.leverage)}x
                        </b>
                      </span>
                      <span className={`gap${bad ? ' is-bad' : ''}`}>
                        Trader in at {coinPx(p.entryPx)}, now {coinPx(mk)}
                        {adv === null
                          ? ''
                          : `: you'd enter ${pctAbs(adv)} ${adv >= 0 ? 'worse' : 'better'}${bad ? ', over the 5% limit' : ''}`}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <button
              className="ws-btn"
              type="button"
              disabled={!coin}
              onClick={() => setPicked(true)}
            >
              Use this position
            </button>
          </>
        );
      case 'size': {
        if (current !== 'size' || outcome) return null;
        const mark = pos?.mark ?? null;
        const long = pos ? pos.size > 0 : true;
        const move = sl / lev;
        const stopPx = mark ? (long ? mark * (1 - move) : mark * (1 + move)) : null;
        const margin = usdAmt / lev;
        return (
          <>
            <div className="co-mctl">
              <div className="co-mctl__top">
                <label htmlFor="m-usd">Order size</label>
                <span>
                  ${MIRROR.minNotionalUsd} to ${MIRROR.maxNotionalUsd}
                </span>
              </div>
              <div
                className={`co-input${usdAmt >= MIRROR.minNotionalUsd && usdAmt <= MIRROR.maxNotionalUsd ? '' : ' is-bad'}`}
              >
                <span aria-hidden="true">$</span>
                <input
                  id="m-usd"
                  inputMode="decimal"
                  autoComplete="off"
                  value={String(usdAmt)}
                  onChange={(e) =>
                    setUsdAmt(Number.parseFloat(e.target.value.replace(/[^0-9.]/g, '')) || 0)
                  }
                  aria-describedby="m-usd-note"
                />
              </div>
              <input
                className="co-range-in"
                type="range"
                min={MIRROR.minNotionalUsd}
                max={MIRROR.maxNotionalUsd}
                step={5}
                value={Math.min(MIRROR.maxNotionalUsd, Math.max(MIRROR.minNotionalUsd, usdAmt))}
                aria-label="Order size slider"
                onChange={(e) => setUsdAmt(Number(e.target.value))}
              />
              <span className="co-mctl__note" id="m-usd-note">
                Used today <b>${usage.dailyUsd}</b> of ${MIRROR.dailyCapUsd}. Open mirrors{' '}
                <b>{usage.open}</b> of {MIRROR.maxOpen}.
              </span>
            </div>
            <div className="co-mctl">
              <div className="co-mctl__top">
                <span id="m-lev-l">Leverage</span>
                <span>max {allowedLev}x</span>
              </div>
              <fieldset className="co-stepper" aria-labelledby="m-lev-l">
                <button
                  type="button"
                  aria-label="Less leverage"
                  disabled={lev <= 1}
                  onClick={() => setLev((l) => Math.max(1, l - 1))}
                >
                  −
                </button>
                <output aria-live="polite">{lev}x</output>
                <button
                  type="button"
                  aria-label="More leverage"
                  disabled={lev >= allowedLev}
                  onClick={() => setLev((l) => Math.min(allowedLev, l + 1))}
                >
                  +
                </button>
              </fieldset>
              <span className="co-mctl__note">
                {pos && pos.leverage <= MIRROR.maxLeverage
                  ? `Capped at ${allowedLev}x, the trader's own leverage.`
                  : `Capped at ${allowedLev}x. The trader runs ${pos ? Math.round(pos.leverage) : '?'}x; Mirror never goes above ${MIRROR.maxLeverage}x.`}
              </span>
            </div>
            <div className="co-mctl">
              <div className="co-mctl__top">
                <label htmlFor="m-sl">Stop-loss</label>
                <span>risk {Math.round(sl * 100)}% of margin</span>
              </div>
              <input
                className="co-range-in"
                type="range"
                id="m-sl"
                min={5}
                max={50}
                step={5}
                value={Math.round(sl * 100)}
                aria-describedby="m-worst"
                onChange={(e) => setSl(Number(e.target.value) / 100)}
              />
              <div className="co-worst" id="m-worst">
                {stopPx === null
                  ? 'A stop is required on every mirror. You can’t turn it off.'
                  : `Stop at ${coinPx(stopPx)} (${coin} ${long ? '−' : '+'}${pctAbs(move)}). Worst case you lose ${usd(margin * sl)} of ${usd(margin)} margin. A stop is required; you can’t turn it off.`}
              </div>
            </div>
            <button
              className="ws-link co-step__change"
              type="button"
              onClick={() => setPicked(false)}
            >
              Change position
            </button>
          </>
        );
      }
      case 'check':
        if (current !== 'size' || outcome) return null;
        return (
          <div>
            {decision.allow ? (
              <div className="co-verdict">
                <Hanko kanji="承認" word="CLEARED" tone="blue" label="Cleared" />
                <p>
                  <b>All 12 checks pass here.</b>The engine checks again on a fresh snapshot when
                  you send.
                </p>
              </div>
            ) : (
              <div className="co-verdict">
                <Hanko kanji="否決" word="REFUSED" label="Refused" />
                <p>
                  <b>Refused: {fails} of 12 checks failed.</b>Nothing will be sent to Hyperliquid.
                </p>
              </div>
            )}
            {decision.allow ? null : (
              <ul className="co-refusals" aria-label="Why the committee refused">
                {decision.refusals.map((r) => (
                  <li key={r.code} className="co-refusal">
                    <span className="co-refusal__code">{r.code}</span>
                    <q>{r.message}</q>
                    <p>{hint(r, view, coin ?? '')}</p>
                  </li>
                ))}
              </ul>
            )}
            <ul className={`co-mchecks${reduce ? '' : ' is-stamping'}`} aria-label="Policy checks">
              {rows.map((r, i) => (
                <li
                  key={r.code}
                  className={r.fail ? 'is-fail' : undefined}
                  style={{ ['--i' as string]: i }}
                >
                  <span
                    className="co-seal co-seal--sm"
                    data-s={r.fail ? 'fail' : 'pass'}
                    role="img"
                    aria-label={r.fail ? 'Failed' : 'Passed'}
                  >
                    <span>{r.fail ? '否' : '可'}</span>
                  </span>
                  <span>
                    <b>{r.label}</b>
                    <span>{r.value}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      case 'sign':
        if (current !== 'size') return null;
        if (busy === 'send')
          return (
            <div className="co-sending" role="status">
              <i aria-hidden="true" />
              {progress === 'preparing'
                ? 'The engine is checking a fresh snapshot…'
                : progress?.startsWith('signing')
                  ? 'Your agent key is signing…'
                  : 'Signed. Waiting for Hyperliquid…'}
            </div>
          );
        if (outcome)
          return (
            <Outcome
              outcome={outcome}
              view={view}
              coin={coin ?? ''}
              onRecheck={() => void recheck()}
              onAgain={() => {
                setOutcome(null);
                setPicked(false);
              }}
              onDesk={() => open({ kind: 'desk' })}
            />
          );
        return (
          <div className="co-sign">
            <button
              className="ws-btn"
              type="button"
              disabled={!decision.allow}
              onClick={() => void doSend()}
            >
              {decision.allow ? `Sign and send $${usdAmt} mirror` : 'Refused by the committee'}
            </button>
            <p>
              {decision.allow
                ? `Your agent key signs 2 actions for the Nansen Trading API: set ${coin} leverage to ${lev}x (cross), then a market ${pos && pos.size > 0 ? 'buy' : 'sell'} with your stop attached. Slippage limit 1%.`
                : 'Nothing was signed or sent. Fix what the committee refused and the stamps re-check instantly.'}
            </p>
          </div>
        );
    }
  };

  const summary = (key: Step): string | null => {
    if (stepState(key) !== 'done') return null;
    if (key === 'connect') return `${shortAddress(address)} connected`;
    if (key === 'link') return 'Linked to your player';
    if (key === 'approve') return 'Agent key approved. It can trade; it can’t withdraw.';
    if (key === 'pick' && pos)
      return `${side(pos)} ${pos.coin} ${Math.round(pos.leverage)}x, trader in at ${coinPx(pos.entryPx)}`;
    return null;
  };

  return (
    <section className="co-ticket co-mirror" aria-labelledby="mirror-h" data-testid="mirror-on">
      {head}
      {leash}
      <ol className="co-steps">
        {STEPS.map(([key, title], i) => {
          const st = stepState(key);
          const b = body(key);
          const sum = summary(key);
          return (
            <li
              key={key}
              className={`co-step is-${st}`}
              aria-current={st === 'now' || st === 'bad' ? 'step' : undefined}
            >
              <span className="co-step__n" aria-hidden="true">
                {st === 'done' ? '✓' : st === 'bad' ? '!' : i + 1}
              </span>
              <div className="co-step__h">
                <h3>
                  {key === 'sign' && outcome?.kind === 'filled'
                    ? 'Sent. Here is your receipt'
                    : key === 'sign' && outcome?.kind === 'unknown'
                      ? 'Sent. Result unknown'
                      : title}
                  <span className="ws-sr">
                    , step {i + 1} of {STEPS.length}
                    {st === 'done'
                      ? ', done'
                      : st === 'bad'
                        ? ', refused'
                        : st === 'future'
                          ? ', not yet'
                          : ''}
                  </span>
                </h3>
              </div>
              {sum ? <p className="co-step__sum">{sum}</p> : null}
              {b ? <div className="co-step__body">{b}</div> : null}
            </li>
          );
        })}
      </ol>
      {problem ? (
        <p className="co-ticket__note ws-v-red" role="alert" style={{ padding: '0 16px 16px' }}>
          {problem}
        </p>
      ) : null}
      {sfx}
    </section>
  );
}

function Outcome({
  outcome,
  view,
  coin,
  onRecheck,
  onAgain,
  onDesk,
}: {
  outcome: MirrorOutcome;
  view: CompanyView;
  coin: string;
  onRecheck(): void;
  onAgain(): void;
  onDesk(): void;
}) {
  if (outcome.kind === 'refused')
    return (
      <div className="co-receipt co-unknown" role="status">
        <div className="co-receipt__top">
          <Hanko kanji="否決" word="REFUSED" label="Refused" />
          <div>
            <b>The engine refused on a fresh snapshot</b>
            <span>Nothing was sent to Hyperliquid.</span>
          </div>
        </div>
        <ul className="co-refusals">
          {outcome.refusals.map((r) => (
            <li key={r.code} className="co-refusal">
              <span className="co-refusal__code">{r.code}</span>
              <q>{r.message}</q>
              <p>{hint(r, view, coin)}</p>
            </li>
          ))}
        </ul>
        <button className="ws-link" type="button" onClick={onAgain}>
          Try another position
        </button>
      </div>
    );
  if (outcome.kind === 'error')
    return (
      <div className="co-receipt co-unknown" role="alert">
        <div className="co-receipt__top">
          <Hanko kanji="却下" word="STOPPED" label="Stopped" />
          <div>
            <b>
              {outcome.code === 'REGION_BLOCKED'
                ? 'Trading is unavailable in this region'
                : 'Not sent'}
            </b>
            <span>{outcome.message}</span>
          </div>
        </div>
        <button className="ws-link" type="button" onClick={onAgain}>
          Start again
        </button>
      </div>
    );
  const order = outcome.order;
  const last = outcome.receipts[outcome.receipts.length - 1];
  const explorer = last?.explorerUrl ?? null;
  if (outcome.kind === 'unknown')
    return (
      <div className="co-receipt co-unknown" role="status">
        <div className="co-receipt__top">
          <Hanko kanji="不明" word="UNKNOWN" tone="ink" label="Unknown" />
          <div>
            <b>Result unknown. Check Hyperliquid.</b>
            <span>{outcome.detail}</span>
          </div>
        </div>
        <p style={{ margin: 0 }}>
          Your order may have filled. <b>Don't send it again yet</b>: open your positions on
          Hyperliquid first. We never resend automatically.
        </p>
        <ul className="co-rl">
          <li>
            {TICK}
            <span>
              <b>Leverage set to {order.leverage}x</b> on {order.coin}, cross
            </span>
          </li>
          <li>
            {QMARK}
            <span>
              <b>
                Market {order.isBuy ? 'buy' : 'sell'}, ${order.notionalUsd} of {order.coin}
              </b>
              sent, no definitive answer
            </span>
          </li>
          <li>
            {QMARK}
            <span>
              <b>Stop at {coinPx(order.stopLossPx)}</b>attached to the order; it exists only if the
              order filled
            </span>
          </li>
        </ul>
        <div className="co-receipt__links">
          {explorer ? (
            <a className="co-extlink" href={explorer} target="_blank" rel="noopener noreferrer">
              Check your positions on Hyperliquid
            </a>
          ) : null}
          <button className="ws-link" type="button" onClick={onRecheck}>
            Check again
          </button>
        </div>
      </div>
    );
  return (
    <div className="co-receipt" role="status">
      <div className="co-receipt__top">
        <Hanko kanji="約定" word="FILLED" tone="blue" stamping label="Filled" />
        <div>
          <b>
            Mirrored {order.isBuy ? 'LONG' : 'SHORT'} {order.coin} {order.leverage}x, $
            {order.notionalUsd}
          </b>
          <span>
            {last?.status === 'RESTING' ? 'Resting on Hyperliquid' : 'Filled on Hyperliquid'}
          </span>
        </div>
      </div>
      <ul className="co-rl">
        <li>
          {TICK}
          <span>
            <b>Leverage set to {order.leverage}x</b> on {order.coin}, cross
          </span>
        </li>
        <li>
          {TICK}
          <span>
            <b>
              {order.isBuy ? 'Bought' : 'Sold'} {order.coin}
              {last?.avgPx != null ? ` at ${coinPx(last.avgPx)}` : ''}
            </b>
            {last?.hlOid != null ? (
              <>
                Order <span className="co-oid">{last.hlOid}</span>
              </>
            ) : (
              'Order id pending'
            )}
          </span>
        </li>
        <li>
          {outcome.warning ? QMARK : TICK}
          <span>
            <b>Stop at {coinPx(order.stopLossPx)}</b>
            {outcome.warning ?? 'attached as a reduce-only trigger'}
          </span>
        </li>
      </ul>
      <div className="co-receipt__links">
        {explorer ? (
          <a className="co-extlink" href={explorer} target="_blank" rel="noopener noreferrer">
            View on Hyperliquid explorer
          </a>
        ) : null}
        <button className="ws-link" type="button" onClick={onDesk}>
          See it in your desk
        </button>
        <button className="ws-link" type="button" onClick={onAgain}>
          Mirror another position
        </button>
      </div>
    </div>
  );
}
