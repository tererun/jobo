/**
 * Shared driver contracts for Jobo.
 *
 * These types are the cross-phase contract. The tree view, notebook controller,
 * table editor, SQL builder, and renderer all depend on them. Do not change the
 * shapes without coordinating with the dependent phases.
 */

/** A reference to a table, optionally schema-qualified. */
export interface TableRef {
  /** Schema/namespace. Undefined for engines without schemas (e.g. SQLite). */
  schema?: string;
  /** Table name. */
  name: string;
}

/** Row count for a table — exact or a catalog/statistics estimate. */
export interface TableRowCount {
  count: number;
  /** False when `count` comes from engine statistics (pg_class, etc.). */
  exact: boolean;
}

/** Metadata about a single column. */
export interface ColumnInfo {
  name: string;
  /** Engine-specific declared type (e.g. "int4", "varchar(255)"). */
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  /** Default value expression, if any. */
  defaultValue?: string;
}

/** A single column descriptor in a query result. */
export interface ResultColumn {
  name: string;
  /** Optional engine-specific type identifier. */
  type?: string;
}

/**
 * The canonical query result shape.
 *
 * LOCKED CONTRACT — depended on by notebook controller, renderer, table view.
 *   columns:   ordered column descriptors
 *   rows:      row-major array of cell value arrays (rows[i][j] -> column j)
 *   rowCount:  number of rows returned, or rows affected for DML
 *   durationMs: server/round-trip execution time in milliseconds
 */
export interface QueryResult {
  columns: ResultColumn[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
}

/**
 * The common database driver interface implemented by each engine.
 *
 * A driver instance represents a live connection. The ConnectionManager owns the
 * lifecycle (connect/close) and hands active drivers to consumers.
 */
export interface JoboDriver {
  /** Establish the underlying connection/pool. */
  connect(): Promise<void>;
  /** Run a query with optional parameters. */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  /** List databases/catalogs visible to the connection. */
  listDatabases(): Promise<string[]>;
  /** List schemas, optionally scoped to a database. */
  listSchemas(db?: string): Promise<string[]>;
  /** List tables, optionally scoped to a schema. */
  listTables(schema?: string): Promise<TableRef[]>;
  /** List columns of a table (name/type/nullable/isPrimaryKey). */
  listColumns(table: TableRef): Promise<ColumnInfo[]>;
  /** Primary key column names, used for row identification and WHERE clauses. */
  getPrimaryKeys(table: TableRef): Promise<string[]>;
  /**
   * Row count for pager UI. Prefer fast catalog estimates over `COUNT(*)` when
   * the engine provides them; fall back to an exact count when needed.
   */
  getTableRowCount(table: TableRef): Promise<TableRowCount>;
  /** Execute multiple statements as a single transaction (commit/rollback). */
  execTransaction(statements: string[]): Promise<void>;
  /** Quote an identifier for this engine (PG/SQLite: ", MySQL: `). */
  quoteIdent(name: string): string;
  /** Quote/escape a literal value safely for inline SQL. */
  quoteValue(value: unknown): string;
  /** Close the connection/pool and release resources. */
  close(): Promise<void>;
}

/** Supported driver kinds. */
export type DriverKind = "postgres" | "mysql" | "sqlite";

/**
 * Normalized connection parameters handed to a driver. The ConnectionManager
 * builds this from a stored ConnectionConfig, after resolving secrets and any
 * SSH tunnel (host/port here already point at the local tunnel endpoint).
 */
export interface DriverConnectionOptions {
  kind: DriverKind;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  /** SQLite database file path. */
  file?: string;
}
