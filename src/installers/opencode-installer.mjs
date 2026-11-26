import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandExists } from "../runtime/package-materializer.mjs";

export function resolveOpencodeConfigDir(env = process.env) {
  return path.resolve(
    env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode"),
  );
}

function ensureOpencodeLinkOrCopy({ sourceDir, targetDir, copy = false, dryRun = false }) {
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

export const opencodeInstaller = {
  id: "opencode",
  name: "OpenCode V2",

  detect(env = process.env) {
    return commandExists("opencode", env.PATH) || fs.existsSync(resolveOpencodeConfigDir(env));
  },

  async install(ctx) {
    const { env, runtimeRoot, options, dryRun, log } = ctx;
    const copyOpencode = Boolean(options.copyOpencode);
    const opencodeDir = options.opencodeConfigDir || resolveOpencodeConfigDir(env);
    const targetDir = path.join(opencodeDir, "plugins", "agi");
    const sourceDir = path.join(runtimeRoot, "opencode", "plugins", "agi");
    const result = ensureOpencodeLinkOrCopy({
      sourceDir,
      targetDir,
      copy: copyOpencode,
      dryRun,
    });
    log(`[agi] ${dryRun ? "Would install" : "Installed"} OpenCode V2 plugin at ${targetDir}.`);
    return result;
  },

  async uninstall(ctx) {
    const { env, options, dryRun } = ctx;
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
    return { action: "removed", targetDir, removed, dryRun };
  },

  nextStepTip() {
    return "  OpenCode        : run /connect -> Antigravity (ACP) -> pick agy/* in /model";
  },
};
