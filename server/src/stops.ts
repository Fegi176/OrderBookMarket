import type { Identity } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import type { Ctx } from './schema';
import { getOrCreateHolding, placeMarketOrder, reserveShares, validateSideAndQty } from './engine';

// A stop that fires can move the price and set off more stops. Each stop fires at
// most once, so this only bounds a pathological cascade within one transaction.
const MAX_TRIGGER_ROUNDS = 50;

/**
 * Places a stop-market order. Sell stops reserve their shares now so they can't be
 * sold twice; buy stops reserve nothing and are checked for cash when they fire.
 * The stop must be on the far side of the last price, or it would fire immediately.
 */
export function placeStopOrder(
  ctx: Ctx,
  owner: Identity,
  symbol: string,
  side: string,
  stopPrice: bigint,
  qty: bigint
): void {
  const { inst } = validateSideAndQty(ctx, symbol, side, qty);
  if (!ctx.db.account.identity.find(owner)) throw new SenderError('Register before trading');
  if (stopPrice <= 0n) throw new SenderError('stop price must be positive');
  if (stopPrice % inst.tickSize !== 0n) {
    throw new SenderError(`stop price must be a multiple of the tick size (${inst.tickSize})`);
  }
  if (side === 'buy' && stopPrice <= inst.lastPrice) {
    throw new SenderError('A buy stop must be above the last price');
  }
  if (side === 'sell' && stopPrice >= inst.lastPrice) {
    throw new SenderError('A sell stop must be below the last price');
  }
  if (side === 'sell') reserveShares(ctx, owner, symbol, qty);

  ctx.db.stopOrder.insert({
    id: 0n,
    owner,
    symbol,
    side,
    stopPrice,
    qty,
    status: 'pending',
    createdAt: ctx.timestamp,
    orderId: 0n,
    note: '',
  });
}

function releaseSellStop(ctx: Ctx, owner: Identity, symbol: string, qty: bigint): void {
  const h = getOrCreateHolding(ctx, owner, symbol);
  ctx.db.holding.id.update({
    ...h,
    qtyReserved: h.qtyReserved - qty,
    qtyAvailable: h.qtyAvailable + qty,
  });
}

/** Cancels a pending stop (owner only) and releases a sell stop's shares. */
export function cancelStopOrder(ctx: Ctx, owner: Identity, stopId: bigint): void {
  const stop = ctx.db.stopOrder.id.find(stopId);
  if (!stop) throw new SenderError('No such stop order');
  if (!stop.owner.isEqual(owner)) throw new SenderError('Not your stop order');
  if (stop.status !== 'pending') throw new SenderError(`Stop order is already ${stop.status}`);
  if (stop.side === 'sell') releaseSellStop(ctx, owner, stop.symbol, stop.qty);
  ctx.db.stopOrder.id.update({ ...stop, status: 'cancelled' });
}

/**
 * Fires every pending stop on `symbol` that the last price has reached, oldest first,
 * as a market order. Call this after anything that can trade. A stop that can't
 * execute (empty book, not enough cash) is marked 'failed' rather than retried.
 */
export function triggerStops(ctx: Ctx, symbol: string): void {
  for (let round = 0; round < MAX_TRIGGER_ROUNDS; round++) {
    const last = ctx.db.instrument.symbol.find(symbol)?.lastPrice;
    if (last === undefined) return;
    const due = [...ctx.db.stopOrder.bySymbolStatus.filter([symbol, 'pending'])]
      .filter(s => (s.side === 'buy' ? last >= s.stopPrice : last <= s.stopPrice))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (!due.length) return;

    for (const stop of due) {
      if (stop.side === 'sell') releaseSellStop(ctx, stop.owner, symbol, stop.qty);
      try {
        // placeMarketOrder rejects before writing anything, so a failure leaves no trace.
        const order = placeMarketOrder(ctx, stop.owner, symbol, stop.side, stop.qty);
        ctx.db.stopOrder.id.update({ ...stop, status: 'triggered', orderId: order.id });
      } catch (err) {
        const note = err instanceof Error ? err.message : String(err);
        ctx.db.stopOrder.id.update({ ...stop, status: 'failed', note });
      }
    }
  }
}
