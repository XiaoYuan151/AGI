/* global window, document */
(function (factory) {
  if (typeof window !== "undefined" && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === "function") {
    window.__ModuleLoader__.load({
      id: "@local/dsh-agi",
      factory: factory,
    });
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory(require);
  }
})(function (require) {
  "use strict";

  var react = require("react");
  var h = react.createElement;
  var useState = react.useState;
  var useEffect = react.useEffect;
  var useCallback = react.useCallback;
  var useMemo = react.useMemo;
  var useRef = react.useRef;

  var NAMESPACE = "agi-acp";
  var BUNDLE_PACKAGE_NAME = "@local/dsh-agi";
  var STYLE_ID = "agi-dsh-plugin-styles";
  var ACCOUNT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

  var LOCALES = {
    en: {
      label: "Antigravity (ACP)",
      description: "Manage Antigravity ACP sign-in, isolated Google accounts, API keys, and live models.",
      title: "Antigravity (ACP) Accounts & Sign-In",
      subtitle: "Configure Google sign-in, Gemini API keys, Enterprise/Vertex auth, and isolated multi-account profiles.",
      refresh: "Refresh",
      probeAll: "Check All",
      probing: "Checking...",
      loading: "Loading Antigravity ACP status...",
      statusReady: "Authenticated",
      statusAuthRequired: "Sign-In Required",
      statusCooldown: "Policy Cooldown",
      activeAccount: "Active Account",
      noAccount: "Default (env)",
      authMethod: "Method",
      apiKeySource: "Key Source",
      dataFolder: "Isolated Data Dir",
      tabGoogle: "Google Sign-In",
      tabApiKey: "Gemini API Key",
      tabEnterprise: "Enterprise & Session",
      googleHint: "Launches official `agy acp --login` inside the selected account's isolated directory.",
      startGoogleLogin: "Sign In with Google",
      cancelLogin: "Cancel Sign-In",
      openAuthUrl: "Open Sign-In URL",
      copyAuthUrl: "Copy URL",
      copyCliCmd: "Copy CLI Command",
      loginStatusIdle: "Ready",
      loginStatusRunning: "Waiting for Google browser sign-in...",
      loginStatusSucceeded: "Sign-in completed",
      loginStatusFailed: "Sign-in failed",
      loginStatusCancelled: "Sign-in cancelled",
      apiKeyLabel: "Gemini API Key",
      apiKeyPlaceholder: "AIza...",
      showKey: "Show",
      hideKey: "Hide",
      persistKey: "Save encrypted-permission key (0600) for this account",
      authWithKey: "Save & Authenticate",
      clearKey: "Clear Saved Key",
      storedKeyPresent: "Account key stored on disk",
      envKeyPresent: "Environment GEMINI_API_KEY active",
      enterpriseHint: "Switch to Gemini Enterprise or Google Vertex AI platform authentication, or sign out of the current session.",
      authBusiness: "Use Gemini Enterprise (oauth-business)",
      authVertex: "Use Vertex AI (agent-platform)",
      signOut: "Sign Out",
      accountsTitle: "Multi-Account Profiles",
      addAccountBtn: "+ Add Account",
      cancel: "Cancel",
      save: "Save",
      createAccount: "Create Account",
      accountName: "Account ID",
      accountNameHint: "1-64 characters: letters, numbers, '.', '_' or '-' (starts with letter or digit).",
      accountNameInvalid: "Must start with a letter/digit and contain only letters, digits, '.', '_' or '-'.",
      accountLabel: "Display Label",
      customDataDir: "Custom Data Dir (optional)",
      appDataDir: "App Data Folder Name",
      activateOnCreate: "Activate immediately",
      startLoginOnCreate: "Start Google sign-in right after creating",
      useAccount: "Use",
      inUse: "Active",
      signInAccount: "Sign In",
      editAccount: "Edit",
      removeAccount: "Remove",
      confirmRemoveTitle: "Remove account profile?",
      purgeDiskData: "Also delete isolated data folder on disk",
      confirmRemoveBtn: "Confirm Remove",
      modelsTitle: "Available Models",
      modelSource: "Source",
      noModels: "No models discovered yet. Sign in or click Refresh.",
      copied: "Copied to clipboard",
      targetAccount: "Target Account",
      outputLog: "Login Output",
    },
    zh: {
      label: "Antigravity (ACP)",
      description: "管理 Antigravity ACP 登录、多账号隔离配置目录、API Key 与可用模型。",
      title: "Antigravity (ACP) 账号与登录管理",
      subtitle: "配置 Google 登录、Gemini API Key、企业/Vertex 认证及多账号隔离配置。",
      refresh: "刷新",
      probeAll: "检测全部",
      probing: "检测中...",
      loading: "正在加载 Antigravity ACP 状态...",
      statusReady: "已认证",
      statusAuthRequired: "需要登录",
      statusCooldown: "策略冷却中",
      activeAccount: "当前账号",
      noAccount: "默认 (环境变量)",
      authMethod: "认证方式",
      apiKeySource: "Key 来源",
      dataFolder: "隔离数据目录",
      tabGoogle: "Google 登录",
      tabApiKey: "Gemini API Key",
      tabEnterprise: "企业认证与注销",
      googleHint: "在目标账号的隔离目录中启动官方 `agy acp --login` 登录流程。",
      startGoogleLogin: "使用 Google 登录",
      cancelLogin: "取消登录",
      openAuthUrl: "打开登录链接",
      copyAuthUrl: "复制链接",
      copyCliCmd: "复制 CLI 命令",
      loginStatusIdle: "就绪",
      loginStatusRunning: "等待浏览器完成 Google 登录...",
      loginStatusSucceeded: "登录成功",
      loginStatusFailed: "登录失败",
      loginStatusCancelled: "已取消登录",
      apiKeyLabel: "Gemini API Key",
      apiKeyPlaceholder: "AIza...",
      showKey: "显示",
      hideKey: "隐藏",
      persistKey: "以 0600 权限保存该账号独立 Key",
      authWithKey: "保存并认证",
      clearKey: "清除已保存 Key",
      storedKeyPresent: "已在本地保存账号 Key",
      envKeyPresent: "环境变量 GEMINI_API_KEY 已生效",
      enterpriseHint: "切换到 Gemini Enterprise 或 Vertex AI 认证，或退出当前账号登录状态。",
      authBusiness: "使用 Gemini Enterprise (oauth-business)",
      authVertex: "使用 Vertex AI (agent-platform)",
      signOut: "退出登录",
      accountsTitle: "多账号配置",
      addAccountBtn: "+ 添加账号",
      cancel: "取消",
      save: "保存",
      createAccount: "创建账号",
      accountName: "账号名称",
      accountNameHint: "1-64 位字母、数字、'.'、'_' 或 '-'（须以字母或数字开头）。",
      accountNameInvalid: "须以字母或数字开头，仅支持字母、数字、'.'、'_' 或 '-'。",
      accountLabel: "显示标签",
      customDataDir: "自定义数据目录（可选）",
      appDataDir: "应用数据子目录名",
      activateOnCreate: "创建后立即切换",
      startLoginOnCreate: "创建后立即发起 Google 登录",
      useAccount: "切换使用",
      inUse: "当前使用",
      signInAccount: "登录",
      editAccount: "编辑",
      removeAccount: "移除",
      confirmRemoveTitle: "确认移除该账号配置？",
      purgeDiskData: "同时删除磁盘上的隔离数据目录",
      confirmRemoveBtn: "确认移除",
      modelsTitle: "可用模型",
      modelSource: "来源",
      noModels: "暂无模型信息，请先登录或点击刷新。",
      copied: "已复制到剪贴板",
      targetAccount: "目标账号",
      outputLog: "登录日志输出",
    },
  };

  var CSS_TEXT = [
    ".agi-root { display: flex; flex-direction: column; gap: 16px; color: var(--dsw-alias-label-primary, #e6edf3); font-size: 13px; line-height: 1.45; }",
    ".agi-card { background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.03))); border: 1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, rgba(255,255,255,0.1))); border-radius: var(--dsw-radius-lg, 12px); padding: 16px; display: flex; flex-direction: column; gap: 12px; }",
    ".agi-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }",
    ".agi-row-tight { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
    ".agi-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6edf3); }",
    ".agi-subtitle { margin: 2px 0 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #9ba7b4); }",
    ".agi-muted { font-size: 12px; color: var(--dsw-alias-label-secondary, #9ba7b4); }",
    ".agi-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }",
    ".agi-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.04)); color: var(--dsw-alias-label-secondary, #9ba7b4); }",
    ".agi-pill-ok { color: var(--dsw-alias-state-success-primary, #3fb950); background: var(--dsw-alias-state-success-tertiary, rgba(63,185,80,0.12)); border-color: rgba(63,185,80,0.35); }",
    ".agi-pill-warn { color: var(--dsw-alias-state-warn-primary, #d29922); background: var(--dsw-alias-state-warn-tertiary, rgba(210,153,34,0.12)); border-color: rgba(210,153,34,0.35); }",
    ".agi-pill-err { color: var(--dsw-alias-state-error-primary, #f85149); background: rgba(248,81,73,0.12); border-color: rgba(248,81,73,0.35); }",
    ".agi-pill-brand { color: var(--dsw-alias-brand-primary, #4d8dff); background: rgba(77,141,255,0.12); border-color: rgba(77,141,255,0.35); }",
    ".agi-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 12px; border-radius: var(--dsw-radius-md, 8px); border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.16)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); color: var(--dsw-alias-label-primary, #e6edf3); font-size: 12px; font-weight: 500; cursor: pointer; transition: background 0.12s ease, opacity 0.12s ease; }",
    ".agi-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.1)); }",
    ".agi-btn:disabled { opacity: 0.55; cursor: not-allowed; }",
    ".agi-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3b82f6)); color: var(--dsw-alias-label-primary-foreground, #ffffff); border-color: transparent; }",
    ".agi-btn-primary:hover:not(:disabled) { opacity: 0.92; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3b82f6)); }",
    ".agi-btn-danger { color: var(--dsw-alias-state-error-primary, #f85149); border-color: rgba(248,81,73,0.4); }",
    ".agi-btn-sm { padding: 4px 9px; font-size: 11px; }",
    ".agi-telemetry { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 10px; }",
    ".agi-stat { padding: 10px 12px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03)); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08)); display: flex; flex-direction: column; gap: 4px; }",
    ".agi-stat-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, #7d8590); text-transform: uppercase; letter-spacing: 0.03em; }",
    ".agi-stat-value { font-size: 13px; font-weight: 600; word-break: break-all; }",
    ".agi-tabs { display: flex; gap: 4px; padding: 3px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08)); align-self: flex-start; flex-wrap: wrap; }",
    ".agi-tab { padding: 5px 11px; border-radius: var(--dsw-radius-sm, 6px); border: none; background: transparent; color: var(--dsw-alias-label-secondary, #9ba7b4); font-size: 12px; font-weight: 500; cursor: pointer; }",
    ".agi-tab-active { background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.12)); color: var(--dsw-alias-label-primary, #e6edf3); }",
    ".agi-field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 180px; }",
    ".agi-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary, #9ba7b4); }",
    ".agi-input, .agi-select { width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: var(--dsw-radius-md, 8px); border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14)); background: var(--dsw-alias-bg-base, rgba(0,0,0,0.2)); color: var(--dsw-alias-label-primary, #e6edf3); font-size: 12px; }",
    ".agi-check { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dsw-alias-label-secondary, #9ba7b4); cursor: pointer; }",
    ".agi-drawer { padding: 12px; border-radius: var(--dsw-radius-md, 8px); border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03)); display: flex; flex-direction: column; gap: 10px; }",
    ".agi-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }",
    ".agi-account-list { display: flex; flex-direction: column; gap: 8px; }",
    ".agi-account-row { position: relative; padding: 11px 12px; border-radius: var(--dsw-radius-md, 8px); border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.025)); display: flex; flex-direction: column; gap: 8px; }",
    ".agi-account-row-active { border-color: rgba(77,141,255,0.45); box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary, #4d8dff); }",
    ".agi-console { margin: 0; padding: 10px; border-radius: var(--dsw-radius-md, 8px); background: rgba(0,0,0,0.35); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08)); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; max-height: 150px; overflow: auto; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, #c9d1d9); }",
    ".agi-banner { padding: 9px 12px; border-radius: var(--dsw-radius-md, 8px); border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14)); display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; }",
    ".agi-banner-ok { border-color: rgba(63,185,80,0.4); background: var(--dsw-alias-state-success-tertiary, rgba(63,185,80,0.12)); color: var(--dsw-alias-state-success-primary, #3fb950); }",
    ".agi-banner-err { border-color: rgba(248,81,73,0.4); background: rgba(248,81,73,0.12); color: var(--dsw-alias-state-error-primary, #f85149); }",
    ".agi-banner-warn { border-color: rgba(210,153,34,0.4); background: var(--dsw-alias-state-warn-tertiary, rgba(210,153,34,0.12)); color: var(--dsw-alias-state-warn-primary, #d29922); }",
    ".agi-models-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }",
    ".agi-model-card { padding: 9px 11px; border-radius: var(--dsw-radius-md, 8px); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.025)); display: flex; flex-direction: column; gap: 4px; }",
  ].join("\n");

  function ensureStylesInjected() {
    if (typeof document === "undefined" || !document.head) return;
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);
  }

  function detectLang(localeSvc) {
    try {
      var lang = localeSvc && (localeSvc.current || localeSvc.lang || localeSvc.locale);
      if (typeof lang === "string" && lang.toLowerCase().startsWith("zh")) return "zh";
    } catch (_) {
      // ignore
    }
    if (typeof navigator !== "undefined" && typeof navigator.language === "string" && navigator.language.toLowerCase().startsWith("zh")) {
      return "zh";
    }
    return "en";
  }

  function makeTranslator(ctx) {
    var localeSvc = ctx && ctx.locale;
    return function t(key) {
      if (localeSvc && typeof localeSvc.t === "function") {
        var resolved = localeSvc.t(NAMESPACE + "." + key);
        if (resolved && resolved !== NAMESPACE + "." + key && resolved !== key) {
          return resolved;
        }
      }
      var lang = detectLang(localeSvc);
      return (LOCALES[lang] && LOCALES[lang][key]) || LOCALES.en[key] || key;
    };
  }

  async function apiGet(probe) {
    var url = probe ? "/api/agi?probe=1" : "/api/agi";
    var res = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
    var data = await res.json();
    if (!res.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || "HTTP " + res.status);
    }
    return data;
  }

  async function apiPost(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    var res = await fetch("/api/agi", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    var data = await res.json();
    if (!res.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || "HTTP " + res.status);
    }
    return data;
  }

  function copyText(text) {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(String(text || ""));
    }
    return Promise.resolve();
  }

  function formatTokens(n) {
    if (!n || typeof n !== "number") return "";
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return Math.round(n / 1000) + "k";
    return String(n);
  }

  function statusPillInfo(state, t) {
    var statusObj = state && state.status && typeof state.status === "object" ? state.status : null;
    var authObj = state && state.auth && typeof state.auth === "object" ? state.auth : null;
    if (statusObj && statusObj.policyCooldownUntil && statusObj.policyCooldownUntil > Date.now()) {
      return { text: t("statusCooldown"), cls: "agi-pill agi-pill-warn" };
    }
    if ((authObj && authObj.authenticated) || (statusObj && statusObj.authenticated)) {
      return { text: t("statusReady"), cls: "agi-pill agi-pill-ok" };
    }
    return { text: t("statusAuthRequired"), cls: "agi-pill agi-pill-warn" };
  }

  function createPanelComponent(ctx) {
    var t = makeTranslator(ctx);

    return function AgiAccountsPanel() {
      var stateTuple = useState(null);
      var state = stateTuple[0];
      var setState = stateTuple[1];

      var loadingTuple = useState(true);
      var loading = loadingTuple[0];
      var setLoading = loadingTuple[1];

      var busyTuple = useState("");
      var busy = busyTuple[0];
      var setBusy = busyTuple[1];

      var noticeTuple = useState(null);
      var notice = noticeTuple[0];
      var setNotice = noticeTuple[1];

      var tabTuple = useState("google");
      var authTab = tabTuple[0];
      var setAuthTab = tabTuple[1];

      var targetAccountTuple = useState("");
      var targetAccount = targetAccountTuple[0];
      var setTargetAccount = targetAccountTuple[1];

      var keyInputTuple = useState("");
      var apiKeyInput = keyInputTuple[0];
      var setApiKeyInput = keyInputTuple[1];

      var showKeyTuple = useState(false);
      var showApiKey = showKeyTuple[0];
      var setShowApiKey = showKeyTuple[1];

      var persistKeyTuple = useState(true);
      var persistKey = persistKeyTuple[0];
      var setPersistKey = persistKeyTuple[1];

      var showAddTuple = useState(false);
      var showAddDrawer = showAddTuple[0];
      var setShowAddDrawer = showAddTuple[1];

      var newAcctTuple = useState({
        name: "",
        label: "",
        dataDir: "",
        appDataDir: "antigravity-acp",
        authMethod: "",
        activate: true,
        startLogin: false,
      });
      var newAcct = newAcctTuple[0];
      var setNewAcct = newAcctTuple[1];

      var editingTuple = useState(null);
      var editing = editingTuple[0];
      var setEditing = editingTuple[1];

      var removingTuple = useState(null);
      var removing = removingTuple[0];
      var setRemoving = removingTuple[1];

      var pollRef = useRef(null);

      useEffect(function () {
        ensureStylesInjected();
      }, []);

      var loadInitial = useCallback(function (probe) {
        setLoading(true);
        return apiGet(probe)
          .then(function (data) {
            setState(data);
            setNotice(null);
          })
          .catch(function (err) {
            setNotice({ tone: "err", text: err.message || String(err) });
          })
          .finally(function () {
            setLoading(false);
          });
      }, []);

      useEffect(function () {
        loadInitial(false);
        return function () {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        };
      }, [loadInitial]);

      var loginStatus = state && state.loginSession ? state.loginSession.status : "idle";

      useEffect(
        function () {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          if (loginStatus === "running") {
            pollRef.current = setInterval(function () {
              apiPost("login-google-status", {})
                .then(function (data) {
                  setState(data);
                })
                .catch(function () {
                  // ignore transient poll error
                });
            }, 1200);
          }
          return function () {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          };
        },
        [loginStatus],
      );

      var runAction = useCallback(function (label, action, payload, successMessage) {
        setBusy(label);
        return apiPost(action, payload)
          .then(function (data) {
            setState(data);
            if (successMessage) {
              setNotice({ tone: "ok", text: successMessage });
            } else {
              setNotice(null);
            }
            return data;
          })
          .catch(function (err) {
            setNotice({ tone: "err", text: err.message || String(err) });
            return null;
          })
          .finally(function () {
            setBusy("");
          });
      }, []);

      var accounts = (state && state.accounts) || [];
      var auth = (state && state.auth) || {};
      var loginSession = (state && state.loginSession) || { status: "idle", outputTail: [] };
      var models = (state && state.models) || [];
      var effectiveTarget = targetAccount || (state && state.activeAccount) || "";

      var newNameTrimmed = (newAcct.name || "").trim();
      var newNameValid = !newNameTrimmed || ACCOUNT_NAME_RE.test(newNameTrimmed);

      var telemetryPill = statusPillInfo(state, t);

      var targetOptions = useMemo(
        function () {
          var opts = [{ value: "", label: (state && state.activeAccount ? state.activeAccount + " (active)" : t("noAccount")) }];
          for (var i = 0; i < accounts.length; i++) {
            var a = accounts[i];
            if (!state || a.name !== state.activeAccount) {
              opts.push({ value: a.name, label: a.label ? a.label + " (" + a.name + ")" : a.name });
            }
          }
          return opts;
        },
        [accounts, state, t],
      );

      if (loading && !state) {
        return h("div", { className: "agi-root" }, h("div", { className: "agi-card agi-muted" }, t("loading")));
      }

      return h(
        "div",
        { className: "agi-root", "data-testid": "agi-dsh-panel" },

        // Notice banner
        notice
          ? h(
              "div",
              { className: "agi-banner agi-banner-" + (notice.tone || "ok") },
              h("span", null, notice.text),
              h(
                "button",
                {
                  type: "button",
                  className: "agi-btn agi-btn-sm",
                  onClick: function () {
                    setNotice(null);
                  },
                },
                "×",
              ),
            )
          : null,

        // Header & Active Telemetry Card
        h(
          "div",
          { className: "agi-card" },
          h(
            "div",
            { className: "agi-row" },
            h(
              "div",
              null,
              h(
                "div",
                { className: "agi-row-tight" },
                h("h3", { className: "agi-title" }, t("title")),
                h("span", { className: telemetryPill.cls }, telemetryPill.text),
              ),
              h("p", { className: "agi-subtitle" }, t("subtitle")),
            ),
            h(
              "div",
              { className: "agi-row-tight" },
              h(
                "button",
                {
                  type: "button",
                  className: "agi-btn",
                  disabled: Boolean(busy),
                  onClick: function () {
                    runAction("refresh", "refresh", {}, null);
                  },
                },
                busy === "refresh" ? "..." : t("refresh"),
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "agi-btn",
                  disabled: Boolean(busy) || accounts.length === 0,
                  onClick: function () {
                    runAction("probe", "probe-accounts", {}, null);
                  },
                },
                busy === "probe" ? t("probing") : t("probeAll"),
              ),
            ),
          ),
          h(
            "div",
            { className: "agi-telemetry" },
            h(
              "div",
              { className: "agi-stat" },
              h("span", { className: "agi-stat-label" }, t("activeAccount")),
              h("span", { className: "agi-stat-value agi-mono" }, (state && state.activeAccount) || t("noAccount")),
            ),
            h(
              "div",
              { className: "agi-stat" },
              h("span", { className: "agi-stat-label" }, t("authMethod")),
              h("span", { className: "agi-stat-value agi-mono" }, auth.authMethod || "auto"),
            ),
            h(
              "div",
              { className: "agi-stat" },
              h("span", { className: "agi-stat-label" }, t("apiKeySource")),
              h("span", { className: "agi-stat-value agi-mono" }, auth.apiKeySource || (auth.hasStoredAccountKey ? "stored-account" : "none")),
            ),
            h(
              "div",
              { className: "agi-stat" },
              h("span", { className: "agi-stat-label" }, t("dataFolder")),
              h("span", { className: "agi-stat-value agi-mono" }, auth.geminiDir || state?.configPath || "-"),
            ),
          ),
        ),

        // Sign-in & Credentials Card
        h(
          "div",
          { className: "agi-card" },
          h(
            "div",
            { className: "agi-row" },
            h(
              "div",
              { className: "agi-tabs", role: "tablist" },
              [
                { id: "google", label: t("tabGoogle") },
                { id: "api-key", label: t("tabApiKey") },
                { id: "enterprise", label: t("tabEnterprise") },
              ].map(function (tab) {
                return h(
                  "button",
                  {
                    key: tab.id,
                    type: "button",
                    role: "tab",
                    "aria-selected": authTab === tab.id,
                    className: "agi-tab" + (authTab === tab.id ? " agi-tab-active" : ""),
                    onClick: function () {
                      setAuthTab(tab.id);
                    },
                  },
                  tab.label,
                );
              }),
            ),
            accounts.length > 0
              ? h(
                  "div",
                  { className: "agi-row-tight" },
                  h("span", { className: "agi-label" }, t("targetAccount") + ":"),
                  h(
                    "select",
                    {
                      className: "agi-select",
                      style: { width: "auto", minWidth: "150px" },
                      value: targetAccount,
                      onChange: function (e) {
                        setTargetAccount(e.target.value);
                      },
                    },
                    targetOptions.map(function (opt) {
                      return h("option", { key: opt.value || "__active__", value: opt.value }, opt.label);
                    }),
                  ),
                )
              : null,
          ),

          authTab === "google"
            ? h(
                "div",
                { className: "agi-drawer" },
                h("div", { className: "agi-muted" }, t("googleHint")),
                h(
                  "div",
                  { className: "agi-row" },
                  h(
                    "div",
                    { className: "agi-row-tight" },
                    loginStatus === "running"
                      ? h(
                          "button",
                          {
                            type: "button",
                            className: "agi-btn agi-btn-danger",
                            disabled: Boolean(busy),
                            onClick: function () {
                              runAction("cancel-login", "login-google-cancel", {}, t("loginStatusCancelled"));
                            },
                          },
                          t("cancelLogin"),
                        )
                      : h(
                          "button",
                          {
                            type: "button",
                            className: "agi-btn agi-btn-primary",
                            disabled: Boolean(busy),
                            onClick: function () {
                              runAction("google-login", "login-google-start", { account: effectiveTarget }, null);
                            },
                          },
                          t("startGoogleLogin"),
                        ),
                    auth.loginCommand
                      ? h(
                          "button",
                          {
                            type: "button",
                            className: "agi-btn",
                            onClick: function () {
                              copyText(auth.loginCommand).then(function () {
                                setNotice({ tone: "ok", text: t("copied") + ": " + auth.loginCommand });
                              });
                            },
                          },
                          t("copyCliCmd"),
                        )
                      : null,
                  ),
                  h(
                    "span",
                    {
                      className:
                        "agi-pill " +
                        (loginStatus === "succeeded"
                          ? "agi-pill-ok"
                          : loginStatus === "failed"
                            ? "agi-pill-err"
                            : loginStatus === "running"
                              ? "agi-pill-brand"
                              : ""),
                    },
                    loginStatus === "running"
                      ? t("loginStatusRunning")
                      : loginStatus === "succeeded"
                        ? t("loginStatusSucceeded")
                        : loginStatus === "failed"
                          ? t("loginStatusFailed") + (loginSession.error ? ": " + loginSession.error : "")
                          : loginStatus === "cancelled"
                            ? t("loginStatusCancelled")
                            : t("loginStatusIdle"),
                  ),
                ),
                loginSession.authUrl
                  ? h(
                      "div",
                      { className: "agi-row agi-drawer", style: { background: "rgba(77,141,255,0.08)" } },
                      h("a", { href: loginSession.authUrl, target: "_blank", rel: "noopener noreferrer", className: "agi-mono", style: { color: "var(--dsw-alias-brand-primary, #4d8dff)", wordBreak: "break-all" } }, loginSession.authUrl),
                      h(
                        "div",
                        { className: "agi-row-tight" },
                        h("a", { href: loginSession.authUrl, target: "_blank", rel: "noopener noreferrer", className: "agi-btn agi-btn-primary agi-btn-sm", style: { textDecoration: "none" } }, t("openAuthUrl")),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "agi-btn agi-btn-sm",
                            onClick: function () {
                              copyText(loginSession.authUrl).then(function () {
                                setNotice({ tone: "ok", text: t("copied") });
                              });
                            },
                          },
                          t("copyAuthUrl"),
                        ),
                      ),
                    )
                  : null,
                loginSession.outputTail && loginSession.outputTail.length > 0
                  ? h(
                      "div",
                      null,
                      h("div", { className: "agi-label", style: { marginBottom: "4px" } }, t("outputLog")),
                      h("pre", { className: "agi-console" }, loginSession.outputTail.join("\n")),
                    )
                  : null,
              )
            : null,

          authTab === "api-key"
            ? h(
                "div",
                { className: "agi-drawer" },
                h(
                  "div",
                  { className: "agi-row-tight" },
                  auth.hasStoredAccountKey ? h("span", { className: "agi-pill agi-pill-ok" }, t("storedKeyPresent")) : null,
                  auth.hasGeminiApiKey ? h("span", { className: "agi-pill agi-pill-brand" }, t("envKeyPresent")) : null,
                ),
                h(
                  "div",
                  { className: "agi-field" },
                  h("label", { className: "agi-label" }, t("apiKeyLabel")),
                  h(
                    "div",
                    { className: "agi-row-tight" },
                    h("input", {
                      className: "agi-input agi-mono",
                      style: { flex: 1 },
                      type: showApiKey ? "text" : "password",
                      placeholder: t("apiKeyPlaceholder"),
                      value: apiKeyInput,
                      onChange: function (e) {
                        setApiKeyInput(e.target.value);
                      },
                    }),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "agi-btn",
                        onClick: function () {
                          setShowApiKey(!showApiKey);
                        },
                      },
                      showApiKey ? t("hideKey") : t("showKey"),
                    ),
                  ),
                ),
                h(
                  "label",
                  { className: "agi-check" },
                  h("input", {
                    type: "checkbox",
                    checked: persistKey,
                    onChange: function (e) {
                      setPersistKey(Boolean(e.target.checked));
                    },
                  }),
                  t("persistKey"),
                ),
                h(
                  "div",
                  { className: "agi-row-tight" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "agi-btn agi-btn-primary",
                      disabled: Boolean(busy) || !apiKeyInput.trim(),
                      onClick: function () {
                        var raw = apiKeyInput;
                        runAction("auth-key", "auth-api-key", { account: effectiveTarget, apiKey: raw, persist: persistKey }, t("statusReady")).then(function (ok) {
                          if (ok) setApiKeyInput("");
                        });
                      },
                    },
                    t("authWithKey"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "agi-btn",
                      disabled: Boolean(busy),
                      onClick: function () {
                        runAction("clear-key", "auth-api-key-clear", { account: effectiveTarget }, t("clearKey"));
                      },
                    },
                    t("clearKey"),
                  ),
                ),
              )
            : null,

          authTab === "enterprise"
            ? h(
                "div",
                { className: "agi-drawer" },
                h("div", { className: "agi-muted" }, t("enterpriseHint")),
                h(
                  "div",
                  { className: "agi-row-tight" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "agi-btn",
                      disabled: Boolean(busy),
                      onClick: function () {
                        runAction("auth-biz", "auth-method", { methodId: "oauth-business" }, "oauth-business");
                      },
                    },
                    t("authBusiness"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "agi-btn",
                      disabled: Boolean(busy),
                      onClick: function () {
                        runAction("auth-vertex", "auth-method", { methodId: "agent-platform" }, "agent-platform");
                      },
                    },
                    t("authVertex"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "agi-btn agi-btn-danger",
                      disabled: Boolean(busy),
                      onClick: function () {
                        runAction("logout", "logout", { account: effectiveTarget }, t("signOut"));
                      },
                    },
                    t("signOut"),
                  ),
                ),
              )
            : null,
        ),

        // Multi-Account Profiles Card
        h(
          "div",
          { className: "agi-card" },
          h(
            "div",
            { className: "agi-row" },
            h(
              "div",
              { className: "agi-row-tight" },
              h("h3", { className: "agi-title" }, t("accountsTitle")),
              h("span", { className: "agi-pill" }, String(accounts.length)),
            ),
            h(
              "button",
              {
                type: "button",
                className: "agi-btn agi-btn-primary agi-btn-sm",
                onClick: function () {
                  setShowAddDrawer(!showAddDrawer);
                },
              },
              showAddDrawer ? t("cancel") : t("addAccountBtn"),
            ),
          ),

          showAddDrawer
            ? h(
                "div",
                { className: "agi-drawer" },
                h(
                  "div",
                  { className: "agi-grid-2" },
                  h(
                    "div",
                    { className: "agi-field" },
                    h("label", { className: "agi-label" }, t("accountName")),
                    h("input", {
                      className: "agi-input agi-mono",
                      placeholder: "work",
                      value: newAcct.name,
                      onChange: function (e) {
                        setNewAcct(Object.assign({}, newAcct, { name: e.target.value }));
                      },
                    }),
                    !newNameValid ? h("span", { className: "agi-muted", style: { color: "var(--dsw-alias-state-error-primary, #f85149)" } }, t("accountNameInvalid")) : h("span", { className: "agi-muted" }, t("accountNameHint")),
                  ),
                  h(
                    "div",
                    { className: "agi-field" },
                    h("label", { className: "agi-label" }, t("accountLabel")),
                    h("input", {
                      className: "agi-input",
                      placeholder: "Work Google Account",
                      value: newAcct.label,
                      onChange: function (e) {
                        setNewAcct(Object.assign({}, newAcct, { label: e.target.value }));
                      },
                    }),
                  ),
                  h(
                    "div",
                    { className: "agi-field" },
                    h("label", { className: "agi-label" }, t("customDataDir")),
                    h("input", {
                      className: "agi-input agi-mono",
                      placeholder: "~/.agi/accounts/<name>/gemini",
                      value: newAcct.dataDir,
                      onChange: function (e) {
                        setNewAcct(Object.assign({}, newAcct, { dataDir: e.target.value }));
                      },
                    }),
                  ),
                  h(
                    "div",
                    { className: "agi-field" },
                    h("label", { className: "agi-label" }, t("authMethod")),
                    h(
                      "select",
                      {
                        className: "agi-select",
                        value: newAcct.authMethod,
                        onChange: function (e) {
                          setNewAcct(Object.assign({}, newAcct, { authMethod: e.target.value }));
                        },
                      },
                      h("option", { value: "" }, "auto"),
                      h("option", { value: "oauth-personal" }, "oauth-personal (Google)"),
                      h("option", { value: "gemini-api-key" }, "gemini-api-key"),
                      h("option", { value: "oauth-business" }, "oauth-business"),
                      h("option", { value: "agent-platform" }, "agent-platform"),
                    ),
                  ),
                ),
                h(
                  "div",
                  { className: "agi-row" },
                  h(
                    "div",
                    { className: "agi-row-tight" },
                    h(
                      "label",
                      { className: "agi-check" },
                      h("input", {
                        type: "checkbox",
                        checked: newAcct.activate,
                        onChange: function (e) {
                          setNewAcct(Object.assign({}, newAcct, { activate: Boolean(e.target.checked) }));
                        },
                      }),
                      t("activateOnCreate"),
                    ),
                    h(
                      "label",
                      { className: "agi-check" },
                      h("input", {
                        type: "checkbox",
                        checked: newAcct.startLogin,
                        onChange: function (e) {
                          setNewAcct(Object.assign({}, newAcct, { startLogin: Boolean(e.target.checked) }));
                        },
                      }),
                      t("startLoginOnCreate"),
                    ),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "agi-btn agi-btn-primary",
                      disabled: Boolean(busy) || !newNameTrimmed || !newNameValid,
                      onClick: function () {
                        runAction(
                          "add-acct",
                          "account-add",
                          {
                            name: newNameTrimmed,
                            label: newAcct.label,
                            dataDir: newAcct.dataDir || undefined,
                            appDataDir: newAcct.appDataDir || "antigravity-acp",
                            authMethod: newAcct.authMethod || undefined,
                            activate: newAcct.activate,
                            startLogin: newAcct.startLogin,
                          },
                          newNameTrimmed,
                        ).then(function (ok) {
                          if (ok) {
                            setShowAddDrawer(false);
                            setNewAcct({
                              name: "",
                              label: "",
                              dataDir: "",
                              appDataDir: "antigravity-acp",
                              authMethod: "",
                              activate: true,
                              startLogin: false,
                            });
                          }
                        });
                      },
                    },
                    t("createAccount"),
                  ),
                ),
              )
            : null,

          accounts.length === 0
            ? h("div", { className: "agi-muted" }, t("noAccount"))
            : h(
                "div",
                { className: "agi-account-list" },
                accounts.map(function (acct) {
                  var isActive = Boolean(acct.active || acct.isCurrent);
                  var isEditing = editing && editing.name === acct.name;
                  var isRemoving = removing && removing.name === acct.name;
                  return h(
                    "div",
                    {
                      key: acct.name,
                      className: "agi-account-row" + (isActive ? " agi-account-row-active" : ""),
                    },
                    h(
                      "div",
                      { className: "agi-row" },
                      h(
                        "div",
                        { className: "agi-row-tight" },
                        h("strong", { className: "agi-mono" }, acct.name),
                        acct.label ? h("span", { className: "agi-muted" }, acct.label) : null,
                        isActive ? h("span", { className: "agi-pill agi-pill-brand" }, t("inUse")) : null,
                        acct.authMethod ? h("span", { className: "agi-pill agi-mono" }, acct.authMethod) : null,
                        acct.hasStoredApiKey ? h("span", { className: "agi-pill agi-pill-ok" }, "API Key") : null,
                        acct.probed
                          ? h(
                              "span",
                              { className: "agi-pill " + (acct.probed.authenticated ? "agi-pill-ok" : "agi-pill-warn") },
                              acct.probed.authenticated ? t("statusReady") + " (" + acct.probed.modelsCount + ")" : t("statusAuthRequired"),
                            )
                          : null,
                      ),
                      h(
                        "div",
                        { className: "agi-row-tight" },
                        !isActive
                          ? h(
                              "button",
                              {
                                type: "button",
                                className: "agi-btn agi-btn-sm agi-btn-primary",
                                disabled: Boolean(busy),
                                onClick: function () {
                                  runAction("use-" + acct.name, "account-use", { name: acct.name }, acct.name);
                                },
                              },
                              t("useAccount"),
                            )
                          : null,
                        h(
                          "button",
                          {
                            type: "button",
                            className: "agi-btn agi-btn-sm",
                            disabled: Boolean(busy),
                            onClick: function () {
                              setAuthTab("google");
                              setTargetAccount(acct.name);
                              runAction("login-" + acct.name, "login-google-start", { account: acct.name }, null);
                            },
                          },
                          t("signInAccount"),
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "agi-btn agi-btn-sm",
                            onClick: function () {
                              setEditing(
                                isEditing
                                  ? null
                                  : {
                                      name: acct.name,
                                      label: acct.label || "",
                                      dataDir: acct.dataDir || "",
                                      appDataDir: acct.appDataDir || "antigravity-acp",
                                      authMethod: acct.authMethod || "",
                                    },
                              );
                              setRemoving(null);
                            },
                          },
                          t("editAccount"),
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "agi-btn agi-btn-sm agi-btn-danger",
                            onClick: function () {
                              setRemoving(isRemoving ? null : { name: acct.name, purgeData: false });
                              setEditing(null);
                            },
                          },
                          t("removeAccount"),
                        ),
                      ),
                    ),
                    h("div", { className: "agi-muted agi-mono", style: { wordBreak: "break-all" } }, acct.geminiDir || acct.dataDir),
                    isEditing
                      ? h(
                          "div",
                          { className: "agi-drawer" },
                          h(
                            "div",
                            { className: "agi-grid-2" },
                            h(
                              "div",
                              { className: "agi-field" },
                              h("label", { className: "agi-label" }, t("accountLabel")),
                              h("input", {
                                className: "agi-input",
                                value: editing.label,
                                onChange: function (e) {
                                  setEditing(Object.assign({}, editing, { label: e.target.value }));
                                },
                              }),
                            ),
                            h(
                              "div",
                              { className: "agi-field" },
                              h("label", { className: "agi-label" }, t("authMethod")),
                              h(
                                "select",
                                {
                                  className: "agi-select",
                                  value: editing.authMethod,
                                  onChange: function (e) {
                                    setEditing(Object.assign({}, editing, { authMethod: e.target.value }));
                                  },
                                },
                                h("option", { value: "" }, "auto"),
                                h("option", { value: "oauth-personal" }, "oauth-personal"),
                                h("option", { value: "gemini-api-key" }, "gemini-api-key"),
                                h("option", { value: "oauth-business" }, "oauth-business"),
                                h("option", { value: "agent-platform" }, "agent-platform"),
                              ),
                            ),
                            h(
                              "div",
                              { className: "agi-field" },
                              h("label", { className: "agi-label" }, t("customDataDir")),
                              h("input", {
                                className: "agi-input agi-mono",
                                value: editing.dataDir,
                                onChange: function (e) {
                                  setEditing(Object.assign({}, editing, { dataDir: e.target.value }));
                                },
                              }),
                            ),
                            h(
                              "div",
                              { className: "agi-field" },
                              h("label", { className: "agi-label" }, t("appDataDir")),
                              h("input", {
                                className: "agi-input agi-mono",
                                value: editing.appDataDir,
                                onChange: function (e) {
                                  setEditing(Object.assign({}, editing, { appDataDir: e.target.value }));
                                },
                              }),
                            ),
                          ),
                          h(
                            "div",
                            { className: "agi-row-tight" },
                            h(
                              "button",
                              {
                                type: "button",
                                className: "agi-btn agi-btn-primary agi-btn-sm",
                                disabled: Boolean(busy),
                                onClick: function () {
                                  runAction("upd-" + editing.name, "account-update", editing, editing.name).then(function (ok) {
                                    if (ok) setEditing(null);
                                  });
                                },
                              },
                              t("save"),
                            ),
                            h(
                              "button",
                              {
                                type: "button",
                                className: "agi-btn agi-btn-sm",
                                onClick: function () {
                                  setEditing(null);
                                },
                              },
                              t("cancel"),
                            ),
                          ),
                        )
                      : null,
                    isRemoving
                      ? h(
                          "div",
                          { className: "agi-drawer", style: { borderColor: "rgba(248,81,73,0.4)" } },
                          h("strong", { style: { fontSize: "12px" } }, t("confirmRemoveTitle") + " (" + removing.name + ")"),
                          h(
                            "label",
                            { className: "agi-check" },
                            h("input", {
                              type: "checkbox",
                              checked: removing.purgeData,
                              onChange: function (e) {
                                setRemoving(Object.assign({}, removing, { purgeData: Boolean(e.target.checked) }));
                              },
                            }),
                            t("purgeDiskData"),
                          ),
                          h(
                            "div",
                            { className: "agi-row-tight" },
                            h(
                              "button",
                              {
                                type: "button",
                                className: "agi-btn agi-btn-danger agi-btn-sm",
                                disabled: Boolean(busy),
                                onClick: function () {
                                  runAction("rm-" + removing.name, "account-remove", removing, removing.name).then(function (ok) {
                                    if (ok) setRemoving(null);
                                  });
                                },
                              },
                              t("confirmRemoveBtn"),
                            ),
                            h(
                              "button",
                              {
                                type: "button",
                                className: "agi-btn agi-btn-sm",
                                onClick: function () {
                                  setRemoving(null);
                                },
                              },
                              t("cancel"),
                            ),
                          ),
                        )
                      : null,
                  );
                }),
              ),
        ),

        // Available Models Card
        h(
          "div",
          { className: "agi-card" },
          h(
            "div",
            { className: "agi-row" },
            h(
              "div",
              { className: "agi-row-tight" },
              h("h3", { className: "agi-title" }, t("modelsTitle")),
              h("span", { className: "agi-pill" }, String(models.length)),
            ),
            h("span", { className: "agi-pill agi-mono" }, t("modelSource") + ": " + ((state && state.modelSource) || "fallback")),
          ),
          models.length === 0
            ? h("div", { className: "agi-muted" }, t("noModels"))
            : h(
                "div",
                { className: "agi-models-grid" },
                models.map(function (m) {
                  return h(
                    "div",
                    { key: m.fullId || m.id, className: "agi-model-card" },
                    h("strong", { style: { fontSize: "12px" } }, m.name || m.id),
                    h("span", { className: "agi-muted agi-mono" }, m.fullId || "agy/" + m.id),
                    h(
                      "div",
                      { className: "agi-row-tight", style: { marginTop: "4px" } },
                      m.contextWindow ? h("span", { className: "agi-pill" }, formatTokens(m.contextWindow) + " ctx") : null,
                      m.supportsImages ? h("span", { className: "agi-pill" }, "vision") : null,
                      m.efforts && m.efforts.length ? h("span", { className: "agi-pill" }, m.efforts.join("/")) : null,
                    ),
                  );
                }),
              ),
        ),
      );
    };
  }

  function apply(ctx) {
    if (ctx && ctx.locale && typeof ctx.locale.register === "function") {
      if (typeof ctx.effect === "function") {
        ctx.effect(function () {
          return ctx.locale.register(NAMESPACE, { en: LOCALES.en, zh: LOCALES.zh });
        }, "agi-acp: dictionaries");
      } else {
        ctx.locale.register(NAMESPACE, { en: LOCALES.en, zh: LOCALES.zh });
      }
    }
    var Panel = createPanelComponent(ctx);

    function AgiBundleConfigView(ownerProps) {
      if (ownerProps && ownerProps.view === "summary") {
        return null;
      }
      return h(Panel, ownerProps);
    }

    if (ctx && ctx.slots && typeof ctx.slots.inject === "function" && typeof ctx.slots.register === "function") {
      ctx.slots.inject("plugins.bundle.config", function () {
        return ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: BUNDLE_PACKAGE_NAME,
            registrant: BUNDLE_PACKAGE_NAME,
            locale: NAMESPACE,
          },
          AgiBundleConfigView,
        );
      });
    }
  }

  return {
    name: NAMESPACE,
    inject: ["slots", "locale"],
    apply: apply,
    LOCALES: LOCALES,
    createPanelComponent: createPanelComponent,
  };
});
