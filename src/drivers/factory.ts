/**
 * Driver factory — constructs a JoboDriver for given connection options.
 */

import type { JoboDriver, DriverConnectionOptions } from "./driver";
import { PostgresDriver } from "./postgres";
import { MysqlDriver } from "./mysql";
import { SqliteDriver } from "./sqlite";

/** Create (but do not connect) a driver for the given options. */
export function createDriver(options: DriverConnectionOptions): JoboDriver {
  switch (options.kind) {
    case "postgres":
      return new PostgresDriver(options);
    case "mysql":
      return new MysqlDriver(options);
    case "sqlite":
      return new SqliteDriver(options);
    default: {
      const exhaustive: never = options.kind;
      throw new Error(`Unsupported driver kind: ${String(exhaustive)}`);
    }
  }
}
