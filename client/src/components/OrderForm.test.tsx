import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { reducerSpies, resetSpacetimeMock, spacetimeMock } from '../test/spacetime';
import OrderForm from './OrderForm';

vi.mock('spacetimedb/react', () => spacetimeMock);

const props = { roomId: 1n, symbol: 'BRKT', tickSize: 1n, lastPrice: 4_250n, cash: 10_000_000n, shares: 100n };

function setup(overrides: Partial<typeof props> = {}) {
  const user = userEvent.setup();
  render(<OrderForm {...props} {...overrides} />);
  return user;
}

const priceInput = () => screen.getByLabelText(/price/i);
const sharesInput = () => screen.getByLabelText(/shares/i);
const submit = () => screen.getByRole('button', { name: /^(buy|sell) brkt/i });

beforeEach(resetSpacetimeMock);

describe('OrderForm', () => {
  it('sends a limit buy in integer cents and confirms', async () => {
    const user = setup();
    await user.type(priceInput(), '42.50');
    await user.clear(sharesInput());
    await user.type(sharesInput(), '10');
    // Cost plus the worst-case 0.10% fee: $425.00 + $0.43.
    expect(screen.getByText(/up to \$425\.43 incl\. fee/i)).toBeInTheDocument();

    await user.click(submit());
    expect(reducerSpies.placeLimitOrder).toHaveBeenCalledWith({
      roomId: 1n,
      symbol: 'BRKT',
      side: 'buy',
      price: 4_250n,
      qty: 10n,
    });
    expect(await screen.findByText('Buy order sent')).toBeInTheDocument();
  });

  it('sends a market sell without a price', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Sell' }));
    await user.click(screen.getByRole('button', { name: 'Market' }));
    expect(screen.queryByLabelText(/price/i)).not.toBeInTheDocument();
    expect(screen.getByText(/BRKT available 100/)).toBeInTheDocument();

    await user.click(submit());
    expect(reducerSpies.placeMarketOrder).toHaveBeenCalledWith({ roomId: 1n, symbol: 'BRKT', side: 'sell', qty: 10n });
  });

  it('sends a stop with its trigger price and explains when it fires', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText(/at or above this\. Last 42\.50/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/stop price/i), '45');

    await user.click(screen.getByRole('button', { name: /buy brkt on stop/i }));
    expect(reducerSpies.placeStopOrder).toHaveBeenCalledWith({
      roomId: 1n,
      symbol: 'BRKT',
      side: 'buy',
      stopPrice: 4_500n,
      qty: 10n,
    });
    expect(await screen.findByText('Buy stop sent')).toBeInTheDocument();
  });

  it('blocks prices that are off the tick grid or malformed', async () => {
    const user = setup({ tickSize: 5n });
    await user.type(priceInput(), '42.51');
    expect(submit()).toBeDisabled();
    await user.clear(priceInput());
    await user.type(priceInput(), '42.55');
    expect(submit()).toBeEnabled();
    await user.clear(priceInput());
    await user.type(priceInput(), '4x');
    expect(submit()).toBeDisabled();
  });

  it('blocks a zero or fractional share count', async () => {
    const user = setup();
    await user.type(priceInput(), '40');
    await user.clear(sharesInput());
    await user.type(sharesInput(), '0');
    expect(submit()).toBeDisabled();
    await user.clear(sharesInput());
    await user.type(sharesInput(), '1.5');
    expect(submit()).toBeDisabled();
  });

  it("shows the server's rejection message", async () => {
    const user = setup();
    // The reducer spy is created on first render; make it reject before submitting.
    reducerSpies.placeLimitOrder.mockRejectedValueOnce(new Error('Insufficient cash'));
    await user.type(priceInput(), '42.50');
    await user.click(submit());
    expect(await screen.findByText('Insufficient cash')).toBeInTheDocument();
  });
});
