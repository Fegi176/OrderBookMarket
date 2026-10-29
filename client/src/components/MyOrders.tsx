import { useState } from 'react';
import type { Identity } from 'spacetimedb';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { cmpBig, fmtPrice } from '../format';

/**
 * Your open orders in this symbol (read from the book subscription) and your pending
 * stops (from the private my_stop_orders view), each with a cancel button.
 */
export default function MyOrders({ roomId, symbol, me }: { roomId: bigint; symbol: string; me: Identity }) {
  const cancel = useReducer(reducers.cancelOrder);
  const cancelStop = useReducer(reducers.cancelStopOrder);
  const [error, setError] = useState<string | null>(null);
  const [open] = useTable(
    tables.orders.where(r => r.roomId.eq(roomId)).where(r => r.symbol.eq(symbol)).where(r => r.status.eq('open'))
  );
  const [stops] = useTable(tables.myStopOrders);

  const mine = open.filter(o => o.owner.isEqual(me)).sort((a, b) => cmpBig(b.seq, a.seq));
  const pending = stops
    .filter(s => s.roomId === roomId && s.symbol === symbol && s.status === 'pending')
    .sort((a, b) => cmpBig(b.id, a.id));

  if (!mine.length && !pending.length) return null;

  const onError = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  return (
    <div className="my-orders">
      <h3>Your open orders</h3>
      {mine.map(o => (
        <div key={o.id.toString()} className="my-order">
          <span className={o.side === 'buy' ? 'buy-text' : 'sell-text'}>{o.side}</span>
          <span>
            {o.remaining.toString()}
            {o.remaining !== o.qty && <span className="muted">/{o.qty.toString()}</span>} @{' '}
            {fmtPrice(o.price)}
          </span>
          <button type="button" className="link" onClick={() => cancel({ orderId: o.id }).catch(onError)}>
            Cancel
          </button>
        </div>
      ))}
      {pending.map(s => (
        <div key={`stop-${s.id}`} className="my-order">
          <span className={s.side === 'buy' ? 'buy-text' : 'sell-text'}>{s.side}</span>
          <span>
            {s.qty.toString()} <span className="muted">stop {s.side === 'buy' ? '≥' : '≤'}</span>{' '}
            {fmtPrice(s.stopPrice)}
          </span>
          <button type="button" className="link" onClick={() => cancelStop({ stopId: s.id }).catch(onError)}>
            Cancel
          </button>
        </div>
      ))}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
