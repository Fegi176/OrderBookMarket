import { useEffect, useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../module_bindings';

type Props = {
  currentRoomId: bigint | null;
  /** Name used in another room, offered as the default when joining or creating. */
  defaultName: string;
  onSwitch: (roomId: bigint) => void;
};

/** Which room to switch to once a join or create shows up in my_rooms. */
type Pending = { code: string } | { id: bigint } | { name: string } | null;

/**
 * The room directory: your rooms (with invite codes), joining by code, the public
 * lobby, and creating a room. Each room is its own market with its own balances.
 */
export default function Rooms({ currentRoomId, defaultName, onSwitch }: Props) {
  const [mine] = useTable(tables.myRooms);
  const [lobby, lobbyReady] = useTable(tables.publicRooms);
  const join = useReducer(reducers.joinRoom);
  const create = useReducer(reducers.createRoom);

  const [playerName, setPlayerName] = useState(defaultName);
  const [code, setCode] = useState('');
  const [roomName, setRoomName] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Reducers don't return values, so wait for the new membership to arrive, then switch.
  useEffect(() => {
    if (!pending) return;
    const room = mine.find(r =>
      'code' in pending ? r.code === pending.code : 'id' in pending ? r.id === pending.id : r.isOwner && r.name === pending.name
    );
    if (room) {
      setPending(null);
      onSwitch(room.id);
    }
  }, [mine, pending, onSwitch]);

  const memberOf = new Set(mine.map(r => r.id));
  const others = [...lobby].filter(r => !memberOf.has(r.id)).sort((a, b) => b.players - a.players);
  const nameOk = playerName.trim().length > 0;

  async function run(action: () => Promise<void>, then: Pending) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setPending(then);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
    } catch {
      // Clipboard can be blocked; the code is on screen to copy by hand.
    }
  }

  const normalizedCode = code.trim().toUpperCase();

  return (
    <div className="rooms">
      <div className="rooms-col">
        <section className="panel">
          <h2>Your rooms</h2>
          {mine.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Access</th>
                  <th>Invite code</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...mine]
                  .sort((a, b) => (a.id < b.id ? -1 : 1))
                  .map(r => (
                    <tr key={r.id.toString()} className={r.id === currentRoomId ? 'me' : undefined}>
                      <td>
                        {r.name}
                        {r.isOwner && <span className="muted small"> (yours)</span>}
                      </td>
                      <td className="muted">{r.isPublic ? 'Public' : 'Private'}</td>
                      <td>
                        <code className="code">{r.code}</code>{' '}
                        <button type="button" className="link small" onClick={() => copy(r.code)}>
                          {copied === r.code ? 'Copied' : 'Copy'}
                        </button>
                      </td>
                      <td className="num">
                        {r.id === currentRoomId ? (
                          <span className="muted small">Current</span>
                        ) : (
                          <button type="button" className="link" onClick={() => onSwitch(r.id)}>
                            Open
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">You haven't joined a room yet.</p>
          )}
        </section>

        <section className="panel">
          <h2>Public rooms</h2>
          {others.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Room</th>
                  <th className="num">Players</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {others.map(r => (
                  <tr key={r.id.toString()}>
                    <td>{r.name}</td>
                    <td className="num">{r.players}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="link"
                        disabled={busy || !nameOk}
                        onClick={() => run(() => join({ roomId: r.id, code: '', name: playerName }), { id: r.id })}
                      >
                        Join
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">{lobbyReady ? "You're in every public room." : 'Loading rooms…'}</p>
          )}
        </section>
      </div>
      <div className="rooms-col">
        <section className="panel">
          <h2>Your trader name</h2>
          <label>
            Name for new rooms
            <input value={playerName} onChange={e => setPlayerName(e.target.value)} maxLength={24} />
          </label>
          {error && <p className="error small">{error}</p>}
        </section>

        <section className="panel">
          <h2>Join with an invite code</h2>
          <form
            className="inline-form"
            onSubmit={e => {
              e.preventDefault();
              run(() => join({ roomId: 0n, code: normalizedCode, name: playerName }), { code: normalizedCode });
            }}
          >
            <input
              aria-label="Invite code"
              placeholder="ABC234"
              value={code}
              onChange={e => setCode(e.target.value)}
              maxLength={6}
            />
            <button type="submit" className="primary" disabled={busy || !nameOk || normalizedCode.length !== 6}>
              Join
            </button>
          </form>
        </section>

        <section className="panel">
          <h2>Create a room</h2>
          <form
            onSubmit={e => {
              e.preventDefault();
              const name = roomName.trim();
              run(() => create({ name, isPublic, playerName }), { name });
            }}
          >
            <label>
              Room name
              <input value={roomName} onChange={e => setRoomName(e.target.value)} maxLength={32} />
            </label>
            <div className="toggle" role="group" aria-label="Access">
              <button type="button" className={!isPublic ? 'on' : ''} onClick={() => setIsPublic(false)}>
                Private
              </button>
              <button type="button" className={isPublic ? 'on' : ''} onClick={() => setIsPublic(true)}>
                Public
              </button>
            </div>
            <p className="muted small">
              {isPublic
                ? 'Listed in Public rooms for anyone to join.'
                : 'Unlisted. Friends join with the invite code shown under Your rooms.'}{' '}
              The room gets its own market, bots, news and weekly seasons.
            </p>
            <button type="submit" className="primary" disabled={busy || !nameOk || !roomName.trim()}>
              Create room
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
