import { schema, table, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

// All money is stored as integer cents and all quantities as whole shares.
// u64 columns surface as `bigint` in TypeScript, so there is no float math anywhere.

/** One row per player. Private: clients read their own row through the `my_account` view. */
export const account = table(
  { public: false },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    cashAvailable: t.u64(),
    cashReserved: t.u64(),
    createdAt: t.timestamp(),
    /** Bot accounts are owned by the module and left off the leaderboard. */
    isBot: t.bool(),
    /** Net worth at registration (cash plus shares at that moment's last prices), for return %. */
    startingNetWorth: t.u64(),
  }
);

/** The tradable companies. */
export const instrument = table(
  { public: true },
  {
    symbol: t.string().primaryKey(),
    name: t.string(),
    tickSize: t.u64(),
    /** Last traded price, seeded with a listing price before the first trade. */
    lastPrice: t.u64(),
  }
);

/** Shares each player owns. Private: clients read their own rows through `my_holdings`. */
export const holding = table(
  {
    public: false,
    indexes: [
      {
        accessor: 'byOwnerSymbol',
        algorithm: 'btree',
        columns: ['owner', 'symbol'] as const,
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    symbol: t.string(),
    qtyAvailable: t.u64(),
    qtyReserved: t.u64(),
  }
);

/**
 * The order book. Public, so clients subscribe per symbol to open orders.
 * `side` is 'buy' | 'sell' and `status` is 'open' | 'filled' | 'cancelled'.
 * The `book` index is a full-key lookup of one side's open orders; the engine sorts
 * them by price and sequence. (Prefix and `Range` scans don't work under the SDK's
 * unit-test harness, so the index avoids them.)
 */
export const orders = table(
  {
    public: true,
    indexes: [
      {
        accessor: 'book',
        algorithm: 'btree',
        columns: ['symbol', 'side', 'status'] as const,
      },
      {
        accessor: 'byOwner',
        algorithm: 'btree',
        columns: ['owner'] as const,
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    symbol: t.string(),
    side: t.string(),
    price: t.u64(),
    qty: t.u64(),
    remaining: t.u64(),
    seq: t.u64(),
    status: t.string(),
    createdAt: t.timestamp(),
    /** Taker fee charged on the part of this order that executed on arrival. */
    feePaid: t.u64(),
  }
);

/**
 * Stop orders wait off the book until the last trade price reaches `stopPrice`
 * (at or above for buys, at or below for sells), then fire as market orders.
 * `status` is 'pending' | 'triggered' | 'cancelled' | 'failed'. Private: other
 * players can't see where your stops sit. Clients use the `my_stop_orders` view.
 */
export const stopOrder = table(
  {
    public: false,
    indexes: [
      {
        accessor: 'bySymbolStatus',
        algorithm: 'btree',
        columns: ['symbol', 'status'] as const,
      },
      {
        accessor: 'byOwner',
        algorithm: 'btree',
        columns: ['owner'] as const,
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    symbol: t.string(),
    side: t.string(),
    stopPrice: t.u64(),
    qty: t.u64(),
    status: t.string(),
    createdAt: t.timestamp(),
    /** The market order it became once triggered; 0 until then. */
    orderId: t.u64(),
    /** Why a stop failed, e.g. "No matching orders on the book". Empty otherwise. */
    note: t.string(),
  }
);

/** Executed matches. */
export const trade = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    symbol: t.string().index('btree'),
    price: t.u64(),
    qty: t.u64(),
    buyer: t.identity(),
    seller: t.identity(),
    timestamp: t.timestamp(),
  }
);

/**
 * One-minute OHLCV bars for the price chart. Trades update the current bar as they
 * happen; `roll_candles` opens a flat bar for every symbol at each minute boundary,
 * so the chart has no gaps when nothing trades.
 */
export const candle = table(
  {
    public: true,
    indexes: [
      {
        accessor: 'bySymbolStart',
        algorithm: 'btree',
        columns: ['symbol', 'intervalStart'] as const,
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    symbol: t.string().index('btree'),
    /** Start of the bar, in microseconds since the Unix epoch. */
    intervalStart: t.u64(),
    open: t.u64(),
    high: t.u64(),
    low: t.u64(),
    close: t.u64(),
    volume: t.u64(),
  }
);

/** Drives `roll_candles` once per candle interval. */
export const candleSchedule = table(
  { public: false },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

/**
 * Hidden "true value" per symbol. News moves it; the market-maker bot quotes around a
 * point drifting from the last price toward it, so prices react gradually. Private so
 * players have to read the news rather than the table.
 */
export const marketState = table(
  { public: false },
  {
    symbol: t.string().primaryKey(),
    fairValue: t.u64(),
  }
);

/** Market events shown to every player. */
export const news = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    symbol: t.string().index('btree'),
    headline: t.string(),
    /** Change applied to fair value, in basis points (+250 = +2.5%). */
    impactBps: t.i32(),
    timestamp: t.timestamp(),
  }
);

/** Drives `run_bots` on a fixed interval. */
export const botSchedule = table(
  { public: false },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

/** Holds the next `fire_news_event`; each event schedules the one after it at a random time. */
export const newsSchedule = table(
  { public: false },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

/** Named monotonic counters. `order_seq` gives time priority, since timestamps can tie. */
export const counter = table(
  { public: false },
  {
    name: t.string().primaryKey(),
    value: t.u64(),
  }
);

const spacetimedb = schema({
  account,
  instrument,
  holding,
  orders,
  stopOrder,
  trade,
  candle,
  candleSchedule,
  marketState,
  news,
  botSchedule,
  newsSchedule,
  counter,
});
export default spacetimedb;

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
export type Order = typeof orders.rowType.type;
