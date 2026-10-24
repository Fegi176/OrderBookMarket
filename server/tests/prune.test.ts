import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp, type Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';
import { MARKET_MAKER, NOISE_TRADER } from '../src/bots';
import { BOT_TRADE_RETENTION_MICROS, CANDLE_RETENTION_MICROS } from '../src/prune';

const makeHarness = () => createModuleTestHarness(spacetimedb, mod, { rngSeed: 3 });
let h: ReturnType<typeof makeHarness>;

const internal = TestAuth.internal();
const T0 = 1_800_000_000_000_000n;
const MINUTE = 60_000_000n;
const schedArg = { arg: { scheduledId: 0n, scheduledAt: { tag: 'Interval' as const, value: null as any } } };
const tick = () => h.withReducerTx(internal, ctx => mod.run_bots(ctx, schedArg));
const roll = () => h.withReducerTx(internal, ctx => mod.roll_candles(ctx, schedArg));
const at = (micros: bigint) => h.clock.set(new Timestamp(micros));

const isBot = (id: Identity) => id.isEqual(MARKET_MAKER) || id.isEqual(NOISE_TRADER);

let alice: TestAuth;
let A: Identity;

beforeEach(() => {
  h = makeHarness();
  at(T0);
  h.withReducerTx(internal, ctx => mod.init(ctx, {}));
  alice = TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'https://test.local', sub: 'alice', aud: ['order-book'] }),
    new ConnectionId(1n)
  );
  h.withReducerTx(alice, ctx => mod.register(ctx, { name: 'Alice' }));
  A = h.withReducerTx(alice, ctx => ctx.sender);
});

describe('pruning', () => {
  it('keeps only open bot orders after each tick', () => {
    for (let i = 0; i < 50; i++) tick();
    const botRows = [...h.db.orders.iter()].filter(o => isBot(o.owner));
    expect(botRows.length).toBeGreaterThan(0);
    expect(botRows.every(o => o.status === 'open')).toBe(true);
    expect(h.db.trade.count()).toBeGreaterThan(0n); // the bots did trade
  });

  it("never touches a player's orders", () => {
    tick();
    h.withReducerTx(alice, ctx => mod.place_market_order(ctx, { symbol: 'BRKT', side: 'buy', qty: 3n }));
    h.withReducerTx(alice, ctx =>
      mod.place_limit_order(ctx, { symbol: 'GRVY', side: 'buy', price: 100n, qty: 1n })
    );
    for (let i = 0; i < 20; i++) tick();
    const mine = [...h.db.orders.iter()].filter(o => o.owner.isEqual(A));
    expect(mine.map(o => o.status).sort()).toEqual(['filled', 'open']);
  });

  it('drops bot-only trades past retention but keeps every trade with a player', () => {
    tick();
    h.withReducerTx(alice, ctx => mod.place_market_order(ctx, { symbol: 'BRKT', side: 'buy', qty: 3n }));
    for (let i = 0; i < 30; i++) tick();
    const playerTrades = () => [...h.db.trade.iter()].filter(t => t.buyer.isEqual(A) || t.seller.isEqual(A));
    const botTrades = () => [...h.db.trade.iter()].filter(t => isBot(t.buyer) && isBot(t.seller));
    expect(playerTrades().length).toBeGreaterThan(0);
    expect(botTrades().length).toBeGreaterThan(0);

    // Within retention nothing goes.
    at(T0 + BOT_TRADE_RETENTION_MICROS - MINUTE);
    roll();
    expect(botTrades().length).toBeGreaterThan(0);

    // Past it, bot-only trades go and the player's stay.
    const before = playerTrades().length;
    at(T0 + BOT_TRADE_RETENTION_MICROS + MINUTE);
    roll();
    expect(botTrades()).toHaveLength(0);
    expect(playerTrades()).toHaveLength(before);
  });

  it('keeps the last few hours of candles', () => {
    for (let m = 0n; m <= 5n * 60n; m += 1n) {
      at(T0 + m * MINUTE);
      roll();
    }
    const now = T0 + 5n * 60n * MINUTE;
    const oldest = [...h.db.candle.iter()].reduce(
      (min, c) => (c.intervalStart < min ? c.intervalStart : min),
      now
    );
    expect(oldest).toBeGreaterThanOrEqual(now - CANDLE_RETENTION_MICROS - MINUTE);
    // 3 hours of one-minute bars per symbol, give or take the boundary bar.
    const perSymbol = Number(h.db.candle.count() / h.db.instrument.count());
    expect(perSymbol).toBeGreaterThanOrEqual(180);
    expect(perSymbol).toBeLessThanOrEqual(182);
  });
});
