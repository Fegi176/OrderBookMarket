import { useMemo } from 'react';
import type { Identity } from 'spacetimedb';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { fmtPrice } from '../format';
import { aggregateDepth, type Level } from '../lib/market';

/** Aggregated depth: open orders grouped by price, best prices nearest the spread. */
export default function OrderBook({ symbol, me }: { symbol: string; me: Identity }) {
  const [open, ready] = useTable(
    tables.orders.where(r => r.symbol.eq(symbol)).where(r => r.status.eq('open'))
  );

  const { bids, asks, spread } = useMemo(() => aggregateDepth(open, me), [open, me]);

  const maxCum = [...bids, ...asks].reduce((m, l) => (l.cumulative > m ? l.cumulative : m), 1n);
  const width = (l: Level) => `${Number((l.cumulative * 100n) / maxCum)}%`;

  const row = (l: Level, side: 'bid' | 'ask') => (
    <div key={`${side}-${l.price}`} className={`depth-row ${side}`}>
      <div className="depth-bar" style={{ width: width(l) }} />
      <span className="price">{fmtPrice(l.price)}</span>
      <span className="qty">{l.qty.toString()}</span>
      <span className="muted small">{l.mine ? '● you' : `${l.orders}`}</span>
    </div>
  );

  if (!ready) return <p className="muted small">Loading book…</p>;

  return (
    <div className="depth">
      <div className="depth-head muted small">
        <span>Price</span>
        <span>Shares</span>
        <span>Orders</span>
      </div>
      <div className="asks">
        {asks.length ? [...asks].reverse().map(l => row(l, 'ask')) : <p className="muted small">No sellers</p>}
      </div>
      <div className="spread muted small">
        {spread === null ? 'No spread yet' : `Spread ${fmtPrice(spread)}`}
      </div>
      <div className="bids">
        {bids.length ? bids.map(l => row(l, 'bid')) : <p className="muted small">No buyers</p>}
      </div>
    </div>
  );
}
