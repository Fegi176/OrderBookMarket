# Order-Book Marketplace

A fictional stock exchange game on SpacetimeDB with a real price-time-priority order book. See [SPEC.md](SPEC.md) for the full design.

## Layout

```
server/            SpacetimeDB module (TypeScript)
  src/schema.ts    tables, indexes and the schema object
  src/engine.ts    matching engine, reservations, cancel
  src/index.ts     reducers (init, register, place_limit_order, cancel_order) and private views
  tests/           engine tests run against the SDK's in-process test datastore
```

A `client/` web app comes later (build order step 3).

## Develop

```bash
cd server
npm install
npm test          # engine tests, no SpacetimeDB server needed
npm run typecheck
```

## Run on SpacetimeDB

Install the CLI from https://spacetimedb.com/install, then:

```bash
spacetime start
spacetime publish --project-path server order-book
spacetime generate --lang typescript --out-dir client/src/module_bindings --project-path server
```

## Design notes

- Money is integer cents and quantities are whole shares, all `u64` (`bigint` in TS).
- Time priority uses a private `order_seq` counter, not timestamps.
- Placing an order reserves cash (buys, at the limit price) or shares (sells). Fills settle at the resting order's price and refund any price improvement to the buyer.
- Self-trades are skipped: your own resting orders are passed over and stay on the book.
- `account` and `holding` are private tables. Clients read their own rows through the `my_account` and `my_holdings` views.
- Filled and cancelled orders stay in `orders` with their status, so order history is already there.

## Status

- [x] Step 1: accounts, instruments, limit orders, matching engine
- [x] Part of step 2: cancel and the conservation (invariants) test
- [ ] Step 2: market orders
- [ ] Steps 3-6: candles, trade feed, client UI, bots, news, leaderboard
