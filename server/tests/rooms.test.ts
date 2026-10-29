import { beforeEach, describe, expect, it } from 'vitest';
import { createGame, mod, type Game, type Harness, type TestAuth } from './helpers';
import { STARTING_CASH } from '../src/engine';
import { MAX_ROOMS_PER_PLAYER } from '../src/rooms';

let g: Game;
let h: Harness;
let ada: TestAuth;

beforeEach(() => {
  g = createGame({ rngSeed: 11, t0: 1_800_000_000_000_000n });
  h = g.h;
  ada = g.newPlayer('Ada');
});

describe('the Main room', () => {
  it('is created by init as a public, fully stocked market', () => {
    const [main] = [...h.db.room.iter()];
    expect(main).toMatchObject({ name: 'Main', isPublic: true });
    expect(g.rows.instruments()).toHaveLength(6);
    expect(g.rows.accounts().filter(a => a.isBot).map(a => a.name).sort()).toEqual([
      'Exchange',
      'Liquidity Bot',
      'Noise Bot',
    ]);
    expect(g.rows.seasons().map(s => [s.number, s.status])).toEqual([[1, 'active']]);
    expect([...h.db.newsSchedule.iter()].map(s => s.roomId)).toEqual([g.main]);
  });
});

describe('creating rooms', () => {
  it('gives a private room its own market, a readable code, and joins its creator', () => {
    const roomId = g.createRoom(ada, 'Friday Club', false, 'Ada');
    const room = h.db.room.id.find(roomId)!;
    expect(room).toMatchObject({ name: 'Friday Club', isPublic: false });
    expect(room.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);

    expect(g.rows.instruments(roomId)).toHaveLength(6);
    expect(g.rows.accounts(roomId).filter(a => a.isBot)).toHaveLength(3);
    expect(g.rows.seasons(roomId).map(s => s.number)).toEqual([1]);
    expect([...h.db.seasonSchedule.iter()].filter(s => s.roomId === roomId)).toHaveLength(1);
    expect([...h.db.newsSchedule.iter()].filter(s => s.roomId === roomId)).toHaveLength(1);
    expect(g.acct(g.id(ada), roomId).cashAvailable).toBe(STARTING_CASH);
  });

  it('validates the name and caps rooms per player', () => {
    expect(() => g.createRoom(ada, '  ', true)).toThrow(/Room name must be 1-32/);
    for (let i = 0; i < MAX_ROOMS_PER_PLAYER; i++) g.createRoom(ada, `Room ${i}`, true);
    expect(() => g.createRoom(ada, 'One too many', true)).toThrow(/at most 3 rooms/);
  });
});

describe('joining rooms', () => {
  let privateId: bigint;
  let code: string;
  beforeEach(() => {
    privateId = g.createRoom(ada, 'Secret', false);
    code = h.db.room.id.find(privateId)!.code;
  });

  it('needs the invite code for a private room', () => {
    const bo = g.player('bo');
    expect(() => g.join(bo, 'Bo', privateId)).toThrow(/needs an invite code/);
    expect(() => g.join(bo, 'Bo', 0n, 'ZZZZZZ')).toThrow(/No room with that code/);
    g.join(bo, 'Bo', 0n, ` ${code.toLowerCase()} `); // forgiving about case and spaces
    expect(g.acct(g.id(bo), privateId).name).toBe('Bo');
  });

  it('opens public rooms by id', () => {
    const publicId = g.createRoom(ada, 'Open Floor', true);
    const bo = g.player('bo');
    g.join(bo, 'Bo', publicId);
    expect(g.rows.accounts(publicId).filter(a => !a.isBot)).toHaveLength(2);
  });

  it('rejects unknown rooms and joining twice', () => {
    expect(() => g.join(g.player('x'), 'X', 999n)).toThrow(/No such room/);
    expect(() => g.join(ada, 'Ada', 0n, code)).toThrow(/Already in this room/);
  });
});

describe('isolation between rooms', () => {
  let other: bigint;
  let bo: TestAuth;
  beforeEach(() => {
    other = g.createRoom(ada, 'Other', true, 'Ada');
    bo = g.newPlayer('Bo');
    g.join(bo, 'Bo', other);
  });

  it('keeps separate balances, books, prices and candles per room', () => {
    // Same two players, same symbol, different rooms and prices.
    g.limit(bo, 'BRKT', 'sell', 5_000n, 10n, g.main);
    g.limit(ada, 'BRKT', 'buy', 5_000n, 10n, g.main);
    g.limit(bo, 'BRKT', 'sell', 3_000n, 2n, other);

    expect(g.inst('BRKT', g.main).lastPrice).toBe(5_000n);
    expect(g.inst('BRKT', other).lastPrice).toBe(4_250n); // untouched listing price
    expect(g.acct(g.id(ada), g.main).cashAvailable).toBeLessThan(STARTING_CASH);
    expect(g.acct(g.id(ada), other).cashAvailable).toBe(STARTING_CASH);
    expect(g.shares(g.id(bo), 'BRKT', other).qtyReserved).toBe(2n);
    expect(g.shares(g.id(bo), 'BRKT', g.main).qtyReserved).toBe(0n);
    expect(g.rows.trades(other)).toHaveLength(0);
    expect(g.rows.candles(other).every(c => c.volume === 0n)).toBe(true);
  });

  it('never matches an order against another room\'s book', () => {
    g.limit(bo, 'GRVY', 'sell', 3_000n, 5n, other);
    g.limit(ada, 'GRVY', 'buy', 3_000n, 5n, g.main); // same price, wrong room
    expect(g.rows.trades(g.main)).toHaveLength(0);
    expect(g.rows.trades(other)).toHaveLength(0);
    expect(() => g.market(ada, 'GRVY', 'buy', 1n, g.main)).toThrow(/No matching orders/);
  });

  it('runs bots in every room and conserves each room\'s cash and shares', () => {
    const before = [g.totals(g.main), g.totals(other)];
    for (let i = 0; i < 40; i++) g.tick();
    expect(g.rows.trades(g.main).length).toBeGreaterThan(0);
    expect(g.rows.trades(other).length).toBeGreaterThan(0);
    expect([g.totals(g.main), g.totals(other)]).toEqual(before);
  });

  it('fires news and ends seasons per room', () => {
    g.news(other);
    expect(g.rows.news(other)).toHaveLength(1);
    expect(g.rows.news(g.main)).toHaveLength(0);

    g.limit(bo, 'BRKT', 'sell', 5_000n, 10n, g.main);
    g.limit(ada, 'BRKT', 'buy', 5_000n, 10n, g.main);
    g.endSeason(other);
    expect(g.rows.seasons(other).map(s => s.status)).toEqual(['ended', 'active']);
    expect(g.rows.seasons(g.main).map(s => s.status)).toEqual(['active']);
    expect(g.rows.trades(g.main)).toHaveLength(1); // Main's history survives Other's reset
    expect([...h.db.seasonResult.iter()].every(r => r.roomId === other)).toBe(true);
  });

  it('ranks the leaderboard within each room', () => {
    g.limit(bo, 'BRKT', 'sell', 9_000n, 10n, other);
    g.limit(ada, 'BRKT', 'buy', 9_000n, 10n, other);
    g.limit(ada, 'BRKT', 'sell', 4_250n, 1n, other);
    g.limit(bo, 'BRKT', 'buy', 4_250n, 1n, other);
    expect(g.leaderboard(other).map(r => r.name)).toEqual(['Bo', 'Ada']);
    const main = g.leaderboard(g.main);
    expect(main.map(r => r.netWorth)).toEqual([main[0].netWorth, main[0].netWorth]); // still level
  });
});

describe('room views', () => {
  it('lists public rooms without codes and counts only players', () => {
    g.createRoom(ada, 'Hidden', false);
    const publicId = g.createRoom(ada, 'Listed', true);
    const lobby = mod.public_rooms(h.anonymousViewContext());
    expect(lobby.map(r => r.name).sort()).toEqual(['Listed', 'Main']);
    expect(lobby.find(r => r.id === publicId)!.players).toBe(1);
    expect(lobby.find(r => r.id === g.main)!.players).toBe(1);
    expect(Object.keys(lobby[0])).not.toContain('code');
  });

  it("shows invite codes only for rooms you're in", () => {
    const secret = g.createRoom(ada, 'Secret', false);
    const code = h.db.room.id.find(secret)!.code;
    const mine = mod.my_rooms(h.viewContext(ada));
    expect(mine.find(r => r.id === secret)).toMatchObject({ code, isOwner: true, isPublic: false });

    const bo = g.newPlayer('Bo');
    expect(mod.my_rooms(h.viewContext(bo)).map(r => r.name)).toEqual(['Main']);
  });

  it('returns a player\'s accounts, holdings and stops across all their rooms', () => {
    const other = g.createRoom(ada, 'Other', true);
    g.stop(ada, 'PXL', 'sell', 900n, 1n, other);
    const ctx = h.viewContext(ada);
    expect(mod.my_accounts(ctx).map(a => a.roomId).sort()).toEqual([g.main, other].sort());
    expect(new Set(mod.my_holdings(ctx).map(r => r.roomId))).toEqual(new Set([g.main, other]));
    expect(mod.my_stop_orders(ctx).map(s => s.roomId)).toEqual([other]);
  });
});
