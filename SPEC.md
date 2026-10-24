# Order-Book Marketplace on SpacetimeDB

Oct 24, 2026 · @Hoi

## What to build

A fictional stock exchange game with a real order book. Everyone starts with the same play money and trades 5 to 8 made-up companies. Scheduled news events move prices, bots keep the book from ever being empty, and a leaderboard ranks players by net worth.

SpacetimeDB fits because matching must be atomic: a reducer is one transaction handling one order at a time, so there are no race conditions.

## Tables

Seven tables carry the whole game.

| Table | Key fields | Purpose |
| --- | --- | --- |
| account | identity, name, cash\_available, cash\_reserved | One row per player |
| instrument | symbol, name, tick size | The tradable companies |
| holding | owner, symbol, qty\_available, qty\_reserved | Shares each player owns |
| order | id, owner, symbol, side (buy/sell), price, qty, remaining, sequence number, status (open/filled/cancelled) | The order book |
| trade | id, symbol, price, qty, buyer, seller, timestamp | Executed matches |
| candle | symbol, interval start, open, high, low, close, volume | Price chart data, rolled up by a scheduled reducer |
| news\_schedule | scheduled table | Fires market events |

## Reducers

Four reducers are called by players and three run on a schedule.

- `register(name)`: creates the account with starting cash and shares
- `place_limit_order(symbol, side, price, qty)`: runs the matching engine below
- `place_market_order(symbol, side, qty)`
- `cancel_order(order_id)`: owner only, releases the reservation
- Scheduled: `run_bots`, `roll_candles`, `fire_news_event`

## Matching engine

Matching lives inside `place_limit_order` and follows price-time priority: best price first, then the lowest sequence number.

1. Validate the input and reserve funds (buy) or shares (sell).
2. Walk the opposite side of the book in price-time priority.
3. Execute each match at the resting order's price. Insert a trade, move cash and shares, and reduce `remaining` on both orders.
4. Stop when the order is filled or no longer crosses the book.
5. If any quantity remains, rest it on the book.
6. Block self-trades by skipping or rejecting matches against your own orders.

A btree index on (symbol, side, price) keeps finding the best order fast.

## Things to get right

- **Integers only.** Store prices as integer ticks (cents) and quantities as integers. Floating point will eventually break the accounting.
- **Ordering.** Use your own incrementing sequence number for time priority, since timestamps can tie.
- **Reservations.** Lock cash or shares when an order is placed, or players can sell what they don't have.
- **Invariants.** Total cash and total shares must never change except through bots, news or deposits. Write a test that checks this after thousands of random orders.
- **Subscriptions.** Subscribe per symbol, not to the whole order table, and show aggregated depth in the UI.
- **Privacy.** The book is public, but accounts and balances should be private to their owner. Check the current SpacetimeDB docs for how to restrict rows per client.
- **Determinism.** No randomness or network calls inside reducers except through the module's provided RNG. Bots and news must use it.

## Build order

Start with the engine and test it without a UI, then add features in this order.

1. Accounts, one instrument, limit orders and the matching engine
2. Cancel, market orders and the invariants test
3. Trade feed, order book depth view and a price chart from candles
4. Bots for liquidity and scheduled news events
5. Leaderboard (net worth at last trade price) and portfolio page
6. Stretch: stop orders, fees, order history, multiple rooms or seasons

## Screens

- **Trading view:** order book, chart and order form
- **Portfolio:** holdings and open orders
- **Leaderboard:** players ranked by net worth

## Open questions

- [x] Which language for the module: Rust, C# or TypeScript? **TypeScript**
- [ ] Is this for school, work or a portfolio, and is there a deadline?
