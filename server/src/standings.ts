import type { Identity } from 'spacetimedb';
import type { account, holding, instrument } from './schema';

type AccountRow = typeof account.rowType.type;
type HoldingRow = typeof holding.rowType.type;
type InstrumentRow = typeof instrument.rowType.type;

/** The tables standings read. Both a reducer's and a view's `ctx.db` satisfy this. */
type StandingsDb = {
  account: { iter(): Iterable<AccountRow> };
  holding: { iter(): Iterable<HoldingRow> };
  instrument: { iter(): Iterable<InstrumentRow> };
};

export type Standing = {
  identity: Identity;
  name: string;
  netWorth: bigint;
  startingNetWorth: bigint;
};

/**
 * Players ranked by net worth, highest first: cash (available + reserved) plus every
 * share at its symbol's last trade price. Bots and the Exchange are excluded.
 */
export function computeStandings(db: StandingsDb): Standing[] {
  const lastPrice = new Map<string, bigint>();
  for (const inst of db.instrument.iter()) lastPrice.set(inst.symbol, inst.lastPrice);

  // One pass over holdings, keyed by identity hex, rather than a scan per player.
  const sharesValue = new Map<string, bigint>();
  for (const h of db.holding.iter()) {
    const key = h.owner.toHexString();
    const value = (h.qtyAvailable + h.qtyReserved) * (lastPrice.get(h.symbol) ?? 0n);
    sharesValue.set(key, (sharesValue.get(key) ?? 0n) + value);
  }

  return [...db.account.iter()]
    .filter(a => !a.isBot)
    .map(a => ({
      identity: a.identity,
      name: a.name,
      netWorth: a.cashAvailable + a.cashReserved + (sharesValue.get(a.identity.toHexString()) ?? 0n),
      startingNetWorth: a.startingNetWorth,
    }))
    .sort((a, b) => (a.netWorth > b.netWorth ? -1 : a.netWorth < b.netWorth ? 1 : 0));
}
