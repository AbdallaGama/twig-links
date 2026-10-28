import { randomToken } from './util/crypto.ts';

/**
 * The subset of Cloudflare D1's API that Twig uses. In production this is the D1 binding;
 * on Node (local dev, tests) it is provided by sqlite-d1.ts on top of node:sqlite.
 * Schema: migrations/*.sql (applied by `wrangler d1 migrations apply`, or by the Node adapter).
 */
export type SqlValue = string | number | null;

export interface D1Statement {
  bind(...values: SqlValue[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number; last_row_id: number } }>;
}

export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

export type Row = Record<string, unknown>;
export type Param = SqlValue | boolean | undefined;

function normalize(values: Param[]): SqlValue[] {
  return values.map((value) => (value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value));
}

export class Db {
  readonly d1: D1Like;

  constructor(d1: D1Like) {
    this.d1 = d1;
  }

  statement(sql: string, ...params: Param[]): D1Statement {
    return this.d1.prepare(sql).bind(...normalize(params));
  }

  async get<T = Row>(sql: string, ...params: Param[]): Promise<T | undefined> {
    return (await this.statement(sql, ...params).first<T>()) ?? undefined;
  }

  async all<T = Row>(sql: string, ...params: Param[]): Promise<T[]> {
    return (await this.statement(sql, ...params).all<T>()).results;
  }

  async run(sql: string, ...params: Param[]): Promise<{ changes: number; lastInsertRowid: number }> {
    const result = await this.statement(sql, ...params).run();
    return { changes: result.meta.changes, lastInsertRowid: result.meta.last_row_id };
  }

  /** Executes statements atomically (D1 batches are transactions). */
  async batch(statements: D1Statement[]): Promise<void> {
    if (statements.length) await this.d1.batch(statements);
  }

  /** Server-wide secret used to HMAC IP addresses; generated once and kept in the database. */
  async serverSecret(): Promise<string> {
    await this.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', 'server_secret', randomToken(32));
    return (await this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', 'server_secret'))!.value;
  }
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
