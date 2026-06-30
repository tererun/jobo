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
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#コントリビュート)

[English](./README.md) | 日本語

Jobo は、平城京などの古代日本の都に採用された碁盤の目状の区画割り **条坊（じょうぼう）** に着想を得た、VSCode 用データベースクライアント拡張です。街路で都市を均等な街区に区切るその姿をメタファに、クエリ結果やテーブルを常に整然とした「区画（ward）」のグリッドで表示します。

機能的でありながら、結果が常に読みやすい格子として整列します。

```sql
-- %%
SELECT id, name, created_at
FROM users
WHERE active = true
ORDER BY created_at DESC
LIMIT 50;
```

## クイックスタート

```bash
npm install
# このフォルダを VSCode で開き、F5 で Extension Development Host を起動
```

## 主な機能

- **マルチ DB 対応** 🗄️ - **PostgreSQL**（`pg`）、**MySQL / MariaDB**（`mysql2`）、**SQLite**（`node-sqlite3-wasm` — ネイティブビルド不要の純 WASM 実装）に対応。
- **SSH トンネル** 🔐 - `ssh2` のローカルポートフォワードで踏み台経由のセキュアな接続。`~/.ssh/config` を読み込み、`Host` エイリアスを指定すると `HostName` / `User` / `Port` / `IdentityFile` を自動補完。手動上書きも可能。
- **ノートブック形式の SQL** 📓 - `.jobonb`（JSON）/ `.sql`（`-- %%` でセル分割するプレーンテキスト）でセルごとに SQL を、選択した接続に対して実行。
- **条坊グリッド表示** 🏯 - 結果は「条坊」グリッドで描画。各セルが街区のように罫線で区切られ、列ソート・クライアントページングに対応。
- **編集可能なテーブルビュー** ✏️ - テーブルを開いて編集モードに切り替え、セル編集・行追加・行削除を「保留中の変更」として蓄積し、2 段階 Execute 確認で確定実行（後述）。
- **安全な設計** 🛡️ - 値・識別子のクオートは常にドライバ側で実施。Webview からは構造化された変更のみが送られ、生 SQL は流れません。

## 条坊（じょうぼう）というコンセプト

条坊制は、古代日本の都（平城京・平安京など）で採用された、街路で都市を碁盤目状に区切る都市計画です。1 つ 1 つの区画（街区）が均等に並ぶその姿を、本拡張ではデータの見せ方のメタファとして採用しています。

- **テーブル = 区画** - サイドバーのテーブル一覧やテーブルビューを、整然と区切られた街区として扱う。
- **結果グリッド = 区画割り** - クエリ結果の各セルを、罫線できっちり区切られた 1 区画として描画する（`.jobo-grid` の「ward-grid」スタイル）。

## 使い方

### 1. 接続を追加する

1. アクティビティバーの **Jobo** アイコン → **Connections** ビューを開きます。
2. ビュー右上の **＋ (Add Connection)**、またはウェルカム表示の **Add Connection** をクリックします。
3. エディタタブに **接続フォーム** が開きます。各項目を入力し、**Add Connection** / **Save Changes** をクリックします。
   - **Name**：表示名（必須）
   - **Driver**：PostgreSQL / MySQL・MariaDB / SQLite（選択に応じてフォームの項目が切り替わります）
   - **SQLite の場合**：データベースファイルのパスを入力します。
   - **PostgreSQL / MySQL の場合**：Host / Port / Database / User / Password / SSL に加えて、必要なら SSH トンネルのセクションを入力します。
4. パスワードやパスフレーズなどの秘密情報は VSCode の **SecretStorage** に安全に保存されます。その他の設定は `settings.json` の `jobo.connections` に保存されます。

接続ノードの右クリック（コンテキストメニュー）から **Connect / Disconnect / Edit / Delete** を実行できます。接続済みノードを展開すると、データベース・スキーマ・テーブル・カラムを辿れます。

### 2. SSH トンネルを設定する

接続フォームの **Connect through an SSH tunnel** にチェックを入れると、SSH 設定の入力欄が表示されます。

- **`configHost`（`~/.ssh/config` のエイリアス）を使う場合**
  `~/.ssh/config` 内の `Host` 名を入力します。`HostName` / `User` / `Port` / `IdentityFile` / `ProxyJump` などの未入力項目が自動補完されます。個別の項目を入力すると、その項目だけ `~/.ssh/config` の値を上書きします。`~/.ssh/config` からの解決は設定 `jobo.useSshConfig`（既定: `true`）で切り替えられます。
- **手動で設定する場合**
  `configHost` を空のままにして、SSH host / port / user / identity file（秘密鍵のパス）/ password / passphrase を直接入力します。

接続時、`ssh2` が `127.0.0.1:<ランダムなローカルポート>` → リモートの `dbHost:dbPort` へポートフォワードし、そのローカルの `host:port` をドライバに渡して DB へ接続します。

```sshconfig
Host my-db-bastion
  HostName bastion.example.com
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  Port 22
```

この場合、接続の SSH 設定で `configHost = my-db-bastion` とだけ指定すれば、ホスト・ユーザー・鍵・ポートが補完されます。

### 3. SQL ノートブックを使う

- **新規作成**：コマンドパレットから **Jobo: New SQL Notebook** を実行します。`.jobonb`（JSON）または `.sql`（`-- %%` でセル区切り）のファイルを開くこともできます。
- **対象接続の選択**：ノートブックを開くと、右下のステータスバーに対象接続が表示されます。クリック（= **Select Target Connection**）するか、ノートブックツールバーのプラグアイコンから接続を選びます。未選択のままセルを実行すると、選択を促すクイックピックが表示されます。
- **実行**：SQL コードセル（言語 `sql`）の実行ボタンを押すと、対象接続に対してクエリが実行されます（必要に応じて自動接続）。
- **結果表示**：`SELECT` 等の結果は **条坊グリッド**（`x-application/jobo-grid` レンダラ）で表示され、列ヘッダのクリックでソート、下部でページサイズ変更・ページ送りができます。DML は「N row(s) affected」と実行時間を表示し、`text/plain` のフォールバック出力も併記されます。
- **保存形式**：`.jobonb` は JSON、`.sql` はセルを `-- %%` 区切りでまとめたプレーンテキストとして保存されます。出力は保存されません（`transientOutputs`）。

### 4. 編集可能なテーブルビューと「2 段階 Execute」フロー

ツリーでテーブルをクリック（またはテーブル行のインライン **table** アイコン）すると、テーブルビューの Webview が開きます。表示と編集はモードで分かれておらず、**常に編集可能**です。

- **読み込み**
  `SELECT * FROM <table> LIMIT n` を実行して条坊グリッドで表示します（`n` は設定 `jobo.defaultQueryLimit`、既定 200）。ソート・ページングが可能です。
- **編集**
  - 各行は **主キー**（`getPrimaryKeys`）で同定します。主キーが無いテーブルでは既存行の編集・削除はできず、行の追加のみ可能です。
  - セルを**ダブルクリック**して編集、**＋ 行を追加**で空行を追加、ゴミ箱ボタンで行を**削除マーク**します。
  - これらの変更は即時実行されず、「**保留中の変更（pending changes）**」として蓄積され、変更されたセル・行はハイライト表示されます。

**2 段階 Execute（確定実行）フロー**

1. **1 段階目**：右上の **Execute ▸** ボタンを押すと、保留中の変更が拡張ホストへ送られ、ホスト側が `src/sql/builder.ts` の `buildStatements()` でドライバを使って `UPDATE` / `INSERT` / `DELETE` を生成し、**モーダルに SQL 一覧を表示するだけ**です（この時点では未実行）。
   - 編集 → `UPDATE <tbl> SET col=値 ... WHERE pk=値`
   - 追加 → `INSERT INTO <tbl> (...) VALUES (...)`
   - 削除 → `DELETE FROM <tbl> WHERE pk=値`
   - 実行順は安全のため **DELETE → UPDATE → INSERT** に固定されます。
2. **2 段階目**：モーダル内の **Execute（確定実行）** ボタンを押すと初めて確定されます。ホストは Webview から渡された生 SQL を信用せず**サーバ側で再生成**し、`driver.execTransaction(statements)` で **1 トランザクション**として実行します。
   - 成功時：情報メッセージを表示し、グリッドを再読込して保留中の変更をクリアします。
   - 失敗時：トランザクションはロールバックされ、モーダルにエラーを表示します。
   - **キャンセル**：何も実行せず保留中の変更を保持したままモーダルを閉じます。

```mermaid
flowchart LR
  Edit[セル編集/行追加/削除] --> Pending[保留中の変更を蓄積]
  Pending --> Btn["右上 Execute（1段階目）"]
  Btn --> Gen[SQL生成 UPDATE/INSERT/DELETE]
  Gen --> Dialog[モーダルにSQL一覧表示]
  Dialog -->|"モーダル内 Execute（2段階目）"| Tx[execTransaction で実行]
  Dialog -->|キャンセル| Pending
  Tx --> Reload[グリッド再読込 + pending クリア]
```

## 設定項目

| 設定キー | 既定値 | 説明 |
| --- | --- | --- |
| `jobo.connections` | `[]` | 接続定義の配列。秘密情報（パスワード/パスフレーズ）は含まず、SecretStorage に別途保存されます。 |
| `jobo.defaultQueryLimit` | `200` | テーブルビューの閲覧時に付与する `LIMIT` の既定値。 |
| `jobo.useSshConfig` | `true` | `configHost` 指定時に `~/.ssh/config` から未入力の SSH 設定を解決するか。 |

## 開発

### 必要環境

- VSCode `^1.90.0`
- Node.js 18 以降

### スクリプト

```bash
npm install
npm run typecheck   # 型チェックのみ（tsc --noEmit）
npm run lint        # ESLint
npm run build       # 本番バンドル（dist/extension.js + dist/renderer.js）
npm run watch       # 変更を監視して逐次リビルド
npm run compile     # typecheck + 開発用バンドル
```

### 拡張機能の起動（開発）

1. このフォルダを VSCode で開きます。
2. `F5` を押して **Extension Development Host** を起動します。
3. アクティビティバーの **Jobo** アイコンから Connections ビューを開けます。

### パッケージ化（任意）

```bash
npx @vscode/vsce package
```

（`vscode:prepublish` で `npm run build` が走ります。）

## アーキテクチャ概要

```
UI 層            Core                       Drivers
─────────       ───────────────────        ─────────────────────
Connections ──▶ ConnectionManager ──▶ Driver Factory ──▶ PostgreSQL (pg)
TreeView        (settings + SecretStorage)               MySQL (mysql2)
SQL Notebook ─▶ SSH Tunnel (ssh2) ◀── ~/.ssh/config       SQLite (node-sqlite3-wasm)
条坊グリッド     └ ローカルポートフォワード → DB へ
```

`ConnectionManager` が設定を読み込み、SSH 設定があれば `Tunnel` でローカルポートにフォワード（`~/.ssh/config` の Host を解決可能）し、そのローカルの `host:port` をドライバに渡して接続します。

### 主要ファイル

- `src/extension.ts` — `activate` エントリ。`registerConnectionsTree` / `registerNotebook` / `registerTableView` を結線。
- `src/connections/` — 接続設定の型と ConnectionManager（接続/切断/保管）。
- `src/ssh/tunnel.ts`, `src/ssh/sshConfig.ts` — SSH トンネルと `~/.ssh/config` パーサ。
- `src/drivers/` — 共通インタフェース（`driver.ts`）と各ドライバ・factory。
- `src/tree/connectionsProvider.ts` — Connections ツリーと接続管理コマンド。
- `src/notebook/` — Serializer・Controller（実行カーネル）・結果グリッドレンダラ。
- `src/webview/tableView.ts` — 編集可能テーブルビューの Webview と 2 段階 Execute フロー。
- `src/sql/builder.ts` — 保留中の変更から UPDATE/INSERT/DELETE を生成（純粋関数、クオートはドライバ依存）。
- `src/shared/gridData.ts` — グリッド出力の共通ペイロード型（MIME `x-application/jobo-grid`）。
- `media/` — Webview/レンダラのアセット（CSS/JS）。

## 動作確認

### 自動検証（ヘッドレス）

ドライバ + SQL ビルダーのエンドツーエンドは、GUI 無しで検証可能です（CI 等で実行できます）。

- `node-sqlite3-wasm` で SQLite ファイル/テーブル作成・行挿入
- `query()` の `QueryResult` 形状（`columns` / `rows` / `rowCount` / `durationMs`）
- `listTables` / `listColumns` / `getPrimaryKeys`
- `buildStatements()` による UPDATE/INSERT/DELETE 生成 → `execTransaction()` 実行 → データ反映の確認
- 不正な文を含むトランザクションがロールバックされること

### 手動テストチェックリスト

`F5` で Extension Development Host を起動し、以下を確認します（GUI が必要なため利用者の手元での実施が必要です）。

- [ ] **SQLite ローカル接続**：SQLite 接続を追加し、Connections ツリーで Connect → テーブル → カラムまで展開できる。
- [ ] **ノートブック → グリッド**：`.jobonb`（または `Jobo: New SQL Notebook`）を開き、対象接続を選択 → `SELECT` セルを実行 → 条坊グリッドに結果が表示され、ソート・ページングが動く。
- [ ] **テーブルビュー（閲覧）**：ツリーのテーブルをクリック → 閲覧モードで `SELECT * ... LIMIT n` の結果が表示される。
- [ ] **テーブルビュー（編集 → 2 段階 Execute）**：編集モードでセル編集・行追加・行削除 → 右上 **Execute ▸** で SQL 一覧モーダルが開く（未実行）→ モーダル内 **Execute（確定実行）** で `execTransaction` 実行 → グリッドが再読込され、保留中の変更がクリアされる。
- [ ] **エラー時ロールバック**：故意に失敗する変更を投入し、ロールバックされエラーが表示されることを確認する。
- [ ] **インラインアイコン**：テーブル行にホバーして表示されるテーブルアイコンからもテーブルビューが開ける。
- [ ] **SSH トンネル接続**：`~/.ssh/config` の Host を `configHost` に指定し、PostgreSQL / MySQL へトンネル経由で接続 → ツリー展開・クエリ実行ができる。

## コントリビュート

コントリビュート歓迎です。機能提案やバグ報告は Issue で、バグ修正・リファクタ・ドキュメント改善は Pull Request でお願いします。

## ライセンス

MIT ライセンスで配布しています。詳細は [LICENSE](./LICENSE) を参照してください。
