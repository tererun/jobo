/**
 * Notebook controller (kernel) for the `jobo-notebook` type.
 *
 * Each SQL code cell is executed against the connection currently targeted by
 * its notebook. Results are written as two output items:
 *   - `x-application/jobo-grid` (JOBO_GRID_MIME) carrying a `GridData` payload,
 *     consumed by the result-grid renderer.
 *   - `text/plain`, a compact textual fallback for plain notebook viewers.
 *
 * Query failures are written as an error output and the cell is ended unsuccessfully.
 */

import * as vscode from "vscode";
import type { ConnectionManager } from "../connections/manager";
import type { JoboDriver, QueryResult } from "../drivers/driver";
import { JOBO_GRID_MIME, type GridData } from "../shared/gridData";

const CONTROLLER_ID = "jobo-controller";
const NOTEBOOK_TYPE = "jobo-notebook";

/**
 * Tracks which connection each open notebook executes against, keyed by the
 * notebook document URI. Fires when a mapping changes so UI (status bar) can
 * refresh.
 */
export class NotebookTargetStore implements vscode.Disposable {
  private readonly map = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.NotebookDocument>();
  readonly onDidChange = this._onDidChange.event;

  get(notebook: vscode.NotebookDocument): string | undefined {
    return this.map.get(notebook.uri.toString());
  }

  set(notebook: vscode.NotebookDocument, connectionId: string): void {
    this.map.set(notebook.uri.toString(), connectionId);
    this._onDidChange.fire(notebook);
  }

  clear(notebook: vscode.NotebookDocument): void {
    if (this.map.delete(notebook.uri.toString())) {
      this._onDidChange.fire(notebook);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/**
 * Resolves the connection id a notebook should run against. Implemented by the
 * notebook wiring so it can present a quick pick when no target is set yet.
 * Returns undefined when the user cancels or no connection is available.
 */
export type TargetResolver = (
  notebook: vscode.NotebookDocument
) => Promise<string | undefined>;

export class JoboNotebookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private executionOrder = 0;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly resolveTargetId: TargetResolver
  ) {
    this.controller = vscode.notebooks.createNotebookController(
      CONTROLLER_ID,
      NOTEBOOK_TYPE,
      "Jobo SQL"
    );
    this.controller.supportedLanguages = ["sql"];
    this.controller.supportsExecutionOrder = true;
    this.controller.description = "Execute SQL against a Jobo connection";
    this.controller.executeHandler = this.execute.bind(this);
  }

  private async execute(
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument
  ): Promise<void> {
    let driver: JoboDriver;
    try {
      driver = await this.resolveDriver(notebook);
    } catch (err) {
      // Resolution/connection failed: fail every requested cell with the reason.
      for (const cell of cells) {
        await this.writeError(cell, asError(err));
      }
      return;
    }

    for (const cell of cells) {
      await this.runCell(cell, driver);
    }
  }

  /** Resolve (and connect if needed) the driver for a notebook's target. */
  private async resolveDriver(
    notebook: vscode.NotebookDocument
  ): Promise<JoboDriver> {
    const id = await this.resolveTargetId(notebook);
    if (!id) {
      throw new Error(
        'No target connection selected. Use the "Select Target Connection" toolbar action.'
      );
    }
    if (!this.manager.isConnected(id)) {
      await this.manager.connect(id);
    }
    const driver = this.manager.getDriver(id);
    if (!driver) {
      throw new Error("Could not obtain a database driver for the selected connection.");
    }
    return driver;
  }

  private async runCell(
    cell: vscode.NotebookCell,
    driver: JoboDriver
  ): Promise<void> {
    const exec = this.controller.createNotebookCellExecution(cell);
    exec.executionOrder = ++this.executionOrder;
    exec.start(Date.now());

    const sql = cell.document.getText().trim();
    if (sql === "") {
      await exec.replaceOutput([]);
      exec.end(true, Date.now());
      return;
    }

    try {
      const result = await driver.query(sql);
      const grid = toGridData(result);
      await exec.replaceOutput(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.json(grid, JOBO_GRID_MIME),
          vscode.NotebookCellOutputItem.text(toTextFallback(result), "text/plain"),
        ])
      );
      exec.end(true, Date.now());
    } catch (err) {
      await exec.replaceOutput(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.error(asError(err)),
        ])
      );
      exec.end(false, Date.now());
    }
  }

  /** Write a single error output for a cell (used when execution can't start). */
  private async writeError(
    cell: vscode.NotebookCell,
    error: Error
  ): Promise<void> {
    const exec = this.controller.createNotebookCellExecution(cell);
    exec.executionOrder = ++this.executionOrder;
    exec.start(Date.now());
    await exec.replaceOutput(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.error(error),
      ])
    );
    exec.end(false, Date.now());
  }

  dispose(): void {
    this.controller.dispose();
  }
}

/** Map a driver QueryResult into the shared read-only grid payload. */
function toGridData(result: QueryResult): GridData {
  return {
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    durationMs: result.durationMs,
    editable: false,
  };
}

/** Compact tab-separated text rendering for the `text/plain` fallback. */
function toTextFallback(result: QueryResult): string {
  if (result.columns.length === 0) {
    return `${result.rowCount} row(s) affected in ${result.durationMs} ms`;
  }
  const MAX_ROWS = 100;
  const header = result.columns.map((c) => c.name).join("\t");
  const shown = result.rows.slice(0, MAX_ROWS);
  const body = shown
    .map((row) => row.map((value) => formatCell(value)).join("\t"))
    .join("\n");
  const more =
    result.rows.length > MAX_ROWS
      ? `\n… ${result.rows.length - MAX_ROWS} more row(s)`
      : "";
  const summary = `\n(${result.rowCount} row(s), ${result.durationMs} ms)`;
  return `${header}\n${body}${more}${summary}`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
