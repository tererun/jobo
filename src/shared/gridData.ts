/**
 * Shared grid data payload.
 *
 * LOCKED CONTRACT — this is the payload carried by:
 *   - the notebook output MIME `x-application/jobo-grid` (controller -> renderer)
 *   - the editable table view webview (extension -> webview)
 *
 * Both the notebook controller and the renderer/webview import this type and
 * must agree on its shape. Keep it serializable (JSON-safe) — no class
 * instances, functions, or circular references.
 */

import type { ResultColumn } from "../drivers/driver";

/** MIME type used for the notebook grid output and webview payloads. */
export const JOBO_GRID_MIME = "x-application/jobo-grid";

/** Identity of the source table, when the grid is backed by a single table. */
export interface GridTable {
  schema?: string;
  name: string;
}

/**
 * The data shape rendered by the result grid / table view.
 *
 *   columns:     ordered column descriptors (same shape as QueryResult.columns)
 *   rows:        row-major cell values (rows[i][j] -> column j)
 *   table:       present when the grid is backed by a single table (enables edit)
 *   primaryKeys: PK column names, used to identify rows for UPDATE/DELETE
 *   editable:    whether the consumer should allow edit mode
 *   rowCount:    total rows (may exceed rows.length when paginated/limited)
 *   durationMs:  execution time, for status display
 */
export interface GridData {
  columns: ResultColumn[];
  rows: unknown[][];
  table?: GridTable;
  primaryKeys?: string[];
  editable?: boolean;
  rowCount?: number;
  durationMs?: number;
}
