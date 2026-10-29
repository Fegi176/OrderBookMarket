import { useEffect, useRef, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';

function fmtRemaining(micros: bigint): string {
  const total = micros > 0n ? Number(micros / 1_000_000n) : 0;
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * "Season N · ends in …" for the current room, plus a one-off notice when a new season
 * starts while the page is open (balances have just been reset under the player).
 * Render it with `key={roomId}` so switching rooms doesn't look like a new season.
 */
export default function SeasonBanner({ roomId }: { roomId: bigint }) {
  const [seasons] = useTable(tables.season.where(r => r.roomId.eq(roomId)));
  const active = seasons.find(s => s.status === 'active');
  const [now, setNow] = useState(() => BigInt(Date.now()) * 1000n);
  const seen = useRef<number | null>(null);
  const [started, setStarted] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(BigInt(Date.now()) * 1000n), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!active) return;
    if (seen.current !== null && active.number > seen.current) setStarted(active.number);
    seen.current = active.number;
  }, [active?.number]);

  if (!active) return null;
  const remaining = active.endsAt.microsSinceUnixEpoch - now;

  return (
    <>
      <div className="season" title={`Ends ${new Date(Number(active.endsAt.microsSinceUnixEpoch / 1000n)).toLocaleString()}`}>
        <span className="muted">Season</span> {active.number}
        <span className="muted"> · {remaining > 0n ? `ends in ${fmtRemaining(remaining)}` : 'ending…'}</span>
      </div>
      {started !== null && (
        <div className="notice" role="status">
          <span>
            <strong>Season {started} has started.</strong> Everyone is back to $100,000 and 100 shares
            of each company. Last season's results are in the Hall of Fame.
          </span>
          <button type="button" className="link" onClick={() => setStarted(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
