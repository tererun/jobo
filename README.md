<div align="center">
  <a href="#">
    <img src="./media/jobo.svg" width="140" height="auto" alt="Jobo" />
  </a>
  <h1>Jobo <sub>条坊</sub></h1>
</div>

<hr />

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com/)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

English | [日本語](./README-ja.md)

Jobo - _**means the grid-like ward layout (条坊) of ancient Japanese capitals**_ - is a database client for VS Code. The street-grid that divided cities like Heijō-kyō into evenly ruled blocks is the metaphor behind how Jobo lays out your data: every query result and table is rendered as a tidy grid of "wards".

A capable client, but always easy on the eyes.

```sql
-- %%
SELECT id, name, created_at
FROM users
WHERE active = true
ORDER BY created_at DESC
LIMIT 50;
```

## Quick Start

```bash
npm install
# Open this folder in VS Code and press F5 to launch the Extension Development Host
```

## Features

- **Multi-database** 🗄️ - First-class support for **PostgreSQL** (`pg`), **MySQL / MariaDB** (`mysql2`), and **SQLite** (`node-sqlite3-wasm`, a pure-WASM build with no native compilation).
- **SSH Tunnel** 🔐 - Connect securely through an SSH bastion via local port forwarding (`ssh2`). Reads `~/.ssh/config`: point a connection at a `Host` alias and `HostName` / `User` / `Port` / `IdentityFile` are filled in for you. Manual overrides supported.
- **Notebook-style SQL** 📓 - Run SQL cell by cell in `.jobonb` (JSON) or `.sql` (plain text split on `-- %%`) notebooks, against the connection you select.
- **Ward-grid results** 🏯 - Results render as a "条坊" ward-grid: every cell crisply ruled like a city block, with column sorting and client-side paging.
- **Editable table view** ✏️ - Open a table, switch to edit mode, and stage cell edits, row inserts, and row deletes as pending changes - then commit them through a two-step Execute confirmation (see below).
- **Safe by construction** 🛡️ - Identifier and value quoting always happens driver-side, so the webview only ever sends structured changes, never raw SQL.

## The 条坊 (Jobo) Concept

The _jōbō_ system was an urban plan used in ancient Japanese capitals (Heijō-kyō, Heian-kyō, ...) that divided a city into a checkerboard of streets. Each ward (block) sits in an even, ordered grid - and that is exactly how Jobo presents data:

- **Table = ward** - the table list and table view are treated as neatly partitioned blocks.
- **Result grid = ward layout** - each cell of a query result is drawn as a single ruled block (the `.jobo-grid` "ward-grid" style).

## Usage

### 1. Add a connection

1. Open the **Jobo** icon in the Activity Bar to reveal the **Connections** view.
2. Click **＋ (Add Connection)** in the view title, or **Add Connection** in the welcome view.
3. Follow the input prompts:
   - **Connection name** - display name (required)
   - **Database driver** - PostgreSQL / MySQL / MariaDB / SQLite
   - **SQLite** - enter the path to the database file
   - **PostgreSQL / MySQL** - Host / Port / Database / User / Password / SSL, then whether to use an SSH tunnel
4. Secrets (passwords, passphrases) are stored in VS Code **SecretStorage**. Everything else is stored under `jobo.connections` in `settings.json`.

Right-click a connection node for **Connect / Disconnect / Edit / Delete**. Expand a connected node to browse databases, schemas, tables, and columns.

### 2. Configure an SSH tunnel

When adding a connection, answer **Yes** to "Connect through an SSH tunnel?" to enter SSH settings.

- **Using `configHost` (a `~/.ssh/config` alias)** - enter a `Host` name from `~/.ssh/config`. Missing fields (`HostName` / `User` / `Port` / `IdentityFile` / `ProxyJump`) are resolved automatically; anything you type overrides the config value. Toggle resolution with the `jobo.useSshConfig` setting (default `true`).
- **Manual** - leave `configHost` empty and enter SSH host / port / user / identity file / password / passphrase directly.

On connect, `ssh2` forwards `127.0.0.1:<random local port>` to the remote `dbHost:dbPort`, and the driver connects to that local `host:port`.

```sshconfig
Host my-db-bastion
  HostName bastion.example.com
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  Port 22
```

With the above, setting just `configHost = my-db-bastion` fills in host, user, key, and port.

### 3. Use the SQL notebook

- **New** - run **Jobo: New SQL Notebook** from the Command Palette, or open a `.jobonb` / `.sql` file.
- **Target connection** - the target connection is shown in the status bar (bottom-right). Click it (**Select Target Connection**) or use the plug icon in the notebook toolbar. Running a cell with no target prompts you to pick one.
- **Run** - execute a `sql` code cell to query the target connection (it auto-connects if needed).
- **Results** - `SELECT` results render in the **ward-grid** (`x-application/jobo-grid` renderer) with header-click sorting and paging. DML shows "N row(s) affected" plus timing, with a `text/plain` fallback.
- **Saving** - `.jobonb` saves as JSON; `.sql` saves as plain text with `-- %%` cell separators. Outputs are not persisted (`transientOutputs`).

### 4. Editable table view & the two-step Execute flow

Click a table in the tree (or its inline **table** icon) to open the table view webview.

- **View mode (default)** - runs `SELECT * FROM <table> LIMIT n` (`n` = `jobo.defaultQueryLimit`, default 200) and renders the ward-grid with sorting/paging.
- **Edit mode**
  - Rows are identified by **primary keys** (`getPrimaryKeys`). Tables without a primary key allow inserts only.
  - **Double-click** a cell to edit, **+ Add Row** to append, or the trash button to **mark a row for deletion**.
  - Changes are not executed immediately - they accumulate as **pending changes** in the webview and changed cells/rows are highlighted.

**Two-step Execute (confirm) flow**

1. **Step 1** - press **Execute ▸** in the top-right. Pending changes go to the extension host, which uses `buildStatements()` (`src/sql/builder.ts`) to generate `UPDATE` / `INSERT` / `DELETE` and **only shows them in a modal** (nothing runs yet).
   - Edit → `UPDATE <tbl> SET col=val ... WHERE pk=val`
   - Insert → `INSERT INTO <tbl> (...) VALUES (...)`
   - Delete → `DELETE FROM <tbl> WHERE pk=val`
   - Execution order is fixed to **DELETE → UPDATE → INSERT** for safety.
2. **Step 2** - press **Execute (Confirm)** inside the modal to commit. The host does not trust the previewed SQL: it **re-generates** statements server-side and runs them via `driver.execTransaction(statements)` as a **single transaction**.
   - Success: shows a message, reloads the grid, and clears pending changes.
   - Failure: the transaction rolls back and the error is shown in the modal.
   - Cancel: closes the modal, keeping pending changes, without running anything.

```mermaid
flowchart LR
  Edit[Edit / Insert / Delete] --> Pending[Accumulate pending changes]
  Pending --> Btn["Execute (step 1)"]
  Btn --> Gen[Generate UPDATE/INSERT/DELETE]
  Gen --> Dialog[Show SQL list in modal]
  Dialog -->|"Execute Confirm (step 2)"| Tx[Run via execTransaction]
  Dialog -->|Cancel| Pending
  Tx --> Reload[Reload grid + clear pending]
```

## Settings

| Setting                  | Default | Description                                                                                             |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| `jobo.connections`       | `[]`    | Array of connection definitions. Contains no secrets (passwords/passphrases are kept in SecretStorage). |
| `jobo.defaultQueryLimit` | `200`   | Default `LIMIT` applied when browsing a table in view mode.                                             |
| `jobo.useSshConfig`      | `true`  | Whether to resolve missing SSH settings from `~/.ssh/config` when `configHost` is set.                  |

## Development

### Requirements

- VS Code `^1.90.0`
- Node.js 18+

### Scripts

```bash
npm install
npm run typecheck   # type-check only (tsc --noEmit)
npm run lint        # ESLint
npm run build       # production bundle (dist/extension.js + dist/renderer.js)
npm run watch       # rebuild on change
npm run compile     # typecheck + dev bundle
```

### Run the extension

1. Open this folder in VS Code.
2. Press `F5` to launch the **Extension Development Host**.
3. Open the **Jobo** icon in the Activity Bar to use the Connections view.

### Package (optional)

```bash
npx @vscode/vsce package
```

(`vscode:prepublish` runs `npm run build`.)

## Architecture

```
UI Layer         Core                        Drivers
─────────        ───────────────────         ─────────────────────
Connections ──▶  ConnectionManager  ──▶ Driver Factory ──▶ PostgreSQL (pg)
TreeView         (settings + SecretStorage)                MySQL (mysql2)
SQL Notebook ─▶  SSH Tunnel (ssh2) ◀── ~/.ssh/config       SQLite (node-sqlite3-wasm)
Ward grid        └ local port forward → DB
```

`ConnectionManager` reads settings, opens an SSH tunnel when configured (resolving `~/.ssh/config` hosts), and hands the local `host:port` to the driver.

### Key files

- `src/extension.ts` - `activate` entry; wires `registerConnectionsTree` / `registerNotebook` / `registerTableView`.
- `src/connections/` - connection types and the ConnectionManager (connect/disconnect/storage).
- `src/ssh/tunnel.ts`, `src/ssh/sshConfig.ts` - SSH tunnel and `~/.ssh/config` parser.
- `src/drivers/` - the shared interface (`driver.ts`), each driver, and the factory.
- `src/tree/connectionsProvider.ts` - the Connections tree and connection commands.
- `src/notebook/` - serializer, controller (execution kernel), and the result-grid renderer.
- `src/webview/tableView.ts` - the editable table view webview and two-step Execute flow.
- `src/sql/builder.ts` - generates UPDATE/INSERT/DELETE from pending changes (pure functions; quoting is driver-specific).
- `src/shared/gridData.ts` - the shared grid payload type (MIME `x-application/jobo-grid`).
- `media/` - webview/renderer assets (CSS/JS).

## Testing

### Headless verification

The driver + SQL builder path is verifiable without a GUI (e.g. in CI):

- create a SQLite file/table and insert rows with `node-sqlite3-wasm`
- check the `QueryResult` shape from `query()` (`columns` / `rows` / `rowCount` / `durationMs`)
- `listTables` / `listColumns` / `getPrimaryKeys`
- generate UPDATE/INSERT/DELETE via `buildStatements()`, run them through `execTransaction()`, and confirm the data changed
- confirm a transaction containing an invalid statement rolls back

### Manual test checklist

Launch the Extension Development Host with `F5` and verify (GUI required, so run these yourself):

- [ ] **SQLite local connection** - add a SQLite connection and expand Connect → table → columns in the tree.
- [ ] **Notebook → grid** - open a `.jobonb` (or `Jobo: New SQL Notebook`), pick a target, run a `SELECT` cell, and see the ward-grid with working sort/paging.
- [ ] **Table view (browse)** - click a table in the tree and see `SELECT * ... LIMIT n` results in view mode.
- [ ] **Table view (edit → two-step Execute)** - in edit mode, edit/insert/delete, press **Execute ▸** to open the SQL modal (nothing runs), then **Execute (Confirm)** to run `execTransaction`; the grid reloads and pending clears.
- [ ] **Rollback on error** - introduce a failing change and confirm it rolls back with an error.
- [ ] **Inline icon** - the table view also opens from the table icon shown on hover.
- [ ] **SSH tunnel** - set `configHost` to a `~/.ssh/config` Host and connect to PostgreSQL / MySQL through the tunnel, then browse and query.

## Contributing

Contributions are welcome! Open an issue to propose a feature or report a bug, or send a pull request to fix a bug, refactor, or improve the docs.

## License

Distributed under the MIT License. See [LICENSE](./LICENSE) for more information.
