import { Timestamp } from 'spacetimedb';
import { ScheduleAt } from 'spacetimedb/server';
import type { Ctx } from './schema';
import { BOT_CASH, BOT_SHARES } from './bots';
import { rollCandles } from './candles';
import { EXCHANGE, STARTING_CASH, STARTING_SHARES, getOrCreateHolding } from './engine';
import { computeStandings } from './standings';

export const SEASON_LENGTH_MICROS = 7n * 24n * 60n * 60n * 1_000_000n; // one week

export function activeSeason(ctx: Ctx, roomId: bigint) {
  for (const s of ctx.db.season.roomId.filter(roomId)) if (s.status === 'active') return s;
  return null;
}

/** Opens season `number` in the room now and schedules its end. */
export function startSeason(ctx: Ctx, roomId: bigint, number: number): void {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const endsAt = now + SEASON_LENGTH_MICROS;
  ctx.db.season.insert({
    id: 0n,
    roomId,
    number,
    startsAt: ctx.timestamp,
    endsAt: new Timestamp(endsAt),
    status: 'active',
  });
  ctx.db.seasonSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(endsAt), roomId });
}

/** Deletes rows through their primary key; the source is copied first so deletes are safe. */
function clear<Row>(rows: Iterable<Row>, remove: (row: Row) => unknown): void {
  for (const row of [...rows]) remove(row);
}

/** Net worth of the standard starting stake at the room's listing prices. */
export function listingNetWorth(ctx: Ctx, roomId: bigint): bigint {
  let total = STARTING_CASH;
  for (const inst of ctx.db.instrument.roomId.filter(roomId)) total += STARTING_SHARES * inst.listingPrice;
  return total;
}

/**
 * Ends the room's active season and starts the next, all in one transaction:
 * 1. save the room's standings to season_result;
 * 2. delete the room's orders and stop orders;
 * 3. reset players to the starting stake, bots to theirs, and the Exchange to zero;
 * 4. put last prices and fair values back to listing prices;
 * 5. clear the room's trades, candles and news, then open fresh candles;
 * 6. open and schedule the room's next season.
 * Accounts (names and identities) carry over; only balances and positions reset.
 * Other rooms are untouched.
 */
export function endSeason(ctx: Ctx, roomId: bigint): void {
  const current = activeSeason(ctx, roomId);
  const number = current?.number ?? 0;

  // 1. Standings, before anything is reset.
  if (current) {
    computeStandings(ctx.db, roomId).forEach((s, i) => {
      ctx.db.seasonResult.insert({ id: 0n, seasonNumber: number, rank: i + 1, ...s });
    });
    ctx.db.season.id.update({ ...current, status: 'ended' });
  }

  // 2. The book. Reservations disappear with the balances reset below.
  clear(ctx.db.orders.roomId.filter(roomId), o => ctx.db.orders.id.delete(o.id));
  clear(ctx.db.stopOrder.roomId.filter(roomId), s => ctx.db.stopOrder.id.delete(s.id));

  // 4 (first, so step 3 can value the new stake). Prices back to listing.
  for (const inst of [...ctx.db.instrument.roomId.filter(roomId)]) {
    ctx.db.instrument.id.update({ ...inst, lastPrice: inst.listingPrice });
    let state = null;
    for (const s of ctx.db.marketState.bySymbol.filter([roomId, inst.symbol])) state = s;
    if (state) ctx.db.marketState.id.update({ ...state, fairValue: inst.listingPrice });
    else ctx.db.marketState.insert({ id: 0n, roomId, symbol: inst.symbol, fairValue: inst.listingPrice });
  }

  // 3. Balances and positions.
  const startingNetWorth = listingNetWorth(ctx, roomId);
  const instruments = [...ctx.db.instrument.roomId.filter(roomId)];
  for (const acc of [...ctx.db.account.roomId.filter(roomId)]) {
    const isExchange = acc.identity.isEqual(EXCHANGE);
    const cash = isExchange ? 0n : acc.isBot ? BOT_CASH : STARTING_CASH;
    const shares = isExchange ? 0n : acc.isBot ? BOT_SHARES : STARTING_SHARES;
    ctx.db.account.id.update({
      ...acc,
      cashAvailable: cash,
      cashReserved: 0n,
      startingNetWorth: acc.isBot ? 0n : startingNetWorth,
    });
    for (const inst of instruments) {
      const h = getOrCreateHolding(ctx, roomId, acc.identity, inst.symbol);
      ctx.db.holding.id.update({ ...h, qtyAvailable: shares, qtyReserved: 0n });
    }
  }

  // 5. History.
  clear(ctx.db.trade.roomId.filter(roomId), t => ctx.db.trade.id.delete(t.id));
  clear(ctx.db.candle.roomId.filter(roomId), c => ctx.db.candle.id.delete(c.id));
  clear(ctx.db.news.roomId.filter(roomId), n => ctx.db.news.id.delete(n.id));
  rollCandles(ctx, roomId);

  // 6. Next season.
  startSeason(ctx, roomId, number + 1);
}
