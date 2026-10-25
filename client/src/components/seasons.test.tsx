import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Identity, Timestamp } from 'spacetimedb';
import { reducerSpies, resetSpacetimeMock, spacetimeMock, tableReady, tableRows } from '../test/spacetime';
import SeasonBanner from './SeasonBanner';
import HallOfFame from './HallOfFame';
import Register from './Register';

vi.mock('spacetimedb/react', () => spacetimeMock);

const ME = new Identity(1n);
const NOW_MS = 1_800_000_000_000;
const at = (ms: number) => new Timestamp(BigInt(ms) * 1000n);
const season = (number: number, endsInMs: number, status = 'active') => ({
  number,
  startsAt: at(NOW_MS - 1000),
  endsAt: at(NOW_MS + endsInMs),
  status,
});

beforeEach(resetSpacetimeMock);

describe('SeasonBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => vi.useRealTimers());

  it('counts down in days, hours, or minutes and seconds', () => {
    tableRows.season = [season(3, (2 * 86_400 + 4 * 3_600) * 1000)];
    const { unmount } = render(<SeasonBanner />);
    expect(screen.getByText(/ends in 2d 4h/)).toBeInTheDocument();
    unmount();

    tableRows.season = [season(3, 65_000)];
    render(<SeasonBanner />);
    expect(screen.getByText(/ends in 1:05/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByText(/ends in 0:59/)).toBeInTheDocument();
  });

  it('announces a new season when the active number goes up', () => {
    tableRows.season = [season(1, 60_000)];
    const { rerender } = render(<SeasonBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    tableRows.season = [season(1, 0, 'ended'), season(2, 7 * 86_400_000)];
    rerender(<SeasonBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('Season 2 has started');
  });

  it('does not announce the season already running when the page opens', () => {
    tableRows.season = [season(5, 60_000)];
    render(<SeasonBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('HallOfFame', () => {
  const result = (seasonNumber: number, rank: number, name: string, id: bigint, netWorth: bigint) => ({
    id: BigInt(seasonNumber * 100 + rank),
    seasonNumber,
    rank,
    identity: new Identity(id),
    name,
    netWorth,
    startingNetWorth: 13_000_000n,
  });

  it('lists finished seasons newest first with the winner marked', () => {
    tableRows.seasonResult = [
      result(1, 1, 'Bob', 2n, 14_000_000n),
      result(2, 2, 'Ada', 1n, 12_000_000n),
      result(2, 1, 'Cy', 3n, 15_000_000n),
    ];
    render(<HallOfFame me={ME} />);
    const headings = screen.getAllByRole('heading').map(h => h.textContent);
    expect(headings[0]).toMatch(/^Season 2/);
    expect(headings[1]).toMatch(/^Season 1/);
    expect(screen.getAllByText(/🏆/).map(el => el.textContent)).toEqual(['🏆 Cy', '🏆 Bob']);
  });

  it("tells a player outside the top 10 where they finished", () => {
    tableRows.seasonResult = Array.from({ length: 12 }, (_, i) =>
      result(1, i + 1, i === 11 ? 'Ada' : `P${i}`, i === 11 ? 1n : BigInt(10 + i), BigInt(20_000_000 - i))
    );
    render(<HallOfFame me={ME} />);
    expect(screen.getByText(/You finished #12 of 12/)).toBeInTheDocument();
  });

  it('explains the empty state', () => {
    render(<HallOfFame me={ME} />);
    expect(screen.getByText(/No season has finished yet/)).toBeInTheDocument();
  });
});

describe('Register', () => {
  it('sends the name and shows a server rejection', async () => {
    const user = userEvent.setup();
    render(<Register />);
    const button = screen.getByRole('button', { name: 'Start trading' });
    expect(button).toBeDisabled();

    reducerSpies.register.mockRejectedValueOnce(new Error('Already registered'));
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.click(button);
    expect(reducerSpies.register).toHaveBeenCalledWith({ name: 'Ada' });
    expect(await screen.findByText('Already registered')).toBeInTheDocument();
  });
});

// Keep the shared readiness flag honest for files that run after this one.
afterEach(() => {
  tableReady.value = true;
});
