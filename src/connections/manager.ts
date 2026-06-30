/**
 * ConnectionManager — owns connection definitions, secrets, and live drivers.
 *
 * Persistence:
 *   - Non-secret connection configs live in the `jobo.connections` setting.
 *   - Secrets (db password, ssh password/passphrase) live in SecretStorage,
 *     keyed by connection id.
 *
 * Lifecycle:
 *   - connect(id): resolve secrets, open an SSH tunnel if configured, build
 *     driver options pointing at the (possibly tunneled) host:port, create and
 *     connect the driver.
 *   - disconnect(id): close the driver and tear down the tunnel.
 *   - getDriver(id): expose the live driver to consumers (tree/notebook/table).
 */

import * as vscode from "vscode";
import { createDriver } from "../drivers/factory";
import type { JoboDriver, DriverConnectionOptions } from "../drivers/driver";
import { openTunnel, type SshTunnel } from "../ssh/tunnel";
import { resolveSshOptions } from "../ssh/sshConfig";
import type {
  ConnectionConfig,
  ConnectionSecrets,
  ConnectionStatus,
} from "./types";

const CONFIG_SECTION = "jobo";
const CONNECTIONS_KEY = "connections";
const SECRET_PREFIX = "jobo.secret.";

/** A connection that is currently live. */
interface ActiveConnection {
  driver: JoboDriver;
  tunnel?: SshTunnel;
}

/** Event payload when a connection's status changes. */
export interface ConnectionStatusEvent {
  id: string;
  status: ConnectionStatus;
  error?: Error;
}

export class ConnectionManager implements vscode.Disposable {
  private readonly active = new Map<string, ActiveConnection>();
  private readonly statuses = new Map<string, ConnectionStatus>();

  private readonly _onDidChangeStatus =
    new vscode.EventEmitter<ConnectionStatusEvent>();
  /** Fired whenever a connection's status changes. */
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- Persistence: connection configs ------------------------------------

  /** All persisted connection definitions. */
  getConnections(): ConnectionConfig[] {
    return vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<ConnectionConfig[]>(CONNECTIONS_KEY, []);
  }

  /** Look up a single connection config by id. */
  getConnection(id: string): ConnectionConfig | undefined {
    return this.getConnections().find((c) => c.id === id);
  }

  /** Insert or update a connection config (matched by id). */
  async saveConnection(config: ConnectionConfig): Promise<void> {
    const all = this.getConnections();
    const idx = all.findIndex((c) => c.id === config.id);
    if (idx >= 0) {
      all[idx] = config;
    } else {
      all.push(config);
    }
    await this.persistConnections(all);
  }

  /** Remove a connection config and its secrets, disconnecting first. */
  async deleteConnection(id: string): Promise<void> {
    await this.disconnect(id);
    await this.clearSecrets(id);
    const all = this.getConnections().filter((c) => c.id !== id);
    await this.persistConnections(all);
  }

  private async persistConnections(all: ConnectionConfig[]): Promise<void> {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(CONNECTIONS_KEY, all, vscode.ConfigurationTarget.Global);
  }

  // --- Persistence: secrets ------------------------------------------------

  private secretKey(id: string): string {
    return `${SECRET_PREFIX}${id}`;
  }

  /** Store secrets for a connection. Pass an empty object to clear. */
  async setSecrets(id: string, secrets: ConnectionSecrets): Promise<void> {
    await this.context.secrets.store(this.secretKey(id), JSON.stringify(secrets));
  }

  /** Retrieve stored secrets for a connection (empty object if none). */
  async getSecrets(id: string): Promise<ConnectionSecrets> {
    const raw = await this.context.secrets.get(this.secretKey(id));
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw) as ConnectionSecrets;
    } catch {
      return {};
    }
  }

  /** Delete all secrets for a connection. */
  async clearSecrets(id: string): Promise<void> {
    await this.context.secrets.delete(this.secretKey(id));
  }

  // --- Lifecycle -----------------------------------------------------------

  /** Current status of a connection. */
  getStatus(id: string): ConnectionStatus {
    return this.statuses.get(id) ?? "disconnected";
  }

  private setStatus(id: string, status: ConnectionStatus, error?: Error): void {
    this.statuses.set(id, status);
    this._onDidChangeStatus.fire({ id, status, error });
  }

  /** The live driver for a connection, if connected. */
  getDriver(id: string): JoboDriver | undefined {
    return this.active.get(id)?.driver;
  }

  /** Whether a connection currently has a live driver. */
  isConnected(id: string): boolean {
    return this.active.has(id);
  }

  /** Build driver options, opening an SSH tunnel when configured. */
  private async buildDriverOptions(
    config: ConnectionConfig
  ): Promise<{ options: DriverConnectionOptions; tunnel?: SshTunnel }> {
    const secrets = await this.getSecrets(config.id);

    let host = config.host;
    let port = config.port;
    let tunnel: SshTunnel | undefined;

    if (config.ssh && config.driver !== "sqlite") {
      if (!config.host || !config.port) {
        throw new Error(
          "An SSH tunnel requires the target database host and port to be set."
        );
      }
      const useSshConfig = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<boolean>("useSshConfig", true);
      const sshResolved = await resolveSshOptions(config.ssh, secrets, useSshConfig);
      tunnel = await openTunnel(sshResolved, { host: config.host, port: config.port });
      host = tunnel.localHost;
      port = tunnel.localPort;
    }

    const options: DriverConnectionOptions = {
      kind: config.driver,
      host,
      port,
      database: config.database,
      user: config.user,
      password: secrets.password,
      ssl: config.ssl,
      file: config.file,
    };
    return { options, tunnel };
  }

  /** Connect a stored connection by id and return the live driver. */
  async connect(id: string): Promise<JoboDriver> {
    const existing = this.active.get(id);
    if (existing) {
      return existing.driver;
    }
    const config = this.getConnection(id);
    if (!config) {
      throw new Error(`Connection not found: ${id}`);
    }

    this.setStatus(id, "connecting");
    let tunnel: SshTunnel | undefined;
    try {
      const built = await this.buildDriverOptions(config);
      tunnel = built.tunnel;
      const driver = createDriver(built.options);
      await driver.connect();
      this.active.set(id, { driver, tunnel });
      this.setStatus(id, "connected");
      return driver;
    } catch (err) {
      if (tunnel) {
        await tunnel.close().catch(() => undefined);
      }
      const error = err instanceof Error ? err : new Error(String(err));
      this.setStatus(id, "error", error);
      throw error;
    }
  }

  /** Disconnect a connection, closing its driver and tunnel. */
  async disconnect(id: string): Promise<void> {
    const conn = this.active.get(id);
    if (!conn) {
      return;
    }
    this.active.delete(id);
    try {
      await conn.driver.close();
    } finally {
      if (conn.tunnel) {
        await conn.tunnel.close().catch(() => undefined);
      }
      this.setStatus(id, "disconnected");
    }
  }

  /** Disconnect all live connections. */
  async disconnectAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.disconnect(id)));
  }

  dispose(): void {
    void this.disconnectAll();
    this._onDidChangeStatus.dispose();
  }
}
