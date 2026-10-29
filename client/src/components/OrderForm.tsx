import { useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';
import { TAKER_FEE_BPS, feeOn, fmtCents, fmtPrice, parseDollars, parseQty } from '../format';

type Props = { roomId: bigint; symbol: string; tickSize: bigint; lastPrice: bigint; cash: bigint; shares: bigint };
type Kind = 'limit' | 'market' | 'stop';

const FEE_PCT = `${Number(TAKER_FEE_BPS) / 100}%`;

export default function OrderForm({ roomId, symbol, tickSize, lastPrice, cash, shares }: Props) {
  const placeLimit = useReducer(reducers.placeLimitOrder);
  const placeMarket = useReducer(reducers.placeMarketOrder);
  const placeStop = useReducer(reducers.placeStopOrder);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [kind, setKind] = useState<Kind>('limit');
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
      if (kind === 'limit') await placeLimit({ roomId, symbol, side, price: price!, qty });
      else if (kind === 'market') await placeMarket({ roomId, symbol, side, qty });
      else await placeStop({ roomId, symbol, side, stopPrice: price!, qty });
      const what = kind === 'stop' ? 'stop' : 'order';
      setStatus({ ok: true, text: `${side === 'buy' ? 'Buy' : 'Sell'} ${what} sent` });
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  let summary = side === 'buy' ? `Cash available ${fmtCents(cash)}` : `${symbol} available ${shares}`;
  if (kind === 'limit' && price !== null && qty !== null) {
    const notional = price * qty;
    // A buy reserves the worst-case fee too, so show what it will set aside.
    summary += side === 'buy'
      ? ` · Up to ${fmtCents(notional + feeOn(notional))} incl. fee`
      : ` · Total ${fmtCents(notional)}`;
  }

  const stopHint =
    side === 'buy'
      ? `Fires as a market buy once a trade prints at or above this. Last ${fmtPrice(lastPrice)}.`
      : `Fires as a market sell once a trade prints at or below this. Last ${fmtPrice(lastPrice)}.`;

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
        {(['limit', 'market', 'stop'] as const).map(k => (
          <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>

      {kind !== 'market' && (
        <label>
          {kind === 'stop' ? 'Stop price ($)' : 'Price ($)'}
          <input
            inputMode="decimal"
            value={priceText}
            onChange={e => setPriceText(e.target.value)}
            placeholder={fmtPrice(lastPrice)}
          />
          {kind === 'stop' && <span className="muted small">{stopHint}</span>}
          {tickSize > 1n && <span className="muted small">Tick size {fmtPrice(tickSize)}</span>}
        </label>
      )}
      <label>
        Shares
        <input inputMode="numeric" value={qtyText} onChange={e => setQtyText(e.target.value)} />
      </label>

      <p className="muted small">{summary}</p>
      <p className="muted small">
        Taker fee {FEE_PCT} on what fills immediately. Orders resting on the book pay nothing.
      </p>

      <button type="submit" className={`primary ${side}`} disabled={busy || !valid}>
        {side === 'buy' ? 'Buy' : 'Sell'} {symbol}
        {kind === 'stop' ? ' on stop' : ''}
      </button>
      {status && <p className={status.ok ? 'ok small' : 'error small'}>{status.text}</p>}
    </form>
  );
}
