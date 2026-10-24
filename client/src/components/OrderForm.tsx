import { useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';
import { fmtCents, fmtPrice, parseDollars, parseQty } from '../format';

type Props = { symbol: string; tickSize: bigint; cash: bigint; shares: bigint };

export default function OrderForm({ symbol, tickSize, cash, shares }: Props) {
  const placeLimit = useReducer(reducers.placeLimitOrder);
  const placeMarket = useReducer(reducers.placeMarketOrder);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [kind, setKind] = useState<'limit' | 'market'>('limit');
  const [priceText, setPriceText] = useState('');
  const [qtyText, setQtyText] = useState('10');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const price = parseDollars(priceText);
  const qty = parseQty(qtyText);
  const priceOk = kind === 'market' || (price !== null && price > 0n && price % tickSize === 0n);
  const valid = qty !== null && qty > 0n && priceOk;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || qty === null) return;
    setBusy(true);
    setStatus(null);
    try {
      if (kind === 'limit') await placeLimit({ symbol, side, price: price!, qty });
      else await placeMarket({ symbol, side, qty });
      setStatus({ ok: true, text: `${side === 'buy' ? 'Buy' : 'Sell'} order sent` });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="order-form" onSubmit={submit}>
      <div className="toggle" role="group" aria-label="Side">
        <button type="button" className={side === 'buy' ? 'on buy' : ''} onClick={() => setSide('buy')}>
          Buy
        </button>
        <button type="button" className={side === 'sell' ? 'on sell' : ''} onClick={() => setSide('sell')}>
          Sell
        </button>
      </div>
      <div className="toggle" role="group" aria-label="Order type">
        <button type="button" className={kind === 'limit' ? 'on' : ''} onClick={() => setKind('limit')}>
          Limit
        </button>
        <button type="button" className={kind === 'market' ? 'on' : ''} onClick={() => setKind('market')}>
          Market
        </button>
      </div>

      {kind === 'limit' && (
        <label>
          Price ($)
          <input
            inputMode="decimal"
            value={priceText}
            onChange={e => setPriceText(e.target.value)}
            placeholder="42.50"
          />
          {tickSize > 1n && <span className="muted small">Tick size {fmtPrice(tickSize)}</span>}
        </label>
      )}
      <label>
        Shares
        <input inputMode="numeric" value={qtyText} onChange={e => setQtyText(e.target.value)} />
      </label>

      <p className="muted small">
        {side === 'buy' ? `Cash available ${fmtCents(cash)}` : `${symbol} available ${shares}`}
        {kind === 'limit' && price !== null && qty !== null && ` · Total ${fmtCents(price * qty)}`}
      </p>

      <button type="submit" className={`primary ${side}`} disabled={busy || !valid}>
        {side === 'buy' ? 'Buy' : 'Sell'} {symbol}
      </button>
      {status && <p className={status.ok ? 'ok small' : 'error small'}>{status.text}</p>}
    </form>
  );
}
