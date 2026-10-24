import { useMemo, useState } from 'react';
import type { Identity, Infer } from 'spacetimedb';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';
import MyAccountRow from '../module_bindings/my_account_table';
import MyHoldingsRow from '../module_bindings/my_holdings_table';
import InstrumentRow from '../module_bindings/instrument_table';
import { cmpBig, fmtCents, fmtPrice, fmtReturn, fmtTime } from '../format';

type Props = {
  me: Identity;
  account: Infer<typeof MyAccountRow>;
  holdings: readonly Infer<typeof MyHoldingsRow>[];
  instruments: readonly Infer<typeof InstrumentRow>[];
  onTrade: (symbol: string) => void;
};

const RECENT_FILLS = 20;

export default function Portfolio({ me, account, holdings, instruments, onTrade }: Props) {
  const cancel = useReducer(reducers.cancelOrder);
  const [error, setError] = useState<string | null>(null);
  const [openOrders] = useTable(
    tables.orders.where(r => r.owner.eq(me)).where(r => r.status.eq('open'))
  );
  const [bought] = useTable(tables.trade.where(r => r.buyer.eq(me)));
  const [sold] = useTable(tables.trade.where(r => r.seller.eq(me)));

  const price = useMemo(() => new Map(instruments.map(i => [i.symbol, i.lastPrice])), [instruments]);

  const positions = useMemo(
    () =>
      [...holdings]
        .map(h => {
          const qty = h.qtyAvailable + h.qtyReserved;
          const last = price.get(h.symbol) ?? 0n;
          return { ...h, qty, last, value: qty * last };
        })
        .filter(p => p.qty > 0n)
        .sort((a, b) => cmpBig(b.value, a.value)),
    [holdings, price]
  );

  const sharesValue = positions.reduce((s, p) => s + p.value, 0n);
  const cash = account.cashAvailable + account.cashReserved;
  const netWorth = cash + sharesValue;
  const pnl = netWorth - account.startingNetWorth;

  const fills = useMemo(
    () =>
      [...bought.map(t => ({ t, side: 'buy' as const })), ...sold.map(t => ({ t, side: 'sell' as const }))]
        .sort((a, b) => cmpBig(b.t.id, a.t.id))
        .slice(0, RECENT_FILLS),
    [bought, sold]
  );

  const share = (v: bigint) => (netWorth ? `${Number((v * 1000n) / netWorth) / 10}%` : '—');

  return (
    <div className="portfolio">
      <section className="panel summary">
        <div>
          <div className="muted small">Net worth</div>
          <div className="big">{fmtCents(netWorth)}</div>
        </div>
        <div>
          <div className="muted small">Return</div>
          <div className={`big ${pnl >= 0n ? 'up' : 'down'}`}>
            {fmtReturn(account.startingNetWorth, netWorth)}{' '}
            <span className="small">({pnl >= 0n ? '+' : '-'}{fmtCents(pnl < 0n ? -pnl : pnl)})</span>
          </div>
        </div>
        <div>
          <div className="muted small">Cash</div>
          <div className="big">{fmtCents(account.cashAvailable)}</div>
          {account.cashReserved > 0n && (
            <div className="muted small">+ {fmtCents(account.cashReserved)} in orders</div>
          )}
        </div>
        <div>
          <div className="muted small">Shares</div>
          <div className="big">{fmtCents(sharesValue)}</div>
        </div>
      </section>

      <section className="panel">
        <h2>Holdings</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">Shares</th>
              <th className="num">Last</th>
              <th className="num">Value</th>
              <th className="num">Of net worth</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="muted">Cash</td>
              <td />
              <td />
              <td className="num">{fmtCents(cash)}</td>
              <td className="num muted">{share(cash)}</td>
            </tr>
            {positions.map(p => (
              <tr key={p.symbol}>
                <td>
                  <button type="button" className="link sym-link" onClick={() => onTrade(p.symbol)}>
                    {p.symbol}
                  </button>
                </td>
                <td className="num">
                  {p.qty.toString()}
                  {p.qtyReserved > 0n && <span className="muted small"> ({p.qtyReserved} in orders)</span>}
                </td>
                <td className="num">{fmtPrice(p.last)}</td>
                <td className="num">{fmtCents(p.value)}</td>
                <td className="num muted">{share(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Open orders</h2>
        {openOrders.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th className="num">Price</th>
                <th className="num">Filled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...openOrders]
                .sort((a, b) => cmpBig(b.seq, a.seq))
                .map(o => (
                  <tr key={o.id.toString()}>
                    <td>{o.symbol}</td>
                    <td className={o.side === 'buy' ? 'buy-text' : 'sell-text'}>{o.side}</td>
                    <td className="num">{fmtPrice(o.price)}</td>
                    <td className="num">
                      {(o.qty - o.remaining).toString()} / {o.qty.toString()}
                    </td>
                    <td className="num">
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
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small">No open orders.</p>
        )}
        {error && <p className="error small">{error}</p>}
      </section>

      <section className="panel">
        <h2>Recent fills</h2>
        {fills.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Side</th>
                <th className="num">Shares</th>
                <th className="num">Price</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {fills.map(({ t, side }) => (
                <tr key={t.id.toString()}>
                  <td className="muted">{fmtTime(t.timestamp.microsSinceUnixEpoch)}</td>
                  <td>{t.symbol}</td>
                  <td className={side === 'buy' ? 'buy-text' : 'sell-text'}>{side}</td>
                  <td className="num">{t.qty.toString()}</td>
                  <td className="num">{fmtPrice(t.price)}</td>
                  <td className="num">{fmtCents(t.price * t.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small">No fills yet.</p>
        )}
      </section>
    </div>
  );
}
