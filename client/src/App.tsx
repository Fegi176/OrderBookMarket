import { useCallback, useMemo, useState } from 'react';
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
import Portfolio from './components/Portfolio';
import Leaderboard from './components/Leaderboard';
import SeasonBanner from './components/SeasonBanner';
import HallOfFame from './components/HallOfFame';
import Rooms from './components/Rooms';

type Page = 'trade' | 'portfolio' | 'leaderboard' | 'hall' | 'rooms';
const PAGES: { id: Page; label: string; needsAccount: boolean }[] = [
  { id: 'trade', label: 'Trade', needsAccount: false },
  { id: 'portfolio', label: 'Portfolio', needsAccount: true },
  { id: 'leaderboard', label: 'Leaderboard', needsAccount: true },
  { id: 'hall', label: 'Hall of Fame', needsAccount: true },
  { id: 'rooms', label: 'Rooms', needsAccount: false },
];

const ROOM_KEY = 'order-book/room';

function readStoredRoom(): bigint | null {
  try {
    const v = localStorage.getItem(ROOM_KEY);
    return v ? BigInt(v) : null;
  } catch {
    return null;
  }
}

function storeRoom(id: bigint) {
  try {
    localStorage.setItem(ROOM_KEY, id.toString());
  } catch {
    // Private mode: the room choice just won't survive a reload.
  }
}

export default function App() {
  const { isActive, identity, connectionError } = useSpacetimeDB();
  const [myRooms, myRoomsReady] = useTable(tables.myRooms);
  const [lobby, lobbyReady] = useTable(tables.publicRooms);
  const [accounts, accountsReady] = useTable(tables.myAccounts);
  const [allHoldings] = useTable(tables.myHoldings);
  const [stored, setStored] = useState<bigint | null>(readStoredRoom);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('trade');

  // The current room: the last one chosen if it still exists for this player,
  // otherwise Main (the oldest public room, created with the database).
  const mainId = useMemo(
    () => [...lobby].sort((a, b) => (a.id < b.id ? -1 : 1))[0]?.id ?? null,
    [lobby]
  );
  const known = (id: bigint) => myRooms.some(r => r.id === id) || lobby.some(r => r.id === id);
  const roomId = stored !== null && known(stored) ? stored : mainId;

  // Hooks can't be conditional, so before a room is known the queries ask for room 0, which never exists.
  const [instruments] = useTable(tables.instrument.where(r => r.roomId.eq(roomId ?? 0n)));
  const sorted = useMemo(
    () => [...instruments].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [instruments]
  );

  const switchRoom = useCallback((id: bigint) => {
    storeRoom(id);
    setStored(id);
    setSelected(null);
    setPage('trade');
  }, []);

  if (connectionError) {
    return <div className="center">Can't reach the exchange: {connectionError.message}</div>;
  }
  if (!isActive || !identity || !accountsReady || !lobbyReady || !myRoomsReady) {
    return <div className="center muted">Connecting to the exchange…</div>;
  }
  if (roomId === null) {
    return <div className="center muted">No rooms are open yet.</div>;
  }

  const account = accounts.find(a => a.roomId === roomId);
  const holdings = allHoldings.filter(h => h.roomId === roomId);
  const room = myRooms.find(r => r.id === roomId);
  const roomName = room?.name ?? lobby.find(r => r.id === roomId)?.name ?? 'this room';
  const defaultName = accounts[0]?.name ?? '';
  const symbol = selected ?? sorted[0]?.symbol ?? null;
  const holding = holdings.find(h => h.symbol === symbol);
  const trade = (sym: string) => {
    setSelected(sym);
    setPage('trade');
  };
  const visiblePages = PAGES.filter(p => account || !p.needsAccount);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Order Book Market</h1>
        <nav className="pages" aria-label="Pages">
          {visiblePages.map(p => (
            <button
              key={p.id}
              type="button"
              className={page === p.id ? 'page active' : 'page'}
              aria-current={page === p.id ? 'page' : undefined}
              onClick={() => setPage(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <div className="balances">
          <label className="room-switch">
            <span className="muted">Room</span>
            <select
              aria-label="Current room"
              value={roomId.toString()}
              onChange={e => switchRoom(BigInt(e.target.value))}
            >
              {!room && <option value={roomId.toString()}>{roomName}</option>}
              {[...myRooms]
                .sort((a, b) => (a.id < b.id ? -1 : 1))
                .map(r => (
                  <option key={r.id.toString()} value={r.id.toString()}>
                    {r.name}
                  </option>
                ))}
            </select>
          </label>
          {room && !room.isPublic && (
            <span title="Share this code so friends can join">
              <span className="muted">Code</span> <code className="code">{room.code}</code>
            </span>
          )}
          {account && <SeasonBanner key={roomId.toString()} roomId={roomId} />}
          {account && (
            <>
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
            </>
          )}
        </div>
      </header>

      {page === 'rooms' && <Rooms currentRoomId={roomId} defaultName={defaultName} onSwitch={switchRoom} />}

      {page !== 'rooms' && !account && (
        <Register
          key={roomId.toString()}
          roomId={roomId}
          roomName={roomName}
          defaultName={defaultName}
          onBrowseRooms={() => setPage('rooms')}
        />
      )}

      {account && page === 'portfolio' && (
        <Portfolio
          me={identity}
          roomId={roomId}
          account={account}
          holdings={holdings}
          instruments={sorted}
          onTrade={trade}
        />
      )}

      {account && page === 'hall' && <HallOfFame me={identity} roomId={roomId} />}

      {account && page === 'leaderboard' && (
        <section className="panel leaderboard">
          <h2>Leaderboard · {roomName}</h2>
          <Leaderboard me={identity} roomId={roomId} />
        </section>
      )}

      {account && page === 'trade' && (
        <>
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
                <PriceChart roomId={roomId} symbol={symbol} />
              </section>
              <section className="panel book-panel">
                <h2>Order book</h2>
                <OrderBook roomId={roomId} symbol={symbol} me={identity} />
              </section>
              <section className="panel form-panel">
                <h2>Place order</h2>
                <OrderForm
                  roomId={roomId}
                  symbol={symbol}
                  tickSize={sorted.find(i => i.symbol === symbol)?.tickSize ?? 1n}
                  lastPrice={sorted.find(i => i.symbol === symbol)?.lastPrice ?? 0n}
                  cash={account.cashAvailable}
                  shares={holding?.qtyAvailable ?? 0n}
                />
                <MyOrders roomId={roomId} symbol={symbol} me={identity} />
              </section>
              <section className="panel feed-panel">
                <h2>Trades</h2>
                <TradeFeed roomId={roomId} symbol={symbol} me={identity} />
              </section>
              <section className="panel news-panel">
                <h2>News</h2>
                <NewsFeed roomId={roomId} onSelect={trade} />
              </section>
            </main>
          )}
        </>
      )}
    </div>
  );
}
