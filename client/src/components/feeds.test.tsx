import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Identity, Timestamp } from 'spacetimedb';
import { reducerSpies, resetSpacetimeMock, spacetimeMock, tableReady, tableRows } from '../test/spacetime';
import TradeFeed from './TradeFeed';
import NewsFeed from './NewsFeed';
import MyOrders from './MyOrders';
import PriceChart from './PriceChart';

vi.mock('spacetimedb/react', () => spacetimeMock);

const ME = new Identity(1n);
const OTHER = new Identity(2n);
const ts = new Timestamp(1_800_000_000_000_000n);

beforeEach(resetSpacetimeMock);

describe('TradeFeed', () => {
  it('colours ticks and tags your own fills', () => {
    tableRows.trade = [
      { id: 1n, symbol: 'BRKT', price: 4_000n, qty: 1n, buyer: OTHER, seller: OTHER, timestamp: ts },
      { id: 2n, symbol: 'BRKT', price: 4_100n, qty: 2n, buyer: ME, seller: OTHER, timestamp: ts },
      { id: 3n, symbol: 'BRKT', price: 4_050n, qty: 3n, buyer: OTHER, seller: ME, timestamp: ts },
    ];
    render(<TradeFeed symbol="BRKT" me={ME} />);
    expect(screen.getByText('40.50')).toHaveClass('down');
    expect(screen.getByText('41.00')).toHaveClass('up');
    expect(screen.getByText('you bought')).toBeInTheDocument();
    expect(screen.getByText('you sold')).toBeInTheDocument();
  });

  it('distinguishes loading from no trades', () => {
    tableReady.value = false;
    const { unmount } = render(<TradeFeed symbol="BRKT" me={ME} />);
    expect(screen.getByText('Loading trades…')).toBeInTheDocument();
    unmount();
    tableReady.value = true;
    render(<TradeFeed symbol="BRKT" me={ME} />);
    expect(screen.getByText('No trades yet.')).toBeInTheDocument();
  });
});

describe('NewsFeed', () => {
  it('lists headlines newest first and jumps to the company on click', async () => {
    tableRows.news = [
      { id: 1n, symbol: 'BRKT', headline: 'Bracket Robotics beats earnings', impactBps: 300, timestamp: ts },
      { id: 2n, symbol: 'PXL', headline: 'Pixel Pictures recall', impactBps: -500, timestamp: ts },
    ];
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<NewsFeed onSelect={onSelect} />);
    const items = screen.getAllByRole('button');
    expect(items[0]).toHaveTextContent('▼ PXL');
    expect(items[1]).toHaveTextContent('▲ BRKT');
    await user.click(items[1]);
    expect(onSelect).toHaveBeenCalledWith('BRKT');
  });
});

describe('MyOrders', () => {
  it("shows only the viewer's open orders and pending stops for the symbol, with cancel", async () => {
    tableRows.orders = [
      { id: 1n, owner: ME, symbol: 'BRKT', side: 'buy', price: 4_000n, qty: 10n, remaining: 4n, seq: 1n, status: 'open' },
      { id: 2n, owner: OTHER, symbol: 'BRKT', side: 'sell', price: 4_500n, qty: 1n, remaining: 1n, seq: 2n, status: 'open' },
    ];
    tableRows.myStopOrders = [
      { id: 9n, owner: ME, symbol: 'BRKT', side: 'sell', stopPrice: 3_800n, qty: 5n, status: 'pending' },
      { id: 8n, owner: ME, symbol: 'PXL', side: 'sell', stopPrice: 900n, qty: 5n, status: 'pending' },
      { id: 7n, owner: ME, symbol: 'BRKT', side: 'buy', stopPrice: 5_000n, qty: 5n, status: 'triggered' },
    ];
    const user = userEvent.setup();
    render(<MyOrders symbol="BRKT" me={ME} />);

    expect(screen.getByText(/@ 40\.00/)).toBeInTheDocument();
    expect(screen.getByText('/10')).toBeInTheDocument(); // partly filled
    expect(screen.queryByText(/45\.00/)).not.toBeInTheDocument(); // someone else's
    expect(screen.getByText(/38\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/9\.00/)).not.toBeInTheDocument(); // other symbol
    expect(screen.queryByText(/50\.00/)).not.toBeInTheDocument(); // already triggered

    const [cancelOrder, cancelStop] = screen.getAllByRole('button', { name: 'Cancel' });
    await user.click(cancelOrder);
    await user.click(cancelStop);
    expect(reducerSpies.cancelOrder).toHaveBeenCalledWith({ orderId: 1n });
    expect(reducerSpies.cancelStopOrder).toHaveBeenCalledWith({ stopId: 9n });
  });

  it('renders nothing when there is nothing open', () => {
    const { container } = render(<MyOrders symbol="BRKT" me={ME} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PriceChart', () => {
  const bar = (i: bigint, open: bigint, close: bigint, volume = 1n) => ({
    id: i,
    symbol: 'BRKT',
    intervalStart: 1_800_000_000_000_000n + i * 60_000_000n,
    open,
    high: (open > close ? open : close) + 5n,
    low: (open < close ? open : close) - 5n,
    close,
    volume,
  });

  it('draws one candle per bar, coloured by direction, capped at 60', () => {
    tableRows.candle = Array.from({ length: 70 }, (_, i) =>
      bar(BigInt(i), 4_000n, i % 2 ? 4_010n : 3_990n)
    );
    const { container } = render(<PriceChart symbol="BRKT" />);
    expect(container.querySelectorAll('.candle')).toHaveLength(60);
    expect(container.querySelectorAll('.candle.up').length).toBe(30);
    expect(screen.getByRole('img', { name: /last 40\.10/ })).toBeInTheDocument();
  });

  it('skips the volume bar for a minute with no trades', () => {
    tableRows.candle = [bar(0n, 4_000n, 4_000n, 0n), bar(1n, 4_000n, 4_010n, 3n)];
    const { container } = render(<PriceChart symbol="BRKT" />);
    expect(container.querySelectorAll('.vol')).toHaveLength(1);
  });

  it('distinguishes loading from no history', () => {
    tableReady.value = false;
    const { unmount } = render(<PriceChart symbol="BRKT" />);
    expect(screen.getByText('Loading chart…')).toBeInTheDocument();
    unmount();
    tableReady.value = true;
    render(<PriceChart symbol="BRKT" />);
    expect(screen.getByText('No price history yet.')).toBeInTheDocument();
  });
});
