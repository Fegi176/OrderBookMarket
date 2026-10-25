import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Identity, Timestamp } from 'spacetimedb';
import { resetSpacetimeMock, spacetimeMock, tableReady, tableRows } from './test/spacetime';
import App from './App';

vi.mock('spacetimedb/react', () => spacetimeMock);

const ME = new Identity(1n);
const ts = new Timestamp(1_800_000_000_000_000n);

function connected(extra: object = {}) {
  spacetimeMock.useSpacetimeDB.mockReturnValue({ isActive: true, identity: ME, ...extra });
}

const account = {
  identity: ME,
  name: 'Ada',
  cashAvailable: 10_000_000n,
  cashReserved: 0n,
  createdAt: ts,
  isBot: false,
  startingNetWorth: 13_000_000n,
};

beforeEach(() => {
  resetSpacetimeMock();
  tableRows.instrument = [
    { symbol: 'PXL', name: 'Pixel Pictures', tickSize: 1n, lastPrice: 960n, listingPrice: 960n },
    { symbol: 'BRKT', name: 'Bracket Robotics', tickSize: 1n, lastPrice: 4_250n, listingPrice: 4_250n },
  ];
});

describe('App', () => {
  it('shows connection progress and errors', () => {
    spacetimeMock.useSpacetimeDB.mockReturnValue({ isActive: false });
    const { unmount } = render(<App />);
    expect(screen.getByText(/Connecting to the exchange/)).toBeInTheDocument();
    unmount();

    connected({ connectionError: new Error('refused') });
    render(<App />);
    expect(screen.getByText(/Can't reach the exchange: refused/)).toBeInTheDocument();
  });

  it('asks a new player to register', () => {
    connected();
    render(<App />);
    expect(screen.getByRole('button', { name: 'Start trading' })).toBeInTheDocument();
  });

  it('waits for the account subscription before deciding the player is new', () => {
    connected();
    tableReady.value = false;
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Start trading' })).not.toBeInTheDocument();
    tableReady.value = true;
  });

  it('opens on the first symbol alphabetically and switches pages from the nav', async () => {
    connected();
    tableRows.myAccount = [account];
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole('heading', { name: /BRKT/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /PXL/ }));
    expect(screen.getByRole('heading', { name: /PXL/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Portfolio' }));
    expect(screen.getByRole('heading', { name: 'Holdings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Portfolio' })).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: 'Leaderboard' }));
    expect(screen.getByRole('heading', { name: 'Leaderboard' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hall of Fame' }));
    expect(screen.getByText(/No season has finished yet/)).toBeInTheDocument();
  });
});
