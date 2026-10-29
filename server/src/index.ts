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
import { endSeason } from './seasons';
import { computeStandings } from './standings';
import { pruneHistory } from './prune';
import { cancelStopOrder, placeStopOrder, triggerStops } from './stops';
import { CANDLE_INTERVAL_MICROS, rollCandles } from './candles';
import { BOT_TICK_MICROS, runBots } from './bots';
import { fireNews, scheduleNextNews } from './news';
import { cancelOrder, placeLimitOrder, placeMarketOrder } from './engine';
import { MAIN_ROOM_NAME, createPlayerRoom, createRoom, joinRoom } from './rooms';

export default spacetimedb;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const init = spacetimedb.init(ctx => {
  // The public Main room is where every new player lands. It's owned by the module.
  if (ctx.db.room.count() === 0n) createRoom(ctx, MAIN_ROOM_NAME, true, ctx.identity);
  if (ctx.db.candleSchedule.count() === 0n) {
    ctx.db.candleSchedule.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.interval(CANDLE_INTERVAL_MICROS),
    });
  }
  if (ctx.db.botSchedule.count() === 0n) {
    ctx.db.botSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(BOT_TICK_MICROS) });
  }
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
    for (const room of [...ctx.db.room.iter()]) rollCandles(ctx, room.id);
    pruneHistory(ctx);
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
  (ctx, { arg }) => {
    requireModule(ctx, 'fire_news_event');
    fireNews(ctx, arg.roomId);
    scheduleNextNews(ctx, arg.roomId);
  }
);

export const end_season = spacetimedb.reducer(
  { onSchedule: seasonSchedule },
  { arg: seasonSchedule.rowType },
  (ctx, { arg }) => {
    requireModule(ctx, 'end_season');
    endSeason(ctx, arg.roomId);
  }
);

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** Creates a room (public or private) and joins it as its first player. */
export const create_room = spacetimedb.reducer(
  { name: t.string(), isPublic: t.bool(), playerName: t.string() },
  (ctx, { name, isPublic, playerName }) => {
    const roomId = createPlayerRoom(ctx, name, isPublic, ctx.sender);
    joinRoom(ctx, roomId, ctx.db.room.id.find(roomId)!.code, ctx.sender, playerName);
  }
);

/** Joins a public room by id, or any room by its invite code (pass roomId 0). */
export const join_room = spacetimedb.reducer(
  { roomId: t.u64(), code: t.string(), name: t.string() },
  (ctx, { roomId, code, name }) => {
    joinRoom(ctx, roomId, code, ctx.sender, name);
  }
);

// ---------------------------------------------------------------------------
// Trading. Anything that can trade moves the last price, so the room's stops on
// that symbol are checked after.
// ---------------------------------------------------------------------------

export const place_limit_order = spacetimedb.reducer(
  { roomId: t.u64(), symbol: t.string(), side: t.string(), price: t.u64(), qty: t.u64() },
  (ctx, { roomId, symbol, side, price, qty }) => {
    placeLimitOrder(ctx, roomId, ctx.sender, symbol, side, price, qty);
    triggerStops(ctx, roomId, symbol);
  }
);

export const place_market_order = spacetimedb.reducer(
  { roomId: t.u64(), symbol: t.string(), side: t.string(), qty: t.u64() },
  (ctx, { roomId, symbol, side, qty }) => {
    placeMarketOrder(ctx, roomId, ctx.sender, symbol, side, qty);
    triggerStops(ctx, roomId, symbol);
  }
);

export const cancel_order = spacetimedb.reducer({ orderId: t.u64() }, (ctx, { orderId }) => {
  cancelOrder(ctx, ctx.sender, orderId);
});

export const place_stop_order = spacetimedb.reducer(
  { roomId: t.u64(), symbol: t.string(), side: t.string(), stopPrice: t.u64(), qty: t.u64() },
  (ctx, { roomId, symbol, side, stopPrice, qty }) => {
    placeStopOrder(ctx, roomId, ctx.sender, symbol, side, stopPrice, qty);
  }
);

export const cancel_stop_order = spacetimedb.reducer({ stopId: t.u64() }, (ctx, { stopId }) => {
  cancelStopOrder(ctx, ctx.sender, stopId);
});

// ---------------------------------------------------------------------------
// Private views: each client only ever sees its own accounts, holdings and stops,
// across every room it has joined. The client filters by its current room.
// ---------------------------------------------------------------------------

export const my_accounts = spacetimedb.view(
  { name: 'my_accounts', public: true },
  t.array(account.rowType),
  ctx => [...ctx.db.account.identity.filter(ctx.sender)]
);

export const my_holdings = spacetimedb.view(
  { name: 'my_holdings', public: true },
  t.array(holding.rowType),
  ctx => [...ctx.db.holding.owner.filter(ctx.sender)]
);

export const my_stop_orders = spacetimedb.view(
  { name: 'my_stop_orders', public: true },
  t.array(stopOrder.rowType),
  ctx => [...ctx.db.stopOrder.byOwner.filter(ctx.sender)]
);

// ---------------------------------------------------------------------------
// Room directory. The room table is private because it holds invite codes:
// the lobby lists public rooms without codes; my_rooms shows codes only to members.
// ---------------------------------------------------------------------------

const lobbyRoom = t.row('LobbyRoom', {
  id: t.u64(),
  name: t.string(),
  players: t.u32(),
  createdAt: t.timestamp(),
});

export const public_rooms = spacetimedb.anonymousView(
  { name: 'public_rooms', public: true },
  t.array(lobbyRoom),
  ctx =>
    [...ctx.db.room.iter()]
      .filter(r => r.isPublic)
      .map(r => ({
        id: r.id,
        name: r.name,
        players: [...ctx.db.account.roomId.filter(r.id)].filter(a => !a.isBot).length,
        createdAt: r.createdAt,
      }))
);

const memberRoom = t.row('MemberRoom', {
  id: t.u64(),
  name: t.string(),
  code: t.string(),
  isPublic: t.bool(),
  isOwner: t.bool(),
});

export const my_rooms = spacetimedb.view(
  { name: 'my_rooms', public: true },
  t.array(memberRoom),
  ctx =>
    [...ctx.db.account.identity.filter(ctx.sender)].flatMap(a => {
      const r = ctx.db.room.id.find(a.roomId);
      return r
        ? [{ id: r.id, name: r.name, code: r.code, isPublic: r.isPublic, isOwner: r.createdBy.isEqual(ctx.sender) }]
        : [];
    })
);

// ---------------------------------------------------------------------------
// Public leaderboard: names and net worth only, never balances or positions.
// One row per player per room; clients filter to their room.
// ---------------------------------------------------------------------------

const leaderboardEntry = t.row('LeaderboardEntry', {
  roomId: t.u64(),
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
