import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Identity, Timestamp } from 'spacetimedb';
import { resetSpacetimeMock, spacetimeMock, tableReady, tableRows } from './test/spacetime';
import App from './App';

vi.mock('spacetimedb/react', () => spacetimeMock);

const ME = new Identity(1n);
const ts = new Timestamp(1_800_000_000_000_000n);
const MAIN = 1n;
const CLUB = 4n;

function connected(extra: object = {}) {
  spacetimeMock.useSpacetimeDB.mockReturnValue({ isActive: true, identity: ME, ...extra });
}

const account = (roomId: bigint, name = 'Ada') => ({
  id: roomId * 10n,
  roomId,
  identity: ME,
  name,
  cashAvailable: 10_000_000n,
  cashReserved: 0n,
  createdAt: ts,
  isBot: false,
  startingNetWorth: 13_000_000n,
});
const memberRoom = (id: bigint, name: string, code: string, isPublic: boolean) => ({
  id,
  name,
  code,
  isPublic,
  isOwner: false,
});

beforeEach(() => {
  resetSpacetimeMock();
  localStorage.clear();
  tableRows.publicRooms = [{ id: MAIN, name: 'Main', players: 3, createdAt: ts }];
  // The mock doesn't apply the room filter, so these stand for the current room's companies.
  tableRows.instrument = [
    { id: 1n, roomId: MAIN, symbol: 'PXL', name: 'Pixel Pictures', tickSize: 1n, lastPrice: 960n, listingPrice: 960n },
    { id: 2n, roomId: MAIN, symbol: 'BRKT', name: 'Bracket Robotics', tickSize: 1n, lastPrice: 4_250n, listingPrice: 4_250n },
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

  it('lands a first-time visitor on the Main room join screen', () => {
    connected();
    render(<App />);
    expect(screen.getByText(/You're joining the/)).toHaveTextContent('Main');
    expect(screen.getByRole('button', { name: 'Start trading' })).toBeInTheDocument();
    // Only pages that work without an account are offered.
    expect(screen.queryByRole('button', { name: 'Portfolio' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rooms' })).toBeInTheDocument();
  });

  it('waits for its subscriptions before deciding the player is new', () => {
    connected();
    tableReady.value = false;
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Start trading' })).not.toBeInTheDocument();
    tableReady.value = true;
  });

  it('opens on the first symbol alphabetically and switches pages from the nav', async () => {
    connected();
    tableRows.myAccounts = [account(MAIN)];
    tableRows.myRooms = [memberRoom(MAIN, 'Main', 'MAIN23', true)];
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole('heading', { name: /BRKT/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /PXL/ }));
    expect(screen.getByRole('heading', { name: /PXL/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Portfolio' }));
    expect(screen.getByRole('heading', { name: 'Holdings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Portfolio' })).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: 'Leaderboard' }));
    expect(screen.getByRole('heading', { name: 'Leaderboard · Main' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hall of Fame' }));
    expect(screen.getByText(/No season has finished yet/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rooms' }));
    expect(screen.getByRole('heading', { name: 'Your rooms' })).toBeInTheDocument();
  });

  it('shows the invite code of a private room and remembers the room across reloads', async () => {
    connected();
    tableRows.myAccounts = [account(MAIN), account(CLUB)];
    tableRows.myRooms = [memberRoom(MAIN, 'Main', 'MAIN23', true), memberRoom(CLUB, 'Friday Club', 'K7QX2P', false)];
    const user = userEvent.setup();
    const { unmount } = render(<App />);

    expect(screen.queryByText('K7QX2P')).not.toBeInTheDocument(); // Main is public: no code shown
    await user.selectOptions(screen.getByLabelText('Current room'), CLUB.toString());
    expect(screen.getByText('K7QX2P')).toBeInTheDocument();
    expect(localStorage.getItem('order-book/room')).toBe('4');

    unmount();
    render(<App />);
    expect(screen.getByLabelText('Current room')).toHaveValue('4');
  });

  it('falls back to Main when the remembered room is no longer visible', () => {
    localStorage.setItem('order-book/room', '99');
    connected();
    tableRows.myAccounts = [account(MAIN)];
    tableRows.myRooms = [memberRoom(MAIN, 'Main', 'MAIN23', true)];
    render(<App />);
    expect(screen.getByLabelText('Current room')).toHaveValue('1');
  });

  it("offers the player's name from another room when they open one they haven't joined", () => {
    connected();
    tableRows.myAccounts = [account(CLUB, 'Ada')];
    tableRows.myRooms = [memberRoom(CLUB, 'Friday Club', 'K7QX2P', false)];
    render(<App />); // nothing remembered, so Main, where Ada has no account yet
    expect(screen.getByLabelText('Name')).toHaveValue('Ada');
  });
});
