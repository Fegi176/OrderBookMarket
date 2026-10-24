import { useMemo } from 'react';
import type { Identity } from 'spacetimedb';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { cmpBig, fmtCents, fmtReturn } from '../format';

/** Players ranked by net worth at last trade prices. Computed server-side; bots excluded. */
export default function Leaderboard({ me }: { me: Identity }) {
  const [rows, ready] = useTable(tables.leaderboard);
  const ranked = useMemo(() => [...rows].sort((a, b) => cmpBig(b.netWorth, a.netWorth)), [rows]);

  if (!ranked.length) {
    return <p className="muted small">{ready ? 'No players yet.' : 'Loading leaderboard…'}</p>;
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th className="num">#</th>
          <th>Player</th>
          <th className="num">Net worth</th>
          <th className="num">Return</th>
        </tr>
      </thead>
      <tbody>
        {ranked.map((r, i) => {
          const mine = r.identity.isEqual(me);
          const up = r.netWorth >= r.startingNetWorth;
          return (
            <tr key={r.identity.toHexString()} className={mine ? 'me' : undefined}>
              <td className="num muted">{i + 1}</td>
              <td>
                {r.name}
                {mine && <span className="accent small"> (you)</span>}
              </td>
              <td className="num">{fmtCents(r.netWorth)}</td>
              <td className={`num ${up ? 'up' : 'down'}`}>{fmtReturn(r.startingNetWorth, r.netWorth)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
