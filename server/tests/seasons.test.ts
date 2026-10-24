import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';
import { EXCHANGE, STARTING_CASH, STARTING_SHARES } from '../src/engine';
import { SEASON_LENGTH_MICROS } from '../src/seasons';

const makeHarness = () => createModuleTestHarness(spacetimedb, mod, { rngSeed: 7 });
let h: ReturnType<typeof makeHarness>;
let nextConn = 1n;

const internal = TestAuth.internal();
const T0 = 1_800_000_000_000_000n;
const schedArg = { arg: { scheduledId: 0n, scheduledAt: { tag: 'Interval' as const, value: null as any } } };
const endSeason = () => h.withReducerTx(internal, ctx => mod.end_season(ctx, schedArg));

function player(sub: string): TestAuth {
  return TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'https://test.local', sub, aud: ['order-book'] }),
    new ConnectionId(nextConn++)
  );
}

function setup(players: string[]) {
  h = makeHarness();
  h.clock.set(new Timestamp(T0));
  h.withReducerTx(internal, ctx => mod.init(ctx, {}));
  return players.map(name => {
    const auth = player(name);
    h.withReducerTx(auth, ctx => mod.register(ctx, { name }));
    return auth;
  });
}

const limit = (a: TestAuth, symbol: string, side: string, price: bigint, qty: bigint) =>
  h.withReducerTx(a, ctx => mod.place_limit_order(ctx, { symbol, side, price, qty }));

function totals() {
  let cash = 0n;
  for (const a of h.db.account.iter()) cash += a.cashAvailable + a.cashReserved;
  const qty: Record<string, bigint> = {};
  for (const r of h.db.holding.iter()) qty[r.symbol] = (qty[r.symbol] ?? 0n) + r.qtyAvailable + r.qtyReserved;
  return { cash, qty };
}

const seasons = () => [...h.db.season.iter()].sort((a, b) => a.number - b.number);

let alice: TestAuth, bob: TestAuth;

beforeEach(() => {
  [alice, bob] = setup(['Alice', 'Bob']);
});

describe('seasons', () => {
  it('init opens season 1 for one week and schedules its end', () => {
    const [s] = seasons();
    expect(s).toMatchObject({ number: 1, status: 'active' });
    expect(s.startsAt.microsSinceUnixEpoch).toBe(T0);
    expect(s.endsAt.microsSinceUnixEpoch).toBe(T0 + SEASON_LENGTH_MICROS);
    const [sched] = [...h.db.seasonSchedule.iter()];
    if (sched.scheduledAt.tag !== 'Time') throw new Error('season end should be a one-off time');
    expect(sched.scheduledAt.value.microsSinceUnixEpoch).toBe(T0 + SEASON_LENGTH_MICROS);
  });

  it('saves final standings, ranked, before resetting', () => {
    // Bob sells Alice 10 BRKT far above listing; the last price then marks everyone up,
    // and Bob banks the overpayment, so Bob finishes first.
    limit(bob, 'BRKT', 'sell', 9_000n, 10n);
    limit(alice, 'BRKT', 'buy', 9_000n, 10n);
    limit(alice, 'BRKT', 'sell', 4_250n, 1n);
    limit(bob, 'BRKT', 'buy', 4_250n, 1n);
    const before = mod.leaderboard(h.anonymousViewContext());

    endSeason();

    const results = [...h.db.seasonResult.iter()].sort((a, b) => a.rank - b.rank);
    expect(results.map(r => [r.seasonNumber, r.rank, r.name])).toEqual([
      [1, 1, 'Bob'],
      [1, 2, 'Alice'],
    ]);
    expect(results.map(r => r.netWorth)).toEqual(before.map(r => r.netWorth));
    expect(results.some(r => r.identity.isEqual(EXCHANGE))).toBe(false);
  });

  it('resets balances, books, prices and history, and starts season 2', () => {
    limit(bob, 'BRKT', 'sell', 5_000n, 10n);
    limit(alice, 'BRKT', 'buy', 5_000n, 10n); // a trade, fees and a new last price
    limit(alice, 'GRVY', 'buy', 3_000n, 5n); // a resting order holding reserved cash
    h.withReducerTx(bob, ctx =>
      mod.place_stop_order(ctx, { symbol: 'PXL', side: 'sell', stopPrice: 900n, qty: 5n })
    );
    for (let i = 0; i < 5; i++) h.withReducerTx(internal, ctx => mod.run_bots(ctx, schedArg));
    h.withReducerTx(internal, ctx => mod.fire_news_event(ctx, schedArg));

    h.clock.set(new Timestamp(T0 + SEASON_LENGTH_MICROS));
    endSeason();

    expect(seasons().map(s => [s.number, s.status])).toEqual([
      [1, 'ended'],
      [2, 'active'],
    ]);
    expect(seasons()[1].endsAt.microsSinceUnixEpoch).toBe(T0 + 2n * SEASON_LENGTH_MICROS);

    expect(h.db.orders.count()).toBe(0n);
    expect(h.db.stopOrder.count()).toBe(0n);
    expect(h.db.trade.count()).toBe(0n);
    expect(h.db.news.count()).toBe(0n);
    expect(h.db.candle.count()).toBe(h.db.instrument.count()); // one fresh bar each

    for (const inst of h.db.instrument.iter()) {
      expect(inst.lastPrice).toBe(inst.listingPrice);
      expect(h.db.marketState.symbol.find(inst.symbol)!.fairValue).toBe(inst.listingPrice);
    }

    let listing = STARTING_CASH;
    for (const inst of h.db.instrument.iter()) listing += STARTING_SHARES * inst.listingPrice;
    for (const acc of h.db.account.iter()) {
      expect(acc.cashReserved).toBe(0n);
      if (acc.identity.isEqual(EXCHANGE)) expect(acc.cashAvailable).toBe(0n);
      if (!acc.isBot) {
        expect(acc.cashAvailable).toBe(STARTING_CASH);
        expect(acc.startingNetWorth).toBe(listing);
      }
    }
    for (const row of h.db.holding.iter()) expect(row.qtyReserved).toBe(0n);
  });

  it('leaves the same totals as a fresh start with the same players', () => {
    limit(bob, 'BRKT', 'sell', 5_000n, 10n);
    limit(alice, 'BRKT', 'buy', 5_000n, 10n);
    for (let i = 0; i < 20; i++) h.withReducerTx(internal, ctx => mod.run_bots(ctx, schedArg));
    endSeason();
    const afterReset = totals();

    setup(['Alice', 'Bob']);
    expect(afterReset).toEqual(totals());
  });

  it('keeps accounts: players trade on in the new season without registering again', () => {
    endSeason();
    expect(() => h.withReducerTx(alice, ctx => mod.register(ctx, { name: 'Alice' }))).toThrow(
      /Already registered/
    );
    limit(bob, 'BRKT', 'sell', 4_300n, 5n);
    limit(alice, 'BRKT', 'buy', 4_300n, 5n);
    expect(h.db.trade.count()).toBe(1n);
  });

  it('clients cannot end a season', () => {
    expect(() => h.withReducerTx(alice, ctx => mod.end_season(ctx, schedArg))).toThrow(/internal/);
    expect(seasons()).toHaveLength(1);
  });
});
