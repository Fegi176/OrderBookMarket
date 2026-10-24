import { ScheduleAt } from 'spacetimedb/server';
import type { Ctx } from './schema';

const MIN_GAP_SECS = 45;
const MAX_GAP_SECS = 120;
const MIN_IMPACT_BPS = 150; // 1.5%
const MAX_IMPACT_BPS = 1_200; // 12%

const GOOD = [
  '{name} beats earnings expectations',
  '{name} lands a major new contract',
  'Analysts upgrade {name} to "buy"',
  '{name} unveils a surprise breakthrough product',
  'Rumours of a takeover bid for {name}',
];

const BAD = [
  '{name} misses earnings estimates',
  '{name} announces a product recall',
  'Regulators open an investigation into {name}',
  '{name} CEO resigns unexpectedly',
  'Analysts downgrade {name} to "sell"',
];

/** Schedules the next news event a random 45-120 seconds from now. */
export function scheduleNextNews(ctx: Ctx): void {
  const gapMicros = BigInt(ctx.random.integerInRange(MIN_GAP_SECS, MAX_GAP_SECS)) * 1_000_000n;
  ctx.db.newsSchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + gapMicros),
  });
}

/** Picks a company, moves its fair value up or down, and publishes a headline. */
export function fireNews(ctx: Ctx): void {
  const instruments = [...ctx.db.instrument.iter()];
  if (!instruments.length) return;
  const inst = instruments[ctx.random.integerInRange(0, instruments.length - 1)];

  const good = ctx.random() < 0.5;
  const magnitude = ctx.random.integerInRange(MIN_IMPACT_BPS, MAX_IMPACT_BPS);
  const impactBps = good ? magnitude : -magnitude;
  const templates = good ? GOOD : BAD;
  const headline = templates[ctx.random.integerInRange(0, templates.length - 1)].replace(
    '{name}',
    inst.name
  );

  const state = ctx.db.marketState.symbol.find(inst.symbol);
  const fair = state?.fairValue ?? inst.lastPrice;
  let next = (fair * BigInt(10_000 + impactBps)) / 10_000n;
  next -= next % inst.tickSize;
  const floor = inst.tickSize * 10n;
  if (next < floor) next = floor;

  if (state) ctx.db.marketState.symbol.update({ ...state, fairValue: next });
  else ctx.db.marketState.insert({ symbol: inst.symbol, fairValue: next });

  ctx.db.news.insert({
    id: 0n,
    symbol: inst.symbol,
    headline,
    impactBps,
    timestamp: ctx.timestamp,
  });
}
