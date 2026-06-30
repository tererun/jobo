/**
 * MySQL / MariaDB driver (mysql2).
 */

import mysql from "mysql2/promise";
import type {
  JoboDriver,
  QueryResult,
  TableRef,
  ColumnInfo,
  DriverConnectionOptions,
} from "./driver";

export class MysqlDriver implements JoboDriver {
  private pool: mysql.Pool | undefined;

  constructor(private readonly options: DriverConnectionOptions) {}

  async connect(): Promise<void> {
    this.pool = mysql.createPool({
      host: this.options.host,
      port: this.options.port,
      user: this.options.user,
      password: this.options.password,
      database: this.options.database,
      ssl: this.options.ssl ? { rejectUnauthorized: false } : undefined,
      waitForConnections: true,
      connectionLimit: 5,
    });
    const conn = await this.pool.getConnection();
    conn.release();
  }

  private requirePool(): mysql.Pool {
    if (!this.pool) {
      throw new Error("MysqlDriver is not connected.");
    }
    return this.pool;
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const pool = this.requirePool();
    const start = Date.now();
    const [rows, fields] = await pool.query({
      sql,
      values: params,
      rowsAsArray: true,
    });
    const durationMs = Date.now() - start;

    if (Array.isArray(rows) && fields) {
      const cols = (fields as mysql.FieldPacket[]).map((f) => ({
        name: f.name,
        type: f.type !== undefined ? String(f.type) : undefined,
      }));
      const dataRows = rows as unknown[][];
      return { columns: cols, rows: dataRows, rowCount: dataRows.length, durationMs };
    }

    // DML result (ResultSetHeader).
    const header = rows as mysql.ResultSetHeader;
    return {
      columns: [],
      rows: [],
      rowCount: header.affectedRows ?? 0,
      durationMs,
    };
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.query(
      "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name"
    );
    return res.rows.map((r) => String(r[0]));
  }

  async listSchemas(): Promise<string[]> {
    // MySQL has no separate schema concept; schemas == databases.
    return this.listDatabases();
  }

  async listTables(schema?: string): Promise<TableRef[]> {
    const target = schema ?? this.options.database;
    const res = await this.query(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE (? IS NULL OR table_schema = ?)
         AND table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
       ORDER BY table_schema, table_name`,
      [target ?? null, target ?? null]
    );
    return res.rows.map((r) => ({ schema: String(r[0]), name: String(r[1]) }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const schema = table.schema ?? this.options.database;
    const res = await this.query(
      `SELECT column_name, column_type, is_nullable, column_key, column_default
       FROM information_schema.columns
       WHERE table_name = ? AND (? IS NULL OR table_schema = ?)
       ORDER BY ordinal_position`,
      [table.name, schema ?? null, schema ?? null]
    );
    return res.rows.map((r) => ({
      name: String(r[0]),
      type: String(r[1]),
      nullable: String(r[2]).toUpperCase() === "YES",
      isPrimaryKey: String(r[3]).toUpperCase() === "PRI",
      defaultValue: r[4] == null ? undefined : String(r[4]),
    }));
  }

  async getPrimaryKeys(table: TableRef): Promise<string[]> {
    const schema = table.schema ?? this.options.database;
    const res = await this.query(
      `SELECT column_name FROM information_schema.key_column_usage
       WHERE table_name = ? AND constraint_name = 'PRIMARY'
         AND (? IS NULL OR table_schema = ?)
       ORDER BY ordinal_position`,
      [table.name, schema ?? null, schema ?? null]
    );
    return res.rows.map((r) => String(r[0]));
  }

  async execTransaction(statements: string[]): Promise<void> {
    const pool = this.requirePool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const stmt of statements) {
        await conn.query(stmt);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  }

  quoteIdent(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  quoteValue(value: unknown): string {
    if (value === null || value === undefined) {
      return "NULL";
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? String(value) : "NULL";
    }
    if (typeof value === "boolean") {
      return value ? "1" : "0";
    }
    if (value instanceof Date) {
      return mysql.escape(value);
    }
    return mysql.escape(String(value));
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }
}
