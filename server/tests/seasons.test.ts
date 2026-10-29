import { beforeEach, describe, expect, it } from 'vitest';
import { createGame, type Game, type Harness, type TestAuth } from './helpers';
import { EXCHANGE, STARTING_CASH, STARTING_SHARES } from '../src/engine';
import { SEASON_LENGTH_MICROS } from '../src/seasons';

const T0 = 1_800_000_000_000_000n;

let g: Game;
let h: Harness;

function setup(players: string[]) {
  g = createGame({ rngSeed: 7, t0: T0 });
  h = g.h;
  return players.map(name => g.newPlayer(name));
}

const endSeason = () => g.endSeason();
const limit = (a: TestAuth, symbol: string, side: string, price: bigint, qty: bigint) =>
  g.limit(a, symbol, side, price, qty);
const totals = () => g.totals();
const seasons = () => g.rows.seasons();

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
    const before = g.leaderboard();

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
    g.stop(bob, 'PXL', 'sell', 900n, 5n);
    for (let i = 0; i < 5; i++) g.tick();
    g.news();

    g.at(T0 + SEASON_LENGTH_MICROS);
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
      expect(g.fair(inst.symbol)).toBe(inst.listingPrice);
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
    for (let i = 0; i < 20; i++) g.tick();
    endSeason();
    const afterReset = totals();

    setup(['Alice', 'Bob']);
    expect(afterReset).toEqual(totals());
  });

  it('keeps accounts: players trade on in the new season without joining again', () => {
    endSeason();
    expect(() => g.join(alice, 'Alice')).toThrow(/Already in this room/);
    limit(bob, 'BRKT', 'sell', 4_300n, 5n);
    limit(alice, 'BRKT', 'buy', 4_300n, 5n);
    expect(h.db.trade.count()).toBe(1n);
  });

  it('clients cannot end a season', () => {
    expect(() => g.endSeason(g.main, alice)).toThrow(/internal/);
    expect(seasons()).toHaveLength(1);
  });
});
