import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import * as mod from '../src/index';
import spacetimedb from '../src/schema';
import { MARKET_MAKER } from '../src/bots';

const makeHarness = () => createModuleTestHarness(spacetimedb, mod, { rngSeed: 42 });
let h: ReturnType<typeof makeHarness>;

const internal = TestAuth.internal();
const schedArg = { arg: { scheduledId: 0n, scheduledAt: { tag: 'Interval' as const, value: null as any } } };
const tick = () => h.withReducerTx(internal, ctx => mod.run_bots(ctx, schedArg));
const news = () => h.withReducerTx(internal, ctx => mod.fire_news_event(ctx, schedArg));

function player(sub: string): TestAuth {
  return TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'https://test.local', sub, aud: ['order-book'] }),
    new ConnectionId(1n)
  );
}

const openBook = (symbol: string) =>
  [...h.db.orders.iter()].filter(o => o.symbol === symbol && o.status === 'open');

function totals() {
  let cash = 0n;
  for (const a of h.db.account.iter()) cash += a.cashAvailable + a.cashReserved;
  const qty: Record<string, bigint> = {};
  for (const r of h.db.holding.iter()) qty[r.symbol] = (qty[r.symbol] ?? 0n) + r.qtyAvailable + r.qtyReserved;
  return { cash, qty };
}

beforeEach(() => {
  h = makeHarness();
  h.clock.set(new Timestamp(1_000_000_000_000n));
  h.withReducerTx(internal, ctx => mod.init(ctx, {}));
});

describe('run_bots', () => {
  it('creates bot accounts flagged as bots', () => {
    const bots = [...h.db.account.iter()].filter(a => a.isBot);
    expect(bots.map(b => b.name).sort()).toEqual(['Liquidity Bot', 'Noise Bot']);
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
    const alice = player('alice');
    h.withReducerTx(alice, ctx => mod.register(ctx, { name: 'Alice' }));
    h.withReducerTx(alice, ctx => mod.place_market_order(ctx, { symbol: 'BRKT', side: 'buy', qty: 5n }));
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

    const inst = h.db.instrument.symbol.find(item.symbol)!;
    const fair = h.db.marketState.symbol.find(item.symbol)!.fairValue;
    expect(fair === inst.lastPrice).toBe(false);
    expect(fair > inst.lastPrice).toBe(item.impactBps > 0);
    expect(h.db.newsSchedule.count()).toBe(scheduledBefore + 1n);
  });

  it('bots walk the price toward fair value after news', () => {
    news();
    const [item] = [...h.db.news.iter()];
    const start = h.db.instrument.symbol.find(item.symbol)!.lastPrice;
    const fair = h.db.marketState.symbol.find(item.symbol)!.fairValue;
    for (let i = 0; i < 150; i++) tick();
    const end = h.db.instrument.symbol.find(item.symbol)!.lastPrice;
    const gapBefore = Number(fair - start);
    const gapAfter = Number(fair - end);
    expect(Math.abs(gapAfter)).toBeLessThan(Math.abs(gapBefore) / 2);
  });

  it('clients cannot trigger bots or news', () => {
    const alice = player('alice');
    expect(() => h.withReducerTx(alice, ctx => mod.run_bots(ctx, schedArg))).toThrow(/internal/);
    expect(() => h.withReducerTx(alice, ctx => mod.fire_news_event(ctx, schedArg))).toThrow(/internal/);
  });
});
