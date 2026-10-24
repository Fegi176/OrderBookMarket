import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from './module_bindings';
import App from './App';
import './styles.css';

const URI = import.meta.env.VITE_STDB_URI ?? 'ws://localhost:3000';
const DB_NAME = import.meta.env.VITE_STDB_DB ?? 'order-book';
const TOKEN_KEY = `${URI}/${DB_NAME}/auth_token`;

function readToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private mode: the player just gets a fresh identity next visit.
  }
}

const connectionBuilder = DbConnection.builder()
  .withUri(URI)
  .withDatabaseName(DB_NAME)
  .withToken(readToken())
  .withAutomaticReconnect()
  .onConnect((_conn, _identity, token) => saveToken(token))
  .onAutomaticReconnect((_conn, _identity, token) => saveToken(token))
  .onConnectError((_ctx, err) => console.error('SpacetimeDB connection failed', err));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </StrictMode>
);
