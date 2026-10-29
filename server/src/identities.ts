import { Identity } from 'spacetimedb';

// Fixed identities owned by the module, present in every room. Real client identities
// are hashes, so these can't collide with a player.
export const EXCHANGE = new Identity(0xb07_0000_0000_0000n);
export const MARKET_MAKER = new Identity(0xb07_0000_0000_0001n);
export const NOISE_TRADER = new Identity(0xb07_0000_0000_0002n);

const MODULE_OWNED = [EXCHANGE, MARKET_MAKER, NOISE_TRADER].map(i => i.toHexString());

export function isModuleOwned(who: Identity): boolean {
  return MODULE_OWNED.includes(who.toHexString());
}
