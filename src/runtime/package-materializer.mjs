import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveAgiHome } from "../core/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");

const pkgMeta = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
);
export const PACKAGE_NAME = pkgMeta.name || "@xiaoyuan151/agi";
export const PACKAGE_VERSION = pkgMeta.version || "0.3.0";

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
  "readme",
];

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

export function runQuietCli(bin, args, { env = process.env, cwd, timeoutMs = 20000 } = {}) {
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

export function readGitCommit(dir) {
  if (!dir || !fs.existsSync(path.join(dir, ".git"))) return null;
  const res = runQuietCli("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 3000 });
  return res.ok ? res.stdout.trim() : null;
}
