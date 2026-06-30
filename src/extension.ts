/**
 * Jobo extension entry point.
 *
 * Creates the ConnectionManager and delegates feature wiring to per-phase
 * register* functions. Each register function lives in its own module so the
 * tree, notebook, and table-editor phases can be implemented in parallel
 * without editing this file.
 */

import * as vscode from "vscode";
import { ConnectionManager } from "./connections/manager";
import { registerConnectionsTree } from "./tree/connectionsProvider";
import { registerNotebook } from "./notebook/index";
import { registerTableView } from "./webview/tableView";

let manager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  manager = new ConnectionManager(context);
  context.subscriptions.push(manager);

  registerConnectionsTree(context, manager);
  registerNotebook(context, manager);
  registerTableView(context, manager);
}

export function deactivate(): void {
  // ConnectionManager is disposed via context.subscriptions, which also
  // disconnects any live connections/tunnels.
  manager = undefined;
}
