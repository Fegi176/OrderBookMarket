import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Identity } from 'spacetimedb';
import { resetSpacetimeMock, spacetimeMock, tableReady, tableRows } from '../test/spacetime';
import Leaderboard from './Leaderboard';

vi.mock('spacetimedb/react', () => spacetimeMock);

const ME = new Identity(1n);
const entry = (id: bigint, name: string, netWorth: bigint, startingNetWorth = 13_000_000n) => ({
  identity: new Identity(id),
  name,
  netWorth,
  startingNetWorth,
});

beforeEach(resetSpacetimeMock);

describe('Leaderboard', () => {
  it('ranks players by net worth whatever order rows arrive in', () => {
    tableRows.leaderboard = [
      entry(2n, 'Bob', 12_000_000n),
      entry(1n, 'Ada', 13_650_000n),
      entry(3n, 'Cy', 13_000_000n),
    ];
    render(<Leaderboard roomId={1n} me={ME} />);
    const rows = screen.getAllByRole('row').slice(1); // skip the header
    expect(rows.map(r => r.textContent)).toEqual([
      '1Ada (you)$136,500.00+5.00%',
      '2Cy$130,000.000.00%',
      '3Bob$120,000.00-7.69%',
    ]);
  });

  it("highlights the viewer's row and colours returns", () => {
    tableRows.leaderboard = [entry(1n, 'Ada', 13_650_000n), entry(2n, 'Bob', 12_000_000n)];
    render(<Leaderboard roomId={1n} me={ME} />);
    const [, ada, bob] = screen.getAllByRole('row');
    expect(ada).toHaveClass('me');
    expect(bob).not.toHaveClass('me');
    expect(screen.getByText('+5.00%')).toHaveClass('up');
    expect(screen.getByText('-7.69%')).toHaveClass('down');
  });

  it('distinguishes loading from an empty board', () => {
    tableReady.value = false;
    const { unmount } = render(<Leaderboard roomId={1n} me={ME} />);
    expect(screen.getByText('Loading leaderboard…')).toBeInTheDocument();
    unmount();
    tableReady.value = true;
    render(<Leaderboard roomId={1n} me={ME} />);
    expect(screen.getByText('No players yet.')).toBeInTheDocument();
  });
});
