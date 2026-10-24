import type { Ctx } from './schema';

export const CANDLE_INTERVAL_MICROS = 60_000_000n; // one minute

export function intervalStartOf(micros: bigint): bigint {
  return micros - (micros % CANDLE_INTERVAL_MICROS);
}

function currentCandle(ctx: Ctx, symbol: string, intervalStart: bigint) {
  for (const c of ctx.db.candle.bySymbolStart.filter([symbol, intervalStart])) return c;
  return null;
}

/** Folds one trade into its symbol's last price and current candle. */
export function recordTrade(ctx: Ctx, symbol: string, price: bigint, qty: bigint): void {
  const inst = ctx.db.instrument.symbol.find(symbol);
  if (inst) ctx.db.instrument.symbol.update({ ...inst, lastPrice: price });

  const start = intervalStartOf(ctx.timestamp.microsSinceUnixEpoch);
  const c = currentCandle(ctx, symbol, start);
  if (c) {
    ctx.db.candle.id.update({
      ...c,
      high: price > c.high ? price : c.high,
      low: price < c.low ? price : c.low,
      close: price,
      volume: c.volume + qty,
    });
  } else {
    ctx.db.candle.insert({
      id: 0n,
      symbol,
      intervalStart: start,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: qty,
    });
  }
}

/** Opens a flat candle at the last price for every symbol that has none this interval. */
export function rollCandles(ctx: Ctx): void {
  const start = intervalStartOf(ctx.timestamp.microsSinceUnixEpoch);
  for (const inst of ctx.db.instrument.iter()) {
    if (currentCandle(ctx, inst.symbol, start)) continue;
    const p = inst.lastPrice;
    ctx.db.candle.insert({
      id: 0n,
      symbol: inst.symbol,
      intervalStart: start,
      open: p,
      high: p,
      low: p,
      close: p,
      volume: 0n,
    });
  }
}
