import { useState } from 'react';
import type { Identity } from 'spacetimedb';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import { cmpBig, fmtPrice } from '../format';

/** Your open orders in this symbol, read from the book subscription, with cancel buttons. */
export default function MyOrders({ symbol, me }: { symbol: string; me: Identity }) {
  const cancel = useReducer(reducers.cancelOrder);
  const [error, setError] = useState<string | null>(null);
  const [open] = useTable(
    tables.orders.where(r => r.symbol.eq(symbol)).where(r => r.status.eq('open'))
  );
  const mine = open.filter(o => o.owner.isEqual(me)).sort((a, b) => cmpBig(b.seq, a.seq));

  if (!mine.length) return null;

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
          <button
            type="button"
            className="link"
            onClick={() =>
              cancel({ orderId: o.id }).catch(err =>
                setError(err instanceof Error ? err.message : String(err))
              )
            }
          >
            Cancel
          </button>
        </div>
      ))}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
