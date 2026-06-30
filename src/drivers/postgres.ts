/**
 * PostgreSQL driver (pg).
 */

import { Pool, type PoolClient } from "pg";
import type {
  JoboDriver,
  QueryResult,
  TableRef,
  ColumnInfo,
  TableRowCount,
  DriverConnectionOptions,
} from "./driver";
import { quoteTable } from "../sql/builder";

export class PostgresDriver implements JoboDriver {
  private pool: Pool | undefined;

  constructor(private readonly options: DriverConnectionOptions) {}

  async connect(): Promise<void> {
    this.pool = new Pool({
      host: this.options.host,
      port: this.options.port,
      database: this.options.database,
      user: this.options.user,
      password: this.options.password,
      ssl: this.options.ssl ? { rejectUnauthorized: false } : undefined,
    });
    // Validate connectivity eagerly.
    const client = await this.pool.connect();
    client.release();
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error("PostgresDriver is not connected.");
    }
    return this.pool;
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const pool = this.requirePool();
    const start = Date.now();
    const res = await pool.query({ text: sql, values: params, rowMode: "array" });
    const durationMs = Date.now() - start;
    return {
      columns: (res.fields ?? []).map((f) => ({
        name: f.name,
        type: String(f.dataTypeID),
      })),
      rows: (res.rows as unknown[][]) ?? [],
      rowCount: res.rowCount ?? (res.rows ? res.rows.length : 0),
      durationMs,
    };
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.query(
      "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
    );
    return res.rows.map((r) => String(r[0]));
  }

  async listSchemas(): Promise<string[]> {
    const res = await this.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
         AND schema_name NOT LIKE 'pg_toast%'
         AND schema_name NOT LIKE 'pg_temp%'
       ORDER BY schema_name`
    );
    return res.rows.map((r) => String(r[0]));
  }

  async listTables(schema?: string): Promise<TableRef[]> {
    const res = await this.query(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_type IN ('BASE TABLE', 'VIEW')
         AND ($1::text IS NULL OR table_schema = $1)
         AND table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name`,
      [schema ?? null]
    );
    return res.rows.map((r) => ({ schema: String(r[0]), name: String(r[1]) }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const pks = new Set(await this.getPrimaryKeys(table));
    const res = await this.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = $1 AND ($2::text IS NULL OR table_schema = $2)
       ORDER BY ordinal_position`,
      [table.name, table.schema ?? null]
    );
    return res.rows.map((r) => ({
      name: String(r[0]),
      type: String(r[1]),
      nullable: String(r[2]).toUpperCase() === "YES",
      isPrimaryKey: pks.has(String(r[0])),
      defaultValue: r[3] == null ? undefined : String(r[3]),
    }));
  }

  async getPrimaryKeys(table: TableRef): Promise<string[]> {
    const res = await this.query(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = (
         CASE WHEN $2::text IS NULL THEN quote_ident($1)
              ELSE quote_ident($2) || '.' || quote_ident($1) END
       )::regclass
         AND i.indisprimary`,
      [table.name, table.schema ?? null]
    );
    return res.rows.map((r) => String(r[0]));
  }

  async getTableRowCount(table: TableRef): Promise<TableRowCount> {
    const estRes = await this.query(
      `SELECT c.reltuples::bigint
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = $1
         AND ($2::text IS NULL OR n.nspname = $2)`,
      [table.name, table.schema ?? null]
    );
    const estimate = Number(estRes.rows[0]?.[0]);
    if (Number.isFinite(estimate) && estimate >= 0) {
      return { count: Math.max(0, Math.round(estimate)), exact: false };
    }
    const tableSql = quoteTable(table, this);
    const exactRes = await this.query(`SELECT COUNT(*) FROM ${tableSql}`);
    return { count: toCount(exactRes.rows[0]?.[0]), exact: true };
  }

  async execTransaction(statements: string[]): Promise<void> {
    const pool = this.requirePool();
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const stmt of statements) {
        await client.query(stmt);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  quoteValue(value: unknown): string {
    if (value === null || value === undefined) {
      return "NULL";
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? String(value) : "NULL";
    }
    if (typeof value === "boolean") {
      return value ? "TRUE" : "FALSE";
    }
    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }
}

function toCount(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
