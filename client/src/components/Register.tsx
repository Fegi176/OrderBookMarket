import { useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';

type Props = {
  roomId: bigint;
  roomName: string;
  /** Name used in another room, offered as the default. */
  defaultName?: string;
  onBrowseRooms: () => void;
};

/** Joins the current (public) room with a trader name. */
export default function Register({ roomId, roomName, defaultName = '', onBrowseRooms }: Props) {
  const join = useReducer(reducers.joinRoom);
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await join({ roomId, code: '', name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="join-screen">
      <form className="panel register" onSubmit={submit}>
        <h1>Order Book Market</h1>
        <p className="muted">
          You're joining the <strong>{roomName}</strong> room. Everyone starts with $100,000 and
          100 shares of every company. Pick a trader name.
        </p>
        <label>
          Name
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={24}
            autoFocus
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy || !name.trim()}>
          Start trading
        </button>
        <p className="small center-text">
          <button type="button" className="link" onClick={onBrowseRooms}>
            Create a room or join with an invite code
          </button>
        </p>
      </form>
    </div>
  );
}
