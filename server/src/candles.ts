import type { Ctx } from './schema';
import { findInstrument } from './engine';

export const CANDLE_INTERVAL_MICROS = 60_000_000n; // one minute

export function intervalStartOf(micros: bigint): bigint {
  return micros - (micros % CANDLE_INTERVAL_MICROS);
}

function currentCandle(ctx: Ctx, roomId: bigint, symbol: string, intervalStart: bigint) {
  for (const c of ctx.db.candle.bySymbolStart.filter([roomId, symbol, intervalStart])) return c;
  return null;
}

/** Folds one trade into its symbol's last price and current candle. */
export function recordTrade(ctx: Ctx, roomId: bigint, symbol: string, price: bigint, qty: bigint): void {
  const inst = findInstrument(ctx, roomId, symbol);
  if (inst) ctx.db.instrument.id.update({ ...inst, lastPrice: price });

  const start = intervalStartOf(ctx.timestamp.microsSinceUnixEpoch);
  const c = currentCandle(ctx, roomId, symbol, start);
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
      roomId,
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

/** Opens a flat candle at the last price for every symbol in the room that has none this interval. */
export function rollCandles(ctx: Ctx, roomId: bigint): void {
  const start = intervalStartOf(ctx.timestamp.microsSinceUnixEpoch);
  for (const inst of ctx.db.instrument.roomId.filter(roomId)) {
    if (currentCandle(ctx, roomId, inst.symbol, start)) continue;
    const p = inst.lastPrice;
    ctx.db.candle.insert({
      id: 0n,
      roomId,
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
