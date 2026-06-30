/**
 * Helpers for applying a safety LIMIT to read queries (notebook cells).
 *
 * Notebook SQL is user-authored; when a SELECT-like statement has no LIMIT we
 * wrap it in a subquery and fetch at most `limit + 1` rows so the UI can tell
 * whether the result was truncated without scanning the whole table.
 */

/** Leading read-only statement kinds we auto-limit. */
const READ_QUERY = /^\s*(select|with|pragma)\b/i;

/** LIMIT / FETCH clauses that already cap the result set. */
const HAS_LIMIT = /\blimit\s+(\d+|\?|\$\d+)/i;
const HAS_FETCH = /\bfetch\s+(first|next)\s+\d+\s+rows?\s+only\b/i;

export function isReadQuery(sql: string): boolean {
  return READ_QUERY.test(sql.trim());
}

export function hasResultLimit(sql: string): boolean {
  return HAS_LIMIT.test(sql) || HAS_FETCH.test(sql);
}

export interface AppliedQueryLimit {
  /** SQL to send to the driver. */
  sql: string;
  /** True when a wrapper LIMIT was added. */
  applied: boolean;
  /** The configured row cap (not including the +1 probe row). */
  limit: number;
}

/**
 * Wrap a read query without an existing LIMIT in `SELECT * FROM (...) LIMIT n+1`.
 * DML and queries that already specify LIMIT/FETCH are returned unchanged.
 */
export function applyQueryLimit(
  sql: string,
  limit: number
): AppliedQueryLimit {
  const cap = Math.max(1, Math.floor(limit) || 1);
  if (!isReadQuery(sql) || hasResultLimit(sql)) {
    return { sql, applied: false, limit: cap };
  }
  const stripped = sql.trim().replace(/;\s*$/, "");
  return {
    sql: `SELECT * FROM (${stripped}) AS _jobo LIMIT ${cap + 1}`,
    applied: true,
    limit: cap,
  };
}
