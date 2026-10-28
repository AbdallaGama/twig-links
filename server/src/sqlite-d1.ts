import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Like, D1Statement, SqlValue } from './db.ts';

/** D1-compatible adapter over node:sqlite for local development and tests (Node only). */
class Statement implements D1Statement {
  readonly db: DatabaseSync;
  readonly sql: string;
  readonly values: SqlValue[];

  constructor(db: DatabaseSync, sql: string, values: SqlValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: SqlValue[]): D1Statement {
    return new Statement(this.db, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.values as SQLInputValue[])) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.values as SQLInputValue[])) as T[] };
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
    const result = this.db.prepare(this.sql).run(...(this.values as SQLInputValue[]));
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }

  runSync(): void {
    this.db.prepare(this.sql).run(...(this.values as SQLInputValue[]));
  }
}

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', 'migrations');

/** Opens (and migrates) a SQLite file or ":memory:" behind the D1 interface. */
export function openSqliteD1(path: string, migrationsDir = MIGRATIONS_DIR): D1Like {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // Same bookkeeping table as wrangler, so a database file can move between the two.
  db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  // Databases created by Twig 0.1's built-in migrator already contain the initial schema.
  const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (legacy) db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_init.sql')").run();
  const applied = new Set((db.prepare('SELECT name FROM d1_migrations').all() as Array<{ name: string }>).map((row) => row.name));
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const statement of statements) (statement as Statement).runSync();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return [];
    },
  };
}
