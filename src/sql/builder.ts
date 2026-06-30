/**
 * Pure SQL builder for the editable table view.
 *
 * Generates UPDATE / INSERT / DELETE statements from a set of pending changes.
 * Identifier quoting and value quoting are delegated to the driver so each
 * engine's rules (PG/SQLite `"`, MySQL `` ` ``, dialect-specific escaping) are
 * respected. The functions here are pure and side-effect free, which keeps the
 * table-editor phase decoupled from any live connection.
 *
 * LOCKED CONTRACT — the table-editor phase builds PendingChange objects and
 * calls buildStatements(); the resulting SQL strings are passed to
 * JoboDriver.execTransaction().
 */

import type { TableRef } from "../drivers/driver";

/** Minimal quoting surface the builder needs from a driver. */
export interface SqlQuoter {
  quoteIdent(name: string): string;
  quoteValue(value: unknown): string;
}

/** An edit to an existing row, identified by its primary-key values. */
export interface UpdateChange {
  kind: "update";
  /** Map of PK column name -> original value, used in the WHERE clause. */
  keyValues: Record<string, unknown>;
  /** Map of column name -> new value for the changed columns. */
  values: Record<string, unknown>;
}

/** A new row to insert. */
export interface InsertChange {
  kind: "insert";
  /** Map of column name -> value for the inserted row. */
  values: Record<string, unknown>;
}

/** A row to delete, identified by its primary-key values. */
export interface DeleteChange {
  kind: "delete";
  keyValues: Record<string, unknown>;
}

/** A single pending change accumulated in the table editor. */
export type PendingChange = UpdateChange | InsertChange | DeleteChange;

/** Render a schema-qualified, quoted table name. */
export function quoteTable(table: TableRef, quoter: SqlQuoter): string {
  const name = quoter.quoteIdent(table.name);
  return table.schema ? `${quoter.quoteIdent(table.schema)}.${name}` : name;
}

function buildWhere(
  keyValues: Record<string, unknown>,
  quoter: SqlQuoter
): string {
  const keys = Object.keys(keyValues);
  if (keys.length === 0) {
    throw new Error(
      "Cannot build WHERE clause: no primary key values provided. A primary key is required to safely identify rows."
    );
  }
  return keys
    .map((k) => {
      const v = keyValues[k];
      if (v === null || v === undefined) {
        return `${quoter.quoteIdent(k)} IS NULL`;
      }
      return `${quoter.quoteIdent(k)} = ${quoter.quoteValue(v)}`;
    })
    .join(" AND ");
}

/** Build a single UPDATE statement. */
export function buildUpdate(
  table: TableRef,
  change: UpdateChange,
  quoter: SqlQuoter
): string {
  const setCols = Object.keys(change.values);
  if (setCols.length === 0) {
    throw new Error("Cannot build UPDATE: no changed columns provided.");
  }
  const setClause = setCols
    .map((c) => `${quoter.quoteIdent(c)} = ${quoter.quoteValue(change.values[c])}`)
    .join(", ");
  const where = buildWhere(change.keyValues, quoter);
  return `UPDATE ${quoteTable(table, quoter)} SET ${setClause} WHERE ${where};`;
}

/** Build a single INSERT statement. */
export function buildInsert(
  table: TableRef,
  change: InsertChange,
  quoter: SqlQuoter
): string {
  const cols = Object.keys(change.values);
  if (cols.length === 0) {
    throw new Error("Cannot build INSERT: no column values provided.");
  }
  const colList = cols.map((c) => quoter.quoteIdent(c)).join(", ");
  const valList = cols.map((c) => quoter.quoteValue(change.values[c])).join(", ");
  return `INSERT INTO ${quoteTable(table, quoter)} (${colList}) VALUES (${valList});`;
}

/** Build a single DELETE statement. */
export function buildDelete(
  table: TableRef,
  change: DeleteChange,
  quoter: SqlQuoter
): string {
  const where = buildWhere(change.keyValues, quoter);
  return `DELETE FROM ${quoteTable(table, quoter)} WHERE ${where};`;
}

/**
 * Build all statements for a batch of pending changes, in a safe execution
 * order: DELETEs first, then UPDATEs, then INSERTs.
 */
export function buildStatements(
  table: TableRef,
  changes: PendingChange[],
  quoter: SqlQuoter
): string[] {
  const deletes: string[] = [];
  const updates: string[] = [];
  const inserts: string[] = [];
  for (const change of changes) {
    switch (change.kind) {
      case "delete":
        deletes.push(buildDelete(table, change, quoter));
        break;
      case "update":
        updates.push(buildUpdate(table, change, quoter));
        break;
      case "insert":
        inserts.push(buildInsert(table, change, quoter));
        break;
    }
  }
  return [...deletes, ...updates, ...inserts];
}
