import { useState } from 'react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../module_bindings';

export default function Register() {
  const register = useReducer(reducers.register);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({ name });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="panel register" onSubmit={submit}>
        <h1>Order Book Market</h1>
        <p className="muted">
          Everyone starts with $100,000 and 100 shares of every company. Pick a trader name.
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
      </form>
    </div>
  );
}
