import { describe, expect, it } from 'vitest';
import { Identity } from 'spacetimedb';
import { aggregateDepth, mergeFills, percentOf, recentTicks, summarizePortfolio } from './market';

const ME = new Identity(1n);
const OTHER = new Identity(2n);

const order = (side: string, price: bigint, remaining: bigint, owner = OTHER) => ({ side, price, remaining, owner });

describe('aggregateDepth', () => {
  it('groups by price with the best price first on each side', () => {
    const { bids, asks, spread } = aggregateDepth(
      [
        order('buy', 4_200n, 5n),
        order('buy', 4_250n, 3n),
        order('buy', 4_200n, 7n),
        order('sell', 4_300n, 4n),
        order('sell', 4_275n, 2n),
      ],
      ME
    );
    expect(bids.map(l => [l.price, l.qty, l.orders])).toEqual([
      [4_250n, 3n, 1],
      [4_200n, 12n, 2],
    ]);
    expect(asks.map(l => [l.price, l.qty])).toEqual([
      [4_275n, 2n],
      [4_300n, 4n],
    ]);
    expect(spread).toBe(25n);
  });

  it('keeps a running total for the depth bars', () => {
    const { bids } = aggregateDepth([order('buy', 3n, 1n), order('buy', 2n, 2n), order('buy', 1n, 3n)], ME);
    expect(bids.map(l => l.cumulative)).toEqual([1n, 3n, 6n]);
  });

  it("marks levels that hold one of the viewer's orders", () => {
    const { asks } = aggregateDepth([order('sell', 100n, 1n), order('sell', 101n, 1n, ME)], ME);
    expect(asks.map(l => l.mine)).toEqual([false, true]);
  });

  it('caps the number of levels and has no spread when a side is empty', () => {
    const many = Array.from({ length: 15 }, (_, i) => order('buy', BigInt(100 + i), 1n));
    const { bids, asks, spread } = aggregateDepth(many, ME, 10);
    expect(bids).toHaveLength(10);
    expect(bids[0].price).toBe(114n);
    expect(asks).toHaveLength(0);
    expect(spread).toBeNull();
  });
});

describe('recentTicks', () => {
  const trade = (id: bigint, price: bigint) => ({ id, price });

  it('returns newest first, tagged against the previous trade', () => {
    const ticks = recentTicks([trade(1n, 100n), trade(2n, 105n), trade(3n, 105n), trade(4n, 99n)], 10);
    expect(ticks.map(x => [x.t.id, x.tick])).toEqual([
      [4n, 'down'],
      [3n, 'flat'],
      [2n, 'up'],
      [1n, 'flat'],
    ]);
  });

  it("colours the oldest shown trade against the one just outside the window", () => {
    const ticks = recentTicks([trade(1n, 100n), trade(2n, 110n), trade(3n, 120n)], 2);
    expect(ticks.map(x => [x.t.id, x.tick])).toEqual([
      [3n, 'up'],
      [2n, 'up'],
    ]);
  });
});

describe('summarizePortfolio', () => {
  const account = { cashAvailable: 50_000n, cashReserved: 10_000n, startingNetWorth: 100_000n };

  it('values holdings at last price, largest first, and counts reserved cash and shares', () => {
    const s = summarizePortfolio(
      account,
      [
        { symbol: 'AAA', qtyAvailable: 10n, qtyReserved: 0n },
        { symbol: 'BBB', qtyAvailable: 1n, qtyReserved: 1n },
        { symbol: 'CCC', qtyAvailable: 0n, qtyReserved: 0n },
      ],
      new Map([
        ['AAA', 1_000n],
        ['BBB', 20_000n],
        ['CCC', 5n],
      ])
    );
    expect(s.positions.map(p => [p.symbol, p.qty, p.value])).toEqual([
      ['BBB', 2n, 40_000n],
      ['AAA', 10n, 10_000n],
    ]);
    expect(s.cash).toBe(60_000n);
    expect(s.sharesValue).toBe(50_000n);
    expect(s.netWorth).toBe(110_000n);
    expect(s.pnl).toBe(10_000n);
  });

  it('values a symbol with no known price at zero', () => {
    const s = summarizePortfolio(account, [{ symbol: 'ZZZ', qtyAvailable: 5n, qtyReserved: 0n }], new Map());
    expect(s.positions[0].value).toBe(0n);
  });
});

describe('percentOf and mergeFills', () => {
  it('formats a share of a total to one decimal', () => {
    expect(percentOf(1n, 8n)).toBe('12.5%');
    expect(percentOf(1n, 0n)).toBe('—');
  });

  it('merges buys and sells newest first and keeps the side', () => {
    const fills = mergeFills([{ id: 1n }, { id: 4n }], [{ id: 3n }], 2);
    expect(fills.map(f => [f.t.id, f.side])).toEqual([
      [4n, 'buy'],
      [3n, 'sell'],
    ]);
  });
});
