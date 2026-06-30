/**
 * Connection configuration types.
 *
 * A ConnectionConfig is the non-secret part of a connection, persisted in the
 * `jobo.connections` setting. Secrets (passwords/passphrases) are stored in
 * VSCode SecretStorage keyed by the connection id and never written to settings.
 */

import type { DriverKind } from "../drivers/driver";

/** SSH tunnel configuration (non-secret parts). */
export interface SshConfig {
  /** Host alias resolved from ~/.ssh/config. Other fields override the resolved ones. */
  configHost?: string;
  host?: string;
  port?: number;
  user?: string;
  /** Path to a private key file. */
  identityFile?: string;
  // password / passphrase live in SecretStorage, not here.
}

/** Resolved SSH options including secrets, ready to open a tunnel. */
export interface ResolvedSshConfig {
  host: string;
  port: number;
  user: string;
  identityFile?: string;
  password?: string;
  passphrase?: string;
}

/** A persisted connection definition (no secrets). */
export interface ConnectionConfig {
  id: string;
  name: string;
  driver: DriverKind;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** SQLite database file path. */
  file?: string;
  ssl?: boolean;
  ssh?: SshConfig;
}

/** Runtime connection status, surfaced to the tree view. */
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/** Secrets associated with a connection, stored in SecretStorage. */
export interface ConnectionSecrets {
  /** Database password. */
  password?: string;
  /** SSH login password. */
  sshPassword?: string;
  /** SSH private key passphrase. */
  sshPassphrase?: string;
}
