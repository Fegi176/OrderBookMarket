import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import { cmpBig, fmtTime } from '../format';

const SHOWN = 12;

/** Market-wide headlines, newest first. Clicking one jumps to that company. */
export default function NewsFeed({ onSelect }: { onSelect: (symbol: string) => void }) {
  const [items, ready] = useTable(tables.news);
  const recent = useMemo(
    () => [...items].sort((a, b) => cmpBig(b.id, a.id)).slice(0, SHOWN),
    [items]
  );

  if (!recent.length) {
    return <p className="muted small">{ready ? 'No news yet. Stay tuned.' : 'Loading news…'}</p>;
  }

  return (
    <ul className="news">
      {recent.map(n => (
        <li key={n.id.toString()}>
          <button type="button" className="news-item" onClick={() => onSelect(n.symbol)}>
            <span className="muted small">{fmtTime(n.timestamp.microsSinceUnixEpoch)}</span>
            <span className={n.impactBps >= 0 ? 'news-sym up' : 'news-sym down'}>
              {n.impactBps >= 0 ? '▲' : '▼'} {n.symbol}
            </span>
            <span className="headline">{n.headline}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
