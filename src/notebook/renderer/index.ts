/**
 * Notebook output renderer entry (bundled to dist/renderer.js as ESM).
 *
 * Renders the `x-application/jobo-grid` output (a `GridData` payload) as a
 * read-only ward-grid HTML table with client-side column sorting and
 * paging. The ward-grid metaphor treats each cell as a city block: crisp,
 * evenly ruled borders form a block layout over the result set.
 *
 * This file runs in the notebook renderer (browser/webview) context, NOT the
 * extension host — it must not import `vscode` or Node APIs. CSS is injected
 * inline (most reliable in the renderer sandbox) and scoped under `.jobo-grid`.
 */

import type { GridData } from "../../shared/gridData";

interface RendererContext {
  postMessage?: (message: unknown) => void;
  setState?: (value: unknown) => void;
  getState?: () => unknown;
}

interface OutputItem {
  id: string;
  mime: string;
  json(): unknown;
  text(): string;
}

type SortDirection = "asc" | "desc";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;
const DEFAULT_PAGE_SIZE = 50;

/** Inline stylesheet for the ward-grid, injected once per renderer document. */
const STYLE_ID = "jobo-grid-style";
const STYLES = `
.jobo-grid {
  font-family: var(--vscode-editor-font-family, var(--vscode-font-family, monospace));
  font-size: var(--vscode-editor-font-size, 13px);
  color: var(--vscode-foreground);
  margin: 4px 0 10px;
}
.jobo-grid__bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  padding: 4px 2px 8px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.jobo-grid__bar .jobo-grid__spacer { flex: 1 1 auto; }
.jobo-grid__stat strong {
  color: var(--vscode-foreground);
  font-variant-numeric: tabular-nums;
}
.jobo-grid__pager {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.jobo-grid__pager button,
.jobo-grid__pager select {
  font-family: inherit;
  font-size: 12px;
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  background: var(--vscode-button-secondaryBackground, transparent);
  border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, transparent));
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
}
.jobo-grid__pager button:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
}
.jobo-grid__pager button:disabled { opacity: 0.4; cursor: default; }
.jobo-grid__scroll {
  overflow: auto;
  max-height: 520px;
  border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #8884));
  border-radius: 4px;
}
table.jobo-grid__table {
  border-collapse: collapse;
  width: 100%;
  /* The ward grid: every cell ruled like a city block. */
  border-spacing: 0;
}
.jobo-grid__table th,
.jobo-grid__table td {
  border-right: 1px solid var(--vscode-panel-border, #8883);
  border-bottom: 1px solid var(--vscode-panel-border, #8883);
  padding: 8px 14px;
  text-align: left;
  white-space: pre;
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: top;
}
.jobo-grid__table th:last-child,
.jobo-grid__table td:last-child { border-right: none; }
.jobo-grid__table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--vscode-keybindingLabel-background, var(--vscode-editorWidget-background, #2a2a2a));
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.jobo-grid__table thead th:hover {
  background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground));
}
.jobo-grid__table thead th .jobo-grid__sort {
  color: var(--vscode-descriptionForeground);
  margin-left: 4px;
  font-size: 10px;
}
.jobo-grid__rownum {
  text-align: right !important;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editorGutter-background, transparent);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  position: sticky;
  left: 0;
}
.jobo-grid__table tbody tr:nth-child(even) td {
  background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.06));
}
.jobo-grid__table tbody tr:hover td {
  background: var(--vscode-list-activeSelectionBackground, rgba(128,128,160,0.18));
}
.jobo-grid__null {
  color: var(--vscode-descriptionForeground);
  font-style: italic;
  opacity: 0.8;
}
.jobo-grid__empty {
  padding: 14px;
  color: var(--vscode-descriptionForeground);
  text-align: center;
}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/** Format a single cell value for display. Returns {text, isNull}. */
function formatCell(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) {
    return { text: "NULL", isNull: true };
  }
  if (typeof value === "object") {
    try {
      return { text: JSON.stringify(value), isNull: false };
    } catch {
      return { text: String(value), isNull: false };
    }
  }
  return { text: String(value), isNull: false };
}

/** Stable, type-aware comparison used for column sorting. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) {
    return 0;
  }
  if (a === null || a === undefined) {
    return -1;
  }
  if (b === null || b === undefined) {
    return 1;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) {
    return na - nb;
  }
  return String(a).localeCompare(String(b));
}

/**
 * A single rendered grid instance, bound to one output element. Holds the sort
 * and paging state and re-renders the table body on demand.
 */
class WardGrid {
  root: HTMLElement;
  private columns: { name: string }[] = [];
  private rows: unknown[][] = [];
  private rowCount = 0;
  private durationMs = 0;

  private sortCol: number | null = null;
  private sortDir: SortDirection = "asc";
  private order: number[] = [];
  private pageSize = DEFAULT_PAGE_SIZE;
  private page = 0;

  private tbody: HTMLTableSectionElement | null = null;
  private statEl: HTMLElement | null = null;
  private pageLabel: HTMLElement | null = null;
  private prevBtn: HTMLButtonElement | null = null;
  private nextBtn: HTMLButtonElement | null = null;
  private headCells: HTMLTableCellElement[] = [];

  constructor(element: HTMLElement) {
    this.root = element;
  }

  update(data: GridData): void {
    this.columns = (data.columns ?? []).map((c) => ({ name: c.name }));
    this.rows = data.rows ?? [];
    this.rowCount = data.rowCount ?? this.rows.length;
    this.durationMs = data.durationMs ?? 0;
    this.sortCol = null;
    this.sortDir = "asc";
    this.page = 0;
    this.resetOrder();
    this.render();
  }

  private resetOrder(): void {
    this.order = this.rows.map((_, i) => i);
  }

  private applySort(): void {
    if (this.sortCol === null) {
      this.resetOrder();
      return;
    }
    const col = this.sortCol;
    const dir = this.sortDir === "asc" ? 1 : -1;
    this.order = this.rows
      .map((_, i) => i)
      .sort((ia, ib) => {
        const cmp = compareValues(this.rows[ia][col], this.rows[ib][col]);
        return cmp !== 0 ? cmp * dir : ia - ib;
      });
  }

  private pageCount(): number {
    return Math.max(1, Math.ceil(this.order.length / this.pageSize));
  }

  private render(): void {
    this.root.replaceChildren();
    this.headCells = [];

    const container = document.createElement("div");
    container.className = "jobo-grid";

    container.appendChild(this.buildBar());

    const scroll = document.createElement("div");
    scroll.className = "jobo-grid__scroll";

    if (this.columns.length === 0) {
      const empty = document.createElement("div");
      empty.className = "jobo-grid__empty";
      empty.textContent =
        this.rowCount > 0
          ? `${this.rowCount} row(s) affected.`
          : "No columns returned.";
      scroll.appendChild(empty);
      container.appendChild(scroll);
      this.root.appendChild(container);
      return;
    }

    const table = document.createElement("table");
    table.className = "jobo-grid__table";
    table.appendChild(this.buildHead());
    this.tbody = document.createElement("tbody");
    table.appendChild(this.tbody);
    scroll.appendChild(table);
    container.appendChild(scroll);
    this.root.appendChild(container);

    this.renderBody();
  }

  private buildBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "jobo-grid__bar";

    const stat = document.createElement("span");
    stat.className = "jobo-grid__stat";
    this.statEl = stat;
    bar.appendChild(stat);

    const spacer = document.createElement("span");
    spacer.className = "jobo-grid__spacer";
    bar.appendChild(spacer);

    bar.appendChild(this.buildPager());
    return bar;
  }

  private buildPager(): HTMLElement {
    const pager = document.createElement("span");
    pager.className = "jobo-grid__pager";

    const sizeSelect = document.createElement("select");
    sizeSelect.title = "Rows per page";
    for (const size of PAGE_SIZE_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = String(size);
      opt.textContent = `${size} / page`;
      if (size === this.pageSize) {
        opt.selected = true;
      }
      sizeSelect.appendChild(opt);
    }
    sizeSelect.addEventListener("change", () => {
      this.pageSize = Number(sizeSelect.value) || DEFAULT_PAGE_SIZE;
      this.page = 0;
      this.renderBody();
    });
    pager.appendChild(sizeSelect);

    const prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "‹ Prev";
    prev.addEventListener("click", () => {
      if (this.page > 0) {
        this.page -= 1;
        this.renderBody();
      }
    });
    this.prevBtn = prev;
    pager.appendChild(prev);

    const label = document.createElement("span");
    this.pageLabel = label;
    pager.appendChild(label);

    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Next ›";
    next.addEventListener("click", () => {
      if (this.page < this.pageCount() - 1) {
        this.page += 1;
        this.renderBody();
      }
    });
    this.nextBtn = next;
    pager.appendChild(next);

    return pager;
  }

  private buildHead(): HTMLTableSectionElement {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");

    const corner = document.createElement("th");
    corner.className = "jobo-grid__rownum";
    corner.textContent = "#";
    tr.appendChild(corner);

    this.columns.forEach((col, idx) => {
      const th = document.createElement("th");
      const label = document.createElement("span");
      label.textContent = col.name;
      th.appendChild(label);

      const indicator = document.createElement("span");
      indicator.className = "jobo-grid__sort";
      th.appendChild(indicator);

      th.title = `Sort by ${col.name}`;
      th.addEventListener("click", () => this.toggleSort(idx));
      this.headCells[idx] = th;
      tr.appendChild(th);
    });

    thead.appendChild(tr);
    return thead;
  }

  private toggleSort(col: number): void {
    if (this.sortCol === col) {
      if (this.sortDir === "asc") {
        this.sortDir = "desc";
      } else {
        // asc -> desc -> unsorted
        this.sortCol = null;
      }
    } else {
      this.sortCol = col;
      this.sortDir = "asc";
    }
    this.page = 0;
    this.applySort();
    this.updateSortIndicators();
    this.renderBody();
  }

  private updateSortIndicators(): void {
    this.headCells.forEach((th, idx) => {
      const indicator = th.querySelector(".jobo-grid__sort");
      if (!indicator) {
        return;
      }
      if (this.sortCol === idx) {
        indicator.textContent = this.sortDir === "asc" ? "▲" : "▼";
      } else {
        indicator.textContent = "";
      }
    });
  }

  private renderBody(): void {
    if (!this.tbody) {
      return;
    }
    const total = this.order.length;
    const pageCount = this.pageCount();
    if (this.page > pageCount - 1) {
      this.page = pageCount - 1;
    }
    const startIdx = this.page * this.pageSize;
    const endIdx = Math.min(startIdx + this.pageSize, total);

    const tbody = document.createElement("tbody");
    for (let i = startIdx; i < endIdx; i++) {
      const rowIdx = this.order[i];
      const row = this.rows[rowIdx];
      const tr = document.createElement("tr");

      const num = document.createElement("td");
      num.className = "jobo-grid__rownum";
      num.textContent = String(i + 1);
      tr.appendChild(num);

      this.columns.forEach((_, colIdx) => {
        const td = document.createElement("td");
        const { text, isNull } = formatCell(row ? row[colIdx] : undefined);
        if (isNull) {
          td.className = "jobo-grid__null";
        }
        td.textContent = text;
        td.title = text;
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    }
    this.tbody.replaceWith(tbody);
    this.tbody = tbody;

    this.updateBar(total, startIdx, endIdx, pageCount);
  }

  private updateBar(
    total: number,
    startIdx: number,
    endIdx: number,
    pageCount: number
  ): void {
    if (this.statEl) {
      const shown =
        total === 0 ? "0" : `${startIdx + 1}–${endIdx} / ${total}`;
      const limited =
        this.rowCount > total ? ` (showing up to ${total} / ${this.rowCount} total)` : "";
      this.statEl.innerHTML = "";
      const rows = document.createElement("span");
      rows.textContent = `Rows ${shown}${limited}`;
      const dur = document.createElement("strong");
      dur.textContent = `  ·  ${this.durationMs} ms`;
      this.statEl.appendChild(rows);
      this.statEl.appendChild(dur);
    }
    if (this.pageLabel) {
      this.pageLabel.textContent = `${this.page + 1} / ${pageCount}`;
    }
    if (this.prevBtn) {
      this.prevBtn.disabled = this.page <= 0;
    }
    if (this.nextBtn) {
      this.nextBtn.disabled = this.page >= pageCount - 1;
    }
  }

  dispose(): void {
    this.root.replaceChildren();
  }
}

export function activate(_context: RendererContext) {
  const grids = new Map<string, WardGrid>();

  return {
    renderOutputItem(outputItem: OutputItem, element: HTMLElement): void {
      ensureStyles();
      let data: GridData;
      try {
        data = outputItem.json() as GridData;
      } catch (err) {
        element.textContent = `Jobo grid: failed to parse output (${String(err)}).`;
        return;
      }

      let grid = grids.get(outputItem.id);
      if (!grid || grid.root !== element) {
        grid = new WardGrid(element);
        grids.set(outputItem.id, grid);
      }
      grid.update(data);
    },

    disposeOutputItem(id?: string): void {
      if (id === undefined) {
        for (const grid of grids.values()) {
          grid.dispose();
        }
        grids.clear();
        return;
      }
      const grid = grids.get(id);
      if (grid) {
        grid.dispose();
        grids.delete(id);
      }
    },
  };
}
