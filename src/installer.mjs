import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AgyAcpClient,
  expandHomePath,
  readPersistedAcpConfig,
  resolveAcpConfigPath,
  resolveAgiHome,
  resolveDefaultAccountDataDir,
  upsertPersistedAccount,
} from "../claude-code/plugins/agi/scripts/lib/agy-acp-client.mjs";
import {
  DEFAULT_CLAUDE_BRIDGE_HOST,
  DEFAULT_CLAUDE_BRIDGE_PORT,
  ensureClaudeBridgeRunning,
} from "../claude-code/plugins/agi/scripts/agy-claude-bridge.mjs";
import { configureClaudeSettings } from "../claude-code/plugins/agi/scripts/setup-claude.mjs";
import {
  DEFAULT_CODEX_BRIDGE_HOST,
  DEFAULT_CODEX_BRIDGE_PORT,
  ensureCodexBridgeRunning,
} from "../codex/plugins/agi/scripts/agy-codex-bridge.mjs";
import { configureCodex, resolveCodexHome } from "../codex/plugins/agi/scripts/setup-codex.mjs";
import { configureDsh, resolveDshHome } from "../deepseek-harness/plugins/agi/scripts/setup-dsh.mjs";
import { AGENTS, parseAgentCsv } from "../scripts/select-agents.mjs";
import { listAccounts } from "../scripts/accounts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, "..");

const pkgMeta = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
);
export const PACKAGE_NAME = pkgMeta.name || "@xiaoyuan151/agi";
export const PACKAGE_VERSION = pkgMeta.version || "0.3.0";

export const ALL_AGENT_IDS = Object.freeze(AGENTS.map((a) => a.id));

export function resolveClaudeConfigDir(env = process.env) {
  return path.resolve(
    env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  );
}

export function resolveOpencodeConfigDir(env = process.env) {
  return path.resolve(
    env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode"),
  );
}

export function resolveInstallStatePath(env = process.env) {
  return path.join(resolveAgiHome(env), "install.json");
}

export function readInstallState(env = process.env) {
  const statePath = resolveInstallStatePath(env);
  try {
    if (!fs.existsSync(statePath)) return null;
    const raw = fs.readFileSync(statePath, "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function writeInstallState(state, env = process.env) {
  const statePath = resolveInstallStatePath(env);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, statePath);
  return statePath;
}

export function isEphemeralPackagePath(pkgPath = PACKAGE_ROOT) {
  const normalized = path.resolve(pkgPath).replace(/\\/g, "/");
  return (
    normalized.includes("/_npx/") ||
    normalized.includes("/.npm/_npx/") ||
    normalized.includes("/pnpm/dlx/") ||
    normalized.includes("/dlx-") ||
    normalized.includes("/npm-exec-") ||
    /\/bunx-[^/]+\//.test(normalized)
  );
}

export function isValidAgiPackageRoot(dir) {
  if (!dir) return false;
  return (
    fs.existsSync(path.join(dir, "claude-code", "plugins", "agi", ".claude-plugin", "plugin.json")) &&
    fs.existsSync(path.join(dir, "codex", "plugins", "agi", "plugin.json")) &&
    fs.existsSync(path.join(dir, "opencode", "plugins", "agi", "package.json")) &&
    fs.existsSync(path.join(dir, "deepseek-harness", "plugins", "agi", "package.json"))
  );
}

const RUNTIME_ASSETS = [
  "package.json",
  "LICENSE",
  "install.sh",
  "bin",
  "src",
  "scripts",
  "claude-code",
  "codex",
  "opencode",
  "deepseek-harness",
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.ko.md",
  "README.es.md",
];

export function materializeRuntimePackage(
  sourceRoot = PACKAGE_ROOT,
  { agiHome, targetDir: customTargetDir, forceCopy = false, dryRun = false } = {},
) {
  const resolvedSource = path.resolve(sourceRoot);
  const targetDir = customTargetDir
    ? path.resolve(customTargetDir)
    : path.join(agiHome, "package");
  const shouldMaterialize =
    forceCopy ||
    isEphemeralPackagePath(resolvedSource) ||
    resolvedSource === targetDir;

  if (!shouldMaterialize) {
    return {
      runtimeRoot: resolvedSource,
      materialized: false,
    };
  }

  if (resolvedSource === targetDir) {
    return {
      runtimeRoot: targetDir,
      materialized: true,
    };
  }

  if (dryRun) {
    return {
      runtimeRoot: targetDir,
      materialized: true,
      dryRun: true,
    };
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
  const stageDir = `${targetDir}.stage.${process.pid}.${Date.now()}`;
  fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });

  for (const item of RUNTIME_ASSETS) {
    const src = path.join(resolvedSource, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(stageDir, item);
    fs.cpSync(src, dst, {
      recursive: true,
      filter: (p) => {
        const base = path.basename(p);
        return base !== "node_modules" && base !== ".git";
      },
    });
  }

  const backupDir = `${targetDir}.old.${process.pid}`;
  fs.rmSync(backupDir, { recursive: true, force: true });
  if (fs.existsSync(targetDir)) {
    fs.renameSync(targetDir, backupDir);
  }
  fs.renameSync(stageDir, targetDir);
  fs.rmSync(backupDir, { recursive: true, force: true });

  return {
    runtimeRoot: targetDir,
    materialized: true,
  };
}

export function commandExists(cmd, pathEnv = process.env.PATH || "") {
  if (!cmd || !pathEnv) return false;
  if (path.isAbsolute(cmd)) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      if (process.platform !== "win32") {
        fs.accessSync(candidate, fs.constants.X_OK);
      }
      return true;
    } catch {
      // keep searching
    }
  }
  return false;
}

export function detectInstalledAgents(env = process.env) {
  const detected = [];
  const claudeDir = resolveClaudeConfigDir(env);
  const codexHome = resolveCodexHome(undefined, env);
  const opencodeDir = resolveOpencodeConfigDir(env);
  const dshHome = resolveDshHome(undefined, env);

  if (commandExists("claude", env.PATH) || fs.existsSync(claudeDir)) {
    detected.push("claude");
  }
  if (commandExists("codex", env.PATH) || fs.existsSync(codexHome)) {
    detected.push("codex");
  }
  if (commandExists("opencode", env.PATH) || fs.existsSync(opencodeDir)) {
    detected.push("opencode");
  }
  if (
    commandExists("dsh", env.PATH) ||
    fs.existsSync(dshHome) ||
    fs.existsSync("/Applications/DeepSeek Harness.app")
  ) {
    detected.push("dsh");
  }
  return detected;
}

function runQuietCli(bin, args, { env = process.env, cwd, timeoutMs = 20000 } = {}) {
  try {
    const out = execFileSync(bin, args, {
      env,
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: out };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : "",
      error: err.message,
    };
  }
}

function stopBridgeByPidFile(stateDir, dryRun = false) {
  const pidFile = path.join(stateDir, "bridge.pid");
  if (!fs.existsSync(pidFile)) return { stopped: false, reason: "no-pid-file" };
  const raw = fs.readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  if (!pid || !Number.isFinite(pid)) {
    if (!dryRun) {
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // ignore
      }
    }
    return { stopped: false, reason: "invalid-pid" };
  }
  if (dryRun) {
    return { stopped: false, dryRun: true, pid };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead
  }
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // ignore
  }
  return { stopped: true, pid };
}

export function stopBridges({ env = process.env, dryRun = false } = {}) {
  const claudeStateDir =
    env.AGY_CLAUDE_STATE_DIR || path.join(os.homedir(), ".cache", "agy-claude-bridge");
  const codexStateDir =
    env.AGY_CODEX_STATE_DIR || path.join(os.homedir(), ".cache", "agy-codex-bridge");
  return {
    claude: stopBridgeByPidFile(claudeStateDir, dryRun),
    codex: stopBridgeByPidFile(codexStateDir, dryRun),
  };
}

function readGitCommit(dir) {
  if (!dir || !fs.existsSync(path.join(dir, ".git"))) return null;
  const res = runQuietCli("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 3000 });
  return res.ok ? res.stdout.trim() : null;
}

export async function runInteractiveAgentPicker({
  detected = [],
  action = "install",
  runtimeRoot = PACKAGE_ROOT,
} = {}) {
  const pickerScript = path.join(runtimeRoot, "scripts", "select-agents.mjs");
  if (!fs.existsSync(pickerScript)) return null;
  const res = spawnSync(
    process.execPath,
    [pickerScript, "--action", action, "--detected", detected.join(",")],
    {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"],
    },
  );
  if (res.status === 130) {
    const err = new Error("Selection cancelled.");
    err.code = "CANCELLED";
    err.exitCode = 130;
    throw err;
  }
  if (res.status === 0 && res.stdout.trim()) {
    return parseAgentCsv(res.stdout.trim());
  }
  return null;
}

function ensureOpencodeLinkOrCopy({
  sourceDir,
  targetDir,
  copy = false,
  dryRun = false,
}) {
  if (dryRun) {
    return {
      action: copy ? "would-copy" : "would-symlink",
      sourceDir,
      targetDir,
    };
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  let stat = null;
  try {
    stat = fs.lstatSync(targetDir);
  } catch {
    stat = null;
  }
  if (stat && !stat.isSymbolicLink()) {
    const pkgPath = path.join(targetDir, "package.json");
    const isAgiDir =
      fs.existsSync(pkgPath) && fs.readFileSync(pkgPath, "utf8").includes('"agi"');
    if (!isAgiDir) {
      throw new Error(
        `Existing non-agi directory found at ${targetDir}; remove or back it up first.`,
      );
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  } else if (stat) {
    fs.unlinkSync(targetDir);
  }

  if (copy) {
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    return { action: "copied", sourceDir, targetDir };
  }
  fs.symlinkSync(sourceDir, targetDir, "dir");
  return { action: "symlinked", sourceDir, targetDir };
}

export async function installHarnesses(options = {}) {
  const env = options.env || process.env;
  const mode = options.mode === "update" ? "update" : "install";
  const agiHome = resolveAgiHome(env);
  const dryRun = Boolean(options.dryRun);
  const agyBin = options.agyBin || env.AGY_BIN || "agy";
  const sourceRoot = path.resolve(options.packageRoot || PACKAGE_ROOT);
  const log = typeof options.onLog === "function" ? options.onLog : () => {};

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 18) {
    throw new Error(`Node.js 18+ is required (found ${process.version}).`);
  }

  if (!options.skipAgyCheck && !dryRun && !commandExists(agyBin, env.PATH)) {
    throw new Error(
      `Antigravity CLI ('${agyBin}') not found on PATH. Install the official Antigravity CLI first, or set AGY_BIN=/path/to/agy.`,
    );
  }

  const materialized = materializeRuntimePackage(sourceRoot, {
    agiHome,
    ...(options.installDir ? { targetDir: options.installDir } : {}),
    forceCopy: Boolean(options.materialize || options.installDir),
    dryRun,
  });
  const runtimeRoot = materialized.runtimeRoot;
  if (materialized.materialized) {
    log(
      dryRun
        ? `[agi] Would copy runtime assets into ${runtimeRoot}`
        : `[agi] Runtime assets installed into ${runtimeRoot}`,
    );
  }

  const detected = detectInstalledAgents(env);
  let targetAgents = Array.isArray(options.agents) && options.agents.length > 0
    ? [...options.agents]
    : null;

  if (!targetAgents && options.all) {
    targetAgents = [...ALL_AGENT_IDS];
  }
  if (!targetAgents && options.interactive && process.stdout.isTTY && !dryRun) {
    const preselected = options.preselectedAgents?.length
      ? options.preselectedAgents
      : detected;
    targetAgents = await runInteractiveAgentPicker({
      detected: preselected,
      action: mode,
      runtimeRoot,
    });
  }
  if (!targetAgents || targetAgents.length === 0) {
    targetAgents = detected.length > 0 ? detected : [...ALL_AGENT_IDS];
  }

  log(`[agi] Target harnesses: ${targetAgents.join(", ")}`);

  const prevState = readInstallState(env);
  const existingCfg = readPersistedAcpConfig(env);
  const hasExplicitAccountArgs = Boolean(
    options.account ||
      options.dataDir !== undefined ||
      options.geminiDir !== undefined ||
      options.useDefaultGeminiDir ||
      options.appDataDir !== undefined ||
      options.authMethod !== undefined ||
      options.label !== undefined,
  );
  const shouldUpsertAccount =
    mode === "install" ||
    Object.keys(existingCfg.accounts || {}).length === 0 ||
    hasExplicitAccountArgs;

  let activeAccountName = existingCfg.activeAccount || "";
  let accountRecord = activeAccountName
    ? existingCfg.accounts?.[activeAccountName] || null
    : null;

  if (shouldUpsertAccount && !dryRun) {
    const targetName =
      options.account || existingCfg.activeAccount || "default";
    const resolvedDir =
      options.dataDir !== undefined ? options.dataDir : options.geminiDir;
    const upserted = upsertPersistedAccount(
      {
        name: targetName,
        ...(resolvedDir !== undefined ? { dataDir: resolvedDir } : {}),
        ...(options.appDataDir !== undefined
          ? { appDataDir: options.appDataDir }
          : {}),
        ...(options.authMethod !== undefined
          ? { authMethod: options.authMethod }
          : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
        useDefaultGeminiDir: Boolean(options.useDefaultGeminiDir),
        activate: options.noActivate ? false : true,
        force: Boolean(options.force),
      },
      env,
    );
    activeAccountName = upserted.activeAccount;
    accountRecord = upserted.account;
  } else if (shouldUpsertAccount && dryRun) {
    activeAccountName = options.account || existingCfg.activeAccount || "default";
    const existingTarget = existingCfg.accounts?.[activeAccountName] || null;
    const resolvedInputDir =
      options.dataDir !== undefined ? options.dataDir : options.geminiDir;
    const previewGeminiDir = options.useDefaultGeminiDir
      ? ""
      : resolvedInputDir
        ? expandHomePath(resolvedInputDir)
        : existingTarget?.geminiDir || resolveDefaultAccountDataDir(activeAccountName, env);
    accountRecord = {
      name: activeAccountName,
      label: options.label ?? existingTarget?.label ?? "",
      dataDir: previewGeminiDir,
      geminiDir: previewGeminiDir,
      appDataDir: options.appDataDir ?? existingTarget?.appDataDir ?? "antigravity-acp",
      authMethod: options.authMethod ?? existingTarget?.authMethod ?? "",
    };
  }

  if (accountRecord) {
    log(
      `[agi] Profile '${activeAccountName}' -> dataDir=${accountRecord.geminiDir || "(default ~/.gemini)"}`,
    );
  }

  const skipLogin =
    options.forceLogin
      ? false
      : options.skipLogin !== undefined
        ? Boolean(options.skipLogin)
        : mode === "update";

  let authProbe = null;
  if (!dryRun && commandExists(agyBin, env.PATH)) {
    const client = new AgyAcpClient({
      agyBin,
      ...(accountRecord
        ? {
            account: accountRecord.name,
            geminiDir: accountRecord.geminiDir,
            appDataDir: accountRecord.appDataDir,
            authMethod: accountRecord.authMethod || undefined,
            usePersistedConfig: false,
          }
        : {}),
      env,
      rpcTimeoutMs: 15000,
    });
    try {
      authProbe = await client.discoverModels({ forceRefresh: true, timeoutMs: 15000 });
      if (
        (options.forceLogin ||
          (authProbe.authenticated !== true && !env.GEMINI_API_KEY && !skipLogin)) &&
        process.stdin.isTTY &&
        process.stdout.isTTY
      ) {
        log(`[agi] Running official sign-in: ${client.formatLoginCommand()}`);
        await client.loginInteractive({ stdio: "inherit" });
        authProbe = await client.discoverModels({ forceRefresh: true, timeoutMs: 15000 });
      }
    } finally {
      await client.dispose();
    }
  }

  stopBridges({ env, dryRun });
  if (!dryRun && options.startBridge !== false) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const claudeAuthMode = options.claudeAuthMode || "auto";
  const codexMode = options.codexMode || "profile";
  const copyOpencode = Boolean(options.copyOpencode);
  const startBridge = options.startBridge !== false;
  const dshProfiles = Array.isArray(options.dshProfiles)
    ? options.dshProfiles
    : options.dshProfile
      ? String(options.dshProfile)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const harnessResults = {};

  if (targetAgents.includes("claude")) {
    const claudePluginDir = path.join(runtimeRoot, "claude-code", "plugins", "agi");
    const claudeMarketplaceDir = path.join(runtimeRoot, "claude-code");
    let cliResult = null;
    if (!dryRun && commandExists("claude", env.PATH)) {
      runQuietCli("claude", ["plugin", "validate", claudePluginDir], { env });
      const listRes = runQuietCli("claude", ["plugin", "marketplace", "list"], { env });
      if (listRes.ok && listRes.stdout.includes("local-agi")) {
        runQuietCli("claude", ["plugin", "marketplace", "update", "local-agi"], { env });
      } else {
        runQuietCli("claude", ["plugin", "marketplace", "add", claudeMarketplaceDir], { env });
      }
      if (mode === "update") {
        cliResult = runQuietCli(
          "claude",
          ["plugin", "update", "agi@local-agi", "--scope", "user"],
          { env },
        );
        if (!cliResult.ok) {
          cliResult = runQuietCli(
            "claude",
            ["plugin", "install", "agi@local-agi", "--scope", "user"],
            { env },
          );
        }
      } else {
        cliResult = runQuietCli(
          "claude",
          ["plugin", "install", "agi@local-agi", "--scope", "user"],
          { env },
        );
      }
    }

    const defaultAgiHome = path.join(os.homedir(), ".agi");
    const acpConfigOverride =
      env.AGY_ACP_CONFIG ||
      (path.resolve(agiHome) !== path.resolve(defaultAgiHome)
        ? resolveAcpConfigPath(env)
        : undefined);

    const claudeCfg = configureClaudeSettings({
      scope: "user",
      claudeConfigDir: options.claudeConfigDir || resolveClaudeConfigDir(env),
      host: env.AGY_CLAUDE_HOST || DEFAULT_CLAUDE_BRIDGE_HOST,
      port: Number(env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_BRIDGE_PORT),
      authMode: claudeAuthMode,
      ...(acpConfigOverride ? { acpConfig: acpConfigOverride } : {}),
      ...(options.pinGeminiDir && accountRecord?.geminiDir
        ? { geminiDir: accountRecord.geminiDir }
        : {}),
      ...(options.pinGeminiDir && accountRecord?.appDataDir
        ? { appDataDir: accountRecord.appDataDir }
        : {}),
      dryRun,
    });
    if (startBridge && !dryRun) {
      claudeCfg.bridge = await ensureClaudeBridgeRunning({
        host: env.AGY_CLAUDE_HOST || DEFAULT_CLAUDE_BRIDGE_HOST,
        port: Number(env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_BRIDGE_PORT),
        stateDir: env.AGY_CLAUDE_STATE_DIR,
      });
    }
    harnessResults.claude = { ...claudeCfg, cli: cliResult };
    log(`[agi] ${dryRun ? "Would configure" : "Configured"} Claude Code plugin & bridge.`);
  }

  if (targetAgents.includes("codex")) {
    const codexMarketplaceDir = path.join(runtimeRoot, "codex");
    let cliResult = null;
    if (!dryRun && commandExists("codex", env.PATH)) {
      runQuietCli("codex", ["plugin", "marketplace", "add", codexMarketplaceDir], { env });
      cliResult = runQuietCli("codex", ["plugin", "add", "agi@local-repo"], { env });
    }
    const codexCfg = configureCodex({
      codexHome: options.codexHome || resolveCodexHome(undefined, env),
      mode: codexMode,
      host: env.AGY_CODEX_HOST || DEFAULT_CODEX_BRIDGE_HOST,
      port: Number(env.AGY_CODEX_PORT || DEFAULT_CODEX_BRIDGE_PORT),
      dryRun,
    });
    if (startBridge && !dryRun) {
      codexCfg.bridge = await ensureCodexBridgeRunning({
        host: env.AGY_CODEX_HOST || DEFAULT_CODEX_BRIDGE_HOST,
        port: Number(env.AGY_CODEX_PORT || DEFAULT_CODEX_BRIDGE_PORT),
        stateDir: env.AGY_CODEX_STATE_DIR,
        catalogPath: codexCfg.catalogPath,
      });
    }
    harnessResults.codex = { ...codexCfg, cli: cliResult };
    log(`[agi] ${dryRun ? "Would configure" : "Configured"} Codex plugin (${codexMode} mode) & bridge.`);
  }

  if (targetAgents.includes("opencode")) {
    const opencodeDir = options.opencodeConfigDir || resolveOpencodeConfigDir(env);
    const targetDir = path.join(opencodeDir, "plugins", "agi");
    const sourceDir = path.join(runtimeRoot, "opencode", "plugins", "agi");
    harnessResults.opencode = ensureOpencodeLinkOrCopy({
      sourceDir,
      targetDir,
      copy: copyOpencode,
      dryRun,
    });
    log(
      `[agi] ${dryRun ? "Would install" : "Installed"} OpenCode V2 plugin at ${targetDir}.`,
    );
  }

  if (targetAgents.includes("dsh")) {
    const dshHome = options.dshHome || resolveDshHome(undefined, env);
    const pluginDir = path.join(runtimeRoot, "deepseek-harness", "plugins", "agi");
    harnessResults.dsh = configureDsh({
      dshHome,
      profiles: dshProfiles,
      pluginDir,
      dryRun,
    });
    log(`[agi] ${dryRun ? "Would configure" : "Configured"} DeepSeek Harness plugin.`);
  }

  const nowIso = new Date().toISOString();
  const gitCommit = readGitCommit(runtimeRoot) || readGitCommit(sourceRoot);
  const installMethod =
    options.installMethod ||
    prevState?.installMethod ||
    (gitCommit ? "git" : "npm");

  const nextState = {
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    installMethod,
    repoRoot: runtimeRoot,
    repoUrl: options.repoUrl || prevState?.repoUrl || "https://github.com/XiaoYuan151/AGI.git",
    repoRef: options.repoRef || prevState?.repoRef || "main",
    gitCommit,
    agents: targetAgents,
    options: {
      claudeAuthMode,
      codexMode,
      dshProfile: dshProfiles.join(","),
      copyOpencode,
    },
    installedAt: prevState?.installedAt || nowIso,
    updatedAt: nowIso,
  };

  let installStatePath = resolveInstallStatePath(env);
  if (!dryRun) {
    installStatePath = writeInstallState(nextState, env);
  }

  return {
    ok: true,
    mode,
    dryRun,
    version: PACKAGE_VERSION,
    runtimeRoot,
    materialized: materialized.materialized,
    agents: targetAgents,
    activeAccount: activeAccountName || null,
    account: accountRecord,
    acpConfigPath: resolveAcpConfigPath(env),
    installStatePath,
    auth: authProbe
      ? {
          authenticated: authProbe.authenticated,
          source: authProbe.source,
          modelsCount: authProbe.models.length,
        }
      : null,
    harnesses: harnessResults,
  };
}

export async function updateAgi(options = {}) {
  const env = options.env || process.env;
  const agiHome = resolveAgiHome(env);
  const prevState = readInstallState(env);
  const sourceRoot = path.resolve(options.packageRoot || PACKAGE_ROOT);
  const dryRun = Boolean(options.dryRun);

  const savedOpts = prevState?.options || {};
  const mergedAgents =
    Array.isArray(options.agents) && options.agents.length > 0
      ? options.agents
      : prevState?.agents && prevState.agents.length > 0
        ? prevState.agents
        : undefined;

  if (options.check) {
    const repoDir = prevState?.repoRoot || sourceRoot;
    let remoteCommit = null;
    if (fs.existsSync(path.join(repoDir, ".git")) && commandExists("git", env.PATH)) {
      const ref = options.repoRef || prevState?.repoRef || "main";
      const lsRes = runQuietCli("git", ["-C", repoDir, "ls-remote", "origin", ref], {
        env,
        timeoutMs: 8000,
      });
      if (lsRes.ok && lsRes.stdout.trim()) {
        remoteCommit = lsRes.stdout.trim().split(/\s+/)[0];
      }
    }
    const localCommit = readGitCommit(repoDir);
    return {
      ok: true,
      action: "check",
      installedVersion: prevState?.version || null,
      packageVersion: PACKAGE_VERSION,
      installMethod: prevState?.installMethod || (localCommit ? "git" : "npm"),
      localCommit,
      remoteCommit,
      updateAvailable:
        (prevState?.version && prevState.version !== PACKAGE_VERSION) ||
        Boolean(localCommit && remoteCommit && localCommit !== remoteCommit),
      agents: prevState?.agents || detectInstalledAgents(env),
    };
  }

  let selfUpdate = null;
  if (options.self && !env.AGI_SELF_UPDATED) {
    const tag = options.tag || "latest";
    const npmSpec = `${PACKAGE_NAME}@${tag}`;
    if (dryRun) {
      selfUpdate = { dryRun: true, command: `npm install -g ${npmSpec}` };
    } else {
      const res = spawnSync("npm", ["install", "-g", npmSpec], {
        env,
        stdio: "inherit",
      });
      if (res.status !== 0) {
        throw new Error(`npm install -g ${npmSpec} failed with exit code ${res.status}`);
      }
      selfUpdate = { ok: true, command: `npm install -g ${npmSpec}` };
      if (commandExists("agi", env.PATH)) {
        const reexec = spawnSync(
          "agi",
          ["update", ...(options.rawArgs || []).filter((a) => a !== "--self")],
          {
            env: { ...env, AGI_SELF_UPDATED: "1" },
            stdio: "inherit",
          },
        );
        return {
          ok: reexec.status === 0,
          action: "update",
          delegatedToNewBinary: true,
          exitCode: reexec.status ?? 0,
          selfUpdate,
        };
      }
    }
  }

  let gitUpdate = null;
  const gitCandidate =
    prevState?.repoRoot && fs.existsSync(path.join(prevState.repoRoot, ".git"))
      ? prevState.repoRoot
      : fs.existsSync(path.join(sourceRoot, ".git"))
        ? sourceRoot
        : null;

  if (gitCandidate && !options.noGitPull && commandExists("git", env.PATH)) {
    const ref = options.repoRef || prevState?.repoRef || "main";
    const oldCommit = readGitCommit(gitCandidate);
    const managedRepoDir = path.join(agiHome, "repo");
    const isManagedCheckout = path.resolve(gitCandidate) === path.resolve(managedRepoDir);

    if (dryRun) {
      gitUpdate = {
        dryRun: true,
        repoRoot: gitCandidate,
        ref,
        oldCommit,
      };
    } else {
      let dirty = false;
      if (!isManagedCheckout) {
        const st = runQuietCli("git", ["-C", gitCandidate, "status", "--porcelain"], { env });
        dirty = st.ok && st.stdout.trim().length > 0;
      }
      if (dirty) {
        gitUpdate = {
          skipped: true,
          reason: "dirty-working-tree",
          repoRoot: gitCandidate,
          oldCommit,
        };
      } else {
        const fetchRes = runQuietCli(
          "git",
          ["-C", gitCandidate, "fetch", "--depth", "1", "origin", ref],
          { env, timeoutMs: 15000 },
        );
        if (fetchRes.ok) {
          const applyRes = isManagedCheckout
            ? runQuietCli(
                "git",
                ["-C", gitCandidate, "checkout", "-B", ref, "FETCH_HEAD"],
                { env },
              )
            : runQuietCli(
                "git",
                ["-C", gitCandidate, "merge", "--ff-only", "FETCH_HEAD"],
                { env },
              );
          const newCommit = readGitCommit(gitCandidate);
          gitUpdate = {
            ok: applyRes.ok,
            repoRoot: gitCandidate,
            ref,
            oldCommit,
            newCommit,
            updated: Boolean(oldCommit && newCommit && oldCommit !== newCommit),
            ...(applyRes.ok ? {} : { warning: applyRes.stderr || applyRes.error }),
          };
        } else {
          gitUpdate = {
            ok: false,
            skipped: true,
            reason: "fetch-failed",
            warning: fetchRes.stderr || fetchRes.error,
            repoRoot: gitCandidate,
            oldCommit,
          };
        }
      }
    }
  }

  const effectiveSourceRoot = gitCandidate || sourceRoot;
  const installRes = await installHarnesses({
    ...options,
    mode: "update",
    packageRoot: effectiveSourceRoot,
    agents: mergedAgents,
    preselectedAgents: prevState?.agents,
    claudeAuthMode: options.claudeAuthMode || savedOpts.claudeAuthMode || "auto",
    codexMode: options.codexMode || savedOpts.codexMode || "profile",
    dshProfile:
      options.dshProfile !== undefined
        ? options.dshProfile
        : savedOpts.dshProfile || undefined,
    copyOpencode:
      options.copyOpencode !== undefined
        ? options.copyOpencode
        : Boolean(savedOpts.copyOpencode),
    skipLogin: options.forceLogin ? false : true,
    materialize:
      options.installDir ||
      (prevState?.repoRoot &&
        path.resolve(prevState.repoRoot) === path.resolve(path.join(agiHome, "package")))
        ? true
        : options.materialize,
  });

  return {
    ...installRes,
    action: "update",
    previousVersion: prevState?.version || null,
    selfUpdate,
    gitUpdate,
  };
}

export async function uninstallAgi(options = {}) {
  const env = options.env || process.env;
  const agiHome = resolveAgiHome(env);
  const dryRun = Boolean(options.dryRun);
  const purge = Boolean(options.purge);
  const prevState = readInstallState(env);

  const detected = detectInstalledAgents(env);
  let targetAgents =
    Array.isArray(options.agents) && options.agents.length > 0
      ? [...options.agents]
      : null;

  if (!targetAgents && options.all) {
    targetAgents = [...ALL_AGENT_IDS];
  }
  if (!targetAgents && options.interactive && process.stdout.isTTY && !dryRun) {
    targetAgents = await runInteractiveAgentPicker({
      detected: prevState?.agents?.length ? prevState.agents : detected,
      action: "uninstall",
      runtimeRoot: options.packageRoot || PACKAGE_ROOT,
    });
  }
  if (!targetAgents || targetAgents.length === 0) {
    targetAgents = detected.length > 0 ? detected : [...ALL_AGENT_IDS];
  }

  const bridgeStop = stopBridges({ env, dryRun });
  const results = {};

  if (targetAgents.includes("claude")) {
    const claudeCfgDir = options.claudeConfigDir || resolveClaudeConfigDir(env);
    results.claude = configureClaudeSettings({
      scope: "user",
      claudeConfigDir: claudeCfgDir,
      remove: true,
      dryRun,
    });
    if (!dryRun && commandExists("claude", env.PATH)) {
      runQuietCli("claude", ["plugin", "uninstall", "agi@local-agi", "--scope", "user"], { env });
      runQuietCli("claude", ["plugin", "marketplace", "remove", "local-agi"], { env });
    }
  }

  if (targetAgents.includes("codex")) {
    const codexHome = options.codexHome || resolveCodexHome(undefined, env);
    results.codex = configureCodex({
      codexHome,
      mode: "profile",
      remove: true,
      dryRun,
    });
    const configToml = path.join(codexHome, "config.toml");
    if (
      fs.existsSync(configToml) &&
      fs.readFileSync(configToml, "utf8").includes("agy-acp-bridge")
    ) {
      results.codexDefault = configureCodex({
        codexHome,
        mode: "default",
        remove: true,
        dryRun,
      });
    }
    if (!dryRun && commandExists("codex", env.PATH)) {
      runQuietCli("codex", ["plugin", "remove", "agi@local-repo"], { env });
      runQuietCli("codex", ["plugin", "marketplace", "remove", "local-repo"], { env });
    }
  }

  if (targetAgents.includes("opencode")) {
    const opencodeDir = options.opencodeConfigDir || resolveOpencodeConfigDir(env);
    const targetDir = path.join(opencodeDir, "plugins", "agi");
    let removed = false;
    if (!dryRun) {
      try {
        const stat = fs.lstatSync(targetDir);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(targetDir);
          removed = true;
        } else if (stat.isDirectory()) {
          const pkg = path.join(targetDir, "package.json");
          if (fs.existsSync(pkg) && fs.readFileSync(pkg, "utf8").includes('"agi"')) {
            fs.rmSync(targetDir, { recursive: true, force: true });
            removed = true;
          }
        }
      } catch {
        // missing
      }
    }
    results.opencode = { action: "removed", targetDir, removed, dryRun };
  }

  if (targetAgents.includes("dsh")) {
    const dshHome = options.dshHome || resolveDshHome(undefined, env);
    const dshProfiles = options.dshProfile
      ? String(options.dshProfile)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    results.dsh = configureDsh({
      dshHome,
      profiles: dshProfiles,
      remove: true,
      dryRun,
    });
  }

  const acpCfgPath = resolveAcpConfigPath(env);
  if (!dryRun) {
    if (acpCfgPath && fs.existsSync(acpCfgPath) && !purge) {
      // keep account directories on non-purge uninstall only if accounts exist? Wait: match install.sh behavior:
      // install.sh removes acp.json and leaves antigravity auth dir unless --purge.
      fs.rmSync(acpCfgPath, { force: true });
    }
    const installStatePath = resolveInstallStatePath(env);
    if (fs.existsSync(installStatePath)) {
      fs.rmSync(installStatePath, { force: true });
    }
    const materializedPkg = path.join(agiHome, "package");
    if (fs.existsSync(materializedPkg)) {
      fs.rmSync(materializedPkg, { recursive: true, force: true });
    }
    if (purge && fs.existsSync(agiHome)) {
      fs.rmSync(agiHome, { recursive: true, force: true });
    }
  }

  return {
    ok: true,
    action: "uninstall",
    agents: targetAgents,
    purge,
    dryRun,
    agiHome,
    bridgeStop,
    harnesses: results,
  };
}

async function probeBridgeHealth(host, port, timeoutMs = 1200) {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { running: false, status: res.status };
    const data = await res.json();
    return { running: Boolean(data?.ok), ...data };
  } catch (err) {
    return { running: false, error: err.message };
  }
}

export async function getAgiStatus({ env = process.env } = {}) {
  const agiHome = resolveAgiHome(env);
  const installState = readInstallState(env);
  const accountsInfo = await listAccounts({ probe: false, env });
  const claudeHost = env.AGY_CLAUDE_HOST || DEFAULT_CLAUDE_BRIDGE_HOST;
  const claudePort = Number(env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_BRIDGE_PORT);
  const codexHost = env.AGY_CODEX_HOST || DEFAULT_CODEX_BRIDGE_HOST;
  const codexPort = Number(env.AGY_CODEX_PORT || DEFAULT_CODEX_BRIDGE_PORT);

  const [claudeBridge, codexBridge] = await Promise.all([
    probeBridgeHealth(claudeHost, claudePort),
    probeBridgeHealth(codexHost, codexPort),
  ]);

  return {
    ok: true,
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    agiHome,
    installState,
    detectedAgents: detectInstalledAgents(env),
    accounts: accountsInfo,
    bridges: {
      claude: { url: `http://${claudeHost}:${claudePort}`, ...claudeBridge },
      codex: { url: `http://${codexHost}:${codexPort}`, ...codexBridge },
    },
  };
}
