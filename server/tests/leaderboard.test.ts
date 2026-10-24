import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionId } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';
import { STARTING_CASH, STARTING_SHARES, feeOn } from '../src/engine';

const makeHarness = () => createModuleTestHarness(spacetimedb, mod);
let h: ReturnType<typeof makeHarness>;
let nextConn = 1n;

function player(sub: string): TestAuth {
  return TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'https://test.local', sub, aud: ['order-book'] }),
    new ConnectionId(nextConn++)
  );
}

const board = () => mod.leaderboard(h.anonymousViewContext());
const limit = (auth: TestAuth, symbol: string, side: string, price: bigint, qty: bigint) =>
  h.withReducerTx(auth, ctx => mod.place_limit_order(ctx, { symbol, side, price, qty }));

let alice: TestAuth, bob: TestAuth;
let listingValue: bigint;

beforeEach(() => {
  h = makeHarness();
  h.withReducerTx(TestAuth.internal(), ctx => mod.init(ctx, {}));
  alice = player('alice');
  bob = player('bob');
  h.withReducerTx(alice, ctx => mod.register(ctx, { name: 'Alice' }));
  h.withReducerTx(bob, ctx => mod.register(ctx, { name: 'Bob' }));
  listingValue = 0n;
  for (const inst of h.db.instrument.iter()) listingValue += STARTING_SHARES * inst.lastPrice;
});

describe('leaderboard', () => {
  it('lists players only, at their starting net worth', () => {
    const rows = board();
    expect(rows.map(r => r.name).sort()).toEqual(['Alice', 'Bob']);
    for (const r of rows) {
      expect(r.netWorth).toBe(STARTING_CASH + listingValue);
      expect(r.startingNetWorth).toBe(r.netWorth);
    }
  });

  it('values shares at the last trade price and counts reserved cash', () => {
    // Bob sells 10 BRKT to Alice at $50, well above the $42.50 listing price.
    limit(bob, 'BRKT', 'sell', 5_000n, 10n);
    limit(alice, 'BRKT', 'buy', 5_000n, 10n);
    // Alice also parks a resting bid: reserved cash must still count.
    limit(alice, 'GRVY', 'buy', 100n, 50n);

    const repricing = STARTING_SHARES * (5_000n - 4_250n); // everyone's 100 BRKT got repriced
    const byName = Object.fromEntries(board().map(r => [r.name, r.netWorth]));
    // Alice paid $500 for shares now worth $500, plus the taker fee;
    // Bob received $500 for shares worth $500.
    expect(byName.Alice).toBe(STARTING_CASH + listingValue + repricing - feeOn(50_000n));
    expect(byName.Bob).toBe(STARTING_CASH + listingValue + repricing);
    expect(byName.Exchange).toBeUndefined();
  });

  it('ranks by net worth, highest first', () => {
    // Alice overpays Bob for 10 BRKT, then a tiny trade resets the last price,
    // so Bob comes out ahead.
    limit(bob, 'BRKT', 'sell', 9_000n, 10n);
    limit(alice, 'BRKT', 'buy', 9_000n, 10n);
    limit(alice, 'BRKT', 'sell', 4_250n, 1n);
    limit(bob, 'BRKT', 'buy', 4_250n, 1n);

    const rows = board();
    expect(rows.map(r => r.name)).toEqual(['Bob', 'Alice']);
    expect(rows[0].netWorth).toBeGreaterThan(rows[1].netWorth);
  });
});
