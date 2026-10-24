import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionId, type Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';
import { EXCHANGE, STARTING_CASH, STARTING_SHARES, feeOn } from '../src/engine';

const makeHarness = () => createModuleTestHarness(spacetimedb, mod);
let h: ReturnType<typeof makeHarness>;
let nextConn = 1n;

function player(sub: string): TestAuth {
  return TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'https://test.local', sub, aud: ['order-book'] }),
    new ConnectionId(nextConn++)
  );
}

const limit = (a: TestAuth, symbol: string, side: string, price: bigint, qty: bigint) =>
  h.withReducerTx(a, ctx => mod.place_limit_order(ctx, { symbol, side, price, qty }));
const market = (a: TestAuth, symbol: string, side: string, qty: bigint) =>
  h.withReducerTx(a, ctx => mod.place_market_order(ctx, { symbol, side, qty }));
const stop = (a: TestAuth, symbol: string, side: string, stopPrice: bigint, qty: bigint) =>
  h.withReducerTx(a, ctx => mod.place_stop_order(ctx, { symbol, side, stopPrice, qty }));
const cancelStop = (a: TestAuth, stopId: bigint) =>
  h.withReducerTx(a, ctx => mod.cancel_stop_order(ctx, { stopId }));

const acct = (id: Identity) => h.db.account.identity.find(id)!;
const shares = (id: Identity, symbol: string) =>
  [...h.db.holding.iter()].find(r => r.owner.isEqual(id) && r.symbol === symbol)!;
const stops = () => [...h.db.stopOrder.iter()].sort((a, b) => (a.id < b.id ? -1 : 1));
const lastPrice = (symbol: string) => h.db.instrument.symbol.find(symbol)!.lastPrice;
const myOrders = (id: Identity) => [...h.db.orders.iter()].filter(o => o.owner.isEqual(id));

let alice: TestAuth, bob: TestAuth, carol: TestAuth;
let A: Identity, B: Identity, C: Identity;

beforeEach(() => {
  h = makeHarness();
  h.withReducerTx(TestAuth.internal(), ctx => mod.init(ctx, {}));
  [alice, bob, carol] = ['alice', 'bob', 'carol'].map(player);
  [A, B, C] = [alice, bob, carol].map(a => {
    h.withReducerTx(a, ctx => mod.register(ctx, { name: 'P' }));
    return h.withReducerTx(a, ctx => ctx.sender);
  });
});

describe('fees', () => {
  it('rounds up to the cent', () => {
    expect(feeOn(0n)).toBe(0n);
    expect(feeOn(1n)).toBe(1n);
    expect(feeOn(10_000n)).toBe(10n);
    expect(feeOn(10_001n)).toBe(11n);
  });

  it('charges only the taker portion of a limit order and records it on the order', () => {
    limit(bob, 'BRKT', 'sell', 4_000n, 5n);
    // Alice crosses for 5 and rests the other 5: she pays the fee on 5 only.
    limit(alice, 'BRKT', 'buy', 4_000n, 10n);
    const [order] = myOrders(A);
    expect(order.feePaid).toBe(feeOn(20_000n));
    expect(acct(A).cashReserved).toBe(4_000n * 5n);
    expect(acct(A).cashAvailable).toBe(STARTING_CASH - 4_000n * 10n - feeOn(20_000n));

    // Later, Carol hits Alice's resting bid: Carol pays, Alice (maker) pays nothing more.
    limit(carol, 'BRKT', 'sell', 4_000n, 5n);
    expect(myOrders(A)[0].feePaid).toBe(feeOn(20_000n));
    expect(acct(C).cashAvailable).toBe(STARTING_CASH + 20_000n - feeOn(20_000n));
    expect(acct(EXCHANGE).cashAvailable).toBe(2n * feeOn(20_000n));
  });

  it('needs cash for the worst-case fee before a buy can be placed', () => {
    // Exactly all the cash, at 1 share: affordable without a fee, not with one.
    expect(() => limit(alice, 'MOON', 'buy', STARTING_CASH, 1n)).toThrow(/Insufficient cash/);
  });

  it('sellers pay the fee out of proceeds', () => {
    limit(bob, 'BRKT', 'buy', 4_000n, 10n);
    market(alice, 'BRKT', 'sell', 10n);
    expect(acct(A).cashAvailable).toBe(STARTING_CASH + 40_000n - feeOn(40_000n));
  });
});

describe('market orders never leave half-placed state', () => {
  it('rejects a sell into an empty book without reserving shares or writing an order', () => {
    expect(() => market(alice, 'PXL', 'sell', 5n)).toThrow(/No matching orders/);
    expect(shares(A, 'PXL').qtyReserved).toBe(0n);
    expect(myOrders(A)).toHaveLength(0);
  });
});

describe('stop orders', () => {
  it('must sit on the far side of the last price', () => {
    const last = lastPrice('BRKT');
    expect(() => stop(alice, 'BRKT', 'buy', last, 1n)).toThrow(/above the last price/);
    expect(() => stop(alice, 'BRKT', 'sell', last, 1n)).toThrow(/below the last price/);
  });

  it('a sell stop reserves shares and cancelling releases them', () => {
    stop(alice, 'BRKT', 'sell', 4_000n, 30n);
    expect(shares(A, 'BRKT').qtyReserved).toBe(30n);
    expect(() => limit(alice, 'BRKT', 'sell', 9_000n, STARTING_SHARES)).toThrow(/Insufficient shares/);

    const [s] = stops();
    expect(() => cancelStop(bob, s.id)).toThrow(/Not your stop order/);
    cancelStop(alice, s.id);
    expect(shares(A, 'BRKT').qtyReserved).toBe(0n);
    expect(stops()[0].status).toBe('cancelled');
  });

  it('a sell stop fires as a market order once the price falls to it', () => {
    stop(alice, 'BRKT', 'sell', 4_000n, 10n);
    limit(bob, 'BRKT', 'buy', 3_950n, 50n); // somewhere for Alice's stop to sell into
    expect(stops()).toHaveLength(1);

    // A trade above the stop: nothing happens.
    limit(carol, 'BRKT', 'sell', 4_100n, 1n);
    limit(bob, 'BRKT', 'buy', 4_100n, 1n);
    expect(stops()[0].status).toBe('pending');

    // A trade at the stop price triggers it in the same transaction.
    limit(carol, 'BRKT', 'sell', 3_950n, 1n);
    const [s] = stops();
    expect(s.status).toBe('triggered');
    const triggered = h.db.orders.id.find(s.orderId)!;
    expect(triggered.owner.isEqual(A)).toBe(true);
    expect(triggered.remaining).toBe(0n);
    expect(shares(A, 'BRKT').qtyAvailable + shares(A, 'BRKT').qtyReserved).toBe(STARTING_SHARES - 10n);
  });

  it('a buy stop fires once the price rises to it, and cascades through further stops', () => {
    limit(bob, 'BRKT', 'sell', 4_300n, 5n);
    limit(bob, 'BRKT', 'sell', 4_400n, 5n);
    stop(alice, 'BRKT', 'buy', 4_300n, 5n);
    stop(carol, 'BRKT', 'buy', 4_400n, 5n);

    // Dave buys 1 at 43.00. That fires Alice's stop, which buys the other 4 at 43.00 and
    // 1 at 44.00. That trade at 44.00 fires Carol's stop, which buys the last 4.
    const dave = player('dave');
    h.withReducerTx(dave, ctx => mod.register(ctx, { name: 'Dave' }));
    market(dave, 'BRKT', 'buy', 1n);

    expect(stops().map(s => s.status)).toEqual(['triggered', 'triggered']);
    expect(shares(A, 'BRKT').qtyAvailable).toBe(STARTING_SHARES + 5n);
    expect(shares(C, 'BRKT').qtyAvailable).toBe(STARTING_SHARES + 4n);
    const carolOrder = h.db.orders.id.find(stops()[1].orderId)!;
    expect(carolOrder.status).toBe('cancelled'); // 1 share short: the remainder is cancelled
    expect(lastPrice('BRKT')).toBe(4_400n);
  });

  it('marks a stop failed when it cannot execute, and returns its shares', () => {
    stop(alice, 'GRVY', 'sell', 3_000n, 5n);
    // The price drops to the stop, but the only bid left was consumed: nothing to sell into.
    limit(bob, 'GRVY', 'buy', 3_000n, 1n);
    limit(carol, 'GRVY', 'sell', 3_000n, 1n);
    expect(stops()[0].status).toBe('failed');
    expect(stops()[0].note).toMatch(/No matching orders/);
    expect(shares(A, 'GRVY').qtyReserved).toBe(0n);
    expect(shares(A, 'GRVY').qtyAvailable).toBe(STARTING_SHARES);
  });
});
