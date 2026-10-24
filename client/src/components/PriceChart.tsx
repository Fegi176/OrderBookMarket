import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { cmpBig, fmtPrice, fmtTime } from '../format';

const BARS = 60;
const W = 640;
const PRICE_H = 220;
const VOL_H = 48;
const GAP = 10;
const AXIS_W = 56;
const TOP = 8; // headroom so the top axis label isn't clipped

/** One-minute candlesticks with volume underneath, drawn straight from the candle table. */
export default function PriceChart({ symbol }: { symbol: string }) {
  const [rows, ready] = useTable(tables.candle.where(r => r.symbol.eq(symbol)));

  const bars = useMemo(
    () => [...rows].sort((a, b) => cmpBig(a.intervalStart, b.intervalStart)).slice(-BARS),
    [rows]
  );

  if (!bars.length) {
    return <p className="muted small">{ready ? 'No price history yet.' : 'Loading chart…'}</p>;
  }

  let lo = bars[0].low;
  let hi = bars[0].high;
  let maxVol = 1n;
  for (const b of bars) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
    if (b.volume > maxVol) maxVol = b.volume;
  }
  // Pad the range so flat markets still get some vertical room.
  const pad = (hi - lo) / 10n + 5n;
  lo = lo > pad ? lo - pad : 0n;
  hi += pad;

  const plotW = W - AXIS_W;
  const slot = plotW / BARS;
  const body = Math.max(2, slot * 0.6);
  const y = (p: bigint) => TOP + (PRICE_H - TOP) * (1 - Number(p - lo) / Number(hi - lo));
  const x = (i: number) => (BARS - bars.length + i) * slot + slot / 2;
  const volY = PRICE_H + GAP + VOL_H;

  const ticks = [0, 1, 2, 3, 4].map(i => lo + ((hi - lo) * BigInt(i)) / 4n);
  const last = bars[bars.length - 1];

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${PRICE_H + GAP + VOL_H + 18}`}
      role="img"
      aria-label={`${symbol} one-minute price chart, last ${fmtPrice(last.close)}`}
    >
      {ticks.map(p => (
        <g key={p.toString()}>
          <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} className="grid" />
          <text x={plotW + 6} y={y(p) + 4} className="axis">
            {fmtPrice(p)}
          </text>
        </g>
      ))}

      {bars.map((b, i) => {
        const up = b.close >= b.open;
        const top = y(up ? b.close : b.open);
        const bottom = y(up ? b.open : b.close);
        const vh = (Number(b.volume) / Number(maxVol)) * VOL_H;
        return (
          <g key={b.id.toString()} className={up ? 'candle up' : 'candle down'}>
            <title>
              {`${fmtTime(b.intervalStart)}  O ${fmtPrice(b.open)}  H ${fmtPrice(b.high)}  L ${fmtPrice(b.low)}  C ${fmtPrice(b.close)}  Vol ${b.volume}`}
            </title>
            <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} className="wick" />
            <rect x={x(i) - body / 2} y={top} width={body} height={Math.max(1, bottom - top)} className="body" />
            {b.volume > 0n && (
              <rect x={x(i) - body / 2} y={volY - vh} width={body} height={vh} className="vol" />
            )}
          </g>
        );
      })}

      <line x1={0} x2={plotW} y1={y(last.close)} y2={y(last.close)} className="last-line" />
      <text x={0} y={PRICE_H + GAP + VOL_H + 14} className="axis">
        {fmtTime(bars[0].intervalStart)}
      </text>
      <text x={plotW} y={PRICE_H + GAP + VOL_H + 14} className="axis" textAnchor="end">
        {fmtTime(last.intervalStart)}
      </text>
    </svg>
  );
}
