// Shared setup for module tests: a harness with the Main room created by init, plus
// short helpers that call reducers as players or as the scheduler.

import { ConnectionId, Timestamp, type Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';

export { mod, TestAuth };

const makeHarness = (rngSeed?: number) => createModuleTestHarness(spacetimedb, mod, { rngSeed });
export type Harness = ReturnType<typeof makeHarness>;

export const internal = TestAuth.internal();
const interval = { tag: 'Interval' as const, value: null as any };

let nextConn = 1n;

export function createGame(opts: { rngSeed?: number; t0?: bigint } = {}) {
  const h = makeHarness(opts.rngSeed);
  if (opts.t0 !== undefined) h.clock.set(new Timestamp(opts.t0));
  h.withReducerTx(internal, ctx => mod.init(ctx, {}));
  const main = [...h.db.room.iter()][0].id;

  const tx = <T>(auth: TestAuth, body: Parameters<Harness['withReducerTx']>[1]) =>
    h.withReducerTx(auth, body) as T;

  const g = {
    h,
    /** The Main room created by init. */
    main,
    at: (micros: bigint) => h.clock.set(new Timestamp(micros)),

    player(sub: string): TestAuth {
      return TestAuth.fromJwtPayload(
        JSON.stringify({ iss: 'https://test.local', sub, aud: ['order-book'] }),
        new ConnectionId(nextConn++)
      );
    },
    id: (auth: TestAuth): Identity => tx(auth, ctx => ctx.sender),

    /** Joins a room (Main by default) by id, or by code when one is given. */
    join: (auth: TestAuth, name: string, roomId = main, code = '') =>
      h.withReducerTx(auth, ctx => mod.join_room(ctx, { roomId, code, name })),
    /** Creates a room and returns its id. */
    createRoom(auth: TestAuth, name: string, isPublic: boolean, playerName = 'Owner'): bigint {
      const before = new Set([...h.db.room.iter()].map(r => r.id));
      h.withReducerTx(auth, ctx => mod.create_room(ctx, { name, isPublic, playerName }));
      return [...h.db.room.iter()].find(r => !before.has(r.id))!.id;
    },
    /** Registers a player in Main (or `roomId`) and returns their auth. */
    newPlayer(sub: string, roomId = main): TestAuth {
      const auth = g.player(sub);
      g.join(auth, sub, roomId);
      return auth;
    },

    limit: (a: TestAuth, symbol: string, side: string, price: bigint, qty: bigint, roomId = main) =>
      h.withReducerTx(a, ctx => mod.place_limit_order(ctx, { roomId, symbol, side, price, qty })),
    market: (a: TestAuth, symbol: string, side: string, qty: bigint, roomId = main) =>
      h.withReducerTx(a, ctx => mod.place_market_order(ctx, { roomId, symbol, side, qty })),
    stop: (a: TestAuth, symbol: string, side: string, stopPrice: bigint, qty: bigint, roomId = main) =>
      h.withReducerTx(a, ctx => mod.place_stop_order(ctx, { roomId, symbol, side, stopPrice, qty })),
    cancel: (a: TestAuth, orderId: bigint) => h.withReducerTx(a, ctx => mod.cancel_order(ctx, { orderId })),
    cancelStop: (a: TestAuth, stopId: bigint) =>
      h.withReducerTx(a, ctx => mod.cancel_stop_order(ctx, { stopId })),

    // Scheduler-driven reducers. Bots and candles run for every room; news and season
    // ends are scheduled per room.
    tick: () => h.withReducerTx(internal, ctx => mod.run_bots(ctx, { arg: { scheduledId: 0n, scheduledAt: interval } })),
    roll: () =>
      h.withReducerTx(internal, ctx => mod.roll_candles(ctx, { arg: { scheduledId: 0n, scheduledAt: interval } })),
    news: (roomId = main) =>
      h.withReducerTx(internal, ctx =>
        mod.fire_news_event(ctx, { arg: { scheduledId: 0n, scheduledAt: interval, roomId } })
      ),
    endSeason: (roomId = main, auth = internal) =>
      h.withReducerTx(auth, ctx => mod.end_season(ctx, { arg: { scheduledId: 0n, scheduledAt: interval, roomId } })),

    acct(who: Identity, roomId = main) {
      for (const a of h.db.account.byMember.filter([roomId, who])) return a;
      throw new Error('no account');
    },
    shares(who: Identity, symbol: string, roomId = main) {
      for (const r of h.db.holding.byOwnerSymbol.filter([roomId, who, symbol])) return r;
      throw new Error('no holding');
    },
    inst(symbol: string, roomId = main) {
      for (const i of h.db.instrument.bySymbol.filter([roomId, symbol])) return i;
      throw new Error('no instrument');
    },
    fair(symbol: string, roomId = main) {
      for (const s of h.db.marketState.bySymbol.filter([roomId, symbol])) return s.fairValue;
      throw new Error('no market state');
    },
    leaderboard: (roomId = main) => mod.leaderboard(h.anonymousViewContext()).filter(r => r.roomId === roomId),
    rows: {
      orders: (roomId = main) => [...h.db.orders.iter()].filter(o => o.roomId === roomId),
      trades: (roomId = main) => [...h.db.trade.iter()].filter(t => t.roomId === roomId),
      stops: (roomId = main) =>
        [...h.db.stopOrder.iter()].filter(s => s.roomId === roomId).sort((a, b) => (a.id < b.id ? -1 : 1)),
      candles: (roomId = main) => [...h.db.candle.iter()].filter(c => c.roomId === roomId),
      news: (roomId = main) => [...h.db.news.iter()].filter(n => n.roomId === roomId),
      accounts: (roomId = main) => [...h.db.account.iter()].filter(a => a.roomId === roomId),
      holdings: (roomId = main) => [...h.db.holding.iter()].filter(r => r.roomId === roomId),
      instruments: (roomId = main) => [...h.db.instrument.iter()].filter(i => i.roomId === roomId),
      seasons: (roomId = main) =>
        [...h.db.season.iter()].filter(s => s.roomId === roomId).sort((a, b) => a.number - b.number),
    },

    /** Total cash and per-symbol shares in a room: what conservation tests compare. */
    totals(roomId = main) {
      let cash = 0n;
      for (const a of g.rows.accounts(roomId)) cash += a.cashAvailable + a.cashReserved;
      const qty: Record<string, bigint> = {};
      for (const r of g.rows.holdings(roomId)) qty[r.symbol] = (qty[r.symbol] ?? 0n) + r.qtyAvailable + r.qtyReserved;
      return { cash, qty };
    },
  };
  return g;
}

export type Game = ReturnType<typeof createGame>;
