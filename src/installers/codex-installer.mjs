import fs from "node:fs";
import path from "node:path";
import { commandExists, runQuietCli } from "../runtime/package-materializer.mjs";
import {
  DEFAULT_CODEX_BRIDGE_HOST,
  DEFAULT_CODEX_BRIDGE_PORT,
  ensureCodexBridgeRunning,
} from "../../codex/plugins/agi/scripts/agy-codex-bridge.mjs";
import {
  configureCodex,
  resolveCodexHome,
} from "../../codex/plugins/agi/scripts/setup-codex.mjs";

export const codexInstaller = {
  id: "codex",
  name: "Codex",

  detect(env = process.env) {
    return (
      commandExists("codex", env.PATH) ||
      fs.existsSync(resolveCodexHome(undefined, env))
    );
  },

  async install(ctx) {
    const { env, runtimeRoot, options, startBridge, dryRun, log } = ctx;
    const codexMode = options.codexMode || "profile";
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

    log(`[agi] ${dryRun ? "Would configure" : "Configured"} Codex plugin (${codexMode} mode) & bridge.`);
    return { ...codexCfg, cli: cliResult };
  },

  async uninstall(ctx) {
    const { env, options, dryRun } = ctx;
    const codexHome = options.codexHome || resolveCodexHome(undefined, env);
    const res = configureCodex({
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
      ctx.extraResults.codexDefault = configureCodex({
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
    return res;
  },

  nextStepTip() {
    return "  Codex           : run 'codex -p agy' -> $agy-connect -> pick agy/* in /model";
  },
};
