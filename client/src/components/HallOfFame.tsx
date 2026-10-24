import { useMemo } from 'react';
import type { Identity } from 'spacetimedb';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { cmpBig, fmtCents, fmtReturn } from '../format';

const SHOWN_PER_SEASON = 10;

/** Final standings of every finished season, newest first. */
export default function HallOfFame({ me }: { me: Identity }) {
  const [results, ready] = useTable(tables.seasonResult);
  const [seasons] = useTable(tables.season);

  const bySeason = useMemo(() => {
    const groups = new Map<number, typeof results[number][]>();
    for (const r of results) groups.set(r.seasonNumber, [...(groups.get(r.seasonNumber) ?? []), r]);
    return [...groups.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([number, rows]) => ({ number, rows: [...rows].sort((a, b) => a.rank - b.rank) }));
  }, [results]);

  if (!bySeason.length) {
    return (
      <p className="muted small">
        {ready ? 'No season has finished yet. The first results appear here when the current season ends.' : 'Loading…'}
      </p>
    );
  }

  return (
    <div className="hall">
      {bySeason.map(({ number, rows }) => {
        const season = seasons.find(s => s.number === number);
        const mine = rows.find(r => r.identity.isEqual(me));
        return (
          <section key={number} className="panel">
            <h2>
              Season {number}
              {season && (
                <span className="muted small">
                  {' '}
                  · ended {new Date(Number(season.endsAt.microsSinceUnixEpoch / 1000n)).toLocaleDateString()}
                </span>
              )}
            </h2>
            <table className="table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Player</th>
                  <th className="num">Final net worth</th>
                  <th className="num">Return</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, SHOWN_PER_SEASON).map(r => (
                  <tr key={r.id.toString()} className={r.identity.isEqual(me) ? 'me' : undefined}>
                    <td className="num muted">{r.rank}</td>
                    <td>
                      {r.rank === 1 && '🏆 '}
                      {r.name}
                    </td>
                    <td className="num">{fmtCents(r.netWorth)}</td>
                    <td className={`num ${cmpBig(r.netWorth, r.startingNetWorth) >= 0 ? 'up' : 'down'}`}>
                      {fmtReturn(r.startingNetWorth, r.netWorth)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {mine && mine.rank > SHOWN_PER_SEASON && (
              <p className="muted small">
                You finished #{mine.rank} of {rows.length} with {fmtCents(mine.netWorth)}.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
