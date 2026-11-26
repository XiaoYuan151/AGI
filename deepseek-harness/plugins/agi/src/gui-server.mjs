import http from "node:http";
import { AgyAcpClient } from "./lib/core/index.mjs";
import { AgyDshGuiService } from "./gui-service.mjs";
import { AGI_API_PATH, handleAgiFetchRequest } from "./gui-routes.mjs";

const MAX_BODY_BYTES = 64 * 1024;

function isLoopbackAddress(host) {
  if (!host) return false;
  const normalized = String(host).trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return isLoopbackAddress(parsed.hostname);
  } catch {
    return false;
  }
}

function isAllowedHostHeader(hostHeader) {
  if (!hostHeader) return true;
  const host = String(hostHeader).replace(/^\[([^\]]+)\].*$/, "$1").split(":")[0];
  return isLoopbackAddress(host);
}

function readNodeBody(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        const err = new Error("Request body too large");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function renderStandaloneGuiHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek Harness · Antigravity ACP Account Console</title>
<style>
  :root {
    --bg: #f6f8fb;
    --surface: #ffffff;
    --surface-2: #f1f5f9;
    --border: rgba(15, 23, 42, 0.12);
    --border-strong: rgba(15, 23, 42, 0.22);
    --text: #0f172a;
    --text-2: #475569;
    --text-3: #64748b;
    --accent: #2563eb;
    --accent-hover: #1d4ed8;
    --accent-soft: rgba(37, 99, 235, 0.1);
    --ok: #10b981;
    --ok-soft: rgba(16, 185, 129, 0.12);
    --warn: #f59e0b;
    --warn-soft: rgba(245, 158, 11, 0.14);
    --err: #ef4444;
    --err-soft: rgba(239, 68, 68, 0.12);
    --radius: 10px;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0e14;
      --surface: #121722;
      --surface-2: #171e2c;
      --border: rgba(226, 232, 240, 0.12);
      --border-strong: rgba(226, 232, 240, 0.24);
      --text: #e2e8f0;
      --text-2: #94a3b8;
      --text-3: #64748b;
      --accent: #4c8dff;
      --accent-hover: #3b7ef6;
      --accent-soft: rgba(76, 141, 255, 0.15);
      --ok: #34d399;
      --ok-soft: rgba(52, 211, 153, 0.14);
      --warn: #fbbf24;
      --warn-soft: rgba(251, 191, 36, 0.14);
      --err: #f87171;
      --err-soft: rgba(248, 113, 113, 0.14);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.5;
    padding: 24px 16px 48px;
  }
  .shell { max-width: 780px; margin: 0 auto; display: grid; gap: 16px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
  .header h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
  .header p { margin: 4px 0 0; color: var(--text-2); font-size: 13px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
  }
  .telemetry {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    background: linear-gradient(135deg, var(--surface) 0%, var(--surface-2) 100%);
  }
  .telemetry-left { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
  .beacon {
    width: 10px; height: 10px; border-radius: 999px; flex-shrink: 0;
    background: var(--warn); box-shadow: 0 0 0 4px var(--warn-soft);
  }
  .beacon.ok { background: var(--ok); box-shadow: 0 0 0 4px var(--ok-soft); }
  .beacon.running { background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .beacon.running { animation: none; } }
  .mono { font-family: var(--mono); font-size: 12px; }
  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
    background: var(--surface-2); color: var(--text-2); border: 1px solid var(--border);
  }
  .pill.ok { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
  .pill.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
  .pill.accent { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    height: 34px; padding: 0 13px; border-radius: 8px; border: 1px solid var(--border-strong);
    background: var(--surface); color: var(--text); font-size: 13px; font-weight: 500;
    cursor: pointer; text-decoration: none;
  }
  .btn:hover:not(:disabled) { background: var(--surface-2); }
  .btn:focus-visible, input:focus-visible, select:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn.primary { background: var(--accent); color: #fff; border-color: transparent; }
  .btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn.danger { color: var(--err); border-color: rgba(239, 68, 68, 0.35); }
  .btn.sm { height: 28px; padding: 0 10px; font-size: 12px; }
  .tabs { display: inline-flex; gap: 4px; padding: 3px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); margin-bottom: 14px; flex-wrap: wrap; }
  .tab { border: none; background: transparent; color: var(--text-2); padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; }
  .tab.active { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .between { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .field { display: grid; gap: 4px; margin-bottom: 10px; }
  .field label { font-size: 12px; font-weight: 500; color: var(--text-2); }
  .input {
    width: 100%; height: 34px; padding: 0 10px; border-radius: 8px;
    border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
    font-size: 13px;
  }
  .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
  .acct-list { display: grid; gap: 8px; margin-top: 12px; }
  .acct-row {
    border: 1px solid var(--border); border-radius: 8px; padding: 12px;
    background: var(--surface); display: grid; gap: 8px;
  }
  .acct-row.active { border-left: 3px solid var(--accent); background: var(--surface-2); }
  .notice { padding: 10px 12px; border-radius: 8px; font-size: 13px; border: 1px solid var(--border); }
  .notice.ok { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
  .notice.err { background: var(--err-soft); color: var(--err); border-color: transparent; }
  .models-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin-top: 10px; }
  .model-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--surface-2); }
  pre.log {
    margin: 8px 0 0; padding: 10px; border-radius: 8px; background: var(--surface-2);
    border: 1px solid var(--border); max-height: 140px; overflow: auto;
    font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-all;
  }
  .muted { color: var(--text-2); font-size: 12px; }
</style>
</head>
<body>
<div class="shell" id="app">
  <div class="header">
    <div>
      <h1>Antigravity (ACP) · DeepSeek Harness</h1>
      <p>Sign in via official Google ACP or API key and manage isolated multi-account folders.</p>
    </div>
    <div class="row">
      <button class="btn" id="btn-refresh">Refresh Models</button>
    </div>
  </div>
  <div id="notice-area"></div>
  <div class="card telemetry" id="telemetry-card">Loading state…</div>
  <div class="card" id="auth-card"></div>
  <div class="card" id="accounts-card"></div>
  <div class="card" id="models-card"></div>
</div>
<script>
(function () {
  var state = null;
  var authTab = "google";
  var busy = false;
  var showAdd = false;
  var editingName = null;
  var removingName = null;
  var purgeChecked = false;
  var apiKeyValue = "";
  var showKey = false;
  var persistKey = true;
  var addForm = { name: "", label: "", dataDir: "", appDataDir: "antigravity-acp", authMethod: "", activate: true, startLogin: false };
  var editForm = { label: "", dataDir: "", appDataDir: "antigravity-acp", authMethod: "" };
  var pollTimer = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function showNotice(kind, text) {
    var area = document.getElementById("notice-area");
    if (!text) { area.innerHTML = ""; return; }
    area.innerHTML = '<div class="notice ' + (kind === "err" ? "err" : "ok") + '">' + esc(text) + "</div>";
  }

  async function apiGet(probe) {
    var res = await fetch("/api/agi" + (probe ? "?probe=1" : ""), { cache: "no-store" });
    var data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  async function apiPost(action, payload) {
    busy = true;
    render();
    try {
      var res = await fetch("/api/agi", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ action: action }, payload || {})),
      });
      var data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || ("HTTP " + res.status));
      state = data;
      return data;
    } finally {
      busy = false;
      syncPolling();
      render();
    }
  }

  function syncPolling() {
    if (state && state.loginSession && state.loginSession.status === "running") {
      if (!pollTimer) {
        pollTimer = setInterval(async function () {
          try {
            var next = await apiGet(false);
            state = next;
            if (!next.loginSession || next.loginSession.status !== "running") {
              clearInterval(pollTimer);
              pollTimer = null;
              if (next.loginSession && next.loginSession.status === "succeeded") {
                showNotice("ok", "Google sign-in completed and models refreshed.");
              } else if (next.loginSession && next.loginSession.status === "failed") {
                showNotice("err", next.loginSession.error || "Google sign-in failed.");
              }
            }
            render();
          } catch (e) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        }, 1200);
      }
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function renderTelemetry() {
    var el = document.getElementById("telemetry-card");
    if (!state) { el.textContent = "Loading…"; return; }
    var auth = state.auth || {};
    var runningLogin = state.loginSession && state.loginSession.status === "running";
    var cls = runningLogin ? "running" : (auth.authenticated ? "ok" : "");
    var statusLabel = runningLogin ? "Signing in…" : (auth.authenticated ? "Authenticated" : "Sign-in required");
    el.innerHTML =
      '<div class="telemetry-left">' +
        '<span class="beacon ' + cls + '"></span>' +
        '<div style="min-width:0">' +
          '<div class="row">' +
            '<strong>' + esc(state.activeAccount || "(default)") + '</strong>' +
            '<span class="pill ' + (auth.authenticated ? "ok" : "warn") + '">' + esc(statusLabel) + '</span>' +
            '<span class="pill ' + (state.modelSource === "acp" ? "accent" : "") + '">' + esc(state.modelSource === "acp" ? "ACP LIVE" : "FALLBACK") + ' · ' + esc((state.models || []).length) + ' models</span>' +
          '</div>' +
          '<div class="mono muted" style="margin-top:4px;overflow:hidden;text-overflow:ellipsis">' + esc(auth.geminiDir || "(default ~/.gemini)") + '</div>' +
        '</div>' +
      '</div>' +
      (auth.authenticated ? '<button class="btn danger sm" id="btn-logout"' + (busy ? " disabled" : "") + '>Sign Out</button>' : "");
    var logoutBtn = document.getElementById("btn-logout");
    if (logoutBtn) {
      logoutBtn.onclick = async function () {
        try {
          await apiPost("logout", {});
          showNotice("ok", "Signed out of active account.");
        } catch (e) { showNotice("err", e.message); }
      };
    }
  }

  function renderAuth() {
    var el = document.getElementById("auth-card");
    if (!state) { el.innerHTML = ""; return; }
    var auth = state.auth || {};
    var ls = state.loginSession || { status: "idle", outputTail: [] };
    var tabsHtml =
      '<div class="tabs">' +
        '<button class="tab ' + (authTab === "google" ? "active" : "") + '" data-tab="google">Google Sign-In</button>' +
        '<button class="tab ' + (authTab === "apikey" ? "active" : "") + '" data-tab="apikey">Gemini API Key</button>' +
        '<button class="tab ' + (authTab === "enterprise" ? "active" : "") + '" data-tab="enterprise">Enterprise / Vertex</button>' +
      '</div>';
    var body = "";
    if (authTab === "google") {
      body =
        '<div class="row">' +
          '<button class="btn primary" id="btn-google-login"' + (busy || ls.status === "running" ? " disabled" : "") + '>' +
            (ls.status === "running" ? "Waiting for Google Sign-In…" : "Sign in with Google") +
          '</button>' +
          (ls.status === "running" ? '<button class="btn danger" id="btn-google-cancel">Cancel</button>' : "") +
          (ls.authUrl ? '<a class="btn" href="' + esc(ls.authUrl) + '" target="_blank" rel="noopener noreferrer">Open Sign-In Page</a>' : "") +
        '</div>' +
        '<p class="muted" style="margin:10px 0 4px">Manual CLI command (isolated profile):</p>' +
        '<div class="mono" style="padding:8px 10px;border-radius:6px;background:var(--surface-2);border:1px solid var(--border);word-break:break-all">' + esc(auth.loginCommand || "agy acp --login") + '</div>' +
        (ls.outputTail && ls.outputTail.length ? '<pre class="log">' + esc(ls.outputTail.join("\\n")) + '</pre>' : "");
    } else if (authTab === "apikey") {
      body =
        '<div class="field"><label>Gemini API Key (GEMINI_API_KEY) · current source: <strong>' + esc(auth.apiKeySource || "none") + '</strong></label>' +
          '<div class="row">' +
            '<input class="input" style="flex:1;min-width:200px" id="inp-apikey" type="' + (showKey ? "text" : "password") + '" placeholder="AIza..." value="' + esc(apiKeyValue) + '">' +
            '<button class="btn" id="btn-toggle-key" type="button">' + (showKey ? "Hide" : "Show") + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="between">' +
          '<label class="row" style="font-size:13px;cursor:pointer"><input type="checkbox" id="chk-persist-key"' + (persistKey ? " checked" : "") + '> Remember in isolated account folder (0600)</label>' +
          '<div class="row">' +
            '<button class="btn primary" id="btn-save-key"' + (busy ? " disabled" : "") + '>Save &amp; Connect</button>' +
            (auth.hasStoredAccountKey || auth.hasGeminiApiKey ? '<button class="btn danger" id="btn-clear-key"' + (busy ? " disabled" : "") + '>Clear Key</button>' : "") +
          '</div>' +
        '</div>';
    } else {
      body =
        '<p class="muted" style="margin-top:0">Authenticate using Google Gemini Enterprise or Vertex Agent Platform credentials configured in your environment.</p>' +
        '<div class="row">' +
          '<button class="btn primary" id="btn-auth-business"' + (busy ? " disabled" : "") + '>Connect Gemini Enterprise (oauth-business)</button>' +
          '<button class="btn" id="btn-auth-vertex"' + (busy ? " disabled" : "") + '>Connect Vertex Agent Platform (agent-platform)</button>' +
        '</div>';
    }
    el.innerHTML = '<div class="between" style="margin-bottom:10px"><strong>Authentication</strong></div>' + tabsHtml + body;
    el.querySelectorAll(".tab").forEach(function (btn) {
      btn.onclick = function () { authTab = btn.getAttribute("data-tab"); renderAuth(); };
    });
    if (document.getElementById("btn-google-login")) {
      document.getElementById("btn-google-login").onclick = async function () {
        try { await apiPost("login-google-start", { account: state.activeAccount || "" }); } catch (e) { showNotice("err", e.message); }
      };
    }
    if (document.getElementById("btn-google-cancel")) {
      document.getElementById("btn-google-cancel").onclick = async function () {
        try { await apiPost("login-google-cancel", {}); } catch (e) { showNotice("err", e.message); }
      };
    }
    if (document.getElementById("inp-apikey")) {
      document.getElementById("inp-apikey").oninput = function (e) { apiKeyValue = e.target.value; };
    }
    if (document.getElementById("btn-toggle-key")) {
      document.getElementById("btn-toggle-key").onclick = function () { showKey = !showKey; renderAuth(); };
    }
    if (document.getElementById("chk-persist-key")) {
      document.getElementById("chk-persist-key").onchange = function (e) { persistKey = e.target.checked; };
    }
    if (document.getElementById("btn-save-key")) {
      document.getElementById("btn-save-key").onclick = async function () {
        try {
          await apiPost("auth-api-key", { account: state.activeAccount || "", apiKey: apiKeyValue, persist: persistKey });
          apiKeyValue = "";
          showNotice("ok", "API key verified and connected.");
        } catch (e) { showNotice("err", e.message); }
      };
    }
    if (document.getElementById("btn-clear-key")) {
      document.getElementById("btn-clear-key").onclick = async function () {
        try {
          await apiPost("auth-api-key-clear", { account: state.activeAccount || "" });
          showNotice("ok", "Cleared API key.");
        } catch (e) { showNotice("err", e.message); }
      };
    }
    if (document.getElementById("btn-auth-business")) {
      document.getElementById("btn-auth-business").onclick = async function () {
        try { await apiPost("auth-method", { methodId: "oauth-business" }); showNotice("ok", "Connected via oauth-business."); } catch (e) { showNotice("err", e.message); }
      };
    }
    if (document.getElementById("btn-auth-vertex")) {
      document.getElementById("btn-auth-vertex").onclick = async function () {
        try { await apiPost("auth-method", { methodId: "agent-platform" }); showNotice("ok", "Connected via agent-platform."); } catch (e) { showNotice("err", e.message); }
      };
    }
  }

  function renderAccounts() {
    var el = document.getElementById("accounts-card");
    if (!state) { el.innerHTML = ""; return; }
    var accts = state.accounts || [];
    var addHtml = showAdd ? (
      '<div style="border:1px solid var(--border-strong);border-radius:8px;padding:12px;margin-top:12px;background:var(--surface-2)">' +
        '<div class="grid-2">' +
          '<div class="field"><label>Account Name *</label><input class="input" id="add-name" placeholder="e.g. work" value="' + esc(addForm.name) + '"></div>' +
          '<div class="field"><label>Display Label</label><input class="input" id="add-label" placeholder="Work Gemini" value="' + esc(addForm.label) + '"></div>' +
          '<div class="field"><label>Isolated Data Folder (--gemini-dir)</label><input class="input mono" id="add-dir" placeholder="~/.agi/accounts/' + esc(addForm.name || "name") + '" value="' + esc(addForm.dataDir) + '"></div>' +
          '<div class="field"><label>App Data Dir</label><input class="input mono" id="add-appdir" value="' + esc(addForm.appDataDir) + '"></div>' +
        '</div>' +
        '<div class="between" style="margin-top:6px">' +
          '<div class="row">' +
            '<label class="row" style="font-size:12px"><input type="checkbox" id="add-activate"' + (addForm.activate ? " checked" : "") + '> Activate immediately</label>' +
            '<label class="row" style="font-size:12px"><input type="checkbox" id="add-login"' + (addForm.startLogin ? " checked" : "") + '> Start Google sign-in</label>' +
          '</div>' +
          '<div class="row">' +
            '<button class="btn sm" id="btn-cancel-add">Cancel</button>' +
            '<button class="btn primary sm" id="btn-submit-add"' + (busy ? " disabled" : "") + '>Create Account</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    ) : "";

    var rowsHtml = accts.length === 0
      ? '<p class="muted" style="margin:12px 0 0">No isolated accounts configured yet. Add one to separate credentials and data folders.</p>'
      : '<div class="acct-list">' + accts.map(function (a) {
          var isEditing = editingName === a.name;
          var isRemoving = removingName === a.name;
          var probed = a.probed;
          var badge = probed
            ? (probed.authenticated ? '<span class="pill ok">Authenticated (' + esc(probed.modelsCount) + ')</span>' : '<span class="pill warn">Unauthenticated</span>')
            : (a.hasStoredApiKey ? '<span class="pill accent">API Key Saved</span>' : "");
          var editBlock = isEditing ? (
            '<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px">' +
              '<div class="grid-2">' +
                '<div class="field"><label>Label</label><input class="input" id="edit-label" value="' + esc(editForm.label) + '"></div>' +
                '<div class="field"><label>Data Folder</label><input class="input mono" id="edit-dir" value="' + esc(editForm.dataDir) + '"></div>' +
              '</div>' +
              '<div class="row">' +
                '<button class="btn primary sm" data-save-edit="' + esc(a.name) + '">Save Changes</button>' +
                '<button class="btn sm" id="btn-cancel-edit">Cancel</button>' +
              '</div>' +
            '</div>'
          ) : "";
          var removeBlock = isRemoving ? (
            '<div class="between" style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px">' +
              '<label class="row" style="font-size:12px;color:var(--err)"><input type="checkbox" id="chk-purge"' + (purgeChecked ? " checked" : "") + '> Also delete isolated data folder on disk</label>' +
              '<div class="row">' +
                '<button class="btn sm" id="btn-cancel-rm">Keep</button>' +
                '<button class="btn danger sm" data-confirm-rm="' + esc(a.name) + '">Confirm Remove</button>' +
              '</div>' +
            '</div>'
          ) : "";

          return (
            '<div class="acct-row ' + (a.active ? "active" : "") + '">' +
              '<div class="between">' +
                '<div>' +
                  '<div class="row">' +
                    '<strong>' + esc(a.name) + '</strong>' +
                    (a.label ? '<span class="muted">(' + esc(a.label) + ')</span>' : "") +
                    (a.active ? '<span class="pill accent">Active</span>' : "") +
                    badge +
                  '</div>' +
                  '<div class="mono muted" style="margin-top:2px">' + esc(a.geminiDir || "(default ~/.gemini)") + '</div>' +
                '</div>' +
                '<div class="row">' +
                  (!a.active ? '<button class="btn primary sm" data-use="' + esc(a.name) + '"' + (busy ? " disabled" : "") + '>Use</button>' : "") +
                  '<button class="btn sm" data-signin="' + esc(a.name) + '"' + (busy ? " disabled" : "") + '>Sign In</button>' +
                  '<button class="btn sm" data-edit="' + esc(a.name) + '">Edit</button>' +
                  '<button class="btn danger sm" data-rm="' + esc(a.name) + '">Remove</button>' +
                '</div>' +
              '</div>' +
              editBlock +
              removeBlock +
            '</div>'
          );
        }).join("") + '</div>';

    el.innerHTML =
      '<div class="between">' +
        '<div><strong>Accounts (' + esc(accts.length) + ')</strong> <span class="muted mono">' + esc(state.configPath || "~/.agi/acp.json") + '</span></div>' +
        '<div class="row">' +
          '<button class="btn sm" id="btn-probe-all"' + (busy ? " disabled" : "") + '>Check All</button>' +
          '<button class="btn primary sm" id="btn-toggle-add">' + (showAdd ? "Close" : "+ Add Account") + '</button>' +
        '</div>' +
      '</div>' +
      addHtml +
      rowsHtml;

    document.getElementById("btn-toggle-add").onclick = function () { showAdd = !showAdd; renderAccounts(); };
    document.getElementById("btn-probe-all").onclick = async function () {
      try { await apiPost("probe-accounts", {}); showNotice("ok", "Checked auth status for all accounts."); } catch (e) { showNotice("err", e.message); }
    };
    if (showAdd) {
      document.getElementById("add-name").oninput = function (e) { addForm.name = e.target.value; };
      document.getElementById("add-label").oninput = function (e) { addForm.label = e.target.value; };
      document.getElementById("add-dir").oninput = function (e) { addForm.dataDir = e.target.value; };
      document.getElementById("add-appdir").oninput = function (e) { addForm.appDataDir = e.target.value; };
      document.getElementById("add-activate").onchange = function (e) { addForm.activate = e.target.checked; };
      document.getElementById("add-login").onchange = function (e) { addForm.startLogin = e.target.checked; };
      document.getElementById("btn-cancel-add").onclick = function () { showAdd = false; renderAccounts(); };
      document.getElementById("btn-submit-add").onclick = async function () {
        try {
          await apiPost("account-add", addForm);
          showAdd = false;
          addForm = { name: "", label: "", dataDir: "", appDataDir: "antigravity-acp", authMethod: "", activate: true, startLogin: false };
          showNotice("ok", "Account saved.");
        } catch (e) { showNotice("err", e.message); }
      };
    }

    el.querySelectorAll("[data-use]").forEach(function (btn) {
      btn.onclick = async function () {
        var name = btn.getAttribute("data-use");
        try { await apiPost("account-use", { name: name }); showNotice("ok", "Switched active account to " + name + "."); } catch (e) { showNotice("err", e.message); }
      };
    });
    el.querySelectorAll("[data-signin]").forEach(function (btn) {
      btn.onclick = async function () {
        var name = btn.getAttribute("data-signin");
        authTab = "google";
        try { await apiPost("login-google-start", { account: name }); } catch (e) { showNotice("err", e.message); }
      };
    });
    el.querySelectorAll("[data-edit]").forEach(function (btn) {
      btn.onclick = function () {
        var name = btn.getAttribute("data-edit");
        var found = accts.find(function (x) { return x.name === name; });
        editingName = editingName === name ? null : name;
        removingName = null;
        if (found) editForm = { label: found.label || "", dataDir: found.geminiDir || "", appDataDir: found.appDataDir || "antigravity-acp", authMethod: found.authMethod || "" };
        renderAccounts();
      };
    });
    el.querySelectorAll("[data-rm]").forEach(function (btn) {
      btn.onclick = function () {
        var name = btn.getAttribute("data-rm");
        removingName = removingName === name ? null : name;
        editingName = null;
        purgeChecked = false;
        renderAccounts();
      };
    });
    if (document.getElementById("edit-label")) {
      document.getElementById("edit-label").oninput = function (e) { editForm.label = e.target.value; };
      document.getElementById("edit-dir").oninput = function (e) { editForm.dataDir = e.target.value; };
      document.getElementById("btn-cancel-edit").onclick = function () { editingName = null; renderAccounts(); };
      el.querySelectorAll("[data-save-edit]").forEach(function (btn) {
        btn.onclick = async function () {
          try {
            await apiPost("account-update", Object.assign({ name: btn.getAttribute("data-save-edit") }, editForm));
            editingName = null;
            showNotice("ok", "Account updated.");
          } catch (e) { showNotice("err", e.message); }
        };
      });
    }
    if (document.getElementById("chk-purge")) {
      document.getElementById("chk-purge").onchange = function (e) { purgeChecked = e.target.checked; };
      document.getElementById("btn-cancel-rm").onclick = function () { removingName = null; renderAccounts(); };
      el.querySelectorAll("[data-confirm-rm]").forEach(function (btn) {
        btn.onclick = async function () {
          var name = btn.getAttribute("data-confirm-rm");
          try {
            await apiPost("account-remove", { name: name, purgeData: purgeChecked });
            removingName = null;
            showNotice("ok", "Removed account " + name + ".");
          } catch (e) { showNotice("err", e.message); }
        };
      });
    }
  }

  function renderModels() {
    var el = document.getElementById("models-card");
    if (!state) { el.innerHTML = ""; return; }
    var models = state.models || [];
    el.innerHTML =
      '<div class="between"><strong>Models (' + esc(models.length) + ')</strong><span class="muted">Source: ' + esc(state.modelSource) + '</span></div>' +
      '<div class="models-grid">' + models.map(function (m) {
        return '<div class="model-card"><div style="font-weight:600">' + esc(m.name) + '</div><div class="mono muted">' + esc(m.fullId) + '</div><div class="muted" style="margin-top:4px">' + esc((m.efforts || []).join(" · ")) + '</div></div>';
      }).join("") + '</div>';
  }

  function render() {
    renderTelemetry();
    renderAuth();
    renderAccounts();
    renderModels();
  }

  document.getElementById("btn-refresh").onclick = async function () {
    try { await apiPost("refresh", {}); showNotice("ok", "Refreshed live ACP models."); } catch (e) { showNotice("err", e.message); }
  };

  apiGet(false).then(function (data) {
    state = data;
    syncPolling();
    render();
  }).catch(function (e) {
    showNotice("err", e.message);
  });
})();
</script>
</body>
</html>`;
}

/**
 * Standalone loopback-only HTTP server for DeepSeek Harness Account & Login GUI.
 * Delegates `/api/agi` directly to `handleAgiFetchRequest` (DIP).
 */
export function createDshGuiServer(options = {}) {
  const host = options.host || "127.0.0.1";
  const port = options.port ?? 0;
  if (!isLoopbackAddress(host)) {
    throw new Error(`Standalone GUI must bind to loopback address only (got '${host}').`);
  }

  const ownsClient = !options.client && !options.guiService;
  const client =
    options.client ||
    new AgyAcpClient({
      ...(options.agyBin ? { agyBin: options.agyBin } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
  const ownsService = !options.guiService;
  const guiService =
    options.guiService ||
    new AgyDshGuiService({
      client,
      providerId: options.providerId || "agy",
      providerName: options.providerName || "Antigravity (ACP)",
    });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
      const pathname = url.pathname;

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = renderStandaloneGuiHtml();
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      if (pathname === AGI_API_PATH || pathname.startsWith(`${AGI_API_PATH}?`)) {
        if (!isAllowedHostHeader(req.headers?.host) || !isAllowedOrigin(req.headers?.origin)) {
          res.writeHead(403, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ ok: false, error: "Forbidden non-loopback origin" }));
          return;
        }
        const method = String(req.method || "GET").toUpperCase();
        const text = method === "POST" ? await readNodeBody(req) : "";
        const fakeReq = {
          method,
          url: req.url || AGI_API_PATH,
          headers: {
            get: (k) => req.headers?.[String(k).toLowerCase()] ?? null,
          },
          text: async () => text,
        };
        const fetchRes = await handleAgiFetchRequest(fakeReq, guiService);
        const bodyText = await fetchRes.text();
        res.writeHead(fetchRes.status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(bodyText);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `Not found: ${req.method} ${pathname}` }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err?.statusCode || 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err?.message || "Internal server error" }));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  async function start() {
    await new Promise((resolve, reject) => {
      const onErr = (err) => {
        server.off("listening", onListen);
        reject(err);
      };
      const onListen = () => {
        server.off("error", onErr);
        resolve();
      };
      server.once("error", onErr);
      server.once("listening", onListen);
      server.listen(port, host);
    });
    const addr = server.address();
    return {
      host,
      port: typeof addr === "object" && addr ? addr.port : port,
      url: `http://${host}:${typeof addr === "object" && addr ? addr.port : port}`,
    };
  }

  async function stop() {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    if (ownsService) {
      guiService.dispose();
    }
    if (ownsClient) {
      await client.dispose();
    }
  }

  return {
    server,
    guiService,
    start,
    stop,
    get port() {
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : port;
    },
    getUrl() {
      return `http://${host}:${this.port}`;
    },
  };
}
