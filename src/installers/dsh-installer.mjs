import fs from "node:fs";
import path from "node:path";
import { commandExists } from "../runtime/package-materializer.mjs";
import {
  configureDsh,
  resolveDshHome,
} from "../../deepseek-harness/plugins/agi/scripts/setup-dsh.mjs";

function parseDshProfiles(options) {
  if (Array.isArray(options.dshProfiles)) {
    return options.dshProfiles;
  }
  if (options.dshProfile) {
    return String(options.dshProfile)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export const dshInstaller = {
  id: "dsh",
  name: "DeepSeek Harness",

  detect(env = process.env) {
    return (
      commandExists("dsh", env.PATH) ||
      fs.existsSync(resolveDshHome(undefined, env)) ||
      fs.existsSync("/Applications/DeepSeek Harness.app")
    );
  },

  async install(ctx) {
    const { env, runtimeRoot, options, dryRun, log } = ctx;
    const dshHome = options.dshHome || resolveDshHome(undefined, env);
    const pluginDir = path.join(runtimeRoot, "deepseek-harness", "plugins", "agi");
    const profiles = parseDshProfiles(options);
    const result = configureDsh({
      dshHome,
      profiles,
      pluginDir,
      dryRun,
    });
    log(`[agi] ${dryRun ? "Would configure" : "Configured"} DeepSeek Harness plugin.`);
    return result;
  },

  async uninstall(ctx) {
    const { env, options, dryRun } = ctx;
    const dshHome = options.dshHome || resolveDshHome(undefined, env);
    const profiles = parseDshProfiles(options);
    return configureDsh({
      dshHome,
      profiles,
      remove: true,
      dryRun,
    });
  },

  nextStepTip() {
    return "  DeepSeek Harness: open Settings -> Antigravity (ACP) or run /agy-connect / `agi gui`";
  },
};
