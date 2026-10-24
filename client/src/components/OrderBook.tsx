import { useMemo } from 'react';
import type { Identity } from 'spacetimedb';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { cmpBig, fmtPrice } from '../format';

const LEVELS = 10;

type Level = { price: bigint; qty: bigint; orders: number; mine: boolean; cumulative: bigint };

/** Aggregated depth: open orders grouped by price, best prices nearest the spread. */
export default function OrderBook({ symbol, me }: { symbol: string; me: Identity }) {
  const [open, ready] = useTable(
    tables.orders.where(r => r.symbol.eq(symbol)).where(r => r.status.eq('open'))
  );

  const { bids, asks, spread } = useMemo(() => {
    const group = (side: string, bestFirst: (a: bigint, b: bigint) => number) => {
      const byPrice = new Map<bigint, Level>();
      for (const o of open) {
        if (o.side !== side) continue;
        const lvl = byPrice.get(o.price) ?? {
          price: o.price,
          qty: 0n,
          orders: 0,
          mine: false,
          cumulative: 0n,
        };
        lvl.qty += o.remaining;
        lvl.orders += 1;
        lvl.mine ||= o.owner.isEqual(me);
        byPrice.set(o.price, lvl);
      }
      const levels = [...byPrice.values()].sort((a, b) => bestFirst(a.price, b.price)).slice(0, LEVELS);
      let running = 0n;
      for (const l of levels) l.cumulative = running += l.qty;
      return levels;
    };
    const bids = group('buy', (a, b) => cmpBig(b, a));
    const asks = group('sell', cmpBig);
    const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : null;
    return { bids, asks, spread };
  }, [open, me]);

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
