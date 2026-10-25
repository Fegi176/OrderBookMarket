import { describe, expect, it } from 'vitest';
import { feeOn, fmtCents, fmtPrice, fmtReturn, parseDollars, parseQty } from './format';

describe('parseDollars', () => {
  it('parses whole dollars and up to two decimals into cents', () => {
    expect(parseDollars('42')).toBe(4_200n);
    expect(parseDollars('42.5')).toBe(4_250n);
    expect(parseDollars('42.50')).toBe(4_250n);
    expect(parseDollars('0.07')).toBe(7n);
    expect(parseDollars('  9.60 ')).toBe(960n);
    expect(parseDollars('42.')).toBe(4_200n);
  });

  it('avoids float rounding: 0.29 is exactly 29 cents', () => {
    // parseFloat('0.29') * 100 === 28.999999999999996
    expect(parseDollars('0.29')).toBe(29n);
    expect(parseDollars('1.15')).toBe(115n);
  });

  it('rejects anything that is not a plain positive amount', () => {
    for (const bad of ['', 'abc', '-1', '1.234', '1,000', '$5', '1e3', '.5']) {
      expect(parseDollars(bad)).toBeNull();
    }
  });
});

describe('parseQty', () => {
  it('accepts whole numbers only', () => {
    expect(parseQty('10')).toBe(10n);
    expect(parseQty(' 3 ')).toBe(3n);
    expect(parseQty('1.5')).toBeNull();
    expect(parseQty('-2')).toBeNull();
    expect(parseQty('')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats cents as dollars without losing precision', () => {
    expect(fmtPrice(4_250n)).toBe('42.50');
    expect(fmtPrice(7n)).toBe('0.07');
    expect(fmtPrice(-150n)).toBe('-1.50');
    expect(fmtCents(10_000_000n)).toBe('$100,000.00');
  });

  it('formats returns with a sign and two decimals', () => {
    expect(fmtReturn(10_000n, 10_325n)).toBe('+3.25%');
    expect(fmtReturn(10_000n, 9_000n)).toBe('-10.00%');
    expect(fmtReturn(10_000n, 10_000n)).toBe('0.00%');
    expect(fmtReturn(0n, 5n)).toBe('—');
  });
});

describe('feeOn', () => {
  it('matches the server: 0.10%, rounded up to the cent', () => {
    expect(feeOn(0n)).toBe(0n);
    expect(feeOn(1n)).toBe(1n);
    expect(feeOn(10_000n)).toBe(10n);
    expect(feeOn(10_001n)).toBe(11n);
    expect(feeOn(21_355n)).toBe(22n);
  });
});
