/**
 * SQLite driver (node-sqlite3-wasm).
 *
 * node-sqlite3-wasm is synchronous; we wrap its calls in async methods to honor
 * the JoboDriver contract. SQLite has no schema layer, so schema is always
 * undefined and listSchemas/listDatabases return empty/`main`.
 */

import { Database, type SQLiteValue } from "node-sqlite3-wasm";
import type {
  JoboDriver,
  QueryResult,
  TableRef,
  ColumnInfo,
  TableRowCount,
  DriverConnectionOptions,
} from "./driver";
import { quoteTable } from "../sql/builder";

export class SqliteDriver implements JoboDriver {
  private db: Database | undefined;

  constructor(private readonly options: DriverConnectionOptions) {}

  async connect(): Promise<void> {
    if (!this.options.file) {
      throw new Error("SqliteDriver requires a 'file' path.");
    }
    this.db = new Database(this.options.file);
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("SqliteDriver is not connected.");
    }
    return this.db;
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const db = this.requireDb();
    const start = Date.now();
    const trimmed = sql.trimStart().toLowerCase();
    const isSelect =
      trimmed.startsWith("select") ||
      trimmed.startsWith("pragma") ||
      trimmed.startsWith("with");

    if (isSelect) {
      const rowsObj = db.all(sql, params as SQLiteValue[] | undefined);
      const durationMs = Date.now() - start;
      const colNames = rowsObj.length > 0 ? Object.keys(rowsObj[0]) : [];
      const rows = rowsObj.map((r) => colNames.map((c) => (r as Record<string, unknown>)[c]));
      return {
        columns: colNames.map((name) => ({ name })),
        rows,
        rowCount: rows.length,
        durationMs,
      };
    }

    const result = db.run(sql, params as SQLiteValue[] | undefined);
    const durationMs = Date.now() - start;
    return { columns: [], rows: [], rowCount: result.changes, durationMs };
  }

  async listDatabases(): Promise<string[]> {
    return ["main"];
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listTables(): Promise<TableRef[]> {
    const res = await this.query(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    );
    return res.rows.map((r) => ({ name: String(r[0]) }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const res = await this.query(`PRAGMA table_info(${this.quoteIdent(table.name)})`);
    // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
    return res.rows.map((r) => ({
      name: String(r[1]),
      type: String(r[2] ?? ""),
      nullable: Number(r[3]) === 0,
      isPrimaryKey: Number(r[5]) > 0,
      defaultValue: r[4] == null ? undefined : String(r[4]),
    }));
  }

  async getPrimaryKeys(table: TableRef): Promise<string[]> {
    const res = await this.query(`PRAGMA table_info(${this.quoteIdent(table.name)})`);
    return res.rows
      .filter((r) => Number(r[5]) > 0)
      .sort((a, b) => Number(a[5]) - Number(b[5]))
      .map((r) => String(r[1]));
  }

  async getTableRowCount(table: TableRef): Promise<TableRowCount> {
    // MAX(rowid) is O(1) on the rowid index and good enough for pager UI.
    // WITHOUT ROWID tables fall back to COUNT(*).
    try {
      const maxRes = await this.query(
        `SELECT MAX(rowid) FROM ${this.quoteIdent(table.name)}`
      );
      const max = Number(maxRes.rows[0]?.[0]);
      if (Number.isFinite(max) && max >= 0) {
        return { count: max, exact: false };
      }
    } catch {
      /* view or edge case */
    }
    const tableSql = quoteTable(table, this);
    const exactRes = await this.query(`SELECT COUNT(*) FROM ${tableSql}`);
    return { count: toCount(exactRes.rows[0]?.[0]), exact: true };
  }

  async execTransaction(statements: string[]): Promise<void> {
    const db = this.requireDb();
    db.exec("BEGIN");
    try {
      for (const stmt of statements) {
        db.exec(stmt);
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw err;
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
      return value ? "1" : "0";
    }
    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
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
