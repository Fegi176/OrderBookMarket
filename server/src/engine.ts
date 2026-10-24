import { Identity } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import type { Ctx, Order } from './schema';
import { recordTrade } from './candles';

export type Side = 'buy' | 'sell';

export const STARTING_CASH = 10_000_000n; // $100,000.00 in cents
export const STARTING_SHARES = 100n; // of every instrument

// ---------------------------------------------------------------------------
// Fees: takers pay FEE_BPS on what they execute on arrival; resting (maker)
// orders pay nothing. Fees move to the Exchange account, so cash is conserved.
// ---------------------------------------------------------------------------

export const FEE_BPS = 10n; // 0.10%
export const EXCHANGE = new Identity(0xb07_0000_0000_0000n);

/** Fee on a notional amount in cents, rounded up to the next cent. */
export const feeOn = (notional: bigint) => (notional * FEE_BPS + 9_999n) / 10_000n;

/** Creates the fee-collecting Exchange account if missing. It's flagged as a bot. */
export function ensureExchange(ctx: Ctx): void {
  if (ctx.db.account.identity.find(EXCHANGE)) return;
  ctx.db.account.insert({
    identity: EXCHANGE,
    name: 'Exchange',
    cashAvailable: 0n,
    cashReserved: 0n,
    createdAt: ctx.timestamp,
    isBot: true,
    startingNetWorth: 0n,
  });
}

/** Moves `fee` from the payer's available cash to the Exchange account. */
function chargeFee(ctx: Ctx, payer: Identity, fee: bigint): void {
  if (fee === 0n) return;
  ensureExchange(ctx);
  const acc = requireAccount(ctx, payer);
  ctx.db.account.identity.update({ ...acc, cashAvailable: acc.cashAvailable - fee });
  const ex = requireAccount(ctx, EXCHANGE);
  ctx.db.account.identity.update({ ...ex, cashAvailable: ex.cashAvailable + fee });
}

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
 * best price first, then lowest sequence number. A `null` price (market order) crosses everything.
 */
function crossingOrders(ctx: Ctx, symbol: string, takerSide: Side, price: bigint | null): Order[] {
  const restingSide: Side = takerSide === 'buy' ? 'sell' : 'buy';
  const crosses = (o: Order) =>
    price === null || (takerSide === 'buy' ? o.price <= price : o.price >= price);
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
  recordTrade(ctx, taker.symbol, price, fill);
}

/** Executes `fill` shares between taker and resting, updates the resting order, returns the new taker. */
function fillAgainst(ctx: Ctx, taker: Order, resting: Order, fill: bigint): Order {
  settle(ctx, taker, resting, fill);
  const restingLeft = resting.remaining - fill;
  ctx.db.orders.id.update({
    ...resting,
    remaining: restingLeft,
    status: restingLeft === 0n ? 'filled' : 'open',
  });
  return { ...taker, remaining: taker.remaining - fill };
}

export function validateSideAndQty(ctx: Ctx, symbol: string, side: string, qty: bigint) {
  if (side !== 'buy' && side !== 'sell') throw new SenderError("side must be 'buy' or 'sell'");
  const inst = ctx.db.instrument.symbol.find(symbol);
  if (!inst) throw new SenderError(`Unknown symbol ${symbol}`);
  if (qty <= 0n) throw new SenderError('qty must be positive');
  return { side: side as Side, inst };
}

/** Moves `qty` shares of `symbol` from available to reserved for `owner`. */
export function reserveShares(ctx: Ctx, owner: Identity, symbol: string, qty: bigint) {
  const h = findHolding(ctx, owner, symbol);
  if (!h || h.qtyAvailable < qty) throw new SenderError('Insufficient shares');
  ctx.db.holding.id.update({
    ...h,
    qtyAvailable: h.qtyAvailable - qty,
    qtyReserved: h.qtyReserved + qty,
  });
}

function insertOrder(ctx: Ctx, owner: Identity, symbol: string, side: Side, price: bigint, qty: bigint): Order {
  return ctx.db.orders.insert({
    id: 0n,
    owner,
    symbol,
    side,
    price,
    qty,
    remaining: qty,
    seq: nextSeq(ctx, 'order_seq'),
    status: 'open',
    createdAt: ctx.timestamp,
    feePaid: 0n,
  });
}

/**
 * Validates, reserves, matches and rests a limit order for `owner` (the caller, or a bot).
 * Runs inside one reducer, so the whole thing is a single transaction: a thrown error
 * rolls everything back. Buys also reserve the worst-case taker fee, and get back
 * whatever the actual fee didn't use.
 */
export function placeLimitOrder(
  ctx: Ctx,
  owner: Identity,
  symbol: string,
  side: string,
  price: bigint,
  qty: bigint
): Order {
  // 1. Validate and reserve.
  const { inst } = validateSideAndQty(ctx, symbol, side, qty);
  if (price <= 0n) throw new SenderError('price must be positive');
  if (price % inst.tickSize !== 0n) {
    throw new SenderError(`price must be a multiple of the tick size (${inst.tickSize})`);
  }

  const acc = requireAccount(ctx, owner);
  const feeReserve = side === 'buy' ? feeOn(price * qty) : 0n;
  if (side === 'buy') {
    const cost = price * qty;
    if (acc.cashAvailable < cost + feeReserve) throw new SenderError('Insufficient cash');
    ctx.db.account.identity.update({
      ...acc,
      cashAvailable: acc.cashAvailable - cost - feeReserve,
      cashReserved: acc.cashReserved + cost + feeReserve,
    });
  } else {
    reserveShares(ctx, owner, symbol, qty);
  }

  let taker = insertOrder(ctx, owner, symbol, side as Side, price, qty);
  let notional = 0n;

  // 2-4. Walk the opposite side until filled or the book no longer crosses.
  for (const resting of crossingOrders(ctx, symbol, taker.side as Side, price)) {
    if (taker.remaining === 0n) break;
    // 6. Self-trade prevention: skip our own resting orders.
    if (resting.owner.isEqual(owner)) continue;
    const fill = min(taker.remaining, resting.remaining);
    notional += resting.price * fill;
    taker = fillAgainst(ctx, taker, resting, fill);
  }

  // Release the fee reserve, then charge the fee on what actually executed. Whatever
  // rests on the book is a maker order from here on and never pays a fee.
  if (feeReserve > 0n) {
    const a = requireAccount(ctx, owner);
    ctx.db.account.identity.update({
      ...a,
      cashReserved: a.cashReserved - feeReserve,
      cashAvailable: a.cashAvailable + feeReserve,
    });
  }
  const fee = feeOn(notional);
  chargeFee(ctx, owner, fee);

  // 5. Whatever is left stays on the book.
  return ctx.db.orders.id.update({
    ...taker,
    status: taker.remaining === 0n ? 'filled' : 'open',
    feePaid: fee,
  });
}

/**
 * Fills as much as possible against the book right now, then cancels the rest
 * (immediate-or-cancel). Market orders never rest, so they are stored with price 0.
 * Buys stop when the next fill plus the fee is unaffordable; sells reserve all shares
 * up front.
 *
 * Every rejection happens before the first write, so callers (bots, stop triggers) can
 * catch the error without leaving a half-placed order behind.
 */
export function placeMarketOrder(ctx: Ctx, owner: Identity, symbol: string, side: string, qty: bigint): Order {
  validateSideAndQty(ctx, symbol, side, qty);
  const budget = requireAccount(ctx, owner).cashAvailable;
  const book = crossingOrders(ctx, symbol, side as Side, null).filter(o => !o.owner.isEqual(owner));
  if (!book.length) throw new SenderError('No matching orders on the book');
  if (side === 'buy' && budget < book[0].price + feeOn(book[0].price)) {
    throw new SenderError('Insufficient cash');
  }
  if (side === 'sell') reserveShares(ctx, owner, symbol, qty);

  let taker = insertOrder(ctx, owner, symbol, side as Side, 0n, qty);
  let notional = 0n;

  for (const resting of book) {
    if (taker.remaining === 0n) break;

    let fill = min(taker.remaining, resting.remaining);
    if (taker.side === 'buy') {
      // Largest fill whose cost, plus the fee on everything bought so far, fits the budget.
      fill = min(fill, (budget - notional) / resting.price);
      while (fill > 0n) {
        const total = notional + resting.price * fill;
        if (total + feeOn(total) <= budget) break;
        fill -= 1n;
      }
      if (fill === 0n) break; // asks only get pricier from here
      // Reserve exactly this fill's cost, then settle as if the limit were the resting price.
      const acc = requireAccount(ctx, owner);
      const cost = resting.price * fill;
      notional += cost;
      ctx.db.account.identity.update({
        ...acc,
        cashAvailable: acc.cashAvailable - cost,
        cashReserved: acc.cashReserved + cost,
      });
      taker = fillAgainst(ctx, { ...taker, price: resting.price }, resting, fill);
      taker = { ...taker, price: 0n };
    } else {
      notional += resting.price * fill;
      taker = fillAgainst(ctx, taker, resting, fill);
    }
  }

  const fee = feeOn(notional);
  chargeFee(ctx, owner, fee);

  if (taker.side === 'sell' && taker.remaining > 0n) {
    // Release the shares that found no buyer.
    const h = getOrCreateHolding(ctx, owner, symbol);
    ctx.db.holding.id.update({
      ...h,
      qtyReserved: h.qtyReserved - taker.remaining,
      qtyAvailable: h.qtyAvailable + taker.remaining,
    });
  }

  return ctx.db.orders.id.update({
    ...taker,
    status: taker.remaining === 0n ? 'filled' : 'cancelled',
    feePaid: fee,
  });
}

/** Cancels an open order (owner only) and releases what it still has reserved. */
export function cancelOrder(ctx: Ctx, owner: Identity, orderId: bigint): void {
  const order = ctx.db.orders.id.find(orderId);
  if (!order) throw new SenderError('No such order');
  if (!order.owner.isEqual(owner)) throw new SenderError('Not your order');
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
