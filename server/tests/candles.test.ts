import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';
import { CANDLE_INTERVAL_MICROS } from '../src/candles';

const makeHarness = () => createModuleTestHarness(spacetimedb, mod);
let h: ReturnType<typeof makeHarness>;
let nextConn = 1n;

function player(sub: string): TestAuth {
  return TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'https://test.local', sub, aud: ['order-book'] }),
    new ConnectionId(nextConn++)
  );
}

function limit(auth: TestAuth, symbol: string, side: string, price: bigint, qty: bigint) {
  h.withReducerTx(auth, ctx => mod.place_limit_order(ctx, { symbol, side, price, qty }));
}

function roll() {
  h.withReducerTx(TestAuth.internal(), ctx =>
    mod.roll_candles(ctx, { arg: { scheduledId: 0n, scheduledAt: { tag: 'Interval', value: null as any } } })
  );
}

const MINUTE = CANDLE_INTERVAL_MICROS;
const at = (micros: bigint) => h.clock.set(new Timestamp(micros));
const candles = (symbol: string) =>
  [...h.db.candle.iter()]
    .filter(c => c.symbol === symbol)
    .sort((a, b) => (a.intervalStart < b.intervalStart ? -1 : 1));

let alice: TestAuth, bob: TestAuth;

beforeEach(() => {
  h = makeHarness();
  at(10n * MINUTE + 5_000_000n); // 5s into minute 10
  h.withReducerTx(TestAuth.internal(), ctx => mod.init(ctx, {}));
  alice = player('alice');
  bob = player('bob');
  h.withReducerTx(alice, ctx => mod.register(ctx, { name: 'Alice' }));
  h.withReducerTx(bob, ctx => mod.register(ctx, { name: 'Bob' }));
});

describe('candles', () => {
  it('init opens a flat candle per instrument at the listing price', () => {
    const [c] = candles('BRKT');
    expect(c).toMatchObject({
      intervalStart: 10n * MINUTE,
      open: 4_250n,
      high: 4_250n,
      low: 4_250n,
      close: 4_250n,
      volume: 0n,
    });
    expect(h.db.candle.count()).toBe(h.db.instrument.count());
  });

  it('trades update last price and the current bar', () => {
    limit(bob, 'BRKT', 'sell', 4_300n, 5n);
    limit(alice, 'BRKT', 'buy', 4_300n, 5n);
    limit(bob, 'BRKT', 'sell', 4_100n, 2n);
    limit(alice, 'BRKT', 'buy', 4_100n, 2n);

    expect(h.db.instrument.symbol.find('BRKT')!.lastPrice).toBe(4_100n);
    expect(candles('BRKT')).toHaveLength(1);
    expect(candles('BRKT')[0]).toMatchObject({
      open: 4_250n,
      high: 4_300n,
      low: 4_100n,
      close: 4_100n,
      volume: 7n,
    });
  });

  it('a trade in a new minute starts a new bar; roll fills quiet symbols at last price', () => {
    limit(bob, 'GRVY', 'sell', 3_400n, 1n);
    limit(alice, 'GRVY', 'buy', 3_400n, 1n);

    at(11n * MINUTE + 1n);
    limit(bob, 'BRKT', 'sell', 4_200n, 3n);
    limit(alice, 'BRKT', 'buy', 4_200n, 3n);
    roll();
    roll(); // idempotent within an interval

    expect(candles('BRKT').map(c => [c.intervalStart, c.open, c.close, c.volume])).toEqual([
      [10n * MINUTE, 4_250n, 4_250n, 0n],
      [11n * MINUTE, 4_200n, 4_200n, 3n],
    ]);
    expect(candles('GRVY')[1]).toMatchObject({ open: 3_400n, close: 3_400n, volume: 0n });
    expect(h.db.candle.count()).toBe(2n * h.db.instrument.count());
  });

  it('clients cannot call roll_candles', () => {
    expect(() =>
      h.withReducerTx(alice, ctx =>
        mod.roll_candles(ctx, { arg: { scheduledId: 0n, scheduledAt: { tag: 'Interval', value: null as any } } })
      )
    ).toThrow(/internal/);
  });
});
