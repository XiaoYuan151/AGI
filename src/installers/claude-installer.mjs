import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAcpConfigPath } from "../core/index.mjs";
import { commandExists, runQuietCli } from "../runtime/package-materializer.mjs";
import {
  DEFAULT_CLAUDE_BRIDGE_HOST,
  DEFAULT_CLAUDE_BRIDGE_PORT,
  ensureClaudeBridgeRunning,
} from "../../claude-code/plugins/agi/scripts/agy-claude-bridge.mjs";
import { configureClaudeSettings } from "../../claude-code/plugins/agi/scripts/setup-claude.mjs";

export function resolveClaudeConfigDir(env = process.env) {
  return path.resolve(
    env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  );
}

export const claudeInstaller = {
  id: "claude",
  name: "Claude Code",

  detect(env = process.env) {
    return commandExists("claude", env.PATH) || fs.existsSync(resolveClaudeConfigDir(env));
  },

  async install(ctx) {
    const { env, mode, agiHome, runtimeRoot, options, accountRecord, startBridge, dryRun, log } = ctx;
    const claudeAuthMode = options.claudeAuthMode || "auto";
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

    log(`[agi] ${dryRun ? "Would configure" : "Configured"} Claude Code plugin & bridge.`);
    return { ...claudeCfg, cli: cliResult };
  },

  async uninstall(ctx) {
    const { env, options, dryRun } = ctx;
    const claudeCfgDir = options.claudeConfigDir || resolveClaudeConfigDir(env);
    const res = configureClaudeSettings({
      scope: "user",
      claudeConfigDir: claudeCfgDir,
      remove: true,
      dryRun,
    });
    if (!dryRun && commandExists("claude", env.PATH)) {
      runQuietCli("claude", ["plugin", "uninstall", "agi@local-agi", "--scope", "user"], { env });
      runQuietCli("claude", ["plugin", "marketplace", "remove", "local-agi"], { env });
    }
    return res;
  },

  nextStepTip() {
    return "  Claude Code     : restart Claude Code -> /agi:connect -> pick anthropic-agy/* in /model";
  },
};
