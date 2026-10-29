import { beforeEach, describe, expect, it } from 'vitest';
import type { Identity } from 'spacetimedb';
import { createGame, type Game, type Harness, type TestAuth } from './helpers';
import { EXCHANGE, STARTING_CASH, STARTING_SHARES, feeOn } from '../src/engine';

// Everything here runs in the Main room.
let g: Game;
let h: Harness;

const limit = (a: TestAuth, symbol: string, side: string, price: bigint, qty: bigint) =>
  g.limit(a, symbol, side, price, qty);
const market = (a: TestAuth, symbol: string, side: string, qty: bigint) => g.market(a, symbol, side, qty);
const cancel = (a: TestAuth, orderId: bigint) => g.cancel(a, orderId);
const acct = (id: Identity) => g.acct(id);
const shares = (id: Identity, symbol: string) => g.shares(id, symbol);
const openOrders = (symbol: string) =>
  [...h.db.orders.iter()].filter(o => o.symbol === symbol && o.status === 'open');

let alice: TestAuth, bob: TestAuth, carol: TestAuth;
let A: Identity, B: Identity, C: Identity;

beforeEach(() => {
  g = createGame();
  h = g.h;
  [alice, bob, carol] = ['Alice', 'Bob', 'Carol'].map(name => g.newPlayer(name));
  [A, B, C] = [alice, bob, carol].map(g.id);
});

describe('joining', () => {
  it('grants starting cash and shares', () => {
    expect(acct(A).cashAvailable).toBe(STARTING_CASH);
    expect(shares(A, 'BRKT').qtyAvailable).toBe(STARTING_SHARES);
  });

  it('rejects joining the same room twice', () => {
    expect(() => g.join(alice, 'Again')).toThrow(/Already in this room/);
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

    // Alice took liquidity, so she pays the taker fee; Bob's resting order pays none.
    expect(acct(A).cashAvailable).toBe(STARTING_CASH - 9_000n - feeOn(9_000n));
    expect(acct(A).cashReserved).toBe(0n);
    expect(acct(B).cashAvailable).toBe(STARTING_CASH + 9_000n);
    expect(acct(EXCHANGE).cashAvailable).toBe(feeOn(9_000n));
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

describe('market orders', () => {
  it('sweeps several price levels at the resting prices', () => {
    limit(bob, 'BRKT', 'sell', 1000n, 5n);
    limit(carol, 'BRKT', 'sell', 1010n, 5n);
    market(alice, 'BRKT', 'buy', 8n);

    const trades = [...h.db.trade.iter()].map(t => [t.price, t.qty]);
    expect(trades).toEqual([
      [1000n, 5n],
      [1010n, 3n],
    ]);
    const notional = 5n * 1000n + 3n * 1010n;
    expect(acct(A).cashAvailable).toBe(STARTING_CASH - notional - feeOn(notional));
    expect(acct(A).cashReserved).toBe(0n);
    expect(shares(A, 'BRKT').qtyAvailable).toBe(STARTING_SHARES + 8n);
  });

  it('never rests: the unfilled part is cancelled and shares are released', () => {
    limit(bob, 'BRKT', 'buy', 1000n, 3n);
    market(alice, 'BRKT', 'sell', 10n);

    const mkt = [...h.db.orders.iter()].find(o => o.owner.isEqual(A))!;
    expect(mkt.status).toBe('cancelled');
    expect(mkt.remaining).toBe(7n);
    expect(shares(A, 'BRKT').qtyAvailable).toBe(STARTING_SHARES - 3n);
    expect(shares(A, 'BRKT').qtyReserved).toBe(0n);
    expect(openOrders('BRKT')).toHaveLength(0);
  });

  it('stops buying when cash runs out', () => {
    // $10,000 a share: starting cash covers 10 shares, but not 10 plus the fee, so 9.
    const price = 1_000_000n;
    limit(bob, 'BRKT', 'sell', price, 15n);
    market(alice, 'BRKT', 'buy', 15n);

    expect(shares(A, 'BRKT').qtyAvailable).toBe(STARTING_SHARES + 9n);
    expect(acct(A).cashAvailable).toBe(STARTING_CASH - 9n * price - feeOn(9n * price));
    expect(acct(A).cashReserved).toBe(0n);
  });

  it('fails and rolls back when nothing can fill', () => {
    limit(alice, 'BRKT', 'sell', 1000n, 5n); // own order only: skipped
    expect(() => market(alice, 'BRKT', 'buy', 5n)).toThrow(/No matching orders/);
    expect(() => market(bob, 'GRVY', 'sell', 5n)).toThrow(/No matching orders/);
    expect(shares(B, 'GRVY').qtyReserved).toBe(0n);
    expect(h.db.orders.count()).toBe(1n);
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
      const [symbol, side, qty] = [symbols[rand(2)], rand(2) ? 'buy' : 'sell', BigInt(1 + rand(20))];
      try {
        const roll = rand(10);
        if (roll < 2) market(who, symbol, side, qty);
        else if (roll < 4) {
          // A stop a few ticks either side of the last price, so the random flow fires some.
          const last = g.inst(symbol)!.lastPrice;
          const offset = BigInt(1 + rand(10)) * 5n;
          const stopPrice = side === 'buy' ? last + offset : last - offset;
          g.stop(who, symbol, side, stopPrice, qty);
        } else limit(who, symbol, side, price, qty);
      } catch {}
    }

    expect(h.db.trade.count()).toBeGreaterThan(0n);
    expect(totals()).toEqual(before);
    const stopStatuses = new Set([...h.db.stopOrder.iter()].map(s => s.status));
    // Stops were placed and some fired. In this thin random book many find nothing to
    // sell into and fail, which is fine here; successful triggers have their own tests.
    expect(stopStatuses.has('pending')).toBe(true);
    expect(stopStatuses.has('triggered') || stopStatuses.has('failed')).toBe(true);

    // Reserved amounts must equal exactly what open orders and pending sell stops hold.
    for (const id of [A, B, C]) {
      const open = [...h.db.orders.byOwner.filter(id)].filter(o => o.status === 'open');
      const pendingStops = [...h.db.stopOrder.iter()].filter(
        s => s.owner.isEqual(id) && s.status === 'pending' && s.side === 'sell'
      );
      const cashHeld = open.filter(o => o.side === 'buy').reduce((s, o) => s + o.price * o.remaining, 0n);
      expect(acct(id).cashReserved).toBe(cashHeld);
      for (const symbol of symbols) {
        const sharesHeld =
          open.filter(o => o.side === 'sell' && o.symbol === symbol).reduce((s, o) => s + o.remaining, 0n) +
          pendingStops.filter(s => s.symbol === symbol).reduce((s, o) => s + o.qty, 0n);
        expect(shares(id, symbol).qtyReserved).toBe(sharesHeld);
      }
    }
  });
});
