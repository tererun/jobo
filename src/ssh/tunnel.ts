/**
 * SSH tunnel service.
 *
 * Opens an SSH connection (ssh2) and a local TCP listener that forwards each
 * incoming socket to a remote host:port through the SSH channel. The local
 * endpoint (127.0.0.1:<random port>) is then handed to a database driver, so
 * the driver connects as if the database were local.
 */

import * as net from "net";
import { promises as fs } from "fs";
import { Client, type ConnectConfig } from "ssh2";
import type { ResolvedSshConfig } from "../connections/types";

/** Remote target the tunnel forwards to. */
export interface TunnelTarget {
  host: string;
  port: number;
}

/** An open tunnel; close() tears down the listener and SSH client. */
export interface SshTunnel {
  /** Local host the driver should connect to. */
  localHost: string;
  /** Local port the driver should connect to. */
  localPort: number;
  close(): Promise<void>;
}

async function buildConnectConfig(ssh: ResolvedSshConfig): Promise<ConnectConfig> {
  const cfg: ConnectConfig = {
    host: ssh.host,
    port: ssh.port,
    username: ssh.user,
  };
  if (ssh.identityFile) {
    cfg.privateKey = await fs.readFile(ssh.identityFile);
    if (ssh.passphrase) {
      cfg.passphrase = ssh.passphrase;
    }
  }
  if (ssh.password) {
    cfg.password = ssh.password;
  }
  return cfg;
}

/**
 * Open an SSH tunnel forwarding a local ephemeral port to `target` through the
 * SSH server described by `ssh`.
 */
export async function openTunnel(
  ssh: ResolvedSshConfig,
  target: TunnelTarget
): Promise<SshTunnel> {
  const connectConfig = await buildConnectConfig(ssh);
  const client = new Client();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    client.once("error", onError);
    client.once("ready", () => {
      client.removeListener("error", onError);
      resolve();
    });
    client.connect(connectConfig);
  });

  const server = net.createServer((socket) => {
    client.forwardOut(
      socket.remoteAddress ?? "127.0.0.1",
      socket.remotePort ?? 0,
      target.host,
      target.port,
      (err, stream) => {
        if (err) {
          socket.destroy(err);
          return;
        }
        socket.pipe(stream);
        stream.pipe(socket);
        stream.on("error", () => socket.destroy());
        socket.on("error", () => stream.end());
      }
    );
  });

  const localPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // Port 0 -> OS assigns an ephemeral port.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to determine local tunnel port."));
      }
    });
  });

  // Tear down the SSH client if it dies unexpectedly.
  client.on("close", () => server.close());

  return {
    localHost: "127.0.0.1",
    localPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          client.end();
          resolve();
        });
      }),
  };
}
