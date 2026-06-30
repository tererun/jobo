/**
 * ~/.ssh/config parsing and host resolution.
 *
 * Given a connection's SshConfig, resolves the effective SSH parameters by
 * reading ~/.ssh/config (when a configHost is given) and letting any explicitly
 * provided fields override the resolved values.
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import SSHConfig from "ssh-config";
import type { SshConfig, ResolvedSshConfig, ConnectionSecrets } from "../connections/types";

const DEFAULT_SSH_PORT = 22;

/** Values resolved from ~/.ssh/config for a given host alias. */
export interface SshConfigEntry {
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function expandHome(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Default location of the user's SSH config file. */
export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), ".ssh", "config");
}

/**
 * Resolve a host alias from an ssh config file. Returns undefined if the file
 * cannot be read. Missing directives simply yield undefined fields.
 */
export async function resolveSshConfigHost(
  hostAlias: string,
  configPath: string = defaultSshConfigPath()
): Promise<SshConfigEntry | undefined> {
  let text: string;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return undefined;
  }

  const config = SSHConfig.parse(text);
  const computed = config.compute(hostAlias) as Record<string, string | string[]>;

  const portStr = firstValue(computed.Port);
  const identityFile = firstValue(computed.IdentityFile);

  return {
    hostName: firstValue(computed.HostName),
    user: firstValue(computed.User),
    port: portStr ? Number(portStr) : undefined,
    identityFile: identityFile ? expandHome(identityFile) : undefined,
    proxyJump: firstValue(computed.ProxyJump),
  };
}

/**
 * Produce the effective SSH parameters used to open a tunnel.
 *
 * Resolution order (later wins): ~/.ssh/config (if configHost + useSshConfig)
 * < explicit SshConfig fields. Secrets are merged in from SecretStorage.
 */
export async function resolveSshOptions(
  ssh: SshConfig,
  secrets: ConnectionSecrets,
  useSshConfig: boolean,
  configPath: string = defaultSshConfigPath()
): Promise<ResolvedSshConfig> {
  let resolved: SshConfigEntry | undefined;
  if (useSshConfig && ssh.configHost) {
    resolved = await resolveSshConfigHost(ssh.configHost, configPath);
  }

  const host = ssh.host ?? resolved?.hostName ?? ssh.configHost;
  if (!host) {
    throw new Error(
      "SSH tunnel: no host could be determined (set ssh.host or a resolvable ssh.configHost)."
    );
  }

  const user = ssh.user ?? resolved?.user;
  if (!user) {
    throw new Error("SSH tunnel: no user could be determined (set ssh.user or User in ~/.ssh/config).");
  }

  const identityFile = ssh.identityFile
    ? expandHome(ssh.identityFile)
    : resolved?.identityFile;

  return {
    host,
    port: ssh.port ?? resolved?.port ?? DEFAULT_SSH_PORT,
    user,
    identityFile,
    password: secrets.sshPassword,
    passphrase: secrets.sshPassphrase,
  };
}
