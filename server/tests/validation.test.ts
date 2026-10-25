import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';
import { MARKET_MAKER, BOT_CASH, BOT_SHARES } from '../src/bots';

// Every reducer rejection a client can trigger, and proof that each one rolls back.

const makeHarness = () => createModuleTestHarness(spacetimedb, mod);
let h: ReturnType<typeof makeHarness>;
let nextConn = 1n;
const internal = TestAuth.internal();
const schedArg = { arg: { scheduledId: 0n, scheduledAt: { tag: 'Interval' as const, value: null as any } } };

function player(sub: string): TestAuth {
  return TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'https://test.local', sub, aud: ['order-book'] }),
    new ConnectionId(nextConn++)
  );
}

const register = (a: TestAuth, name: string) => h.withReducerTx(a, ctx => mod.register(ctx, { name }));
const limit = (a: TestAuth, symbol: string, side: string, price: bigint, qty: bigint) =>
  h.withReducerTx(a, ctx => mod.place_limit_order(ctx, { symbol, side, price, qty }));
const market = (a: TestAuth, symbol: string, side: string, qty: bigint) =>
  h.withReducerTx(a, ctx => mod.place_market_order(ctx, { symbol, side, qty }));
const stop = (a: TestAuth, symbol: string, side: string, stopPrice: bigint, qty: bigint) =>
  h.withReducerTx(a, ctx => mod.place_stop_order(ctx, { symbol, side, stopPrice, qty }));

/** A snapshot of everything a rejected call must leave untouched. */
const snapshot = () => ({
  accounts: h.db.account.count(),
  orders: h.db.orders.count(),
  stops: h.db.stopOrder.count(),
  trades: h.db.trade.count(),
  reserved: [...h.db.holding.iter()].reduce((s, r) => s + r.qtyReserved, 0n),
  cashReserved: [...h.db.account.iter()].reduce((s, a) => s + a.cashReserved, 0n),
});

beforeEach(() => {
  h = makeHarness();
  h.withReducerTx(internal, ctx => mod.init(ctx, {}));
});

describe('register', () => {
  it('trims names and rejects empty or over-long ones', () => {
    const a = player('a');
    expect(() => register(a, '   ')).toThrow(/1-24 characters/);
    expect(() => register(a, 'x'.repeat(25))).toThrow(/1-24 characters/);
    register(a, '  Ada  ');
    expect([...h.db.account.iter()].find(r => !r.isBot)?.name).toBe('Ada');
  });

  it('accepts a name of exactly 24 characters', () => {
    register(player('b'), 'y'.repeat(24));
    expect([...h.db.account.iter()].filter(r => !r.isBot)).toHaveLength(1);
  });
});

describe('trading before registering', () => {
  it('is rejected for every order type', () => {
    const ghost = player('ghost');
    const before = snapshot();
    expect(() => limit(ghost, 'BRKT', 'buy', 4_000n, 1n)).toThrow(/Register before trading/);
    expect(() => market(ghost, 'BRKT', 'buy', 1n)).toThrow(/Register before trading/);
    expect(() => stop(ghost, 'BRKT', 'buy', 5_000n, 1n)).toThrow(/Register before trading/);
    expect(snapshot()).toEqual(before);
  });
});

describe('order validation', () => {
  let alice: TestAuth;
  beforeEach(() => {
    alice = player('alice');
    register(alice, 'Alice');
  });

  it('rejects bad sides, zero quantities and zero prices without side effects', () => {
    const before = snapshot();
    expect(() => limit(alice, 'BRKT', 'hold', 4_000n, 1n)).toThrow(/side must be/);
    expect(() => limit(alice, 'BRKT', 'buy', 4_000n, 0n)).toThrow(/qty must be positive/);
    expect(() => limit(alice, 'BRKT', 'buy', 0n, 1n)).toThrow(/price must be positive/);
    expect(() => market(alice, 'BRKT', 'sideways', 1n)).toThrow(/side must be/);
    expect(() => market(alice, 'NOPE', 'buy', 1n)).toThrow(/Unknown symbol/);
    expect(snapshot()).toEqual(before);
  });

  it('rejects a market buy that cannot afford even one share plus the fee', () => {
    const bob = player('bob');
    register(bob, 'Bob');
    limit(bob, 'BRKT', 'sell', 10_000_000n, 1n); // $100,000: Alice's whole stake, before the fee
    const before = snapshot();
    expect(() => market(alice, 'BRKT', 'buy', 1n)).toThrow(/Insufficient cash/);
    expect(snapshot()).toEqual(before);
  });

  it('rejects stops at a zero price or off the tick grid', () => {
    const before = snapshot();
    expect(() => stop(alice, 'BRKT', 'sell', 0n, 1n)).toThrow(/stop price must be positive/);
    expect(() => stop(alice, 'MOON', 'buy', 13_001n, 1n)).toThrow(/tick size/);
    expect(() => stop(alice, 'BRKT', 'sell', 1_000n, 101n)).toThrow(/Insufficient shares/);
    expect(snapshot()).toEqual(before);
  });

  it('rejects cancelling unknown, foreign or finished orders and stops', () => {
    const bob = player('bob');
    register(bob, 'Bob');
    limit(bob, 'BRKT', 'sell', 4_000n, 1n);
    const [order] = [...h.db.orders.iter()];
    stop(bob, 'BRKT', 'sell', 3_000n, 1n); // well below any trade in this test, so it stays pending
    const [s] = [...h.db.stopOrder.iter()];

    expect(() => h.withReducerTx(alice, ctx => mod.cancel_order(ctx, { orderId: 999n }))).toThrow(/No such order/);
    expect(() => h.withReducerTx(alice, ctx => mod.cancel_order(ctx, { orderId: order.id }))).toThrow(
      /Not your order/
    );
    expect(() => h.withReducerTx(alice, ctx => mod.cancel_stop_order(ctx, { stopId: 999n }))).toThrow(
      /No such stop order/
    );
    expect(() => h.withReducerTx(alice, ctx => mod.cancel_stop_order(ctx, { stopId: s.id }))).toThrow(
      /Not your stop order/
    );

    limit(alice, 'BRKT', 'buy', 4_000n, 1n); // fills Bob's sell
    expect(() => h.withReducerTx(bob, ctx => mod.cancel_order(ctx, { orderId: order.id }))).toThrow(
      /already filled/
    );
    h.withReducerTx(bob, ctx => mod.cancel_stop_order(ctx, { stopId: s.id }));
    expect(() => h.withReducerTx(bob, ctx => mod.cancel_stop_order(ctx, { stopId: s.id }))).toThrow(
      /already cancelled/
    );
  });
});

describe('bot top-ups', () => {
  it('refill a bot that runs low on cash or shares', () => {
    const acc = h.db.account.identity.find(MARKET_MAKER)!;
    h.withReducerTx(internal, ctx => {
      ctx.db.account.identity.update({ ...acc, cashAvailable: 1n });
      for (const row of ctx.db.holding.byOwnerSymbol.filter([MARKET_MAKER, 'BRKT'])) {
        ctx.db.holding.id.update({ ...row, qtyAvailable: 0n });
      }
    });

    h.withReducerTx(internal, ctx => mod.run_bots(ctx, schedArg));

    const after = h.db.account.identity.find(MARKET_MAKER)!;
    expect(after.cashAvailable + after.cashReserved).toBeGreaterThan(BOT_CASH / 2n);
    const brkt = [...h.db.holding.iter()].find(r => r.owner.isEqual(MARKET_MAKER) && r.symbol === 'BRKT')!;
    expect(brkt.qtyAvailable + brkt.qtyReserved).toBe(BOT_SHARES);
  });
});
