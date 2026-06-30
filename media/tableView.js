/*
 * Editable table view — webview client script.
 *
 * Runs inside the Webview sandbox (no Node/vscode APIs; communicates with the
 * extension host only via postMessage). Responsibilities:
 *   - render the ward-grid (always editable)
 *   - cell editing (double-click), add empty row, mark delete,
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
    durationMs: 0,
    /** Page size (rows fetched per page) — mirrors the host LIMIT. */
    limit: 100,
    /** Total rows for paging (exact or estimated). */
    total: 0,
    totalExact: true,
    /** Row offset of the first row on the current page. */
    offset: 0,
    /** @type {RowModel[]} rows of the CURRENT page only */
    rows: [],
    /** @type {number|null} index of the server-sorted column */
    sortCol: null,
    /** @type {"asc"|"desc"} */
    sortDir: "asc",
    nextKey: 1,
    /** @type {string|null} */
    error: null,
    busy: false,
  };

  /** Page-size choices offered in the pager. */
  const PAGE_SIZES = [50, 100, 200, 500, 1000];

  // --- DOM refs ----------------------------------------------------------
  const el = {
    title: document.getElementById("title"),
    addRow: document.getElementById("add-row"),
    reload: document.getElementById("reload"),
    execute: document.getElementById("execute"),
    status: document.getElementById("status"),
    grid: document.getElementById("grid"),
    pager: document.getElementById("pager"),
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

  // --- State transitions -------------------------------------------------

  function setData(payload) {
    state.columns = payload.columns || [];
    state.primaryKeys = payload.primaryKeys || [];
    state.pkSet = new Set(state.primaryKeys);
    state.editable = !!payload.editable;
    state.table = payload.table || state.table;
    state.durationMs = payload.durationMs || 0;
    state.total = payload.total || 0;
    state.totalExact = payload.totalExact !== false;
    state.offset = payload.offset || 0;
    state.limit = payload.limit || state.limit;
    state.error = null;
    state.busy = false;
    state.nextKey = 1;

    // Reflect the server-side sort back onto the clicked-header indicator.
    if (payload.sort && payload.sort.col) {
      const idx = state.columns.findIndex((c) => c.name === payload.sort.col);
      state.sortCol = idx >= 0 ? idx : null;
      state.sortDir = payload.sort.dir === "desc" ? "desc" : "asc";
    } else {
      state.sortCol = null;
      state.sortDir = "asc";
    }

    state.rows = (payload.rows || []).map((cells) => ({
      key: state.nextKey++,
      original: cells.slice(),
      cells: cells.slice(),
      isNew: false,
      isDeleted: false,
      changedCols: new Set(),
    }));
    render();
  }

  /** Build the {col, dir} sort message the host understands, or null. */
  function currentSort() {
    if (state.sortCol === null || !state.columns[state.sortCol]) return null;
    return { col: state.columns[state.sortCol].name, dir: state.sortDir };
  }

  /**
   * Ask the host for a (possibly different) page/sort window. Overrides default
   * to the current view, so callers only pass what changes.
   */
  function requestView(next) {
    const opts = next || {};
    const offset = opts.offset !== undefined ? Math.max(0, opts.offset) : state.offset;
    const limit = opts.limit !== undefined ? opts.limit : state.limit;
    const sort = opts.sort !== undefined ? opts.sort : currentSort();
    state.busy = true;
    state.error = null;
    renderToolbar();
    renderPager();
    vscode.postMessage({ type: "view", offset, limit, sort });
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

  // --- Pagination helpers (server-driven) -------------------------------

  /** Total number of pages, based on the server-reported row count. */
  function pageCount() {
    return Math.max(1, Math.ceil(state.total / state.limit));
  }

  /** 0-based index of the current page. */
  function currentPage() {
    return Math.floor(state.offset / state.limit);
  }

  /** Navigate to a page by fetching it from the host. */
  function gotoPage(page) {
    if (state.busy || hasPending()) return;
    const target = Math.max(0, Math.min(page, pageCount() - 1));
    requestView({ offset: target * state.limit });
  }

  /** True when the user has unsaved edits that paging would discard. */
  function hasPending() {
    return pendingCount() > 0;
  }

  // --- Rendering ---------------------------------------------------------

  function render() {
    renderToolbar();
    renderStatus();
    renderGrid();
    renderPager();
  }

  function renderToolbar() {
    const schemaPart = state.table.schema
      ? `<span class="jobo-schema">${escapeHtml(state.table.schema)}.</span>`
      : "";
    el.title.innerHTML = `${schemaPart}${escapeHtml(state.table.name)}`;

    const count = pendingCount();
    el.execute.disabled = state.busy || count === 0;
    el.execute.textContent = count > 0 ? `Execute (${count}) ▸` : "Execute ▸";
    el.reload.disabled = state.busy;
  }

  function renderStatus() {
    const parts = [];
    parts.push(
      `<span>Table <strong>${escapeHtml(state.table.name)}</strong></span>`
    );
    parts.push(
      `<span>${state.totalExact ? "" : "~"}${state.total} rows total · ${state.durationMs} ms</span>`
    );
    if (!state.totalExact) {
      parts.push(
        `<span class="jobo-status__pending">Row count is approximate (catalog estimate)</span>`
      );
    }
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
      // Sorting re-queries the whole table; block it while edits are pending.
      if (state.busy || hasPending()) {
        th.classList.add("jobo-th--locked");
        th.title = hasPending()
          ? "Execute or Reload pending changes before sorting"
          : "Loading…";
      } else {
        th.title = `Sort by ${col.name}`;
        th.addEventListener("click", () => toggleSort(idx));
      }
      htr.appendChild(th);
    });

    const actHead = document.createElement("th");
    actHead.className = "jobo-rowaction";
    actHead.textContent = "";
    htr.appendChild(actHead);
    thead.appendChild(htr);
    table.appendChild(thead);

    // Body — rows of the current page only; numbering reflects the global offset.
    const tbody = document.createElement("tbody");
    let rowNo = state.offset;
    state.rows.forEach((row) => {
      const tr = document.createElement("tr");
      if (row.isNew) tr.classList.add("jobo-row--new");
      if (row.isDeleted) tr.classList.add("jobo-row--deleted");
      tr.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showRowMenu(e, row);
      });

      const num = document.createElement("td");
      num.className = "jobo-rownum";
      num.textContent = row.isNew ? "+" : String(++rowNo);
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
        if (canEditCell(row, col)) {
          td.classList.add("jobo-cell--editable");
          td.addEventListener("dblclick", () =>
            beginEdit(td, row, colIdx)
          );
        }
        tr.appendChild(td);
      });

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

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.grid.appendChild(table);
  }

  function renderPager() {
    el.pager.replaceChildren();
    if (state.columns.length === 0) {
      return;
    }

    const pages = pageCount();
    const page = currentPage();
    const pending = hasPending();
    // Any control that would re-fetch is locked while busy or while edits are
    // pending (paging away would silently drop those edits).
    const locked = state.busy || pending;

    // Page-size selector.
    const sizeWrap = document.createElement("label");
    sizeWrap.className = "jobo-pager__size";
    sizeWrap.textContent = "Rows/page: ";
    const select = document.createElement("select");
    select.disabled = locked;
    const sizes = PAGE_SIZES.includes(state.limit)
      ? PAGE_SIZES
      : [state.limit, ...PAGE_SIZES].sort((a, b) => a - b);
    sizes.forEach((size) => {
      const opt = document.createElement("option");
      opt.value = String(size);
      opt.textContent = String(size);
      if (size === state.limit) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      const next = Number(select.value);
      // Keep the current first row visible by recomputing the offset.
      const anchor = state.offset;
      requestView({ limit: next, offset: Math.floor(anchor / next) * next });
    });
    sizeWrap.appendChild(select);
    el.pager.appendChild(sizeWrap);

    // Range label (1-based, inclusive).
    const start = state.total === 0 ? 0 : state.offset + 1;
    const end = Math.min(state.total, state.offset + state.rows.length);
    const info = document.createElement("span");
    info.className = "jobo-pager__info";
    info.textContent = `${start}–${end} of ${state.total}`;
    el.pager.appendChild(info);

    // Hint shown when navigation is blocked by pending edits.
    if (pending) {
      const hint = document.createElement("span");
      hint.className = "jobo-pager__hint";
      hint.textContent = "Execute or Reload to change page";
      el.pager.appendChild(hint);
    }

    // Navigation buttons.
    const nav = document.createElement("div");
    nav.className = "jobo-pager__nav";

    const mkBtn = (label, title, targetPage, disabled) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "jobo-btn jobo-btn--secondary jobo-pager__btn";
      b.textContent = label;
      b.title = title;
      b.disabled = disabled;
      if (!disabled) b.addEventListener("click", () => gotoPage(targetPage));
      return b;
    };

    nav.appendChild(mkBtn("«", "First page", 0, locked || page === 0));
    nav.appendChild(mkBtn("‹", "Previous page", page - 1, locked || page === 0));

    const pageLabel = document.createElement("span");
    pageLabel.className = "jobo-pager__page";
    pageLabel.textContent = `Page ${page + 1} / ${pages}`;
    nav.appendChild(pageLabel);

    nav.appendChild(
      mkBtn("›", "Next page", page + 1, locked || page >= pages - 1)
    );
    nav.appendChild(
      mkBtn("»", "Last page", pages - 1, locked || page >= pages - 1)
    );
    el.pager.appendChild(nav);
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

  // --- Row context menu --------------------------------------------------

  /** @type {HTMLElement|null} */
  let menuEl = null;

  function closeRowMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener("mousedown", onMenuOutside, true);
    document.removeEventListener("keydown", onMenuKey, true);
    document.removeEventListener("scroll", closeRowMenu, true);
    window.removeEventListener("blur", closeRowMenu);
    window.removeEventListener("resize", closeRowMenu);
  }

  function onMenuOutside(e) {
    if (menuEl && !menuEl.contains(e.target)) closeRowMenu();
  }

  function onMenuKey(e) {
    if (e.key === "Escape") closeRowMenu();
  }

  function showRowMenu(event, row) {
    closeRowMenu();
    const deletable = row.isNew || state.editable;

    const menu = document.createElement("div");
    menu.className = "jobo-context-menu";

    const item = document.createElement("button");
    item.type = "button";
    item.className = "jobo-context-menu__item";
    item.textContent = row.isDeleted ? "↺ 削除を取り消す" : "🗑 行を削除";
    item.disabled = !deletable;
    if (!deletable) {
      item.title = "主キーが無いため既存行は削除できません";
    }
    item.addEventListener("click", () => {
      closeRowMenu();
      if (deletable) toggleDelete(row);
    });
    menu.appendChild(item);

    document.body.appendChild(menu);
    menuEl = menu;

    const rect = menu.getBoundingClientRect();
    let x = event.clientX;
    let y = event.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
    menu.style.left = `${Math.max(0, x)}px`;
    menu.style.top = `${Math.max(0, y)}px`;

    setTimeout(() => {
      document.addEventListener("mousedown", onMenuOutside, true);
      document.addEventListener("keydown", onMenuKey, true);
      document.addEventListener("scroll", closeRowMenu, true);
      window.addEventListener("blur", closeRowMenu);
      window.addEventListener("resize", closeRowMenu);
    }, 0);
  }

  function addRow() {
    const cells = state.columns.map(() => null);
    // New rows are appended to the bottom of the current page; they live only on
    // the client until committed, so no re-fetch is needed.
    state.rows.push({
      key: state.nextKey++,
      original: cells.slice(),
      cells,
      isNew: true,
      isDeleted: false,
      changedCols: new Set(),
    });
    render();
  }

  function toggleSort(col) {
    // Sorting is server-side; reset to the first page and re-query.
    if (state.busy || hasPending()) return;
    let nextSort;
    if (state.sortCol === col) {
      nextSort = state.sortDir === "asc"
        ? { col: state.columns[col].name, dir: "desc" }
        : null;
    } else {
      nextSort = { col: state.columns[col].name, dir: "asc" };
    }
    requestView({ offset: 0, sort: nextSort });
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

  el.addRow.addEventListener("click", addRow);
  el.reload.addEventListener("click", () => {
    // Reload the current page/sort window; pending edits are discarded.
    requestView({});
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
