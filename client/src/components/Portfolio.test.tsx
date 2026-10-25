import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Identity, Timestamp } from 'spacetimedb';
import { reducerSpies, resetSpacetimeMock, spacetimeMock, tableRows } from '../test/spacetime';
import Portfolio from './Portfolio';

vi.mock('spacetimedb/react', () => spacetimeMock);

const ME = new Identity(1n);
const OTHER = new Identity(2n);
const ts = new Timestamp(1_800_000_000_000_000n);

const account = {
  identity: ME,
  name: 'Ada',
  cashAvailable: 9_000_000n,
  cashReserved: 500_000n,
  createdAt: ts,
  isBot: false,
  startingNetWorth: 10_000_000n,
};
const holding = (symbol: string, qtyAvailable: bigint, qtyReserved = 0n) => ({
  id: 0n,
  owner: ME,
  symbol,
  qtyAvailable,
  qtyReserved,
});
const instruments = [
  { symbol: 'BRKT', name: 'Bracket Robotics', tickSize: 1n, lastPrice: 5_000n, listingPrice: 4_250n },
  { symbol: 'PXL', name: 'Pixel Pictures', tickSize: 1n, lastPrice: 1_000n, listingPrice: 960n },
];
const order = (id: bigint, status: string, extra: object = {}) => ({
  id,
  owner: ME,
  symbol: 'BRKT',
  side: 'buy',
  price: 4_000n,
  qty: 10n,
  remaining: 10n,
  seq: id,
  status,
  createdAt: ts,
  feePaid: 0n,
  ...extra,
});
const stop = (id: bigint, status: string, note = '') => ({
  id,
  owner: ME,
  symbol: 'PXL',
  side: 'sell',
  stopPrice: 900n,
  qty: 5n,
  status,
  createdAt: ts,
  orderId: 0n,
  note,
});

function renderPortfolio(onTrade = vi.fn()) {
  render(
    <Portfolio
      me={ME}
      account={account}
      holdings={[holding('BRKT', 10n, 2n), holding('PXL', 0n, 0n)]}
      instruments={instruments}
      onTrade={onTrade}
    />
  );
  return onTrade;
}

const section = (heading: string) => screen.getByRole('heading', { name: heading }).closest('section')!;

beforeEach(resetSpacetimeMock);

describe('Portfolio', () => {
  it('sums net worth from cash, reserved cash and shares at last price', () => {
    renderPortfolio();
    // $90,000 + $5,000 reserved + 12 BRKT x $50.00 = $95,600.00; started at $100,000.
    expect(screen.getByText('$95,600.00')).toBeInTheDocument();
    expect(screen.getByText('-4.40%')).toBeInTheDocument();
    const holdings = section('Holdings');
    expect(within(holdings).getByText('(2 in orders)')).toBeInTheDocument();
    expect(within(holdings).queryByText('PXL')).not.toBeInTheDocument(); // empty positions hidden
  });

  it('opens a symbol on the trade page from the holdings table', async () => {
    const user = userEvent.setup();
    const onTrade = renderPortfolio();
    await user.click(within(section('Holdings')).getByRole('button', { name: 'BRKT' }));
    expect(onTrade).toHaveBeenCalledWith('BRKT');
  });

  it('splits orders into open (cancellable) and history with fees', async () => {
    tableRows.orders = [
      order(1n, 'filled', { remaining: 0n, feePaid: 40n, price: 0n }),
      order(2n, 'open', { remaining: 4n }),
      order(3n, 'cancelled'),
    ];
    const user = userEvent.setup();
    renderPortfolio();

    const open = section('Open orders');
    expect(within(open).getByText('6 / 10')).toBeInTheDocument();
    await user.click(within(open).getByRole('button', { name: 'Cancel' }));
    expect(reducerSpies.cancelOrder).toHaveBeenCalledWith({ orderId: 2n });

    const history = within(section('Order history')).getAllByRole('row').slice(1);
    expect(history.map(r => r.textContent)).toEqual([
      expect.stringContaining('limit'), // seq 3, newest first: cancelled limit order
      expect.stringContaining('market'), // seq 1: market orders are stored at price 0
    ]);
    expect(within(section('Order history')).getByText('$0.40')).toBeInTheDocument();
  });

  it('lists stops with their failure reason and cancels only pending ones', async () => {
    tableRows.myStopOrders = [stop(1n, 'failed', 'No matching orders on the book'), stop(2n, 'pending')];
    const user = userEvent.setup();
    renderPortfolio();
    const stops = section('Stop orders');
    expect(within(stops).getByText(/No matching orders on the book/)).toBeInTheDocument();
    const cancels = within(stops).getAllByRole('button', { name: 'Cancel' });
    expect(cancels).toHaveLength(1);
    await user.click(cancels[0]);
    expect(reducerSpies.cancelStopOrder).toHaveBeenCalledWith({ stopId: 2n });
  });

  it('shows recent fills from both sides, newest first', () => {
    tableRows.trade = [
      { id: 5n, symbol: 'BRKT', price: 5_000n, qty: 2n, buyer: ME, seller: OTHER, timestamp: ts },
      { id: 7n, symbol: 'PXL', price: 1_000n, qty: 3n, buyer: OTHER, seller: ME, timestamp: ts },
    ];
    renderPortfolio();
    // The mock returns the same rows for both the buyer and seller queries; the real
    // subscription would split them. What matters here is order and totals.
    const rows = within(section('Recent fills')).getAllByRole('row').slice(1);
    expect(rows[0].textContent).toContain('PXL');
    expect(rows[0].textContent).toContain('$30.00');
  });
});
