import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AgyAcpClient,
  expandHomePath,
  readPersistedAcpConfig,
  resolveAcpConfigPath,
  resolveAgiHome,
  resolveDefaultAccountDataDir,
  stopBridgeByPidFile,
  upsertPersistedAccount,
} from "./core/index.mjs";
import {
  DEFAULT_CLAUDE_BRIDGE_HOST,
  DEFAULT_CLAUDE_BRIDGE_PORT,
} from "../claude-code/plugins/agi/scripts/agy-claude-bridge.mjs";
import {
  DEFAULT_CODEX_BRIDGE_HOST,
  DEFAULT_CODEX_BRIDGE_PORT,
} from "../codex/plugins/agi/scripts/agy-codex-bridge.mjs";
import { AGENTS, parseAgentCsv } from "../scripts/select-agents.mjs";
import { listAccounts } from "../scripts/accounts.mjs";
import {
  PACKAGE_NAME,
  PACKAGE_ROOT,
  PACKAGE_VERSION,
  commandExists,
  isEphemeralPackagePath,
  isValidAgiPackageRoot,
  materializeRuntimePackage,
  readGitCommit,
  readInstallState,
  resolveInstallStatePath,
  runQuietCli,
  writeInstallState,
} from "./runtime/package-materializer.mjs";
import { resolveClaudeConfigDir } from "./installers/claude-installer.mjs";
import { resolveOpencodeConfigDir } from "./installers/opencode-installer.mjs";
import { DEFAULT_HARNESS_REGISTRY } from "./installers/registry.mjs";

export {
  PACKAGE_NAME,
  PACKAGE_ROOT,
  PACKAGE_VERSION,
  commandExists,
  isEphemeralPackagePath,
  isValidAgiPackageRoot,
  materializeRuntimePackage,
  readInstallState,
  resolveClaudeConfigDir,
  resolveInstallStatePath,
  resolveOpencodeConfigDir,
  writeInstallState,
};

export const ALL_AGENT_IDS = Object.freeze(AGENTS.map((a) => a.id));

export function detectInstalledAgents(env = process.env, registry = DEFAULT_HARNESS_REGISTRY) {
  return registry.detect(env);
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

async function resolveTargetAgents(options, detected, action, runtimeRoot, dryRun) {
  let targetAgents =
    Array.isArray(options.agents) && options.agents.length > 0
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
      action,
      runtimeRoot,
    });
  }
  if (!targetAgents || targetAgents.length === 0) {
    targetAgents = detected.length > 0 ? detected : [...ALL_AGENT_IDS];
  }
  return targetAgents;
}

export async function installHarnesses(options = {}) {
  const env = options.env || process.env;
  const registry = options.registry || DEFAULT_HARNESS_REGISTRY;
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

  const detected = detectInstalledAgents(env, registry);
  const targetAgents = await resolveTargetAgents(options, detected, mode, runtimeRoot, dryRun);
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
        ...(options.appDataDir !== undefined ? { appDataDir: options.appDataDir } : {}),
        ...(options.authMethod !== undefined ? { authMethod: options.authMethod } : {}),
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
  for (const agentId of targetAgents) {
    const installer = registry.get(agentId);
    if (!installer) continue;
    harnessResults[agentId] = await installer.install({
      env,
      mode,
      agiHome,
      runtimeRoot,
      options,
      accountRecord,
      startBridge,
      dryRun,
      log,
    });
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
  const registry = options.registry || DEFAULT_HARNESS_REGISTRY;
  const agiHome = resolveAgiHome(env);
  const dryRun = Boolean(options.dryRun);
  const purge = Boolean(options.purge);
  const prevState = readInstallState(env);

  const detected = detectInstalledAgents(env, registry);
  const targetAgents = await resolveTargetAgents(
    {
      ...options,
      preselectedAgents: prevState?.agents?.length ? prevState.agents : detected,
    },
    detected,
    "uninstall",
    options.packageRoot || PACKAGE_ROOT,
    dryRun,
  );

  const bridgeStop = stopBridges({ env, dryRun });
  const results = {};

  for (const agentId of targetAgents) {
    const installer = registry.get(agentId);
    if (!installer) continue;
    results[agentId] = await installer.uninstall({
      env,
      options,
      dryRun,
      extraResults: results,
    });
  }

  const acpCfgPath = resolveAcpConfigPath(env);
  if (!dryRun) {
    if (acpCfgPath && fs.existsSync(acpCfgPath) && !purge) {
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
