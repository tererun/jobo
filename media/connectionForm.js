/*
 * Connection form view — webview client script.
 *
 * Runs inside the Webview sandbox (no Node/vscode APIs; communicates with the
 * extension host only via postMessage). Responsibilities:
 *   - request initial values on load ("ready"), populate the form on "init"
 *   - toggle field groups when the driver changes (SQLite file vs. networked)
 *     and reveal the SSH tunnel section when the tunnel checkbox is ticked
 *   - on submit, gather all field values and post them to the host ("submit");
 *     validation + persistence happen host-side
 *   - surface host-reported validation/save errors ("error")
 *
 * The host never trusts raw values blindly: it re-validates and assembles the
 * persisted ConnectionConfig / ConnectionSecrets itself.
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const DEFAULT_PORTS = { postgres: "5432", mysql: "3306", sqlite: "" };

  const $ = (id) => document.getElementById(id);

  const form = $("form");
  const errorEl = $("error");
  const driverEl = $("driver");
  const portEl = $("port");
  const groupSqlite = $("group-sqlite");
  const groupNetwork = $("group-network");
  const groupSsh = $("group-ssh");
  const useSshEl = $("useSsh");
  const saveBtn = $("save");

  /** Show / clear the inline error banner. */
  function setError(message) {
    if (message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    } else {
      errorEl.textContent = "";
      errorEl.hidden = true;
    }
  }

  /** Reflect the selected driver: SQLite shows a file path, others the network group. */
  function applyDriverVisibility() {
    const isSqlite = driverEl.value === "sqlite";
    groupSqlite.hidden = !isSqlite;
    groupNetwork.hidden = isSqlite;
  }

  /** Reflect the SSH tunnel checkbox. */
  function applySshVisibility() {
    groupSsh.hidden = !useSshEl.checked;
  }

  /** Update the port placeholder to the driver's default when empty. */
  function applyPortPlaceholder() {
    portEl.placeholder = DEFAULT_PORTS[driverEl.value] || "";
  }

  /** Populate the form from the host's initial data payload. */
  function populate(isEdit, data) {
    $("form-title").textContent = isEdit ? "Edit Connection" : "New Connection";
    saveBtn.textContent = isEdit ? "Save Changes" : "Add Connection";

    $("name").value = data.name || "";
    driverEl.value = data.driver || "postgres";
    $("host").value = data.host || "";
    portEl.value = data.port || "";
    $("database").value = data.database || "";
    $("user").value = data.user || "";
    $("password").value = data.password || "";
    $("file").value = data.file || "";
    $("ssl").checked = Boolean(data.ssl);
    useSshEl.checked = Boolean(data.useSsh);
    $("sshConfigHost").value = data.sshConfigHost || "";
    $("sshHost").value = data.sshHost || "";
    $("sshPort").value = data.sshPort || "";
    $("sshUser").value = data.sshUser || "";
    $("sshIdentityFile").value = data.sshIdentityFile || "";
    $("sshPassword").value = data.sshPassword || "";
    $("sshPassphrase").value = data.sshPassphrase || "";

    applyDriverVisibility();
    applySshVisibility();
    applyPortPlaceholder();
    $("name").focus();
  }

  /** Collect the current form values into the flat FormData shape. */
  function collect() {
    return {
      name: $("name").value,
      driver: driverEl.value,
      host: $("host").value,
      port: portEl.value,
      database: $("database").value,
      user: $("user").value,
      password: $("password").value,
      file: $("file").value,
      ssl: $("ssl").checked,
      useSsh: useSshEl.checked,
      sshConfigHost: $("sshConfigHost").value,
      sshHost: $("sshHost").value,
      sshPort: $("sshPort").value,
      sshUser: $("sshUser").value,
      sshIdentityFile: $("sshIdentityFile").value,
      sshPassword: $("sshPassword").value,
      sshPassphrase: $("sshPassphrase").value,
    };
  }

  driverEl.addEventListener("change", () => {
    applyDriverVisibility();
    applyPortPlaceholder();
  });
  useSshEl.addEventListener("change", applySshVisibility);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    setError(null);
    vscode.postMessage({ type: "submit", data: collect() });
  });

  $("cancel").addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      vscode.postMessage({ type: "cancel" });
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") {
      return;
    }
    switch (msg.type) {
      case "init":
        populate(Boolean(msg.isEdit), msg.data || {});
        break;
      case "error":
        setError(msg.message || "Unknown error.");
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
