import { beforeEach, describe, expect, it } from 'vitest';
import type { Identity } from 'spacetimedb';
import { createGame, type Game, type Harness, type TestAuth } from './helpers';
import { MARKET_MAKER, NOISE_TRADER } from '../src/bots';
import { BOT_TRADE_RETENTION_MICROS, CANDLE_RETENTION_MICROS } from '../src/prune';

const T0 = 1_800_000_000_000_000n;
const MINUTE = 60_000_000n;

let g: Game;
let h: Harness;
const tick = () => g.tick();
const roll = () => g.roll();
const at = (micros: bigint) => g.at(micros);
const isBot = (id: Identity) => id.isEqual(MARKET_MAKER) || id.isEqual(NOISE_TRADER);

let alice: TestAuth;
let A: Identity;

beforeEach(() => {
  g = createGame({ rngSeed: 3, t0: T0 });
  h = g.h;
  alice = g.newPlayer('Alice');
  A = g.id(alice);
});

describe('pruning', () => {
  it('keeps only open bot orders after each tick', () => {
    for (let i = 0; i < 50; i++) tick();
    const botRows = [...h.db.orders.iter()].filter(o => isBot(o.owner));
    expect(botRows.length).toBeGreaterThan(0);
    expect(botRows.every(o => o.status === 'open')).toBe(true);
    expect(h.db.trade.count()).toBeGreaterThan(0n); // the bots did trade
  });

  it("never touches a player's orders", () => {
    tick();
    g.market(alice, 'BRKT', 'buy', 3n);
    g.limit(alice, 'GRVY', 'buy', 100n, 1n);
    for (let i = 0; i < 20; i++) tick();
    const mine = [...h.db.orders.iter()].filter(o => o.owner.isEqual(A));
    expect(mine.map(o => o.status).sort()).toEqual(['filled', 'open']);
  });

  it('drops bot-only trades past retention but keeps every trade with a player', () => {
    tick();
    g.market(alice, 'BRKT', 'buy', 3n);
    for (let i = 0; i < 30; i++) tick();
    const playerTrades = () => [...h.db.trade.iter()].filter(t => t.buyer.isEqual(A) || t.seller.isEqual(A));
    const botTrades = () => [...h.db.trade.iter()].filter(t => isBot(t.buyer) && isBot(t.seller));
    expect(playerTrades().length).toBeGreaterThan(0);
    expect(botTrades().length).toBeGreaterThan(0);

    // Within retention nothing goes.
    at(T0 + BOT_TRADE_RETENTION_MICROS - MINUTE);
    roll();
    expect(botTrades().length).toBeGreaterThan(0);

    // Past it, bot-only trades go and the player's stay.
    const before = playerTrades().length;
    at(T0 + BOT_TRADE_RETENTION_MICROS + MINUTE);
    roll();
    expect(botTrades()).toHaveLength(0);
    expect(playerTrades()).toHaveLength(before);
  });

  it('keeps the last few hours of candles', () => {
    for (let m = 0n; m <= 5n * 60n; m += 1n) {
      at(T0 + m * MINUTE);
      roll();
    }
    const now = T0 + 5n * 60n * MINUTE;
    const oldest = [...h.db.candle.iter()].reduce(
      (min, c) => (c.intervalStart < min ? c.intervalStart : min),
      now
    );
    expect(oldest).toBeGreaterThanOrEqual(now - CANDLE_RETENTION_MICROS - MINUTE);
    // 3 hours of one-minute bars per symbol, give or take the boundary bar.
    const perSymbol = Number(h.db.candle.count() / h.db.instrument.count());
    expect(perSymbol).toBeGreaterThanOrEqual(180);
    expect(perSymbol).toBeLessThanOrEqual(182);
  });
});
