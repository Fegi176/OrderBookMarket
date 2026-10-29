import { schema, table, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

// All money is stored as integer cents and all quantities as whole shares.
// u64 columns surface as `bigint` in TypeScript, so there is no float math anywhere.
//
// Every market table carries a `roomId`: each room is a separate market with its own
// accounts, book, bots, news and seasons. Tables that need a room-wide pass have a
// single-column `roomId` index; multi-column indexes are always looked up by their
// full key (the SDK's unit-test harness can't decode prefix scans).

/**
 * A market players can join. Private, because it holds the invite code: clients see
 * public rooms through `public_rooms` and the rooms they're in through `my_rooms`.
 */
export const room = table(
  { public: false },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    /** Six characters; needed to join a private room. */
    code: t.string().unique(),
    isPublic: t.bool(),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
  }
);

/**
 * One row per player per room. Private: clients read their own rows through the
 * `my_accounts` view.
 */
export const account = table(
  {
    public: false,
    indexes: [
      { accessor: 'byMember', algorithm: 'btree', columns: ['roomId', 'identity'] as const },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    identity: t.identity().index('btree'),
    name: t.string(),
    cashAvailable: t.u64(),
    cashReserved: t.u64(),
    createdAt: t.timestamp(),
    /** Bot accounts are owned by the module and left off the leaderboard. */
    isBot: t.bool(),
    /** Net worth at joining (cash plus shares at that moment's last prices), for return %. */
    startingNetWorth: t.u64(),
  }
);

/** The tradable companies, listed separately in every room. */
export const instrument = table(
  {
    public: true,
    indexes: [
      { accessor: 'bySymbol', algorithm: 'btree', columns: ['roomId', 'symbol'] as const },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    symbol: t.string(),
    name: t.string(),
    tickSize: t.u64(),
    /** Last traded price, seeded with the listing price before the first trade. */
    lastPrice: t.u64(),
    /** Price every season starts from. */
    listingPrice: t.u64(),
  }
);

/** Shares each player owns, per room. Private: clients read their own through `my_holdings`. */
export const holding = table(
  {
    public: false,
    indexes: [
      {
        accessor: 'byOwnerSymbol',
        algorithm: 'btree',
        columns: ['roomId', 'owner', 'symbol'] as const,
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    owner: t.identity().index('btree'),
    symbol: t.string(),
    qtyAvailable: t.u64(),
    qtyReserved: t.u64(),
  }
);

/**
 * The order book. Public, so clients subscribe per room and symbol to open orders.
 * `side` is 'buy' | 'sell' and `status` is 'open' | 'filled' | 'cancelled'.
 * The `book` index is a full-key lookup of one side's open orders; the engine sorts
 * them by price and sequence.
 */
export const orders = table(
  {
    public: true,
    indexes: [
      {
        accessor: 'book',
        algorithm: 'btree',
        columns: ['roomId', 'symbol', 'side', 'status'] as const,
      },
      { accessor: 'byOwner', algorithm: 'btree', columns: ['owner'] as const },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
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
        columns: ['roomId', 'symbol', 'status'] as const,
      },
      { accessor: 'byOwner', algorithm: 'btree', columns: ['owner'] as const },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
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
    roomId: t.u64().index('btree'),
    symbol: t.string(),
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
        columns: ['roomId', 'symbol', 'intervalStart'] as const,
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    symbol: t.string(),
    /** Start of the bar, in microseconds since the Unix epoch. */
    intervalStart: t.u64(),
    open: t.u64(),
    high: t.u64(),
    low: t.u64(),
    close: t.u64(),
    volume: t.u64(),
  }
);

/** Drives `roll_candles` once per candle interval, for every room. */
export const candleSchedule = table(
  { public: false },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

/**
 * Hidden "true value" per room and symbol. News moves it; the market-maker bot quotes
 * around a point drifting from the last price toward it, so prices react gradually.
 * Private so players have to read the news rather than the table.
 */
export const marketState = table(
  {
    public: false,
    indexes: [
      { accessor: 'bySymbol', algorithm: 'btree', columns: ['roomId', 'symbol'] as const },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    symbol: t.string(),
    fairValue: t.u64(),
  }
);

/** Market events, shown to everyone in the room. */
export const news = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    symbol: t.string(),
    headline: t.string(),
    /** Change applied to fair value, in basis points (+250 = +2.5%). */
    impactBps: t.i32(),
    timestamp: t.timestamp(),
  }
);

/** Drives `run_bots` on a fixed interval, for every room. */
export const botSchedule = table(
  { public: false },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

/** Holds each room's next `fire_news_event`; every event schedules the one after it. */
export const newsSchedule = table(
  { public: false },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    roomId: t.u64(),
  }
);

/**
 * Time-boxed rounds, per room. Each room has exactly one 'active' season; when it
 * ends, standings are saved to `season_result` and the room's market is reset.
 */
export const season = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    number: t.u32(),
    startsAt: t.timestamp(),
    endsAt: t.timestamp(),
    /** 'active' | 'ended' */
    status: t.string(),
  }
);

/** Final standings of each finished season. Bots are excluded. */
export const seasonResult = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    seasonNumber: t.u32(),
    rank: t.u32(),
    identity: t.identity(),
    name: t.string(),
    netWorth: t.u64(),
    startingNetWorth: t.u64(),
  }
);

/** Fires `end_season` once per room, at that room's active season's end time. */
export const seasonSchedule = table(
  { public: false },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    roomId: t.u64(),
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
  room,
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
  season,
  seasonResult,
  seasonSchedule,
  counter,
});
export default spacetimedb;

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
export type Order = typeof orders.rowType.type;
export type Account = typeof account.rowType.type;
export type Instrument = typeof instrument.rowType.type;
