import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionId, type Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';
import { STARTING_CASH, STARTING_SHARES } from '../src/engine';

const makeHarness = () => createModuleTestHarness(spacetimedb, mod);

let h: ReturnType<typeof makeHarness>;
let nextConn = 1n;

function player(sub: string): TestAuth {
  return TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'https://test.local', sub, aud: ['order-book'] }),
    new ConnectionId(nextConn++)
  );
}

function identityOf(auth: TestAuth): Identity {
  return h.withReducerTx(auth, ctx => ctx.sender);
}

function register(auth: TestAuth, name: string) {
  h.withReducerTx(auth, ctx => mod.register(ctx, { name }));
}

function limit(auth: TestAuth, symbol: string, side: string, price: bigint, qty: bigint) {
  h.withReducerTx(auth, ctx => mod.place_limit_order(ctx, { symbol, side, price, qty }));
}

function cancel(auth: TestAuth, orderId: bigint) {
  h.withReducerTx(auth, ctx => mod.cancel_order(ctx, { orderId }));
}

function acct(id: Identity) {
  const a = h.db.account.identity.find(id);
  if (!a) throw new Error('no account');
  return a;
}

function shares(id: Identity, symbol: string) {
  for (const row of h.db.holding.byOwnerSymbol.filter([id, symbol])) return row;
  throw new Error('no holding');
}

function openOrders(symbol: string) {
  return [...h.db.orders.iter()].filter(o => o.symbol === symbol && o.status === 'open');
}

let alice: TestAuth, bob: TestAuth, carol: TestAuth;
let A: Identity, B: Identity, C: Identity;

beforeEach(() => {
  h = makeHarness();
  h.withReducerTx(TestAuth.internal(), ctx => mod.init(ctx, {}));
  alice = player('alice');
  bob = player('bob');
  carol = player('carol');
  register(alice, 'Alice');
  register(bob, 'Bob');
  register(carol, 'Carol');
  [A, B, C] = [alice, bob, carol].map(identityOf);
});

describe('register', () => {
  it('grants starting cash and shares', () => {
    expect(acct(A).cashAvailable).toBe(STARTING_CASH);
    expect(shares(A, 'BRKT').qtyAvailable).toBe(STARTING_SHARES);
  });

  it('rejects registering twice', () => {
    expect(() => register(alice, 'Again')).toThrow(/Already registered/);
  });
});

describe('limit orders', () => {
  it('rests when nothing crosses and reserves cash', () => {
    limit(alice, 'BRKT', 'buy', 1000n, 10n);
    expect(openOrders('BRKT')).toHaveLength(1);
    expect(acct(A).cashReserved).toBe(10_000n);
    expect(acct(A).cashAvailable).toBe(STARTING_CASH - 10_000n);
  });

  it('trades at the resting price and refunds price improvement', () => {
    limit(bob, 'BRKT', 'sell', 900n, 10n);
    limit(alice, 'BRKT', 'buy', 1000n, 10n);

    const trades = [...h.db.trade.iter()];
    expect(trades).toHaveLength(1);
    expect(trades[0].price).toBe(900n);
    expect(trades[0].qty).toBe(10n);

    expect(acct(A).cashAvailable).toBe(STARTING_CASH - 9_000n);
    expect(acct(A).cashReserved).toBe(0n);
    expect(acct(B).cashAvailable).toBe(STARTING_CASH + 9_000n);
    expect(shares(A, 'BRKT').qtyAvailable).toBe(STARTING_SHARES + 10n);
    expect(shares(B, 'BRKT').qtyAvailable).toBe(STARTING_SHARES - 10n);
    expect(shares(B, 'BRKT').qtyReserved).toBe(0n);
    expect(openOrders('BRKT')).toHaveLength(0);
  });

  it('follows price-time priority and rests the remainder', () => {
    limit(bob, 'BRKT', 'sell', 1010n, 5n); // worse price
    limit(carol, 'BRKT', 'sell', 1000n, 5n); // best price, first in time
    limit(bob, 'BRKT', 'sell', 1000n, 5n); // best price, second in time

    limit(alice, 'BRKT', 'buy', 1000n, 8n);

    const trades = [...h.db.trade.iter()].sort((x, y) => Number(x.id - y.id));
    expect(trades.map(t => [t.seller.isEqual(C) ? 'carol' : 'bob', t.qty])).toEqual([
      ['carol', 5n],
      ['bob', 3n],
    ]);
    const book = openOrders('BRKT').map(o => [o.price, o.remaining]);
    expect(book).toContainEqual([1000n, 2n]);
    expect(book).toContainEqual([1010n, 5n]);
  });

  it('sell orders hit the highest bid first', () => {
    limit(bob, 'BRKT', 'buy', 990n, 5n);
    limit(carol, 'BRKT', 'buy', 1000n, 5n);
    limit(alice, 'BRKT', 'sell', 980n, 5n);

    const [trade] = [...h.db.trade.iter()];
    expect(trade.buyer.isEqual(C)).toBe(true);
    expect(trade.price).toBe(1000n);
  });

  it('skips matches against your own orders', () => {
    limit(alice, 'BRKT', 'sell', 1000n, 5n);
    limit(alice, 'BRKT', 'buy', 1000n, 5n);
    expect([...h.db.trade.iter()]).toHaveLength(0);
    expect(openOrders('BRKT')).toHaveLength(2);
  });

  it('rejects bad input and rolls back', () => {
    expect(() => limit(alice, 'NOPE', 'buy', 100n, 1n)).toThrow(/Unknown symbol/);
    expect(() => limit(alice, 'MOON', 'buy', 101n, 1n)).toThrow(/tick size/);
    expect(() => limit(alice, 'BRKT', 'buy', STARTING_CASH, 2n)).toThrow(/Insufficient cash/);
    expect(() => limit(alice, 'BRKT', 'sell', 100n, STARTING_SHARES + 1n)).toThrow(
      /Insufficient shares/
    );
    expect(acct(A).cashReserved).toBe(0n);
    expect(h.db.orders.count()).toBe(0n);
  });
});

describe('cancel_order', () => {
  it('releases the reservation; only the owner may cancel', () => {
    limit(alice, 'BRKT', 'buy', 1000n, 10n);
    limit(bob, 'BRKT', 'sell', 2000n, 10n);
    const [buy, sell] = [...h.db.orders.iter()].sort((x, y) => Number(x.seq - y.seq));

    expect(() => cancel(bob, buy.id)).toThrow(/Not your order/);

    cancel(alice, buy.id);
    cancel(bob, sell.id);
    expect(acct(A).cashAvailable).toBe(STARTING_CASH);
    expect(acct(A).cashReserved).toBe(0n);
    expect(shares(B, 'BRKT').qtyAvailable).toBe(STARTING_SHARES);
    expect(() => cancel(alice, buy.id)).toThrow(/already cancelled/);
  });
});

describe('invariants', () => {
  it('conserves total cash and shares across many random orders', () => {
    const players = [alice, bob, carol];
    const symbols = ['BRKT', 'MOON'];
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };

    const totals = () => {
      let cash = 0n;
      for (const a of h.db.account.iter()) cash += a.cashAvailable + a.cashReserved;
      const qty: Record<string, bigint> = {};
      for (const row of h.db.holding.iter()) {
        qty[row.symbol] = (qty[row.symbol] ?? 0n) + row.qtyAvailable + row.qtyReserved;
      }
      return { cash, qty };
    };
    const before = totals();

    for (let i = 0; i < 1000; i++) {
      const who = players[rand(players.length)];
      if (rand(10) === 0) {
        const mine = [...h.db.orders.iter()].filter(o => o.status === 'open');
        if (mine.length) {
          try {
            cancel(who, mine[rand(mine.length)].id);
          } catch {}
        }
        continue;
      }
      const price = BigInt(950 + rand(20) * 5);
      try {
        limit(who, symbols[rand(2)], rand(2) ? 'buy' : 'sell', price, BigInt(1 + rand(20)));
      } catch {}
    }

    expect(h.db.trade.count()).toBeGreaterThan(0n);
    expect(totals()).toEqual(before);

    // Reserved amounts must equal exactly what open orders still hold.
    for (const id of [A, B, C]) {
      const open = [...h.db.orders.byOwner.filter(id)].filter(o => o.status === 'open');
      const cashHeld = open.filter(o => o.side === 'buy').reduce((s, o) => s + o.price * o.remaining, 0n);
      expect(acct(id).cashReserved).toBe(cashHeld);
      for (const symbol of symbols) {
        const sharesHeld = open
          .filter(o => o.side === 'sell' && o.symbol === symbol)
          .reduce((s, o) => s + o.remaining, 0n);
        expect(shares(id, symbol).qtyReserved).toBe(sharesHeld);
      }
    }
  });
});
