import type { Identity } from 'spacetimedb';
import type { Ctx, Order } from './schema';
import {
  cancelOrder,
  findAccount,
  getOrCreateHolding,
  placeLimitOrder,
  placeMarketOrder,
} from './engine';
import { MARKET_MAKER, NOISE_TRADER } from './identities';
import { triggerStops } from './stops';
import { pruneBotOrders } from './prune';

export { MARKET_MAKER, NOISE_TRADER };

const BOTS = [
  { identity: MARKET_MAKER, name: 'Liquidity Bot' },
  { identity: NOISE_TRADER, name: 'Noise Bot' },
];

export const BOT_TICK_MICROS = 3_000_000n;

// Bot balances are topped up from thin air (a "deposit") whenever they run low.
export const BOT_CASH = 1_000_000_000n; // $10M
const BOT_CASH_FLOOR = 100_000_000n; // $1M
export const BOT_SHARES = 100_000n;
const BOT_SHARES_FLOOR = 10_000n;

const LEVELS = 3;
const HALF_SPREAD_BPS = 25n; // best bid/ask sit 0.25% either side of the anchor
const LEVEL_STEP_BPS = 20n; // each further level is another 0.20% out
const DRIFT_PCT = 25n; // the anchor closes 25% of the gap to fair value per tick
const NOISE_CHANCE = 0.35; // per symbol per tick

const bps = (price: bigint, b: bigint) => (price * b) / 10_000n;

function roundToTick(price: bigint, tick: bigint): bigint {
  const r = ((price + tick / 2n) / tick) * tick;
  return r < tick ? tick : r;
}

/** Creates the room's bot accounts if missing and tops up their cash and shares. */
export function ensureBots(ctx: Ctx, roomId: bigint): void {
  for (const bot of BOTS) {
    const acc = findAccount(ctx, roomId, bot.identity);
    if (!acc) {
      ctx.db.account.insert({
        id: 0n,
        roomId,
        identity: bot.identity,
        name: bot.name,
        cashAvailable: BOT_CASH,
        cashReserved: 0n,
        createdAt: ctx.timestamp,
        isBot: true,
        startingNetWorth: 0n,
      });
    } else if (acc.cashAvailable < BOT_CASH_FLOOR) {
      ctx.db.account.id.update({ ...acc, cashAvailable: BOT_CASH });
    }
    for (const inst of ctx.db.instrument.roomId.filter(roomId)) {
      const h = getOrCreateHolding(ctx, roomId, bot.identity, inst.symbol);
      if (h.qtyAvailable < BOT_SHARES_FLOOR) {
        ctx.db.holding.id.update({ ...h, qtyAvailable: BOT_SHARES });
      }
    }
  }
}

function openOrdersOf(ctx: Ctx, roomId: bigint, owner: Identity, symbol: string): Order[] {
  const mine: Order[] = [];
  for (const side of ['buy', 'sell']) {
    for (const o of ctx.db.orders.book.filter([roomId, symbol, side, 'open'])) {
      if (o.owner.isEqual(owner)) mine.push(o);
    }
  }
  return mine;
}

/**
 * Keeps LEVELS bids and asks around the anchor. Quotes are left alone while they are
 * complete and still centred near the anchor, so the order table doesn't churn.
 * Replaced bot quotes are deleted outright: nobody needs the bot's cancel history.
 */
function quote(ctx: Ctx, roomId: bigint, symbol: string, tick: bigint, anchor: bigint): void {
  const halfSpread = bps(anchor, HALF_SPREAD_BPS);
  const current = openOrdersOf(ctx, roomId, MARKET_MAKER, symbol);
  const bids = current.filter(o => o.side === 'buy');
  const asks = current.filter(o => o.side === 'sell');
  if (bids.length === LEVELS && asks.length === LEVELS) {
    const bestBid = bids.reduce((m, o) => (o.price > m ? o.price : m), 0n);
    const bestAsk = asks.reduce((m, o) => (o.price < m ? o.price : m), asks[0].price);
    const mid = (bestBid + bestAsk) / 2n;
    const off = mid > anchor ? mid - anchor : anchor - mid;
    if (off * 2n <= halfSpread) return;
  }

  for (const o of current) {
    cancelOrder(ctx, MARKET_MAKER, o.id);
    ctx.db.orders.id.delete(o.id);
  }

  for (let level = 0; level < LEVELS; level++) {
    const distance = halfSpread + bps(anchor, LEVEL_STEP_BPS * BigInt(level));
    const qty = BigInt(ctx.random.integerInRange(10, 40));
    const bid = roundToTick(anchor - distance, tick);
    const ask = roundToTick(anchor + distance, tick);
    placeLimitOrder(ctx, roomId, MARKET_MAKER, symbol, 'buy', bid, qty);
    placeLimitOrder(ctx, roomId, MARKET_MAKER, symbol, 'sell', ask > bid ? ask : bid + tick, qty);
  }
}

/** A small market order, tilted toward buying when the price is below fair value. */
function noiseTrade(ctx: Ctx, roomId: bigint, symbol: string, last: bigint, fair: bigint): void {
  if (ctx.random() >= NOISE_CHANCE) return;
  const gap = Number(fair - last) / Number(last);
  const buyChance = 0.5 + Math.max(-0.3, Math.min(0.3, gap * 10));
  const side = ctx.random() < buyChance ? 'buy' : 'sell';
  const qty = BigInt(ctx.random.integerInRange(1, 8));
  try {
    placeMarketOrder(ctx, roomId, NOISE_TRADER, symbol, side, qty);
  } catch {
    // An empty side of the book just means no noise trade this tick.
  }
}

/** One bot tick in one room: top up, then requote and maybe trade every symbol. */
export function runRoomBots(ctx: Ctx, roomId: bigint): void {
  ensureBots(ctx, roomId);
  for (const inst of [...ctx.db.instrument.roomId.filter(roomId)]) {
    let fair = inst.lastPrice;
    for (const s of ctx.db.marketState.bySymbol.filter([roomId, inst.symbol])) fair = s.fairValue;
    const last = inst.lastPrice;
    const jitter = bps(last, BigInt(ctx.random.integerInRange(-5, 5)));
    const anchor = roundToTick(last + ((fair - last) * DRIFT_PCT) / 100n + jitter, inst.tickSize);
    quote(ctx, roomId, inst.symbol, inst.tickSize, anchor);
    noiseTrade(ctx, roomId, inst.symbol, last, fair);
    triggerStops(ctx, roomId, inst.symbol);
  }
}

/** One bot tick across every room. */
export function runBots(ctx: Ctx): void {
  for (const room of [...ctx.db.room.iter()]) runRoomBots(ctx, room.id);
  for (const bot of BOTS) pruneBotOrders(ctx, bot.identity);
}
