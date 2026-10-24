import type { Identity } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import type { Ctx, Order } from './schema';

export type Side = 'buy' | 'sell';

export const STARTING_CASH = 10_000_000n; // $100,000.00 in cents
export const STARTING_SHARES = 100n; // of every instrument

// ---------------------------------------------------------------------------
// Small helpers over the tables
// ---------------------------------------------------------------------------

export function nextSeq(ctx: Ctx, name: string): bigint {
  const row = ctx.db.counter.name.find(name);
  const value = (row?.value ?? 0n) + 1n;
  if (row) ctx.db.counter.name.update({ name, value });
  else ctx.db.counter.insert({ name, value });
  return value;
}

function requireAccount(ctx: Ctx, who: Identity) {
  const acc = ctx.db.account.identity.find(who);
  if (!acc) throw new SenderError('Register before trading');
  return acc;
}

function findHolding(ctx: Ctx, owner: Identity, symbol: string) {
  for (const h of ctx.db.holding.byOwnerSymbol.filter([owner, symbol])) return h;
  return null;
}

/** Returns the holding row for (owner, symbol), creating an empty one if needed. */
export function getOrCreateHolding(ctx: Ctx, owner: Identity, symbol: string) {
  return (
    findHolding(ctx, owner, symbol) ??
    ctx.db.holding.insert({ id: 0n, owner, symbol, qtyAvailable: 0n, qtyReserved: 0n })
  );
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

// ---------------------------------------------------------------------------
// Matching engine
// ---------------------------------------------------------------------------

/**
 * Resting orders on the opposite side that cross `price`, in price-time priority:
 * best price first, then lowest sequence number.
 */
function crossingOrders(ctx: Ctx, symbol: string, takerSide: Side, price: bigint): Order[] {
  const restingSide: Side = takerSide === 'buy' ? 'sell' : 'buy';
  const crosses = (o: Order) => (takerSide === 'buy' ? o.price <= price : o.price >= price);
  const rows = [...ctx.db.orders.book.filter([symbol, restingSide, 'open'])].filter(crosses);
  rows.sort((a, b) => {
    if (a.price !== b.price) {
      const cheaperFirst = a.price < b.price ? -1 : 1;
      return takerSide === 'buy' ? cheaperFirst : -cheaperFirst;
    }
    return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
  });
  return rows;
}

/**
 * Settles one match between the incoming order and a resting order at the resting price.
 * Buyer cash was reserved at the buyer's own limit, so any price improvement is refunded.
 */
function settle(ctx: Ctx, taker: Order, resting: Order, fill: bigint) {
  const price = resting.price;
  const [buyOrder, sellOrder] = taker.side === 'buy' ? [taker, resting] : [resting, taker];

  const buyer = requireAccount(ctx, buyOrder.owner);
  const reservedForFill = buyOrder.price * fill;
  const cost = price * fill;
  ctx.db.account.identity.update({
    ...buyer,
    cashReserved: buyer.cashReserved - reservedForFill,
    cashAvailable: buyer.cashAvailable + (reservedForFill - cost),
  });

  const seller = requireAccount(ctx, sellOrder.owner);
  ctx.db.account.identity.update({ ...seller, cashAvailable: seller.cashAvailable + cost });

  const sellerHolding = getOrCreateHolding(ctx, sellOrder.owner, taker.symbol);
  ctx.db.holding.id.update({ ...sellerHolding, qtyReserved: sellerHolding.qtyReserved - fill });

  const buyerHolding = getOrCreateHolding(ctx, buyOrder.owner, taker.symbol);
  ctx.db.holding.id.update({ ...buyerHolding, qtyAvailable: buyerHolding.qtyAvailable + fill });

  ctx.db.trade.insert({
    id: 0n,
    symbol: taker.symbol,
    price,
    qty: fill,
    buyer: buyOrder.owner,
    seller: sellOrder.owner,
    timestamp: ctx.timestamp,
  });
}

/**
 * Validates, reserves, matches and rests a limit order. Runs inside one reducer,
 * so the whole thing is a single transaction: a thrown error rolls everything back.
 */
export function placeLimitOrder(
  ctx: Ctx,
  symbol: string,
  side: string,
  price: bigint,
  qty: bigint
): Order {
  // 1. Validate and reserve.
  if (side !== 'buy' && side !== 'sell') throw new SenderError("side must be 'buy' or 'sell'");
  const inst = ctx.db.instrument.symbol.find(symbol);
  if (!inst) throw new SenderError(`Unknown symbol ${symbol}`);
  if (qty <= 0n) throw new SenderError('qty must be positive');
  if (price <= 0n) throw new SenderError('price must be positive');
  if (price % inst.tickSize !== 0n) {
    throw new SenderError(`price must be a multiple of the tick size (${inst.tickSize})`);
  }

  const acc = requireAccount(ctx, ctx.sender);
  if (side === 'buy') {
    const cost = price * qty;
    if (acc.cashAvailable < cost) throw new SenderError('Insufficient cash');
    ctx.db.account.identity.update({
      ...acc,
      cashAvailable: acc.cashAvailable - cost,
      cashReserved: acc.cashReserved + cost,
    });
  } else {
    const h = findHolding(ctx, ctx.sender, symbol);
    if (!h || h.qtyAvailable < qty) throw new SenderError('Insufficient shares');
    ctx.db.holding.id.update({
      ...h,
      qtyAvailable: h.qtyAvailable - qty,
      qtyReserved: h.qtyReserved + qty,
    });
  }

  let taker = ctx.db.orders.insert({
    id: 0n,
    owner: ctx.sender,
    symbol,
    side,
    price,
    qty,
    remaining: qty,
    seq: nextSeq(ctx, 'order_seq'),
    status: 'open',
    createdAt: ctx.timestamp,
  });

  // 2-4. Walk the opposite side until filled or the book no longer crosses.
  for (const resting of crossingOrders(ctx, symbol, side, price)) {
    if (taker.remaining === 0n) break;
    // 6. Self-trade prevention: skip our own resting orders.
    if (resting.owner.isEqual(ctx.sender)) continue;

    const fill = min(taker.remaining, resting.remaining);
    settle(ctx, taker, resting, fill);

    const restingLeft = resting.remaining - fill;
    ctx.db.orders.id.update({
      ...resting,
      remaining: restingLeft,
      status: restingLeft === 0n ? 'filled' : 'open',
    });
    taker = { ...taker, remaining: taker.remaining - fill };
  }

  // 5. Whatever is left stays on the book.
  return ctx.db.orders.id.update({
    ...taker,
    status: taker.remaining === 0n ? 'filled' : 'open',
  });
}

/** Cancels an open order (owner only) and releases what it still has reserved. */
export function cancelOrder(ctx: Ctx, orderId: bigint): void {
  const order = ctx.db.orders.id.find(orderId);
  if (!order) throw new SenderError('No such order');
  if (!order.owner.isEqual(ctx.sender)) throw new SenderError('Not your order');
  if (order.status !== 'open') throw new SenderError(`Order is already ${order.status}`);

  if (order.side === 'buy') {
    const acc = requireAccount(ctx, order.owner);
    const release = order.price * order.remaining;
    ctx.db.account.identity.update({
      ...acc,
      cashReserved: acc.cashReserved - release,
      cashAvailable: acc.cashAvailable + release,
    });
  } else {
    const h = getOrCreateHolding(ctx, order.owner, order.symbol);
    ctx.db.holding.id.update({
      ...h,
      qtyReserved: h.qtyReserved - order.remaining,
      qtyAvailable: h.qtyAvailable + order.remaining,
    });
  }
  ctx.db.orders.id.update({ ...order, status: 'cancelled' });
}
