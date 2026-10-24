import { useMemo, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './module_bindings';
import { fmtCents, fmtPrice } from './format';
import Register from './components/Register';
import OrderBook from './components/OrderBook';
import TradeFeed from './components/TradeFeed';
import PriceChart from './components/PriceChart';
import OrderForm from './components/OrderForm';
import MyOrders from './components/MyOrders';
import NewsFeed from './components/NewsFeed';

export default function App() {
  const { isActive, identity, connectionError } = useSpacetimeDB();
  const [instruments] = useTable(tables.instrument);
  const [accounts, accountReady] = useTable(tables.myAccount);
  const [holdings] = useTable(tables.myHoldings);
  const [selected, setSelected] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...instruments].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [instruments]
  );
  const symbol = selected ?? sorted[0]?.symbol ?? null;
  const account = accounts[0];

  if (connectionError) {
    return <div className="center">Can't reach the exchange: {connectionError.message}</div>;
  }
  if (!isActive || !identity || !accountReady) {
    return <div className="center muted">Connecting to the exchange…</div>;
  }
  if (!account) return <Register />;

  const holding = holdings.find(h => h.symbol === symbol);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Order Book Market</h1>
        <div className="balances">
          <span>
            <span className="muted">Player</span> {account.name}
          </span>
          <span>
            <span className="muted">Cash</span> {fmtCents(account.cashAvailable)}
          </span>
          {account.cashReserved > 0n && (
            <span>
              <span className="muted">In orders</span> {fmtCents(account.cashReserved)}
            </span>
          )}
        </div>
      </header>

      <nav className="symbols" aria-label="Instruments">
        {sorted.map(inst => (
          <button
            key={inst.symbol}
            className={inst.symbol === symbol ? 'symbol active' : 'symbol'}
            onClick={() => setSelected(inst.symbol)}
            title={inst.name}
          >
            <span className="sym">{inst.symbol}</span>
            <span className="px">{fmtPrice(inst.lastPrice)}</span>
          </button>
        ))}
      </nav>

      {symbol && (
        <main className="trading">
          <section className="panel chart-panel">
            <h2>
              {symbol}{' '}
              <span className="muted">{sorted.find(i => i.symbol === symbol)?.name}</span>
            </h2>
            <PriceChart symbol={symbol} />
          </section>
          <section className="panel book-panel">
            <h2>Order book</h2>
            <OrderBook symbol={symbol} me={identity} />
          </section>
          <section className="panel form-panel">
            <h2>Place order</h2>
            <OrderForm
              symbol={symbol}
              tickSize={sorted.find(i => i.symbol === symbol)?.tickSize ?? 1n}
              cash={account.cashAvailable}
              shares={holding?.qtyAvailable ?? 0n}
            />
            <MyOrders symbol={symbol} me={identity} />
          </section>
          <section className="panel feed-panel">
            <h2>Trades</h2>
            <TradeFeed symbol={symbol} me={identity} />
          </section>
          <section className="panel news-panel">
            <h2>News</h2>
            <NewsFeed onSelect={setSelected} />
          </section>
        </main>
      )}
      <footer className="muted small">
        Holdings:{' '}
        {[...holdings]
          .sort((a, b) => a.symbol.localeCompare(b.symbol))
          .map(h => `${h.symbol} ${h.qtyAvailable + h.qtyReserved}`)
          .join(' · ')}
      </footer>
    </div>
  );
}
