/**
 * Notebook serializer for the `jobo-notebook` type.
 *
 * One serializer backs two on-disk formats selected by file extension:
 *   - `.jobonb` — our native JSON format (round-trips cell kind + language).
 *   - `.sql`    — plain text, split into cells on lines that are exactly `-- %%`.
 *
 * VSCode does not hand the serializer the document URI, so the on-disk format is
 * detected from the bytes when deserializing and remembered in the notebook
 * metadata (`joboFormat`) so it can be written back in the same shape.
 */

import * as vscode from "vscode";

/** Separator line used to split a `.sql` file into notebook cells. */
const SQL_CELL_SEPARATOR = "-- %%";

/** Notebook metadata key recording the on-disk format. */
const FORMAT_META_KEY = "joboFormat";

type JoboFormat = "jobonb" | "sql";

/** Shape of a cell in the `.jobonb` JSON format. */
interface JobonbCell {
  kind: "code" | "markup";
  language: string;
  value: string;
}

/** Top-level shape of a `.jobonb` file. */
interface JobonbFile {
  version: 1;
  cells: JobonbCell[];
}

export class JoboNotebookSerializer implements vscode.NotebookSerializer {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const text = this.decoder.decode(content);
    const format = detectFormat(text);
    const cells =
      format === "jobonb" ? parseJobonb(text) : parseSql(text);
    const data = new vscode.NotebookData(cells);
    data.metadata = { [FORMAT_META_KEY]: format };
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const format = readFormat(data.metadata);
    const text = format === "sql" ? toSql(data) : toJobonb(data);
    return this.encoder.encode(text);
  }
}

/** Decide whether the raw bytes are our JSON format or a plain `.sql` file. */
function detectFormat(text: string): JoboFormat {
  const trimmed = text.trim();
  if (trimmed === "") {
    // Ambiguous (new/empty file). Default to the native JSON format; a `.sql`
    // file edited and saved will simply gain a JSON wrapper unless it already
    // carried SQL content. This is the documented trade-off of VSCode not
    // exposing the document URI to the serializer.
    return "jobonb";
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { cells?: unknown }).cells)
    ) {
      return "jobonb";
    }
  } catch {
    // Not JSON — treat as plain SQL.
  }
  return "sql";
}

function readFormat(metadata: { [key: string]: unknown } | undefined): JoboFormat {
  const raw = metadata?.[FORMAT_META_KEY];
  return raw === "sql" ? "sql" : "jobonb";
}

function parseJobonb(text: string): vscode.NotebookCellData[] {
  let file: JobonbFile;
  try {
    file = JSON.parse(text) as JobonbFile;
  } catch {
    return [emptyCell()];
  }
  const cells = Array.isArray(file.cells) ? file.cells : [];
  if (cells.length === 0) {
    return [emptyCell()];
  }
  return cells.map((cell) => {
    const kind =
      cell.kind === "markup"
        ? vscode.NotebookCellKind.Markup
        : vscode.NotebookCellKind.Code;
    const language =
      cell.language ?? (kind === vscode.NotebookCellKind.Markup ? "markdown" : "sql");
    return new vscode.NotebookCellData(kind, cell.value ?? "", language);
  });
}

function parseSql(text: string): vscode.NotebookCellData[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const chunks = splitSql(normalized);
  if (chunks.length === 0) {
    return [emptyCell()];
  }
  return chunks.map(
    (chunk) =>
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, chunk, "sql")
  );
}

/** Split a `.sql` body on lines that are exactly the cell separator. */
function splitSql(text: string): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === SQL_CELL_SEPARATOR) {
      chunks.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  chunks.push(current.join("\n"));
  return chunks.map((c) => c.replace(/^\n+|\n+$/g, "")).filter((c, i, arr) => {
    // Drop empty leading/trailing chunks produced by separators at file edges,
    // but keep a single empty cell if the whole file was empty.
    if (c !== "") {
      return true;
    }
    return arr.length === 1;
  });
}

function toJobonb(data: vscode.NotebookData): string {
  const file: JobonbFile = {
    version: 1,
    cells: data.cells.map((cell) => ({
      kind:
        cell.kind === vscode.NotebookCellKind.Markup ? "markup" : "code",
      language: cell.languageId,
      value: cell.value,
    })),
  };
  return JSON.stringify(file, null, 2);
}

function toSql(data: vscode.NotebookData): string {
  return data.cells
    .map((cell) => {
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        // Preserve markup as SQL line comments so the file stays valid SQL.
        return cell.value
          .split("\n")
          .map((line) => (line === "" ? "--" : `-- ${line}`))
          .join("\n");
      }
      return cell.value;
    })
    .join(`\n\n${SQL_CELL_SEPARATOR}\n\n`);
}

function emptyCell(): vscode.NotebookCellData {
  return new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "sql");
}
