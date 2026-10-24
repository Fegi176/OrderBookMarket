import { ScheduleAt, SenderError, t } from 'spacetimedb/server';
import spacetimedb, {
  account,
  botSchedule,
  candleSchedule,
  holding,
  newsSchedule,
  seasonSchedule,
  stopOrder,
  type Ctx,
} from './schema';
import { activeSeason, endSeason, startSeason } from './seasons';
import { computeStandings } from './standings';
import { cancelStopOrder, placeStopOrder, triggerStops } from './stops';
import { CANDLE_INTERVAL_MICROS, rollCandles } from './candles';
import { BOT_TICK_MICROS, ensureBots, runBots } from './bots';
import { fireNews, scheduleNextNews } from './news';
import {
  STARTING_CASH,
  STARTING_SHARES,
  cancelOrder,
  ensureExchange,
  getOrCreateHolding,
  placeLimitOrder,
  placeMarketOrder,
} from './engine';

export default spacetimedb;

// Listing prices in cents: every season starts trading from these.
const INSTRUMENTS = [
  { symbol: 'BRKT', name: 'Bracket Robotics', tickSize: 1n, listingPrice: 4_250n },
  { symbol: 'CLDN', name: 'Cloudnine Airlines', tickSize: 1n, listingPrice: 1_875n },
  { symbol: 'GRVY', name: 'Gravy Foods', tickSize: 1n, listingPrice: 3_310n },
  { symbol: 'MOON', name: 'Moonshot Mining', tickSize: 5n, listingPrice: 12_000n },
  { symbol: 'PXL', name: 'Pixel Pictures', tickSize: 1n, listingPrice: 960n },
  { symbol: 'QNTM', name: 'Quantum Quilts', tickSize: 5n, listingPrice: 7_550n },
];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const init = spacetimedb.init(ctx => {
  for (const inst of INSTRUMENTS) {
    if (!ctx.db.instrument.symbol.find(inst.symbol)) {
      ctx.db.instrument.insert({ ...inst, lastPrice: inst.listingPrice });
    }
    if (!ctx.db.marketState.symbol.find(inst.symbol)) {
      ctx.db.marketState.insert({ symbol: inst.symbol, fairValue: inst.listingPrice });
    }
  }
  if (!activeSeason(ctx)) startSeason(ctx, 1);
  if (ctx.db.candleSchedule.count() === 0n) {
    ctx.db.candleSchedule.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.interval(CANDLE_INTERVAL_MICROS),
    });
  }
  if (ctx.db.botSchedule.count() === 0n) {
    ctx.db.botSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(BOT_TICK_MICROS) });
  }
  if (ctx.db.newsSchedule.count() === 0n) scheduleNextNews(ctx);
  ensureExchange(ctx);
  ensureBots(ctx);
  rollCandles(ctx);
});

// ---------------------------------------------------------------------------
// Scheduled reducers
// ---------------------------------------------------------------------------

/** Scheduled reducers are still callable by clients, so only the module may run them. */
function requireModule(ctx: Ctx, name: string) {
  if (!ctx.sender.isEqual(ctx.identity)) throw new SenderError(`${name} is internal`);
}

export const roll_candles = spacetimedb.reducer(
  { onSchedule: candleSchedule },
  { arg: candleSchedule.rowType },
  ctx => {
    requireModule(ctx, 'roll_candles');
    rollCandles(ctx);
  }
);

export const run_bots = spacetimedb.reducer(
  { onSchedule: botSchedule },
  { arg: botSchedule.rowType },
  ctx => {
    requireModule(ctx, 'run_bots');
    runBots(ctx);
  }
);

export const fire_news_event = spacetimedb.reducer(
  { onSchedule: newsSchedule },
  { arg: newsSchedule.rowType },
  ctx => {
    requireModule(ctx, 'fire_news_event');
    fireNews(ctx);
    scheduleNextNews(ctx);
  }
);

export const end_season = spacetimedb.reducer(
  { onSchedule: seasonSchedule },
  { arg: seasonSchedule.rowType },
  ctx => {
    requireModule(ctx, 'end_season');
    endSeason(ctx);
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

  let startingNetWorth = STARTING_CASH;
  for (const inst of ctx.db.instrument.iter()) startingNetWorth += STARTING_SHARES * inst.lastPrice;

  ctx.db.account.insert({
    identity: ctx.sender,
    name: trimmed,
    cashAvailable: STARTING_CASH,
    cashReserved: 0n,
    createdAt: ctx.timestamp,
    isBot: false,
    startingNetWorth,
  });
  for (const inst of ctx.db.instrument.iter()) {
    const h = getOrCreateHolding(ctx, ctx.sender, inst.symbol);
    ctx.db.holding.id.update({ ...h, qtyAvailable: STARTING_SHARES });
  }
});

// Anything that can trade moves the last price, so stops on that symbol are checked after.

export const place_limit_order = spacetimedb.reducer(
  { symbol: t.string(), side: t.string(), price: t.u64(), qty: t.u64() },
  (ctx, { symbol, side, price, qty }) => {
    placeLimitOrder(ctx, ctx.sender, symbol, side, price, qty);
    triggerStops(ctx, symbol);
  }
);

export const place_market_order = spacetimedb.reducer(
  { symbol: t.string(), side: t.string(), qty: t.u64() },
  (ctx, { symbol, side, qty }) => {
    placeMarketOrder(ctx, ctx.sender, symbol, side, qty);
    triggerStops(ctx, symbol);
  }
);

export const cancel_order = spacetimedb.reducer({ orderId: t.u64() }, (ctx, { orderId }) => {
  cancelOrder(ctx, ctx.sender, orderId);
});

export const place_stop_order = spacetimedb.reducer(
  { symbol: t.string(), side: t.string(), stopPrice: t.u64(), qty: t.u64() },
  (ctx, { symbol, side, stopPrice, qty }) => {
    placeStopOrder(ctx, ctx.sender, symbol, side, stopPrice, qty);
  }
);

export const cancel_stop_order = spacetimedb.reducer({ stopId: t.u64() }, (ctx, { stopId }) => {
  cancelStopOrder(ctx, ctx.sender, stopId);
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

export const my_stop_orders = spacetimedb.view(
  { name: 'my_stop_orders', public: true },
  t.array(stopOrder.rowType),
  ctx => [...ctx.db.stopOrder.byOwner.filter(ctx.sender)]
);

// ---------------------------------------------------------------------------
// Public leaderboard: names and net worth only, never balances or positions
// ---------------------------------------------------------------------------

const leaderboardEntry = t.row('LeaderboardEntry', {
  identity: t.identity(),
  name: t.string(),
  /** Cash (available + reserved) plus all shares valued at each symbol's last trade price. */
  netWorth: t.u64(),
  startingNetWorth: t.u64(),
});

export const leaderboard = spacetimedb.anonymousView(
  { name: 'leaderboard', public: true },
  t.array(leaderboardEntry),
  ctx => computeStandings(ctx.db)
);
