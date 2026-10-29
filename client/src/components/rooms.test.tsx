import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Timestamp } from 'spacetimedb';
import { reducerSpies, resetSpacetimeMock, spacetimeMock, tableRows } from '../test/spacetime';
import Register from './Register';
import Rooms from './Rooms';

vi.mock('spacetimedb/react', () => spacetimeMock);

const ts = new Timestamp(1_800_000_000_000_000n);
const memberRoom = (id: bigint, name: string, code: string, isPublic: boolean, isOwner = false) => ({
  id,
  name,
  code,
  isPublic,
  isOwner,
});
const lobbyRoom = (id: bigint, name: string, players: number) => ({ id, name, players, createdAt: ts });

const section = (heading: string) => screen.getByRole('heading', { name: heading }).closest('section')!;

beforeEach(resetSpacetimeMock);

describe('Register (joining the current room)', () => {
  it('joins the room by id with the chosen name and shows a server rejection', async () => {
    const user = userEvent.setup();
    const onBrowseRooms = vi.fn();
    render(<Register roomId={1n} roomName="Main" onBrowseRooms={onBrowseRooms} />);
    expect(screen.getByText('Main')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Start trading' });
    expect(button).toBeDisabled();

    reducerSpies.joinRoom.mockRejectedValueOnce(new Error('Already in this room'));
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.click(button);
    expect(reducerSpies.joinRoom).toHaveBeenCalledWith({ roomId: 1n, code: '', name: 'Ada' });
    expect(await screen.findByText('Already in this room')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /invite code/i }));
    expect(onBrowseRooms).toHaveBeenCalled();
  });

  it('prefills the name used in another room', () => {
    render(<Register roomId={2n} roomName="Club" defaultName="Ada" onBrowseRooms={vi.fn()} />);
    expect(screen.getByLabelText('Name')).toHaveValue('Ada');
  });
});

describe('Rooms', () => {
  function renderRooms(onSwitch = vi.fn()) {
    const utils = render(<Rooms currentRoomId={1n} defaultName="Ada" onSwitch={onSwitch} />);
    return { ...utils, onSwitch };
  }

  it("lists your rooms with invite codes and opens another one", async () => {
    tableRows.myRooms = [memberRoom(1n, 'Main', 'MAIN23', true), memberRoom(4n, 'Friday Club', 'K7QX2P', false, true)];
    const user = userEvent.setup();
    const { onSwitch } = renderRooms();
    const yours = section('Your rooms');
    expect(within(yours).getByText('K7QX2P')).toBeInTheDocument();
    expect(within(yours).getByText('(yours)')).toBeInTheDocument();
    expect(within(yours).getByText('Current')).toBeInTheDocument();
    await user.click(within(yours).getByRole('button', { name: 'Open' }));
    expect(onSwitch).toHaveBeenCalledWith(4n);
  });

  it('lists only public rooms you have not joined, busiest first, and joins one', async () => {
    tableRows.myRooms = [memberRoom(1n, 'Main', 'MAIN23', true)];
    tableRows.publicRooms = [lobbyRoom(1n, 'Main', 9), lobbyRoom(2n, 'Quiet', 1), lobbyRoom(3n, 'Busy', 5)];
    const user = userEvent.setup();
    renderRooms();
    const rows = within(section('Public rooms')).getAllByRole('row').slice(1);
    expect(rows.map(r => r.textContent)).toEqual(['Busy5Join', 'Quiet1Join']);
    await user.click(within(rows[0]).getByRole('button', { name: 'Join' }));
    expect(reducerSpies.joinRoom).toHaveBeenCalledWith({ roomId: 3n, code: '', name: 'Ada' });
  });

  it('joins by code, case-insensitively, and switches once the membership arrives', async () => {
    const user = userEvent.setup();
    const { rerender, onSwitch } = renderRooms();
    const join = within(section('Join with an invite code'));
    expect(join.getByRole('button', { name: 'Join' })).toBeDisabled();
    await user.type(join.getByLabelText('Invite code'), 'k7qx2p');
    await user.click(join.getByRole('button', { name: 'Join' }));
    expect(reducerSpies.joinRoom).toHaveBeenCalledWith({ roomId: 0n, code: 'K7QX2P', name: 'Ada' });
    expect(onSwitch).not.toHaveBeenCalled();

    // The server's my_rooms update arrives a moment later.
    tableRows.myRooms = [memberRoom(4n, 'Friday Club', 'K7QX2P', false)];
    rerender(<Rooms currentRoomId={1n} defaultName="Ada" onSwitch={onSwitch} />);
    expect(onSwitch).toHaveBeenCalledWith(4n);
  });

  it('creates a private room by default and switches to it', async () => {
    const user = userEvent.setup();
    const { rerender, onSwitch } = renderRooms();
    const create = within(section('Create a room'));
    await user.type(create.getByLabelText('Room name'), 'Friday Club');
    expect(create.getByText(/Friends join with the invite code/)).toBeInTheDocument();
    await user.click(create.getByRole('button', { name: 'Create room' }));
    expect(reducerSpies.createRoom).toHaveBeenCalledWith({ name: 'Friday Club', isPublic: false, playerName: 'Ada' });

    tableRows.myRooms = [memberRoom(7n, 'Friday Club', 'ZZ23AB', false, true)];
    rerender(<Rooms currentRoomId={1n} defaultName="Ada" onSwitch={onSwitch} />);
    expect(onSwitch).toHaveBeenCalledWith(7n);
  });

  it('can create a public room and reports a server rejection', async () => {
    const user = userEvent.setup();
    renderRooms();
    const create = within(section('Create a room'));
    await user.type(create.getByLabelText('Room name'), 'Open Floor');
    await user.click(create.getByRole('button', { name: 'Public' }));
    expect(create.getByText(/Listed in Public rooms/)).toBeInTheDocument();
    reducerSpies.createRoom.mockRejectedValueOnce(new Error('You can create at most 3 rooms'));
    await user.click(create.getByRole('button', { name: 'Create room' }));
    expect(reducerSpies.createRoom).toHaveBeenCalledWith({ name: 'Open Floor', isPublic: true, playerName: 'Ada' });
    expect(await screen.findByText('You can create at most 3 rooms')).toBeInTheDocument();
  });

  it('needs a trader name before joining or creating', async () => {
    const user = userEvent.setup();
    tableRows.publicRooms = [lobbyRoom(2n, 'Quiet', 1)];
    renderRooms();
    await user.clear(screen.getByLabelText('Name for new rooms'));
    expect(within(section('Public rooms')).getByRole('button', { name: 'Join' })).toBeDisabled();
    await user.type(within(section('Create a room')).getByLabelText('Room name'), 'X');
    expect(screen.getByRole('button', { name: 'Create room' })).toBeDisabled();
  });
});
