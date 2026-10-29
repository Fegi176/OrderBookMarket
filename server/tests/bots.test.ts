import { beforeEach, describe, expect, it } from 'vitest';
import { createGame, mod, type Game, type Harness } from './helpers';
import { MARKET_MAKER } from '../src/bots';

let g: Game;
let h: Harness;

const tick = () => g.tick();
const news = () => g.news();
const player = (sub: string) => g.player(sub);
const totals = () => g.totals();
const openBook = (symbol: string) =>
  [...h.db.orders.iter()].filter(o => o.symbol === symbol && o.status === 'open');
const botsArg = { arg: { scheduledId: 0n, scheduledAt: { tag: 'Interval' as const, value: null as any } } };

beforeEach(() => {
  g = createGame({ rngSeed: 42, t0: 1_000_000_000_000n });
  h = g.h;
});

describe('run_bots', () => {
  it('creates bot accounts flagged as bots', () => {
    const bots = [...h.db.account.iter()].filter(a => a.isBot);
    // The fee-collecting Exchange account is module-owned too.
    expect(bots.map(b => b.name).sort()).toEqual(['Exchange', 'Liquidity Bot', 'Noise Bot']);
  });

  it('keeps a two-sided book around the last price for every symbol', () => {
    tick();
    for (const inst of h.db.instrument.iter()) {
      const book = openBook(inst.symbol).filter(o => o.owner.isEqual(MARKET_MAKER));
      const bids = book.filter(o => o.side === 'buy');
      const asks = book.filter(o => o.side === 'sell');
      expect(bids).toHaveLength(3);
      expect(asks).toHaveLength(3);
      const bestBid = bids.reduce((m, o) => (o.price > m ? o.price : m), 0n);
      const bestAsk = asks.reduce((m, o) => (o.price < m ? o.price : m), asks[0].price);
      expect(bestBid).toBeLessThan(bestAsk);
      for (const o of book) expect(o.price % inst.tickSize).toBe(0n);
      // Within 2% of the listing price.
      expect(Number(bestBid)).toBeGreaterThan(Number(inst.lastPrice) * 0.98);
      expect(Number(bestAsk)).toBeLessThan(Number(inst.lastPrice) * 1.02);
    }
  });

  it('does not pile up order rows over many ticks', () => {
    for (let i = 0; i < 200; i++) tick();
    // Replaced quotes are deleted; only fills leave rows behind.
    const openRows = [...h.db.orders.iter()].filter(o => o.status === 'open').length;
    expect(openRows).toBe(6 * 6);
    const cancelledBotRows = [...h.db.orders.iter()].filter(
      o => o.status === 'cancelled' && o.owner.isEqual(MARKET_MAKER)
    );
    expect(cancelledBotRows).toHaveLength(0);
  });

  it('gives players liquidity to trade against', () => {
    tick();
    const alice = g.newPlayer('Alice');
    g.market(alice, 'BRKT', 'buy', 5n);
    expect([...h.db.trade.iter()].some(t => t.seller.isEqual(MARKET_MAKER))).toBe(true);
  });

  it('conserves cash and shares while no bot needs a top-up', () => {
    const before = totals();
    for (let i = 0; i < 100; i++) tick();
    expect(h.db.trade.count()).toBeGreaterThan(0n);
    expect(totals()).toEqual(before);
  });
});

describe('fire_news_event', () => {
  it('publishes a headline, moves fair value, and schedules the next event', () => {
    const scheduledBefore = h.db.newsSchedule.count();
    news();
    const [item] = [...h.db.news.iter()];
    expect(item.headline.length).toBeGreaterThan(0);
    expect(Math.abs(item.impactBps)).toBeGreaterThanOrEqual(150);
    expect(Math.abs(item.impactBps)).toBeLessThanOrEqual(1200);

    const inst = g.inst(item.symbol)!;
    const fair = g.fair(item.symbol);
    expect(fair === inst.lastPrice).toBe(false);
    expect(fair > inst.lastPrice).toBe(item.impactBps > 0);
    expect(h.db.newsSchedule.count()).toBe(scheduledBefore + 1n);
  });

  it('bots walk the price toward fair value after news', () => {
    news();
    const [item] = [...h.db.news.iter()];
    const start = g.inst(item.symbol)!.lastPrice;
    const fair = g.fair(item.symbol);
    for (let i = 0; i < 150; i++) tick();
    const end = g.inst(item.symbol)!.lastPrice;
    const gapBefore = Number(fair - start);
    const gapAfter = Number(fair - end);
    expect(Math.abs(gapAfter)).toBeLessThan(Math.abs(gapBefore) / 2);
  });

  it('clients cannot trigger bots or news', () => {
    const alice = player('alice');
    const newsArg = { arg: { ...botsArg.arg, roomId: g.main } };
    expect(() => h.withReducerTx(alice, ctx => mod.run_bots(ctx, botsArg))).toThrow(/internal/);
    expect(() => h.withReducerTx(alice, ctx => mod.fire_news_event(ctx, newsArg))).toThrow(/internal/);
  });
});
