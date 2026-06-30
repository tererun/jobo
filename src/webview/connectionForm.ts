/**
 * Connection form view (Webview).
 *
 * Replaces the old sequential `showInputBox` / `showQuickPick` dialog flow for
 * adding and editing connections with a single, proper form rendered in a
 * Webview panel. All fields are visible at once, the driver selector toggles
 * the relevant field groups (SQLite file vs. networked host/port/...), and an
 * SSH tunnel section can be expanded when needed.
 *
 * Message protocol:
 *   webview -> host:
 *     { type: "ready" }                 — request the initial form values
 *     { type: "submit", data }          — user pressed Save with the form data
 *     { type: "cancel" }                — user pressed Cancel / Esc
 *   host -> webview:
 *     { type: "init", isEdit, data }    — initial values to populate the form
 *     { type: "error", message }        — validation/save failure (kept open)
 *
 * On a valid submit the host assembles the `ConnectionConfig` (generating a new
 * id for adds, preserving it for edits) and `ConnectionSecrets`, persists both
 * through the `ConnectionManager`, notifies the caller via `onSaved`, and closes
 * the panel.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import { randomUUID } from "node:crypto";
import type { ConnectionManager } from "../connections/manager";
import type {
  ConnectionConfig,
  ConnectionSecrets,
} from "../connections/types";
import type { DriverKind } from "../drivers/driver";

const VIEW_TYPE = "jobo.connectionForm";

/** Flat, JSON-safe shape exchanged with the webview form. */
interface FormData {
  name: string;
  driver: DriverKind;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  file: string;
  ssl: boolean;
  useSsh: boolean;
  sshConfigHost: string;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshIdentityFile: string;
  sshPassword: string;
  sshPassphrase: string;
}

/** Messages the webview sends to the host. */
type InboundMessage =
  | { type: "ready" }
  | { type: "submit"; data: FormData }
  | { type: "cancel" };

export interface OpenConnectionFormOptions {
  existing?: ConnectionConfig;
  existingSecrets?: ConnectionSecrets;
  /** Called with the connection id after a successful save. */
  onSaved: (id: string) => void;
}

/** Active form panels keyed by connection id ("__new__" for adds). */
const panels = new Map<string, ConnectionFormPanel>();

/**
 * Open (or focus) the add/edit connection form. Editing an existing connection
 * focuses the already-open panel for that connection rather than stacking a
 * duplicate.
 */
export function openConnectionForm(
  context: vscode.ExtensionContext,
  manager: ConnectionManager,
  options: OpenConnectionFormOptions
): void {
  const key = options.existing?.id ?? "__new__";
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }
  const panel = new ConnectionFormPanel(context, manager, options, () =>
    panels.delete(key)
  );
  panels.set(key, panel);
}

/** Manages a single add/edit connection form panel. */
class ConnectionFormPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly options: OpenConnectionFormOptions,
    private readonly onDispose: () => void
  ) {
    const isEdit = Boolean(options.existing);
    const title = isEdit
      ? `Edit Connection: ${options.existing?.name ?? ""}`
      : "New Connection";
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
        ],
      }
    );
    this.panel.iconPath = new vscode.ThemeIcon("plug");

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

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg?.type) {
      case "ready":
        await this.panel.webview.postMessage({
          type: "init",
          isEdit: Boolean(this.options.existing),
          data: this.initialData(),
        });
        break;
      case "submit":
        await this.handleSubmit(msg.data);
        break;
      case "cancel":
        this.panel.dispose();
        break;
      default:
        break;
    }
  }

  private initialData(): FormData {
    const existing = this.options.existing;
    const secrets = this.options.existingSecrets ?? {};
    const ssh = existing?.ssh;
    return {
      name: existing?.name ?? "",
      driver: existing?.driver ?? "postgres",
      host: existing?.host ?? "localhost",
      port: existing?.port != null ? String(existing.port) : "",
      database: existing?.database ?? "",
      user: existing?.user ?? "",
      password: secrets.password ?? "",
      file: existing?.file ?? "",
      ssl: existing?.ssl ?? false,
      useSsh: Boolean(ssh),
      sshConfigHost: ssh?.configHost ?? "",
      sshHost: ssh?.host ?? "",
      sshPort: ssh?.port != null ? String(ssh.port) : "",
      sshUser: ssh?.user ?? "",
      sshIdentityFile: ssh?.identityFile ?? "",
      sshPassword: secrets.sshPassword ?? "",
      sshPassphrase: secrets.sshPassphrase ?? "",
    };
  }

  private async handleSubmit(data: FormData): Promise<void> {
    try {
      const { config, secrets } = this.buildConnection(data);
      await this.manager.saveConnection(config);
      await this.manager.setSecrets(config.id, secrets);
      this.options.onSaved(config.id);
      this.panel.dispose();
    } catch (err) {
      await this.panel.webview.postMessage({
        type: "error",
        message: errorMessage(err),
      });
    }
  }

  /** Validate and assemble the persisted config + secrets from form data. */
  private buildConnection(data: FormData): {
    config: ConnectionConfig;
    secrets: ConnectionSecrets;
  } {
    const name = (data.name ?? "").trim();
    if (name === "") {
      throw new Error("Name is required.");
    }
    const driver = data.driver;
    if (driver !== "postgres" && driver !== "mysql" && driver !== "sqlite") {
      throw new Error("A database driver must be selected.");
    }

    const config: ConnectionConfig = {
      id: this.options.existing?.id ?? randomUUID(),
      name,
      driver,
    };
    const secrets: ConnectionSecrets = {};

    if (driver === "sqlite") {
      const file = (data.file ?? "").trim();
      if (file === "") {
        throw new Error("A SQLite database file path is required.");
      }
      config.file = file;
      return { config, secrets };
    }

    config.host = (data.host ?? "").trim() || "localhost";

    const portStr = (data.port ?? "").trim();
    if (portStr !== "") {
      const port = Number(portStr);
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error("Port must be a positive number.");
      }
      config.port = port;
    } else {
      config.port = driver === "postgres" ? 5432 : 3306;
    }

    config.database = (data.database ?? "").trim() || undefined;
    config.user = (data.user ?? "").trim() || undefined;
    config.ssl = Boolean(data.ssl);

    const password = data.password ?? "";
    secrets.password = password === "" ? undefined : password;

    if (data.useSsh) {
      const configHost = (data.sshConfigHost ?? "").trim();
      const sshHost = (data.sshHost ?? "").trim();
      if (configHost === "" && sshHost === "") {
        throw new Error(
          "An SSH tunnel requires either an SSH config host or an SSH host."
        );
      }
      const sshPortStr = (data.sshPort ?? "").trim();
      let sshPort: number | undefined;
      if (sshPortStr !== "") {
        sshPort = Number(sshPortStr);
        if (!Number.isFinite(sshPort) || sshPort <= 0) {
          throw new Error("SSH port must be a positive number.");
        }
      }
      config.ssh = {
        configHost: configHost || undefined,
        host: sshHost || undefined,
        port: sshPort,
        user: (data.sshUser ?? "").trim() || undefined,
        identityFile: (data.sshIdentityFile ?? "").trim() || undefined,
      };
      const sshPassword = data.sshPassword ?? "";
      secrets.sshPassword = sshPassword === "" ? undefined : sshPassword;
      const sshPassphrase = data.sshPassphrase ?? "";
      secrets.sshPassphrase = sshPassphrase === "" ? undefined : sshPassphrase;
    }

    return { config, secrets };
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "connectionForm.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "connectionForm.css"
      )
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
  <title>Jobo Connection</title>
</head>
<body>
  <form id="form" class="jobo-form" autocomplete="off">
    <h1 class="jobo-form__title" id="form-title">Connection</h1>
    <p class="jobo-form__error" id="error" hidden></p>

    <section class="jobo-field">
      <label for="name">Name</label>
      <input id="name" name="name" type="text" placeholder="My database" required />
    </section>

    <section class="jobo-field">
      <label for="driver">Driver</label>
      <select id="driver" name="driver">
        <option value="postgres">PostgreSQL</option>
        <option value="mysql">MySQL / MariaDB</option>
        <option value="sqlite">SQLite</option>
      </select>
    </section>

    <div id="group-sqlite" class="jobo-group" hidden>
      <section class="jobo-field">
        <label for="file">Database file path</label>
        <input id="file" name="file" type="text" placeholder="/path/to/database.sqlite" />
      </section>
    </div>

    <div id="group-network" class="jobo-group">
      <div class="jobo-row">
        <section class="jobo-field jobo-field--grow">
          <label for="host">Host</label>
          <input id="host" name="host" type="text" placeholder="localhost" />
        </section>
        <section class="jobo-field jobo-field--port">
          <label for="port">Port</label>
          <input id="port" name="port" type="text" inputmode="numeric" placeholder="5432" />
        </section>
      </div>

      <section class="jobo-field">
        <label for="database">Database</label>
        <input id="database" name="database" type="text" placeholder="postgres" />
      </section>

      <section class="jobo-field">
        <label for="user">User</label>
        <input id="user" name="user" type="text" placeholder="postgres" />
      </section>

      <section class="jobo-field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" placeholder="(stored securely)" />
        <span class="jobo-hint">Stored securely in SecretStorage, not in settings.</span>
      </section>

      <section class="jobo-field jobo-field--check">
        <label class="jobo-check">
          <input id="ssl" name="ssl" type="checkbox" />
          <span>Use SSL</span>
        </label>
      </section>

      <section class="jobo-field jobo-field--check">
        <label class="jobo-check">
          <input id="useSsh" name="useSsh" type="checkbox" />
          <span>Connect through an SSH tunnel</span>
        </label>
      </section>

      <fieldset id="group-ssh" class="jobo-fieldset" hidden>
        <legend>SSH tunnel</legend>

        <section class="jobo-field">
          <label for="sshConfigHost">SSH config host</label>
          <input id="sshConfigHost" name="sshConfigHost" type="text" placeholder="alias from ~/.ssh/config" />
          <span class="jobo-hint">Optional. Missing fields below are filled from ~/.ssh/config.</span>
        </section>

        <div class="jobo-row">
          <section class="jobo-field jobo-field--grow">
            <label for="sshHost">SSH host</label>
            <input id="sshHost" name="sshHost" type="text" placeholder="bastion.example.com" />
          </section>
          <section class="jobo-field jobo-field--port">
            <label for="sshPort">SSH port</label>
            <input id="sshPort" name="sshPort" type="text" inputmode="numeric" placeholder="22" />
          </section>
        </div>

        <section class="jobo-field">
          <label for="sshUser">SSH user</label>
          <input id="sshUser" name="sshUser" type="text" placeholder="ubuntu" />
        </section>

        <section class="jobo-field">
          <label for="sshIdentityFile">Identity file</label>
          <input id="sshIdentityFile" name="sshIdentityFile" type="text" placeholder="~/.ssh/id_ed25519" />
        </section>

        <section class="jobo-field">
          <label for="sshPassword">SSH password</label>
          <input id="sshPassword" name="sshPassword" type="password" placeholder="(stored securely)" />
          <span class="jobo-hint">Optional. Leave blank to use key auth.</span>
        </section>

        <section class="jobo-field">
          <label for="sshPassphrase">Key passphrase</label>
          <input id="sshPassphrase" name="sshPassphrase" type="password" placeholder="(stored securely)" />
          <span class="jobo-hint">Optional. For an encrypted private key.</span>
        </section>
      </fieldset>
    </div>

    <div class="jobo-actions">
      <button type="button" id="cancel" class="jobo-btn jobo-btn--secondary">Cancel</button>
      <button type="submit" id="save" class="jobo-btn">Save</button>
    </div>
  </form>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}
