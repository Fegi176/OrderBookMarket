import type { Identity } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import type { Ctx } from './schema';
import { ensureBots } from './bots';
import { rollCandles } from './candles';
import { STARTING_CASH, STARTING_SHARES, ensureExchange, findAccount, getOrCreateHolding } from './engine';
import { scheduleNextNews } from './news';
import { startSeason } from './seasons';

// Listing prices in cents: every room, and every season in it, starts trading from these.
export const INSTRUMENTS = [
  { symbol: 'BRKT', name: 'Bracket Robotics', tickSize: 1n, listingPrice: 4_250n },
  { symbol: 'CLDN', name: 'Cloudnine Airlines', tickSize: 1n, listingPrice: 1_875n },
  { symbol: 'GRVY', name: 'Gravy Foods', tickSize: 1n, listingPrice: 3_310n },
  { symbol: 'MOON', name: 'Moonshot Mining', tickSize: 5n, listingPrice: 12_000n },
  { symbol: 'PXL', name: 'Pixel Pictures', tickSize: 1n, listingPrice: 960n },
  { symbol: 'QNTM', name: 'Quantum Quilts', tickSize: 5n, listingPrice: 7_550n },
];

export const MAIN_ROOM_NAME = 'Main';
/** Each room runs its own bots and news, so creating them is capped per player. */
export const MAX_ROOMS_PER_PLAYER = 3;
const CODE_LENGTH = 6;
// No 0/O, 1/I/L: codes get read aloud and typed from screenshots.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function validName(raw: string, max: number, what: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > max) throw new SenderError(`${what} must be 1-${max} characters`);
  return name;
}

function generateCode(ctx: Ctx): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[ctx.random.integerInRange(0, CODE_ALPHABET.length - 1)];
    }
    if (!ctx.db.room.code.find(code)) return code;
  }
}

/**
 * Creates a room with its own market: the six companies at listing prices, hidden
 * fair values, bot and Exchange accounts, season 1, a news schedule and opening
 * candles. Returns the new room's id.
 */
export function createRoom(ctx: Ctx, name: string, isPublic: boolean, createdBy: Identity): bigint {
  const roomName = validName(name, 32, 'Room name');
  const room = ctx.db.room.insert({
    id: 0n,
    name: roomName,
    code: generateCode(ctx),
    isPublic,
    createdBy,
    createdAt: ctx.timestamp,
  });

  for (const inst of INSTRUMENTS) {
    ctx.db.instrument.insert({ id: 0n, roomId: room.id, ...inst, lastPrice: inst.listingPrice });
    ctx.db.marketState.insert({ id: 0n, roomId: room.id, symbol: inst.symbol, fairValue: inst.listingPrice });
  }
  ensureExchange(ctx, room.id);
  ensureBots(ctx, room.id);
  startSeason(ctx, room.id, 1);
  scheduleNextNews(ctx, room.id);
  rollCandles(ctx, room.id);
  return room.id;
}

/** Creates a room for a player, enforcing the per-player cap. */
export function createPlayerRoom(ctx: Ctx, name: string, isPublic: boolean, who: Identity): bigint {
  const owned = [...ctx.db.room.iter()].filter(r => r.createdBy.isEqual(who)).length;
  if (owned >= MAX_ROOMS_PER_PLAYER) {
    throw new SenderError(`You can create at most ${MAX_ROOMS_PER_PLAYER} rooms`);
  }
  return createRoom(ctx, name, isPublic, who);
}

/**
 * Joins a room as a player with the starting stake. A public room can be joined by
 * id; a private one only with its invite code (which also identifies the room).
 * Returns the joined room's id.
 */
export function joinRoom(ctx: Ctx, roomId: bigint, code: string, who: Identity, playerName: string): bigint {
  const name = validName(playerName, 24, 'Name');
  const normalized = code.trim().toUpperCase();
  const room = normalized ? ctx.db.room.code.find(normalized) : ctx.db.room.id.find(roomId);
  if (!room) throw new SenderError(normalized ? 'No room with that code' : 'No such room');
  if (!room.isPublic && !normalized) throw new SenderError('This room needs an invite code');
  if (findAccount(ctx, room.id, who)) throw new SenderError('Already in this room');

  let startingNetWorth = STARTING_CASH;
  for (const inst of ctx.db.instrument.roomId.filter(room.id)) startingNetWorth += STARTING_SHARES * inst.lastPrice;

  ctx.db.account.insert({
    id: 0n,
    roomId: room.id,
    identity: who,
    name,
    cashAvailable: STARTING_CASH,
    cashReserved: 0n,
    createdAt: ctx.timestamp,
    isBot: false,
    startingNetWorth,
  });
  for (const inst of [...ctx.db.instrument.roomId.filter(room.id)]) {
    const h = getOrCreateHolding(ctx, room.id, who, inst.symbol);
    ctx.db.holding.id.update({ ...h, qtyAvailable: STARTING_SHARES });
  }
  return room.id;
}
