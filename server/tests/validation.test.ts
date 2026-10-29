import { beforeEach, describe, expect, it } from 'vitest';
import { createGame, internal, type Game, type Harness, type TestAuth } from './helpers';
import { MARKET_MAKER, BOT_CASH, BOT_SHARES } from '../src/bots';

// Every reducer rejection a client can trigger, and proof that each one rolls back.

let g: Game;
let h: Harness;

const join = (a: TestAuth, name: string) => g.join(a, name);
const limit = (a: TestAuth, symbol: string, side: string, price: bigint, qty: bigint) =>
  g.limit(a, symbol, side, price, qty);
const market = (a: TestAuth, symbol: string, side: string, qty: bigint) => g.market(a, symbol, side, qty);
const stop = (a: TestAuth, symbol: string, side: string, stopPrice: bigint, qty: bigint) =>
  g.stop(a, symbol, side, stopPrice, qty);

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
  g = createGame();
  h = g.h;
});

describe('joining', () => {
  it('trims names and rejects empty or over-long ones', () => {
    const a = g.player('a');
    expect(() => join(a, '   ')).toThrow(/1-24 characters/);
    expect(() => join(a, 'x'.repeat(25))).toThrow(/1-24 characters/);
    join(a, '  Ada  ');
    expect([...h.db.account.iter()].find(r => !r.isBot)?.name).toBe('Ada');
  });

  it('accepts a name of exactly 24 characters', () => {
    join(g.player('b'), 'y'.repeat(24));
    expect([...h.db.account.iter()].filter(r => !r.isBot)).toHaveLength(1);
  });
});

describe('trading before joining', () => {
  it('is rejected for every order type', () => {
    const ghost = g.player('ghost');
    const before = snapshot();
    expect(() => limit(ghost, 'BRKT', 'buy', 4_000n, 1n)).toThrow(/Join this room before trading/);
    expect(() => market(ghost, 'BRKT', 'buy', 1n)).toThrow(/Join this room before trading/);
    expect(() => stop(ghost, 'BRKT', 'buy', 5_000n, 1n)).toThrow(/Join this room before trading/);
    expect(snapshot()).toEqual(before);
  });
});

describe('order validation', () => {
  let alice: TestAuth;
  beforeEach(() => {
    alice = g.newPlayer('Alice');
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
    const bob = g.newPlayer('Bob');
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
    const bob = g.newPlayer('Bob');
    limit(bob, 'BRKT', 'sell', 4_000n, 1n);
    const [order] = [...h.db.orders.iter()];
    stop(bob, 'BRKT', 'sell', 3_000n, 1n); // well below any trade in this test, so it stays pending
    const [s] = [...h.db.stopOrder.iter()];

    expect(() => g.cancel(alice, 999n)).toThrow(/No such order/);
    expect(() => g.cancel(alice, order.id)).toThrow(/Not your order/);
    expect(() => g.cancelStop(alice, 999n)).toThrow(/No such stop order/);
    expect(() => g.cancelStop(alice, s.id)).toThrow(/Not your stop order/);

    limit(alice, 'BRKT', 'buy', 4_000n, 1n); // fills Bob's sell
    expect(() => g.cancel(bob, order.id)).toThrow(/already filled/);
    g.cancelStop(bob, s.id);
    expect(() => g.cancelStop(bob, s.id)).toThrow(/already cancelled/);
  });
});

describe('bot top-ups', () => {
  it('refill a bot that runs low on cash or shares', () => {
    const acc = g.acct(MARKET_MAKER);
    h.withReducerTx(internal, ctx => {
      ctx.db.account.id.update({ ...acc, cashAvailable: 1n });
      for (const row of ctx.db.holding.byOwnerSymbol.filter([g.main, MARKET_MAKER, 'BRKT'])) {
        ctx.db.holding.id.update({ ...row, qtyAvailable: 0n });
      }
    });

    g.tick();

    const after = g.acct(MARKET_MAKER);
    expect(after.cashAvailable + after.cashReserved).toBeGreaterThan(BOT_CASH / 2n);
    const brkt = g.shares(MARKET_MAKER, 'BRKT');
    expect(brkt.qtyAvailable + brkt.qtyReserved).toBe(BOT_SHARES);
  });
});
