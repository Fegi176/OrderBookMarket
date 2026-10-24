import { ScheduleAt, SenderError, t } from 'spacetimedb/server';
import spacetimedb, { account, candleSchedule, holding } from './schema';
import { CANDLE_INTERVAL_MICROS, rollCandles } from './candles';
import {
  STARTING_CASH,
  STARTING_SHARES,
  cancelOrder,
  getOrCreateHolding,
  placeLimitOrder,
  placeMarketOrder,
} from './engine';

export default spacetimedb;

// lastPrice is the listing price in cents, used until the first trade.
const INSTRUMENTS = [
  { symbol: 'BRKT', name: 'Bracket Robotics', tickSize: 1n, lastPrice: 4_250n },
  { symbol: 'CLDN', name: 'Cloudnine Airlines', tickSize: 1n, lastPrice: 1_875n },
  { symbol: 'GRVY', name: 'Gravy Foods', tickSize: 1n, lastPrice: 3_310n },
  { symbol: 'MOON', name: 'Moonshot Mining', tickSize: 5n, lastPrice: 12_000n },
  { symbol: 'PXL', name: 'Pixel Pictures', tickSize: 1n, lastPrice: 960n },
  { symbol: 'QNTM', name: 'Quantum Quilts', tickSize: 5n, lastPrice: 7_550n },
];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const init = spacetimedb.init(ctx => {
  for (const inst of INSTRUMENTS) {
    if (!ctx.db.instrument.symbol.find(inst.symbol)) ctx.db.instrument.insert(inst);
  }
  if (ctx.db.candleSchedule.count() === 0n) {
    ctx.db.candleSchedule.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.interval(CANDLE_INTERVAL_MICROS),
    });
  }
  rollCandles(ctx);
});

// ---------------------------------------------------------------------------
// Scheduled reducers
// ---------------------------------------------------------------------------

export const roll_candles = spacetimedb.reducer(
  { onSchedule: candleSchedule },
  { arg: candleSchedule.rowType },
  ctx => {
    // Scheduled reducers are still callable by clients, so only the module may run this.
    if (!ctx.sender.isEqual(ctx.identity)) throw new SenderError('roll_candles is internal');
    rollCandles(ctx);
  }
);

// ---------------------------------------------------------------------------
// Player reducers
// ---------------------------------------------------------------------------

export const register = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 24) {
    throw new SenderError('Name must be 1-24 characters');
  }
  if (ctx.db.account.identity.find(ctx.sender)) throw new SenderError('Already registered');

  ctx.db.account.insert({
    identity: ctx.sender,
    name: trimmed,
    cashAvailable: STARTING_CASH,
    cashReserved: 0n,
    createdAt: ctx.timestamp,
  });
  for (const inst of ctx.db.instrument.iter()) {
    const h = getOrCreateHolding(ctx, ctx.sender, inst.symbol);
    ctx.db.holding.id.update({ ...h, qtyAvailable: STARTING_SHARES });
  }
});

export const place_limit_order = spacetimedb.reducer(
  { symbol: t.string(), side: t.string(), price: t.u64(), qty: t.u64() },
  (ctx, { symbol, side, price, qty }) => {
    placeLimitOrder(ctx, symbol, side, price, qty);
  }
);

export const place_market_order = spacetimedb.reducer(
  { symbol: t.string(), side: t.string(), qty: t.u64() },
  (ctx, { symbol, side, qty }) => {
    placeMarketOrder(ctx, symbol, side, qty);
  }
);

export const cancel_order =spacetimedb.reducer({ orderId: t.u64() }, (ctx, { orderId }) => {
  cancelOrder(ctx, orderId);
});

// ---------------------------------------------------------------------------
// Private views: each client only ever sees its own account and holdings
// ---------------------------------------------------------------------------

export const my_account = spacetimedb.view(
  { name: 'my_account', public: true },
  t.option(account.rowType),
  ctx => ctx.db.account.identity.find(ctx.sender) ?? undefined
);

export const my_holdings = spacetimedb.view(
  { name: 'my_holdings', public: true },
  t.array(holding.rowType),
  ctx => [...ctx.db.holding.byOwnerSymbol.filter(ctx.sender)]
);
