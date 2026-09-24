import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { migrate } from './sql';

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export interface Db {
  sqlite: Database.Database;
  db: DrizzleDb;
  close(): void;
}

/** Opens (or creates) the SQLite file, applies pragmas and the idempotent schema + column upgrades. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  migrate(sqlite);
  const db = drizzle({ client: sqlite, schema });
  return { sqlite, db, close: () => sqlite.close() };
}
