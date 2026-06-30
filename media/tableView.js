/*
 * Editable table view — webview client script.
 *
 * Runs inside the Webview sandbox (no Node/vscode APIs; communicates with the
 * extension host only via postMessage). Responsibilities:
 *   - render the ward-grid in View and Edit modes
 *   - in edit mode: cell editing (double-click), add empty row, mark delete,
 *     accumulating PENDING changes locally (highlighted, never auto-executed)
 *   - Step 1: the top-right Execute button asks the host to build SQL from the
 *     pending changes and opens a modal listing the generated statements
 *   - Step 2: the modal's "Execute (Confirm)" posts the changes to the host,
 *     which runs them in one transaction; on success the grid reloads.
 *
 * Quoting/identifier safety is done host-side via the driver; this script only
 * ships structured PendingChange objects.
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /** @typedef {{name: string}} Column */
  /**
   * @typedef {Object} RowModel
   * @property {number} key            stable client-side row id
   * @property {Array<any>} original   typed original cell values (JSON-safe)
   * @property {Array<any>} cells       current cell values
   * @property {boolean} isNew
   * @property {boolean} isDeleted
   * @property {Set<number>} changedCols indices of edited columns
   */

  const state = {
    /** @type {Column[]} */
    columns: [],
    /** @type {string[]} */
    primaryKeys: [],
    /** @type {Set<string>} */
    pkSet: new Set(),
    editable: false,
    table: { schema: undefined, name: "" },
    rowCount: 0,
    durationMs: 0,
    limit: 0,
    /** @type {"view"|"edit"} */
    mode: "view",
    /** @type {RowModel[]} */
    rows: [],
    /** @type {number|null} */
    sortCol: null,
    /** @type {"asc"|"desc"} */
    sortDir: "asc",
    /** @type {number[]} display order (indexes into state.rows) */
    order: [],
    nextKey: 1,
    /** @type {string|null} */
    error: null,
    busy: false,
  };

  // --- DOM refs ----------------------------------------------------------
  const el = {
    title: document.getElementById("title"),
    modeView: document.getElementById("mode-view"),
    modeEdit: document.getElementById("mode-edit"),
    addRow: document.getElementById("add-row"),
    reload: document.getElementById("reload"),
    execute: document.getElementById("execute"),
    status: document.getElementById("status"),
    grid: document.getElementById("grid"),
    modalBackdrop: document.getElementById("modal-backdrop"),
    modalBody: document.getElementById("modal-body"),
    modalSub: document.getElementById("modal-sub"),
    modalExecute: document.getElementById("modal-execute"),
    modalCancel: document.getElementById("modal-cancel"),
  };

  /** Pending statements awaiting the modal's confirm. */
  let stagedChanges = null;

  // --- Value helpers -----------------------------------------------------

  function isNullish(v) {
    return v === null || v === undefined;
  }

  function displayText(v) {
    if (isNullish(v)) {
      return "NULL";
    }
    if (typeof v === "object") {
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }
    return String(v);
  }

  function compareValues(a, b) {
    if (a === b) return 0;
    if (isNullish(a)) return -1;
    if (isNullish(b)) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  }

  // --- State transitions -------------------------------------------------

  function setData(payload) {
    state.columns = payload.columns || [];
    state.primaryKeys = payload.primaryKeys || [];
    state.pkSet = new Set(state.primaryKeys);
    state.editable = !!payload.editable;
    state.table = payload.table || state.table;
    state.rowCount = payload.rowCount || 0;
    state.durationMs = payload.durationMs || 0;
    state.limit = payload.limit || state.limit;
    state.error = null;
    state.busy = false;
    state.sortCol = null;
    state.sortDir = "asc";
    state.nextKey = 1;
    state.rows = (payload.rows || []).map((cells) => ({
      key: state.nextKey++,
      original: cells.slice(),
      cells: cells.slice(),
      isNew: false,
      isDeleted: false,
      changedCols: new Set(),
    }));
    rebuildOrder();
    render();
  }

  function rebuildOrder() {
    state.order = state.rows.map((_, i) => i);
    if (state.sortCol !== null) {
      const col = state.sortCol;
      const dir = state.sortDir === "asc" ? 1 : -1;
      state.order.sort((ia, ib) => {
        const cmp = compareValues(state.rows[ia].cells[col], state.rows[ib].cells[col]);
        return cmp !== 0 ? cmp * dir : ia - ib;
      });
    }
  }

  function pendingChanges() {
    /** @type {Array<any>} */
    const changes = [];
    for (const row of state.rows) {
      if (row.isDeleted) {
        if (row.isNew) continue; // never persisted; just drop
        changes.push({ kind: "delete", keyValues: keyValuesOf(row) });
        continue;
      }
      if (row.isNew) {
        const values = {};
        state.columns.forEach((c, i) => {
          if (!isNullish(row.cells[i])) {
            values[c.name] = row.cells[i];
          }
        });
        if (Object.keys(values).length > 0) {
          changes.push({ kind: "insert", values });
        }
        continue;
      }
      if (row.changedCols.size > 0) {
        const values = {};
        row.changedCols.forEach((i) => {
          values[state.columns[i].name] = row.cells[i];
        });
        changes.push({ kind: "update", keyValues: keyValuesOf(row), values });
      }
    }
    return changes;
  }

  function keyValuesOf(row) {
    const kv = {};
    state.columns.forEach((c, i) => {
      if (state.pkSet.has(c.name)) {
        kv[c.name] = row.original[i];
      }
    });
    return kv;
  }

  function pendingCount() {
    let n = 0;
    for (const row of state.rows) {
      if (row.isDeleted) {
        if (!row.isNew) n++;
      } else if (row.isNew) {
        if (row.cells.some((v) => !isNullish(v))) n++;
      } else if (row.changedCols.size > 0) {
        n++;
      }
    }
    return n;
  }

  // --- Rendering ---------------------------------------------------------

  function render() {
    renderToolbar();
    renderStatus();
    renderGrid();
  }

  function renderToolbar() {
    const schemaPart = state.table.schema
      ? `<span class="jobo-schema">${escapeHtml(state.table.schema)}.</span>`
      : "";
    el.title.innerHTML = `${schemaPart}${escapeHtml(state.table.name)}`;

    el.modeView.classList.toggle("active", state.mode === "view");
    el.modeEdit.classList.toggle("active", state.mode === "edit");

    const editing = state.mode === "edit";
    el.addRow.style.display = editing ? "" : "none";
    el.execute.style.display = editing ? "" : "none";

    const count = pendingCount();
    el.execute.disabled = state.busy || count === 0;
    el.execute.textContent = count > 0 ? `Execute (${count}) ▸` : "Execute ▸";
    el.reload.disabled = state.busy;
  }

  function renderStatus() {
    const parts = [];
    const shown = state.rows.filter((r) => !r.isDeleted).length;
    parts.push(
      `<span>Table <strong>${escapeHtml(state.table.name)}</strong></span>`
    );
    parts.push(
      `<span>${shown} rows shown${
        state.limit ? ` (up to ${state.limit})` : ""
      } · ${state.durationMs} ms</span>`
    );
    if (state.mode === "edit") {
      const count = pendingCount();
      if (count > 0) {
        parts.push(
          `<span class="jobo-status__pending">Pending changes: ${count}</span>`
        );
      }
      if (!state.editable) {
        parts.push(
          `<span class="jobo-status__pending">No primary key: existing rows can't be edited/deleted (insert only)</span>`
        );
      }
    }
    let html = parts.join("");
    if (state.error) {
      html += `<span class="jobo-status__error">⚠ ${escapeHtml(state.error)}</span>`;
    }
    el.status.innerHTML = html;
  }

  function renderGrid() {
    el.grid.replaceChildren();
    if (state.columns.length === 0) {
      const div = document.createElement("div");
      div.className = "jobo-empty";
      div.textContent = "No columns.";
      el.grid.appendChild(div);
      return;
    }

    const editing = state.mode === "edit";
    const table = document.createElement("table");
    table.className = "jobo-table";

    // Head
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    const corner = document.createElement("th");
    corner.className = "jobo-rownum";
    corner.textContent = "#";
    htr.appendChild(corner);

    state.columns.forEach((col, idx) => {
      const th = document.createElement("th");
      const label = document.createElement("span");
      label.textContent = col.name;
      th.appendChild(label);
      if (state.pkSet.has(col.name)) {
        const pk = document.createElement("span");
        pk.className = "jobo-pk";
        pk.textContent = "🔑";
        pk.title = "Primary key";
        th.appendChild(pk);
      }
      const sort = document.createElement("span");
      sort.className = "jobo-sort";
      if (state.sortCol === idx) {
        sort.textContent = state.sortDir === "asc" ? "▲" : "▼";
      }
      th.appendChild(sort);
      th.title = `Sort by ${col.name}`;
      th.addEventListener("click", () => toggleSort(idx));
      htr.appendChild(th);
    });

    if (editing) {
      const act = document.createElement("th");
      act.className = "jobo-rowaction";
      act.textContent = "";
      htr.appendChild(act);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement("tbody");
    state.order.forEach((rowIdx, displayIdx) => {
      const row = state.rows[rowIdx];
      const tr = document.createElement("tr");
      if (row.isNew) tr.classList.add("jobo-row--new");
      if (row.isDeleted) tr.classList.add("jobo-row--deleted");

      const num = document.createElement("td");
      num.className = "jobo-rownum";
        num.textContent = row.isNew ? "+" : String(displayIdx + 1);
      tr.appendChild(num);

      state.columns.forEach((col, colIdx) => {
        const td = document.createElement("td");
        const value = row.cells[colIdx];
        if (isNullish(value)) {
          td.classList.add("jobo-cell--null");
        }
        td.textContent = displayText(value);
        if (!isNullish(value)) {
          td.title = displayText(value);
        }
        if (row.changedCols.has(colIdx)) {
          td.classList.add("jobo-cell--changed");
        }
        if (editing && canEditCell(row, col)) {
          td.classList.add("jobo-cell--editable");
          td.addEventListener("dblclick", () =>
            beginEdit(td, row, colIdx)
          );
        }
        tr.appendChild(td);
      });

      if (editing) {
        const act = document.createElement("td");
        act.className = "jobo-rowaction";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = row.isDeleted ? "↺" : "🗑";
        btn.title = row.isDeleted ? "Undo delete" : "Mark row for deletion";
        const deletable = row.isNew || state.editable;
        btn.disabled = !deletable;
        btn.addEventListener("click", () => toggleDelete(row));
        act.appendChild(btn);
        tr.appendChild(act);
      }

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.grid.appendChild(table);
  }

  function canEditCell(row, col) {
    if (row.isDeleted) return false;
    if (row.isNew) return true;
    // Existing rows require a primary key to be safely identified.
    return state.editable;
  }

  // --- Editing interactions ---------------------------------------------

  function beginEdit(td, row, colIdx) {
    const current = row.cells[colIdx];
    const input = document.createElement("input");
    input.className = "jobo-editor";
    input.type = "text";
    input.value = isNullish(current) ? "" : String(current);
    td.replaceChildren(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const raw = input.value;
      const next = raw === "" ? null : raw;
      applyCellEdit(row, colIdx, next);
      render();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      render();
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
  }

  function applyCellEdit(row, colIdx, next) {
    row.cells[colIdx] = next;
    if (row.isNew) {
      return;
    }
    const original = row.original[colIdx];
    if (valuesEqual(original, next)) {
      row.changedCols.delete(colIdx);
    } else {
      row.changedCols.add(colIdx);
    }
  }

  function valuesEqual(a, b) {
    if (isNullish(a) && isNullish(b)) return true;
    if (isNullish(a) || isNullish(b)) return false;
    return String(a) === String(b);
  }

  function toggleDelete(row) {
    row.isDeleted = !row.isDeleted;
    render();
  }

  function addRow() {
    const cells = state.columns.map(() => null);
    state.rows.push({
      key: state.nextKey++,
      original: cells.slice(),
      cells,
      isNew: true,
      isDeleted: false,
      changedCols: new Set(),
    });
    rebuildOrder();
    render();
  }

  function toggleSort(col) {
    if (state.sortCol === col) {
      if (state.sortDir === "asc") {
        state.sortDir = "desc";
      } else {
        state.sortCol = null;
      }
    } else {
      state.sortCol = col;
      state.sortDir = "asc";
    }
    rebuildOrder();
    render();
  }

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    render();
  }

  // --- Two-step Execute flow --------------------------------------------

  function requestPreview() {
    const changes = pendingChanges();
    if (changes.length === 0) {
      return;
    }
    stagedChanges = changes;
    state.busy = true;
    renderToolbar();
    vscode.postMessage({ type: "preview", changes });
  }

  function showModal(statements) {
    el.modalBody.replaceChildren();
    el.modalSub.textContent = `Will run ${statements.length} statement(s) in a single transaction.`;
    const list = document.createElement("ol");
    list.className = "jobo-sql-list";
    statements.forEach((sql) => {
      const li = document.createElement("li");
      const kind = document.createElement("span");
      kind.className = "jobo-sql-kind";
      kind.textContent = sqlKind(sql);
      li.appendChild(kind);
      li.appendChild(document.createTextNode(sql));
      list.appendChild(li);
    });
    el.modalBody.appendChild(list);
    el.modalBackdrop.classList.add("open");
    el.modalExecute.disabled = false;
    el.modalExecute.focus();
  }

  function sqlKind(sql) {
    const m = /^\s*(\w+)/.exec(sql);
    return m ? m[1].toUpperCase() : "SQL";
  }

  function closeModal() {
    el.modalBackdrop.classList.remove("open");
    state.busy = false;
    renderToolbar();
  }

  function confirmExecute() {
    if (!stagedChanges) {
      closeModal();
      return;
    }
    el.modalExecute.disabled = true;
    el.modalSub.textContent = "Executing…";
    vscode.postMessage({ type: "commit", changes: stagedChanges });
  }

  // --- Messaging ---------------------------------------------------------

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "init":
      case "data":
        setData(msg.payload);
        break;
      case "sqlPreview":
        state.busy = false;
        showModal(msg.statements || []);
        break;
      case "committed":
        stagedChanges = null;
        el.modalBackdrop.classList.remove("open");
        // Host follows up with a fresh `data` message.
        break;
      case "error":
        state.busy = false;
        state.error = msg.message || "Unknown error";
        if (el.modalBackdrop.classList.contains("open")) {
          el.modalExecute.disabled = false;
          el.modalSub.textContent = `Error: ${state.error}`;
        }
        render();
        break;
      default:
        break;
    }
  });

  // --- Wire up controls --------------------------------------------------

  el.modeView.addEventListener("click", () => setMode("view"));
  el.modeEdit.addEventListener("click", () => setMode("edit"));
  el.addRow.addEventListener("click", addRow);
  el.reload.addEventListener("click", () => {
    state.busy = true;
    state.error = null;
    renderToolbar();
    vscode.postMessage({ type: "reload" });
  });
  el.execute.addEventListener("click", requestPreview);
  el.modalExecute.addEventListener("click", confirmExecute);
  el.modalCancel.addEventListener("click", () => {
    stagedChanges = null;
    closeModal();
  });
  el.modalBackdrop.addEventListener("click", (e) => {
    if (e.target === el.modalBackdrop) {
      stagedChanges = null;
      closeModal();
    }
  });

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Signal readiness; host replies with `init`.
  vscode.postMessage({ type: "ready" });
})();
