/**
 * Notebook wiring.
 *
 * Registers the `.jobonb`/`.sql` serializer, the SQL execution controller, and
 * the target-connection switching UI (a status bar item plus the
 * `jobo.selectTargetConnection` command). Also hosts the `jobo.newNotebook` and
 * `jobo.runNotebookOnConnection` helper commands.
 */

import * as vscode from "vscode";
import type { ConnectionManager } from "../connections/manager";
import { JoboNotebookSerializer } from "./serializer";
import {
  JoboNotebookController,
  NotebookTargetStore,
} from "./controller";

const NOTEBOOK_TYPE = "jobo-notebook";

export function registerNotebook(
  context: vscode.ExtensionContext,
  manager: ConnectionManager
): void {
  const targets = new NotebookTargetStore();
  context.subscriptions.push(targets);

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      NOTEBOOK_TYPE,
      new JoboNotebookSerializer(),
      { transientOutputs: true }
    )
  );

  // The controller asks for a target via the resolver below: use the remembered
  // mapping, otherwise prompt with a quick pick.
  const controller = new JoboNotebookController(manager, (notebook) =>
    resolveTarget(notebook, false)
  );
  context.subscriptions.push(controller);

  // --- Target connection status bar item ---------------------------------
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusItem.command = "jobo.selectTargetConnection";
  context.subscriptions.push(statusItem);

  const updateStatusItem = (): void => {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE) {
      statusItem.hide();
      return;
    }
    const id = targets.get(editor.notebook);
    const config = id ? manager.getConnection(id) : undefined;
    if (config) {
      const connected = manager.isConnected(config.id);
      statusItem.text = `$(plug) ${config.name}`;
      statusItem.tooltip = `Jobo target: ${config.name} (${
        connected ? "connected" : "not connected"
      }). Click to change.`;
    } else {
      statusItem.text = "$(plug) Select connection";
      statusItem.tooltip = "Pick a Jobo connection to run this notebook against.";
    }
    statusItem.show();
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveNotebookEditor(updateStatusItem),
    targets.onDidChange(updateStatusItem),
    manager.onDidChangeStatus(updateStatusItem)
  );
  updateStatusItem();

  // --- Target resolution / quick pick ------------------------------------
  /**
   * Resolve the connection id for a notebook. When `forcePick` is true (the
   * explicit command) a quick pick is always shown. Otherwise a remembered
   * target is reused and the pick only appears when none is set yet.
   */
  async function resolveTarget(
    notebook: vscode.NotebookDocument,
    forcePick: boolean
  ): Promise<string | undefined> {
    if (!forcePick) {
      const existing = targets.get(notebook);
      if (existing && manager.getConnection(existing)) {
        return existing;
      }
    }

    const connections = manager.getConnections();
    if (connections.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        "No Jobo connections are configured yet.",
        "Add Connection"
      );
      if (choice === "Add Connection") {
        await vscode.commands.executeCommand("jobo.addConnection");
      }
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      connections.map((c) => ({
        label: c.name,
        description: `${c.driver}${manager.isConnected(c.id) ? " • connected" : ""}`,
        detail:
          c.driver === "sqlite"
            ? c.file
            : [c.host, c.port].filter(Boolean).join(":"),
        id: c.id,
      })),
      { placeHolder: "Select the connection to run this notebook against" }
    );
    if (!picked) {
      return undefined;
    }
    targets.set(notebook, picked.id);
    return picked.id;
  }

  // --- Commands -----------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "jobo.selectTargetConnection",
      async () => {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE) {
          void vscode.window.showInformationMessage(
            "Open a Jobo SQL notebook to select its target connection."
          );
          return;
        }
        await resolveTarget(editor.notebook, true);
      }
    ),

    vscode.commands.registerCommand("jobo.newNotebook", async () => {
      const data = new vscode.NotebookData([
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          "SELECT 1;",
          "sql"
        ),
      ]);
      data.metadata = { joboFormat: "jobonb" };
      const doc = await vscode.workspace.openNotebookDocument(
        NOTEBOOK_TYPE,
        data
      );
      await vscode.window.showNotebookDocument(doc);
    }),

    vscode.commands.registerCommand(
      "jobo.runNotebookOnConnection",
      async () => {
        const editor = vscode.window.activeNotebookEditor;
        if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE) {
          void vscode.window.showInformationMessage(
            "Open a Jobo SQL notebook to run it against a connection."
          );
          return;
        }
        const id = await resolveTarget(editor.notebook, true);
        if (!id) {
          return;
        }
        await vscode.commands.executeCommand("notebook.execute");
      }
    )
  );
}
