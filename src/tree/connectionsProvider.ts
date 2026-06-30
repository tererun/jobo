/**
 * Connections TreeView.
 *
 * Renders the `jobo.connections` view as a lazily expanded hierarchy:
 *
 *   connection
 *     └─ database            (postgres / mysql)
 *          └─ schema         (postgres only — mysql databases are schemas)
 *               └─ table
 *                    └─ column
 *
 * SQLite has no database/schema layer, so its tree is connection → table →
 * column. Children are fetched on demand from the live `JoboDriver`, so a
 * connection must be connected before it can be expanded.
 *
 * This module also owns the connection management commands contributed in
 * package.json (add/edit/delete/connect/disconnect/refresh) and forwards table
 * activation to `jobo.openTableView` (registered by the table-view phase).
 */

import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { ConnectionManager } from "../connections/manager";
import type { ConnectionConfig, ConnectionSecrets } from "../connections/types";
import type { DriverKind, JoboDriver, TableRef } from "../drivers/driver";

type NodeType =
  | "connection"
  | "database"
  | "schema"
  | "table"
  | "column"
  | "message";

class JoboNode extends vscode.TreeItem {
  constructor(
    public readonly nodeType: NodeType,
    public readonly connectionId: string,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly database?: string,
    public readonly schema?: string,
    public readonly table?: TableRef
  ) {
    super(label, collapsibleState);
  }
}

class ConnectionsProvider implements vscode.TreeDataProvider<JoboNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    JoboNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly manager: ConnectionManager) {}

  refresh(node?: JoboNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(element: JoboNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: JoboNode): Promise<JoboNode[]> {
    if (!element) {
      return this.getConnectionNodes();
    }
    try {
      switch (element.nodeType) {
        case "connection":
          return await this.getConnectionChildren(element);
        case "database":
          return await this.getDatabaseChildren(element);
        case "schema":
          return await this.getTableNodes(element, element.schema);
        case "table":
          return await this.getColumnNodes(element);
        default:
          return [];
      }
    } catch (err) {
      return [messageNode(element.connectionId, errorText(err))];
    }
  }

  // --- Node builders ------------------------------------------------------

  private getConnectionNodes(): JoboNode[] {
    return this.manager.getConnections().map((config) => {
      const status = this.manager.getStatus(config.id);
      const collapsible =
        status === "connected"
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;
      const node = new JoboNode(
        "connection",
        config.id,
        config.name,
        collapsible
      );
      node.id = `connection:${config.id}`;
      node.contextValue = `connection-${status}`;
      node.description = describeConnection(config, status);
      node.iconPath = connectionIcon(status);
      node.tooltip = connectionTooltip(config, status);
      return node;
    });
  }

  private async getConnectionChildren(node: JoboNode): Promise<JoboNode[]> {
    const driver = this.manager.getDriver(node.connectionId);
    if (!driver) {
      return [messageNode(node.connectionId, "Not connected")];
    }
    const kind = this.driverKind(node.connectionId);
    if (kind === "sqlite") {
      return this.getTableNodes(node, undefined);
    }
    const databases = await driver.listDatabases();
    if (databases.length === 0) {
      return this.getTableNodes(node, undefined);
    }
    return databases.map((db) => {
      const dbNode = new JoboNode(
        "database",
        node.connectionId,
        db,
        vscode.TreeItemCollapsibleState.Collapsed,
        db
      );
      dbNode.iconPath = new vscode.ThemeIcon("database");
      dbNode.contextValue = "database";
      return dbNode;
    });
  }

  private async getDatabaseChildren(node: JoboNode): Promise<JoboNode[]> {
    const driver = this.requireDriver(node.connectionId);
    const kind = this.driverKind(node.connectionId);
    // MySQL databases *are* schemas — go straight to tables. Postgres has a
    // real schema layer between database and table.
    if (kind === "postgres") {
      const schemas = await driver.listSchemas(node.database);
      if (schemas.length > 0) {
        return schemas.map((schema) => {
          const schemaNode = new JoboNode(
            "schema",
            node.connectionId,
            schema,
            vscode.TreeItemCollapsibleState.Collapsed,
            node.database,
            schema
          );
          schemaNode.iconPath = new vscode.ThemeIcon("symbol-namespace");
          schemaNode.contextValue = "schema";
          return schemaNode;
        });
      }
    }
    return this.getTableNodes(node, node.database);
  }

  private async getTableNodes(
    node: JoboNode,
    schema: string | undefined
  ): Promise<JoboNode[]> {
    const driver = this.requireDriver(node.connectionId);
    const tables = await driver.listTables(schema);
    if (tables.length === 0) {
      return [messageNode(node.connectionId, "No tables")];
    }
    return tables.map((table) => {
      const tableNode = new JoboNode(
        "table",
        node.connectionId,
        table.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        node.database,
        table.schema ?? schema,
        table
      );
      tableNode.iconPath = new vscode.ThemeIcon("table");
      tableNode.contextValue = "table";
      tableNode.description = table.schema;
      tableNode.command = {
        command: "jobo.openTableView",
        title: "Open Table",
        arguments: [table, node.connectionId],
      };
      return tableNode;
    });
  }

  private async getColumnNodes(node: JoboNode): Promise<JoboNode[]> {
    const driver = this.requireDriver(node.connectionId);
    if (!node.table) {
      return [];
    }
    const columns = await driver.listColumns(node.table);
    if (columns.length === 0) {
      return [messageNode(node.connectionId, "No columns")];
    }
    return columns.map((column) => {
      const columnNode = new JoboNode(
        "column",
        node.connectionId,
        column.name,
        vscode.TreeItemCollapsibleState.None,
        node.database,
        node.schema,
        node.table
      );
      columnNode.iconPath = new vscode.ThemeIcon(
        column.isPrimaryKey ? "key" : "symbol-field"
      );
      const parts = [column.type];
      if (!column.nullable) {
        parts.push("NOT NULL");
      }
      columnNode.description = parts.filter(Boolean).join(" ");
      columnNode.contextValue = "column";
      return columnNode;
    });
  }

  // --- Helpers ------------------------------------------------------------

  private driverKind(connectionId: string): DriverKind | undefined {
    return this.manager.getConnection(connectionId)?.driver;
  }

  private requireDriver(connectionId: string): JoboDriver {
    const driver = this.manager.getDriver(connectionId);
    if (!driver) {
      throw new Error("Not connected");
    }
    return driver;
  }
}

// --- Presentation helpers -------------------------------------------------

function messageNode(connectionId: string, label: string): JoboNode {
  const node = new JoboNode(
    "message",
    connectionId,
    label,
    vscode.TreeItemCollapsibleState.None
  );
  node.contextValue = "message";
  return node;
}

function describeConnection(
  config: ConnectionConfig,
  status: string
): string {
  const target =
    config.driver === "sqlite"
      ? config.file ?? ""
      : [config.host, config.port].filter(Boolean).join(":");
  return [config.driver, target, status].filter(Boolean).join(" • ");
}

function connectionTooltip(
  config: ConnectionConfig,
  status: string
): string {
  const lines = [`${config.name} (${config.driver})`, `Status: ${status}`];
  if (config.driver === "sqlite") {
    if (config.file) {
      lines.push(`File: ${config.file}`);
    }
  } else {
    if (config.host) {
      lines.push(`Host: ${config.host}:${config.port ?? ""}`);
    }
    if (config.database) {
      lines.push(`Database: ${config.database}`);
    }
    if (config.user) {
      lines.push(`User: ${config.user}`);
    }
    if (config.ssh) {
      lines.push(
        `SSH: ${config.ssh.configHost ?? config.ssh.host ?? "(configured)"}`
      );
    }
  }
  return lines.join("\n");
}

function connectionIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case "connected":
      return new vscode.ThemeIcon(
        "database",
        new vscode.ThemeColor("charts.green")
      );
    case "connecting":
      return new vscode.ThemeIcon("loading~spin");
    case "error":
      return new vscode.ThemeIcon(
        "error",
        new vscode.ThemeColor("charts.red")
      );
    default:
      return new vscode.ThemeIcon("database");
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Command registration -------------------------------------------------

export function registerConnectionsTree(
  context: vscode.ExtensionContext,
  manager: ConnectionManager
): void {
  const provider = new ConnectionsProvider(manager);
  const treeView = vscode.window.createTreeView("jobo.connections", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Refresh the tree whenever a connection's status changes.
  context.subscriptions.push(
    manager.onDidChangeStatus(() => provider.refresh())
  );

  const pickConnectionId = async (
    node: JoboNode | undefined,
    placeHolder: string
  ): Promise<string | undefined> => {
    if (node?.connectionId) {
      return node.connectionId;
    }
    const connections = manager.getConnections();
    if (connections.length === 0) {
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      connections.map((c) => ({ label: c.name, description: c.driver, id: c.id })),
      { placeHolder }
    );
    return picked?.id;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("jobo.refresh", () => provider.refresh()),

    vscode.commands.registerCommand("jobo.addConnection", async () => {
      const result = await promptConnection(manager);
      if (!result) {
        return;
      }
      await manager.saveConnection(result.config);
      await manager.setSecrets(result.config.id, result.secrets);
      provider.refresh();
    }),

    vscode.commands.registerCommand(
      "jobo.editConnection",
      async (node?: JoboNode) => {
        const id = await pickConnectionId(node, "Select a connection to edit");
        if (!id) {
          return;
        }
        const existing = manager.getConnection(id);
        if (!existing) {
          return;
        }
        const secrets = await manager.getSecrets(id);
        const result = await promptConnection(manager, existing, secrets);
        if (!result) {
          return;
        }
        await manager.saveConnection(result.config);
        await manager.setSecrets(result.config.id, result.secrets);
        provider.refresh();
      }
    ),

    vscode.commands.registerCommand(
      "jobo.deleteConnection",
      async (node?: JoboNode) => {
        const id = await pickConnectionId(node, "Select a connection to delete");
        if (!id) {
          return;
        }
        const config = manager.getConnection(id);
        const confirm = await vscode.window.showWarningMessage(
          `Delete connection "${config?.name ?? id}"? This also removes its stored secrets.`,
          { modal: true },
          "Delete"
        );
        if (confirm !== "Delete") {
          return;
        }
        await manager.deleteConnection(id);
        provider.refresh();
      }
    ),

    vscode.commands.registerCommand(
      "jobo.connect",
      async (node?: JoboNode) => {
        const id = await pickConnectionId(node, "Select a connection to connect");
        if (!id) {
          return;
        }
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${manager.getConnection(id)?.name ?? id}…`,
          },
          async () => {
            try {
              await manager.connect(id);
            } catch (err) {
              void vscode.window.showErrorMessage(
                `Failed to connect: ${errorText(err)}`
              );
            }
          }
        );
      }
    ),

    vscode.commands.registerCommand(
      "jobo.disconnect",
      async (node?: JoboNode) => {
        const id = await pickConnectionId(
          node,
          "Select a connection to disconnect"
        );
        if (!id) {
          return;
        }
        await manager.disconnect(id);
      }
    )
  );
}

// --- Add/Edit connection prompt flow --------------------------------------

interface PromptResult {
  config: ConnectionConfig;
  secrets: ConnectionSecrets;
}

async function promptConnection(
  _manager: ConnectionManager,
  existing?: ConnectionConfig,
  existingSecrets?: ConnectionSecrets
): Promise<PromptResult | undefined> {
  const name = await vscode.window.showInputBox({
    title: "Connection name",
    value: existing?.name ?? "",
    validateInput: (v) => (v.trim() === "" ? "Name is required" : undefined),
  });
  if (name === undefined) {
    return undefined;
  }

  const driver = await pickDriver(existing?.driver);
  if (!driver) {
    return undefined;
  }

  const config: ConnectionConfig = {
    id: existing?.id ?? randomUUID(),
    name: name.trim(),
    driver,
  };
  const secrets: ConnectionSecrets = { ...existingSecrets };

  if (driver === "sqlite") {
    const file = await vscode.window.showInputBox({
      title: "SQLite database file path",
      value: existing?.file ?? "",
      validateInput: (v) =>
        v.trim() === "" ? "File path is required" : undefined,
    });
    if (file === undefined) {
      return undefined;
    }
    config.file = file.trim();
    return { config, secrets };
  }

  const host = await vscode.window.showInputBox({
    title: "Host",
    value: existing?.host ?? "localhost",
  });
  if (host === undefined) {
    return undefined;
  }
  config.host = host.trim() || "localhost";

  const defaultPort = driver === "postgres" ? "5432" : "3306";
  const portStr = await vscode.window.showInputBox({
    title: "Port",
    value: existing?.port ? String(existing.port) : defaultPort,
    validateInput: (v) =>
      v.trim() === "" || Number.isFinite(Number(v))
        ? undefined
        : "Port must be a number",
  });
  if (portStr === undefined) {
    return undefined;
  }
  config.port = Number(portStr) || Number(defaultPort);

  const database = await vscode.window.showInputBox({
    title: "Database",
    value: existing?.database ?? "",
  });
  if (database === undefined) {
    return undefined;
  }
  config.database = database.trim() || undefined;

  const user = await vscode.window.showInputBox({
    title: "User",
    value: existing?.user ?? "",
  });
  if (user === undefined) {
    return undefined;
  }
  config.user = user.trim() || undefined;

  const password = await vscode.window.showInputBox({
    title: "Password",
    password: true,
    value: existingSecrets?.password ?? "",
    prompt: "Stored securely in SecretStorage. Leave blank for none.",
  });
  if (password === undefined) {
    return undefined;
  }
  secrets.password = password === "" ? undefined : password;

  const ssl = await vscode.window.showQuickPick(["No", "Yes"], {
    title: "Use SSL?",
    placeHolder: existing?.ssl ? "Currently: Yes" : "Currently: No",
  });
  if (ssl === undefined) {
    return undefined;
  }
  config.ssl = ssl === "Yes";

  const useSsh = await vscode.window.showQuickPick(["No", "Yes"], {
    title: "Connect through an SSH tunnel?",
    placeHolder: existing?.ssh ? "Currently: Yes" : "Currently: No",
  });
  if (useSsh === undefined) {
    return undefined;
  }
  if (useSsh === "Yes") {
    const ssh = await promptSsh(existing, existingSecrets, secrets);
    if (ssh === undefined) {
      return undefined;
    }
    config.ssh = ssh;
  }

  return { config, secrets };
}

async function pickDriver(
  current?: DriverKind
): Promise<DriverKind | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "PostgreSQL", value: "postgres" as DriverKind },
      { label: "MySQL / MariaDB", value: "mysql" as DriverKind },
      { label: "SQLite", value: "sqlite" as DriverKind },
    ],
    {
      title: "Database driver",
      placeHolder: current ? `Currently: ${current}` : undefined,
    }
  );
  return picked?.value;
}

async function promptSsh(
  existing: ConnectionConfig | undefined,
  existingSecrets: ConnectionSecrets | undefined,
  secrets: ConnectionSecrets
): Promise<ConnectionConfig["ssh"] | undefined> {
  const configHost = await vscode.window.showInputBox({
    title: "SSH config host (~/.ssh/config alias)",
    value: existing?.ssh?.configHost ?? "",
    prompt: "Optional. Missing fields below are filled from ~/.ssh/config.",
  });
  if (configHost === undefined) {
    return undefined;
  }

  const sshHost = await vscode.window.showInputBox({
    title: "SSH host",
    value: existing?.ssh?.host ?? "",
    prompt: configHost.trim() ? "Optional (overrides ~/.ssh/config)" : "Required",
  });
  if (sshHost === undefined) {
    return undefined;
  }

  const sshPortStr = await vscode.window.showInputBox({
    title: "SSH port",
    value: existing?.ssh?.port ? String(existing.ssh.port) : "",
    prompt: "Optional (default 22)",
    validateInput: (v) =>
      v.trim() === "" || Number.isFinite(Number(v))
        ? undefined
        : "Port must be a number",
  });
  if (sshPortStr === undefined) {
    return undefined;
  }

  const sshUser = await vscode.window.showInputBox({
    title: "SSH user",
    value: existing?.ssh?.user ?? "",
    prompt: "Optional (overrides ~/.ssh/config)",
  });
  if (sshUser === undefined) {
    return undefined;
  }

  const identityFile = await vscode.window.showInputBox({
    title: "SSH identity file (private key path)",
    value: existing?.ssh?.identityFile ?? "",
    prompt: "Optional (overrides ~/.ssh/config)",
  });
  if (identityFile === undefined) {
    return undefined;
  }

  const sshPassword = await vscode.window.showInputBox({
    title: "SSH password",
    password: true,
    value: existingSecrets?.sshPassword ?? "",
    prompt: "Optional. Stored securely. Leave blank to use key auth.",
  });
  if (sshPassword === undefined) {
    return undefined;
  }
  secrets.sshPassword = sshPassword === "" ? undefined : sshPassword;

  const sshPassphrase = await vscode.window.showInputBox({
    title: "SSH key passphrase",
    password: true,
    value: existingSecrets?.sshPassphrase ?? "",
    prompt: "Optional. Stored securely. For an encrypted private key.",
  });
  if (sshPassphrase === undefined) {
    return undefined;
  }
  secrets.sshPassphrase = sshPassphrase === "" ? undefined : sshPassphrase;

  return {
    configHost: configHost.trim() || undefined,
    host: sshHost.trim() || undefined,
    port: sshPortStr.trim() ? Number(sshPortStr) : undefined,
    user: sshUser.trim() || undefined,
    identityFile: identityFile.trim() || undefined,
  };
}
