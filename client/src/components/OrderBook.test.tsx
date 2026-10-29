import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Identity } from 'spacetimedb';
import { resetSpacetimeMock, spacetimeMock, tableReady, tableRows } from '../test/spacetime';
import OrderBook from './OrderBook';

vi.mock('spacetimedb/react', () => spacetimeMock);

const ME = new Identity(1n);
const OTHER = new Identity(2n);
const order = (side: string, price: bigint, remaining: bigint, owner = OTHER) => ({
  side,
  price,
  remaining,
  owner,
  symbol: 'BRKT',
  status: 'open',
});

const prices = (container: HTMLElement) =>
  [...container.querySelectorAll('.price')].map(el => el.textContent);

beforeEach(resetSpacetimeMock);

describe('OrderBook', () => {
  it('shows asks above bids with the best prices meeting at the spread', () => {
    tableRows.orders = [
      order('sell', 4_300n, 5n),
      order('sell', 4_275n, 2n),
      order('buy', 4_250n, 3n, ME),
      order('buy', 4_200n, 7n),
      order('buy', 4_200n, 1n),
    ];
    const { container } = render(<OrderBook roomId={1n} symbol="BRKT" me={ME} />);

    // Asks are listed worst-to-best so the best ask sits just above the spread.
    expect(prices(container.querySelector('.asks')!)).toEqual(['43.00', '42.75']);
    expect(prices(container.querySelector('.bids')!)).toEqual(['42.50', '42.00']);
    expect(screen.getByText('Spread 0.25')).toBeInTheDocument();

    const bids = container.querySelector('.bids') as HTMLElement;
    expect(within(bids).getByText('● you')).toBeInTheDocument();
    expect(within(bids).getByText('8')).toBeInTheDocument(); // 7 + 1 aggregated at 42.00
  });

  it('says so when a side is empty', () => {
    tableRows.orders = [order('buy', 4_000n, 1n)];
    render(<OrderBook roomId={1n} symbol="BRKT" me={ME} />);
    expect(screen.getByText('No sellers')).toBeInTheDocument();
    expect(screen.getByText('No spread yet')).toBeInTheDocument();
  });

  it('shows a loading state until the subscription is applied', () => {
    tableReady.value = false;
    render(<OrderBook roomId={1n} symbol="BRKT" me={ME} />);
    expect(screen.getByText('Loading book…')).toBeInTheDocument();
  });
});
