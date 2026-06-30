/**
 * Editable table view (Webview).
 *
 * Registers the `jobo.openTableView` command, which opens a Webview panel that
 * shows a single table in an always-editable grid:
 *
 *   - Loads one page at a time via `SELECT * ... ORDER BY <pk|sort> LIMIT n
 *     OFFSET m` (n = page size, seeded from `jobo.defaultQueryLimit`) and renders
 *     the same ward-grid as the notebook renderer. The total row count comes from
 *     a cached `COUNT(*)`, so the webview can show a real pager. Paging and
 *     sorting both round-trip to the host; the webview never holds the whole
 *     table in memory.
 *   - Rows are identified by primary keys; cells can be edited (double-click),
 *     empty rows added, and rows marked for deletion. All edits accumulate as
 *     PENDING changes in the webview — nothing executes until the user confirms.
 *
 * Two-step Execute flow:
 *   1. The webview's top-right Execute button posts `{ type: "preview" }` with
 *      the pending `PendingChange[]`. The host builds SQL via
 *      `buildStatements(table, changes, driver)` (driver provides the quoting)
 *      and posts `{ type: "sqlPreview", statements }`. The webview opens a modal
 *      listing the generated statements — NO execution happens yet.
 *   2. The modal's own "Execute (Confirm)" button posts `{ type: "commit" }`
 *      with the same changes. The host re-builds the statements (never trusting
 *      raw SQL from the webview) and runs them through
 *      `driver.execTransaction(statements)` as ONE transaction. On success the
 *      grid reloads and pending changes clear; on failure the transaction rolls
 *      back and the error is surfaced in the modal.
 *
 * All identifier/value quoting happens host-side through the driver, so the
 * webview only ever ships structured `PendingChange` objects.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import type { ConnectionManager } from "../connections/manager";
import type { JoboDriver, TableRef } from "../drivers/driver";
import { buildStatements, quoteTable, type PendingChange } from "../sql/builder";

const VIEW_TYPE = "jobo.tableView";

/**
 * Arguments accepted by the `jobo.openTableView` command.
 *
 * The command is invoked from three places, each with a different shape:
 *   1. Tree item click (`connectionsProvider`): POSITIONAL `[table, connectionId]`,
 *      where the first arg is a bare `TableRef` (`{ schema?, name }`) and the
 *      connection id is the SECOND positional argument.
 *   2. Inline `view/item/context` menu icon: the selected tree node (a `JoboNode`
 *      carrying both `.connectionId` and `.table`).
 *   3. Programmatic callers: a flat `{ connectionId, schema?, name }` object or the
 *      nested `{ connectionId, table }` form.
 *
 * `resolveArgs` normalizes all of these. `connectionId` is therefore optional on
 * this interface and may instead arrive as the second positional parameter.
 */
interface OpenTableArgs {
  connectionId?: string;
  schema?: string;
  name?: string;
  /** Nested form / tree node: `{ table: { schema, name }, ... }`. */
  table?: TableRef;
}

/** JSON-safe cell value sent to / received from the webview. */
type CellValue = string | number | boolean | null;

/** Server-side sort request: a column name and direction. */
interface SortSpec {
  col: string;
  dir: "asc" | "desc";
}

/** The window of rows the panel is currently showing (server-side paging). */
interface ViewState {
  /** Row offset of the first row on the page. */
  offset: number;
  /** Page size (rows per fetch). */
  limit: number;
  /** Active server-side sort, if any. */
  sort: SortSpec | null;
}

interface GridPayload {
  columns: { name: string }[];
  rows: CellValue[][];
  primaryKeys: string[];
  editable: boolean;
  table: TableRef;
  /** Total rows for paging (exact or estimated). */
  total: number;
  /** False when `total` comes from engine statistics. */
  totalExact: boolean;
  /** Row offset of the first returned row. */
  offset: number;
  /** Page size used for this fetch. */
  limit: number;
  /** Active server-side sort echoed back to the webview. */
  sort: SortSpec | null;
  durationMs: number;
}

/** Messages the webview sends to the host. */
type InboundMessage =
  | { type: "ready" }
  | { type: "view"; offset: number; limit: number; sort: SortSpec | null }
  | { type: "preview"; changes: PendingChange[] }
  | { type: "commit"; changes: PendingChange[] };

export function registerTableView(
  context: vscode.ExtensionContext,
  manager: ConnectionManager
): void {
  const panels = new Map<string, TableViewPanel>();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "jobo.openTableView",
      async (arg?: OpenTableArgs, maybeConnectionId?: string) => {
        try {
          await openTableView(context, manager, panels, arg, maybeConnectionId);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Could not open table view: ${errorMessage(err)}`
          );
        }
      }
    )
  );
}

async function openTableView(
  context: vscode.ExtensionContext,
  manager: ConnectionManager,
  panels: Map<string, TableViewPanel>,
  arg?: OpenTableArgs,
  maybeConnectionId?: string
): Promise<void> {
  const resolved = resolveArgs(arg, maybeConnectionId);
  if (!resolved) {
    vscode.window.showErrorMessage(
      "Table view requires a connectionId and a table name."
    );
    return;
  }
  const { connectionId, table } = resolved;

  // Ensure a live driver (connect on demand if needed).
  let driver = manager.getDriver(connectionId);
  if (!driver) {
    driver = await manager.connect(connectionId);
  }

  const key = panelKey(connectionId, table);
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }

  const panel = new TableViewPanel(
    context,
    manager,
    connectionId,
    table,
    () => panels.delete(key)
  );
  panels.set(key, panel);
}

/**
 * Normalize the various argument shapes the command may be invoked with.
 *
 * Accepts the connection id either from the arg object (`connectionId`, present
 * on the tree node and the programmatic forms) or from the second positional
 * parameter (used by the tree item's click command, whose first arg is a bare
 * `TableRef`). The table name/schema is taken from the nested `table` (tree node
 * / nested form), then the flat `name`/`schema` fields, then the arg treated as a
 * bare `TableRef`.
 */
function resolveArgs(
  arg?: OpenTableArgs,
  maybeConnectionId?: string
):
  | { connectionId: string; table: TableRef }
  | undefined {
  if (!arg || typeof arg !== "object") {
    return undefined;
  }
  const connectionId =
    arg.connectionId ??
    (typeof maybeConnectionId === "string" ? maybeConnectionId : undefined);
  if (!connectionId) {
    return undefined;
  }
  const name = arg.table?.name ?? arg.name;
  if (!name) {
    return undefined;
  }
  const schema = arg.table?.schema ?? arg.schema;
  return { connectionId, table: { schema, name } };
}

function panelKey(connectionId: string, table: TableRef): string {
  return `${connectionId}::${table.schema ?? ""}.${table.name}`;
}

/** Manages a single table view webview panel. */
class TableViewPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  /** Current page/sort window. `limit` is seeded from `jobo.defaultQueryLimit`. */
  private view: ViewState;
  /** Cached total row count; invalidated (undefined) on reload/commit. */
  private total: number | undefined;
  /** Whether the cached total is exact or a catalog estimate. */
  private totalExact = true;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly connectionId: string,
    private readonly table: TableRef,
    private readonly onDispose: () => void
  ) {
    const defaultLimit = vscode.workspace
      .getConfiguration("jobo")
      .get<number>("defaultQueryLimit", 200);
    this.view = { offset: 0, limit: Math.max(1, defaultLimit), sort: null };

    const label = table.schema ? `${table.schema}.${table.name}` : table.name;
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Table ${label}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
        ],
      }
    );

    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (msg: InboundMessage) => this.handleMessage(msg),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  reveal(): void {
    this.panel.reveal();
  }

  private dispose(): void {
    this.onDispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private requireDriver(): JoboDriver {
    const driver = this.manager.getDriver(this.connectionId);
    if (!driver) {
      throw new Error("Connection is closed. Please reconnect.");
    }
    return driver;
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg?.type) {
      case "ready":
        // Fresh open: recompute the total and load the first page.
        this.total = undefined;
        await this.sendData("init");
        break;
      case "view":
        this.view = {
          offset: Math.max(0, Math.floor(msg.offset) || 0),
          limit: Math.max(1, Math.floor(msg.limit) || this.view.limit),
          sort: normalizeSort(msg.sort),
        };
        await this.sendData("data");
        break;
      case "preview":
        await this.handlePreview(msg.changes);
        break;
      case "commit":
        await this.handleCommit(msg.changes);
        break;
      default:
        break;
    }
  }

  private async loadGrid(): Promise<GridPayload> {
    const driver = this.requireDriver();
    const tableSql = quoteTable(this.table, driver);

    let primaryKeys: string[] = [];
    try {
      primaryKeys = await driver.getPrimaryKeys(this.table);
    } catch {
      primaryKeys = [];
    }

    // Total count is cached; recomputed only when invalidated (reload/commit).
    // Prefer fast catalog estimates over COUNT(*) on large tables.
    if (this.total === undefined) {
      const counted = await driver.getTableRowCount(this.table);
      this.total = counted.count;
      this.totalExact = counted.exact;
    }
    const total = this.total;

    // Clamp the offset so a shrunken table (e.g. after deletes) never lands the
    // user on an empty page past the end.
    const limit = Math.max(1, this.view.limit);
    let offset = Math.max(0, this.view.offset);
    if (total > 0 && offset >= total) {
      offset = (Math.ceil(total / limit) - 1) * limit;
    }
    this.view.offset = offset;

    const orderBy = buildOrderBy(this.view.sort, primaryKeys, driver);
    const sql =
      `SELECT * FROM ${tableSql}${orderBy} LIMIT ${limit} OFFSET ${offset}`;
    const result = await driver.query(sql);

    return {
      columns: result.columns.map((c) => ({ name: c.name })),
      rows: result.rows.map((row) => row.map(sanitizeValue)),
      primaryKeys,
      editable: primaryKeys.length > 0,
      table: this.table,
      total,
      totalExact: this.totalExact,
      offset,
      limit,
      sort: this.view.sort,
      durationMs: result.durationMs,
    };
  }

  private async sendData(type: "init" | "data"): Promise<void> {
    try {
      const payload = await this.loadGrid();
      await this.panel.webview.postMessage({ type, payload });
    } catch (err) {
      await this.panel.webview.postMessage({
        type: "error",
        message: errorMessage(err),
      });
    }
  }

  private async handlePreview(changes: PendingChange[]): Promise<void> {
    try {
      const driver = this.requireDriver();
      const statements = buildStatements(this.table, changes ?? [], driver);
      await this.panel.webview.postMessage({ type: "sqlPreview", statements });
    } catch (err) {
      await this.panel.webview.postMessage({
        type: "error",
        message: errorMessage(err),
      });
    }
  }

  private async handleCommit(changes: PendingChange[]): Promise<void> {
    const driver = this.requireDriver();
    let statements: string[];
    try {
      // Re-build host-side: never execute raw SQL handed in by the webview.
      statements = buildStatements(this.table, changes ?? [], driver);
    } catch (err) {
      await this.panel.webview.postMessage({
        type: "error",
        message: `Failed to generate SQL: ${errorMessage(err)}`,
      });
      return;
    }
    if (statements.length === 0) {
      await this.panel.webview.postMessage({ type: "committed" });
      this.total = undefined;
      await this.sendData("data");
      return;
    }
    try {
      await driver.execTransaction(statements);
    } catch (err) {
      await this.panel.webview.postMessage({
        type: "error",
        message: `Execution failed (rolled back): ${errorMessage(err)}`,
      });
      return;
    }
    await this.panel.webview.postMessage({ type: "committed" });
    vscode.window.showInformationMessage(
      `Committed ${statements.length} change(s).`
    );
    // Row count may have changed (inserts/deletes) — force a recount.
    this.total = undefined;
    await this.sendData("data");
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "tableView.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "tableView.css")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Jobo Table View</title>
</head>
<body>
  <div class="jobo-toolbar">
    <span class="jobo-toolbar__title" id="title"></span>
    <span class="jobo-toolbar__spacer"></span>
    <button id="add-row" type="button" class="jobo-btn jobo-btn--secondary">+ Add Row</button>
    <button id="reload" type="button" class="jobo-btn jobo-btn--secondary">↻ Reload</button>
    <button id="execute" type="button" class="jobo-btn">Execute ▸</button>
  </div>
  <div class="jobo-status" id="status"></div>
  <div class="jobo-scroll">
    <div id="grid"></div>
  </div>
  <div class="jobo-pager" id="pager"></div>

  <div class="jobo-modal-backdrop" id="modal-backdrop">
    <div class="jobo-modal" role="dialog" aria-modal="true">
      <div class="jobo-modal__header">
        Review SQL to Execute
        <span class="jobo-modal__sub" id="modal-sub"></span>
      </div>
      <div class="jobo-modal__body" id="modal-body"></div>
      <div class="jobo-modal__footer">
        <button id="modal-cancel" type="button" class="jobo-btn jobo-btn--secondary">Cancel</button>
        <button id="modal-execute" type="button" class="jobo-btn jobo-btn--danger">Execute (Confirm)</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Build a deterministic ORDER BY clause for stable OFFSET pagination. */
function buildOrderBy(
  sort: SortSpec | null,
  primaryKeys: string[],
  driver: JoboDriver
): string {
  if (sort && sort.col) {
    const dir = sort.dir === "desc" ? "DESC" : "ASC";
    return ` ORDER BY ${driver.quoteIdent(sort.col)} ${dir}`;
  }
  // Without an explicit sort, order by primary keys so paging is stable across
  // fetches. Tables without a PK fall back to engine order (best effort).
  if (primaryKeys.length > 0) {
    const cols = primaryKeys.map((k) => driver.quoteIdent(k)).join(", ");
    return ` ORDER BY ${cols}`;
  }
  return "";
}

/** Sanitize an inbound sort spec from the webview. */
function normalizeSort(sort: unknown): SortSpec | null {
  if (!sort || typeof sort !== "object") {
    return null;
  }
  const col = (sort as { col?: unknown }).col;
  if (typeof col !== "string" || col.length === 0) {
    return null;
  }
  const dir = (sort as { dir?: unknown }).dir === "desc" ? "desc" : "asc";
  return { col, dir };
}

/** Convert a driver cell value into a JSON-safe primitive for the webview. */
function sanitizeValue(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return `0x${value.toString("hex")}`;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}
