// Test doubles for spacetimedb/react, so components render without a server.
// Each test file does: vi.mock('spacetimedb/react', () => spacetimeMock);

import { vi } from 'vitest';
import { getQueryAccessorName } from 'spacetimedb';

/** Rows `useTable` returns, keyed by the table accessor the component queried. */
export const tableRows: Record<string, unknown[]> = {};
/** Whether `useTable` reports its subscription as applied. */
export const tableReady = { value: true };
/** One spy per reducer accessor, created on first use. */
export const reducerSpies: Record<string, ReturnType<typeof vi.fn>> = {};

export const spacetimeMock = {
  // Works for a plain table ref and a filtered query alike. The filter itself isn't
  // applied: tests put exactly the rows the component should see in tableRows.
  useTable: vi.fn((query: any) => [tableRows[getQueryAccessorName(query)] ?? [], tableReady.value]),
  useReducer: vi.fn((def: { accessorName: string }) => {
    reducerSpies[def.accessorName] ??= vi.fn().mockResolvedValue(undefined);
    return reducerSpies[def.accessorName];
  }),
  useSpacetimeDB: vi.fn(),
};

export function resetSpacetimeMock() {
  for (const k of Object.keys(tableRows)) delete tableRows[k];
  for (const k of Object.keys(reducerSpies)) delete reducerSpies[k];
  tableReady.value = true;
}
