import type { Identity } from 'spacetimedb';
import type { Ctx } from './schema';
import { isModuleOwned } from './identities';

// Without pruning, bot activity adds roughly 0.7 trades and 0.7 order rows a second
// per room, about 400k of each per week-long season, and clients download a symbol's
// whole trade and candle history when they subscribe. Only bot-only history is pruned:
// any order or trade involving a player is kept until the season resets.

/** Bot-vs-bot trades are kept this long, enough for the trade feed and a busy chart hour. */
export const BOT_TRADE_RETENTION_MICROS = 60n * 60n * 1_000_000n; // 1 hour
/** The chart shows 60 one-minute bars; keep a margin beyond that. */
export const CANDLE_RETENTION_MICROS = 3n * 60n * 60n * 1_000_000n; // 3 hours

/** Deletes a bot's filled and cancelled order rows in every room. Open quotes stay. */
export function pruneBotOrders(ctx: Ctx, bot: Identity): void {
  for (const o of [...ctx.db.orders.byOwner.filter(bot)]) {
    if (o.status !== 'open') ctx.db.orders.id.delete(o.id);
  }
}

/** Deletes bot-vs-bot trades and candles older than their retention windows, in every room. */
export function pruneHistory(ctx: Ctx): void {
  const now = ctx.timestamp.microsSinceUnixEpoch;

  const tradeCutoff = now - BOT_TRADE_RETENTION_MICROS;
  for (const t of [...ctx.db.trade.iter()]) {
    if (
      t.timestamp.microsSinceUnixEpoch < tradeCutoff &&
      isModuleOwned(t.buyer) &&
      isModuleOwned(t.seller)
    ) {
      ctx.db.trade.id.delete(t.id);
    }
  }

  const candleCutoff = now - CANDLE_RETENTION_MICROS;
  for (const c of [...ctx.db.candle.iter()]) {
    if (c.intervalStart < candleCutoff) ctx.db.candle.id.delete(c.id);
  }
}
