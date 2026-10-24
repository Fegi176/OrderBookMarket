// Prices are integer cents on the wire. Keep them as bigint and only format for display.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function fmtCents(cents: bigint): string {
  return usd.format(Number(cents) / 100);
}

/** Plain "42.50" style, no currency sign, for dense tables. */
export function fmtPrice(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const s = `${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** Parses "42", "42.5" or "42.50" into cents without going through floats. */
export function parseDollars(input: string): bigint | null {
  const m = input.trim().match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!m) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

export function parseQty(input: string): bigint | null {
  const m = input.trim().match(/^\d+$/);
  return m ? BigInt(m[0]) : null;
}

export function fmtTime(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Signed percentage change from `from` to `to`, e.g. "+3.25%". */
export function fmtReturn(from: bigint, to: bigint): string {
  if (from === 0n) return '—';
  const bps = ((to - from) * 10_000n) / from;
  const sign = bps > 0n ? '+' : bps < 0n ? '-' : '';
  const abs = bps < 0n ? -bps : bps;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}%`;
}

export const cmpBig =(a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
