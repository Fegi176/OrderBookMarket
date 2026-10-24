import { Timestamp } from 'spacetimedb';
import { ScheduleAt } from 'spacetimedb/server';
import type { Ctx } from './schema';
import { BOT_CASH, BOT_SHARES } from './bots';
import { rollCandles } from './candles';
import { EXCHANGE, STARTING_CASH, STARTING_SHARES, getOrCreateHolding } from './engine';
import { computeStandings } from './standings';

export const SEASON_LENGTH_MICROS = 7n * 24n * 60n * 60n * 1_000_000n; // one week

export function activeSeason(ctx: Ctx) {
  for (const s of ctx.db.season.iter()) if (s.status === 'active') return s;
  return null;
}

/** Opens season `number` now and schedules its end. */
export function startSeason(ctx: Ctx, number: number): void {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const endsAt = now + SEASON_LENGTH_MICROS;
  ctx.db.season.insert({
    number,
    startsAt: ctx.timestamp,
    endsAt: new Timestamp(endsAt),
    status: 'active',
  });
  ctx.db.seasonSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(endsAt) });
}

/** Deletes every row of a table through its primary key. */
function clear<Row>(rows: Iterable<Row>, remove: (row: Row) => unknown): void {
  for (const row of [...rows]) remove(row);
}

/** Net worth of the standard starting stake at listing prices. */
function listingNetWorth(ctx: Ctx): bigint {
  let total = STARTING_CASH;
  for (const inst of ctx.db.instrument.iter()) total += STARTING_SHARES * inst.listingPrice;
  return total;
}

/**
 * Ends the active season and starts the next, all in one transaction:
 * 1. save standings to season_result;
 * 2. delete every order and stop order;
 * 3. reset players to the starting stake, bots to theirs, and the Exchange to zero;
 * 4. put last prices and fair values back to listing prices;
 * 5. clear trades, candles and news, then open fresh candles;
 * 6. open and schedule the next season.
 * Accounts (names and identities) carry over; only balances and positions reset.
 */
export function endSeason(ctx: Ctx): void {
  const current = activeSeason(ctx);
  const number = current?.number ?? 0;

  // 1. Standings, before anything is reset.
  if (current) {
    computeStandings(ctx.db).forEach((s, i) => {
      ctx.db.seasonResult.insert({ id: 0n, seasonNumber: number, rank: i + 1, ...s });
    });
    ctx.db.season.number.update({ ...current, status: 'ended' });
  }

  // 2. The book. Reservations disappear with the balances reset below.
  clear(ctx.db.orders.iter(), o => ctx.db.orders.id.delete(o.id));
  clear(ctx.db.stopOrder.iter(), s => ctx.db.stopOrder.id.delete(s.id));

  // 4 (first, so step 3 can value the new stake). Prices back to listing.
  for (const inst of [...ctx.db.instrument.iter()]) {
    ctx.db.instrument.symbol.update({ ...inst, lastPrice: inst.listingPrice });
    const state = ctx.db.marketState.symbol.find(inst.symbol);
    if (state) ctx.db.marketState.symbol.update({ ...state, fairValue: inst.listingPrice });
    else ctx.db.marketState.insert({ symbol: inst.symbol, fairValue: inst.listingPrice });
  }

  // 3. Balances and positions.
  const startingNetWorth = listingNetWorth(ctx);
  const instruments = [...ctx.db.instrument.iter()];
  for (const acc of [...ctx.db.account.iter()]) {
    const isExchange = acc.identity.isEqual(EXCHANGE);
    const cash = isExchange ? 0n : acc.isBot ? BOT_CASH : STARTING_CASH;
    const shares = isExchange ? 0n : acc.isBot ? BOT_SHARES : STARTING_SHARES;
    ctx.db.account.identity.update({
      ...acc,
      cashAvailable: cash,
      cashReserved: 0n,
      startingNetWorth: acc.isBot ? 0n : startingNetWorth,
    });
    for (const inst of instruments) {
      const h = getOrCreateHolding(ctx, acc.identity, inst.symbol);
      ctx.db.holding.id.update({ ...h, qtyAvailable: shares, qtyReserved: 0n });
    }
  }

  // 5. History.
  clear(ctx.db.trade.iter(), t => ctx.db.trade.id.delete(t.id));
  clear(ctx.db.candle.iter(), c => ctx.db.candle.id.delete(c.id));
  clear(ctx.db.news.iter(), n => ctx.db.news.id.delete(n.id));
  rollCandles(ctx);

  // 6. Next season.
  startSeason(ctx, number + 1);
}
