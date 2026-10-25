// Pure calculations behind the trading view and portfolio, kept apart from React so
// they can be unit-tested. All money is bigint cents; nothing here uses floats.

import type { Identity } from 'spacetimedb';
import { cmpBig } from '../format';

// ---------------------------------------------------------------------------
// Order book depth
// ---------------------------------------------------------------------------

type BookOrder = { side: string; price: bigint; remaining: bigint; owner: Identity };

export type Level = { price: bigint; qty: bigint; orders: number; mine: boolean; cumulative: bigint };

export type Depth = { bids: Level[]; asks: Level[]; spread: bigint | null };

/**
 * Groups open orders by price into at most `levels` levels per side, best price first
 * (highest bid, lowest ask), with a running total for the depth bars. `mine` marks a
 * level holding at least one of `me`'s orders.
 */
export function aggregateDepth(open: readonly BookOrder[], me: Identity, levels = 10): Depth {
  const group = (side: string, bestFirst: (a: bigint, b: bigint) => number) => {
    const byPrice = new Map<bigint, Level>();
    for (const o of open) {
      if (o.side !== side) continue;
      const lvl = byPrice.get(o.price) ?? { price: o.price, qty: 0n, orders: 0, mine: false, cumulative: 0n };
      lvl.qty += o.remaining;
      lvl.orders += 1;
      lvl.mine ||= o.owner.isEqual(me);
      byPrice.set(o.price, lvl);
    }
    const sorted = [...byPrice.values()].sort((a, b) => bestFirst(a.price, b.price)).slice(0, levels);
    let running = 0n;
    for (const l of sorted) l.cumulative = running += l.qty;
    return sorted;
  };
  const bids = group('buy', (a, b) => cmpBig(b, a));
  const asks = group('sell', cmpBig);
  const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : null;
  return { bids, asks, spread };
}

// ---------------------------------------------------------------------------
// Trade feed
// ---------------------------------------------------------------------------

export type Tick = 'up' | 'down' | 'flat';

/**
 * The newest `count` trades, newest first, each tagged by whether it ticked up or down
 * from the trade before it. The oldest shown trade is compared against the one just
 * outside the window, so its colour doesn't change as the window slides.
 */
export function recentTicks<T extends { id: bigint; price: bigint }>(
  trades: readonly T[],
  count: number
): { t: T; tick: Tick }[] {
  const newestFirst = [...trades].sort((a, b) => cmpBig(b.id, a.id)).slice(0, count + 1);
  return newestFirst.slice(0, count).map((t, i) => {
    const prev = newestFirst[i + 1];
    const tick: Tick = !prev || t.price === prev.price ? 'flat' : t.price > prev.price ? 'up' : 'down';
    return { t, tick };
  });
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

type HoldingLike = { symbol: string; qtyAvailable: bigint; qtyReserved: bigint };
type AccountLike = { cashAvailable: bigint; cashReserved: bigint; startingNetWorth: bigint };

export type Position<H> = H & { qty: bigint; last: bigint; value: bigint };

export type PortfolioSummary<H> = {
  positions: Position<H>[];
  cash: bigint;
  sharesValue: bigint;
  netWorth: bigint;
  pnl: bigint;
};

/**
 * Values every non-empty holding at its last trade price, largest first. Net worth is
 * cash (available + reserved) plus shares, the same formula as the server leaderboard.
 */
export function summarizePortfolio<H extends HoldingLike>(
  account: AccountLike,
  holdings: readonly H[],
  lastPrices: ReadonlyMap<string, bigint>
): PortfolioSummary<H> {
  const positions = holdings
    .map(h => {
      const qty = h.qtyAvailable + h.qtyReserved;
      const last = lastPrices.get(h.symbol) ?? 0n;
      return { ...h, qty, last, value: qty * last };
    })
    .filter(p => p.qty > 0n)
    .sort((a, b) => cmpBig(b.value, a.value));
  const sharesValue = positions.reduce((s, p) => s + p.value, 0n);
  const cash = account.cashAvailable + account.cashReserved;
  const netWorth = cash + sharesValue;
  return { positions, cash, sharesValue, netWorth, pnl: netWorth - account.startingNetWorth };
}

/** Share of `total`, to one decimal place, e.g. "12.5%". */
export function percentOf(value: bigint, total: bigint): string {
  return total ? `${Number((value * 1000n) / total) / 10}%` : '—';
}

/** Merges buy-side and sell-side trades into one newest-first list of the player's fills. */
export function mergeFills<T extends { id: bigint }>(bought: readonly T[], sold: readonly T[], count: number) {
  return [
    ...bought.map(t => ({ t, side: 'buy' as const })),
    ...sold.map(t => ({ t, side: 'sell' as const })),
  ]
    .sort((a, b) => cmpBig(b.t.id, a.t.id))
    .slice(0, count);
}
