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
  roomId: bigint;
  identity: Identity;
  name: string;
  netWorth: bigint;
  startingNetWorth: bigint;
};

const key = (roomId: bigint, who: Identity | string) =>
  `${roomId}:${typeof who === 'string' ? who : who.toHexString()}`;

/**
 * Players ranked by net worth within each room, highest first: cash (available +
 * reserved) plus every share at its symbol's last trade price in that room. Bots and
 * the Exchange are excluded. Pass `roomId` for one room, or omit it for all rooms
 * (rows are then grouped by room, each group ranked).
 */
export function computeStandings(db: StandingsDb, roomId?: bigint): Standing[] {
  const inRoom = (r: bigint) => roomId === undefined || r === roomId;

  const lastPrice = new Map<string, bigint>();
  for (const inst of db.instrument.iter()) {
    if (inRoom(inst.roomId)) lastPrice.set(key(inst.roomId, inst.symbol), inst.lastPrice);
  }

  // One pass over holdings rather than a scan per player.
  const sharesValue = new Map<string, bigint>();
  for (const h of db.holding.iter()) {
    if (!inRoom(h.roomId)) continue;
    const k = key(h.roomId, h.owner);
    const value = (h.qtyAvailable + h.qtyReserved) * (lastPrice.get(key(h.roomId, h.symbol)) ?? 0n);
    sharesValue.set(k, (sharesValue.get(k) ?? 0n) + value);
  }

  return [...db.account.iter()]
    .filter(a => !a.isBot && inRoom(a.roomId))
    .map(a => ({
      roomId: a.roomId,
      identity: a.identity,
      name: a.name,
      netWorth: a.cashAvailable + a.cashReserved + (sharesValue.get(key(a.roomId, a.identity)) ?? 0n),
      startingNetWorth: a.startingNetWorth,
    }))
    .sort((a, b) =>
      a.roomId !== b.roomId
        ? a.roomId < b.roomId ? -1 : 1
        : a.netWorth > b.netWorth ? -1 : a.netWorth < b.netWorth ? 1 : 0
    );
}
