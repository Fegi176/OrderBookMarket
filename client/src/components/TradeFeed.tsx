import { useMemo } from 'react';
import type { Identity } from 'spacetimedb';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { fmtPrice, fmtTime } from '../format';
import { recentTicks } from '../lib/market';

const SHOWN = 30;

export default function TradeFeed({ symbol, me }: { symbol: string; me: Identity }) {
  const [trades, ready] = useTable(tables.trade.where(r => r.symbol.eq(symbol)));
  const recent = useMemo(() => recentTicks(trades, SHOWN), [trades]);

  if (!recent.length) {
    return <p className="muted small">{ready ? 'No trades yet.' : 'Loading trades…'}</p>;
  }

  return (
    <div className="feed">
      <div className="feed-row muted small">
        <span>Time</span>
        <span>Price</span>
        <span>Shares</span>
        <span />
      </div>
      {recent.map(({ t, tick }) => {
        const mine = t.buyer.isEqual(me) ? 'you bought' : t.seller.isEqual(me) ? 'you sold' : '';
        return (
          <div key={t.id.toString()} className="feed-row">
            <span className="muted">{fmtTime(t.timestamp.microsSinceUnixEpoch)}</span>
            <span className={`price ${tick}`}>{fmtPrice(t.price)}</span>
            <span>{t.qty.toString()}</span>
            <span className="small accent">{mine}</span>
          </div>
        );
      })}
    </div>
  );
}
