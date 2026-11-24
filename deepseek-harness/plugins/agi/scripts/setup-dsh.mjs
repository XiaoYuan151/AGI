#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DSH_PACKAGE_NAME = "@local/dsh-agi";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PLUGIN_DIR = path.resolve(THIS_DIR, "..");

export function resolveDshHome(dshHome) {
  return path.resolve(dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
}

export function listDshProfiles(dshHome) {
  const root = path.join(resolveDshHome(dshHome), "profiles");
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(root, name, "package.json")))
    .sort();
}

function readJsonOrDefault(filePath, profileName) {
  if (!fs.existsSync(filePath)) {
    return {
      name: `dsh-profile-${profileName}`,
      private: true,
      dependencies: {},
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base"],
        },
      },
    };
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed;
}

function ensureSymlink(targetDir, linkPath, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {
    // linkPath does not exist yet
  }
  const relTarget = path.relative(path.dirname(linkPath), targetDir);
  fs.symlinkSync(relTarget, linkPath, "dir");
}

function removeSymlink(linkPath, dryRun) {
  if (dryRun) return false;
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
    const parent = path.dirname(linkPath);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
    return true;
  } catch {
    return false;
  }
}

export function configureDshProfile({
  dshHome,
  profile = "desktop",
  pluginDir = DEFAULT_PLUGIN_DIR,
  remove = false,
  dryRun = false,
} = {}) {
  const homeDir = resolveDshHome(dshHome);
  const absPluginDir = path.resolve(pluginDir);
  const profileDir = path.join(homeDir, "profiles", profile);
  const packageJsonPath = path.join(profileDir, "package.json");
  const linkPath = path.join(profileDir, "node_modules", "@local", "dsh-agi");

  if (remove) {
    let packageUpdated = false;
    let nextPkg = null;
    if (fs.existsSync(packageJsonPath)) {
      const pkg = readJsonOrDefault(packageJsonPath, profile);
      nextPkg = structuredClone(pkg);
      if (nextPkg.dependencies && typeof nextPkg.dependencies === "object") {
        if (DSH_PACKAGE_NAME in nextPkg.dependencies) {
          delete nextPkg.dependencies[DSH_PACKAGE_NAME];
          packageUpdated = true;
        }
      }
      if (Array.isArray(nextPkg.dsh?.profile?.bundles)) {
        const before = nextPkg.dsh.profile.bundles.length;
        nextPkg.dsh.profile.bundles = nextPkg.dsh.profile.bundles.filter(
          (b) => b !== DSH_PACKAGE_NAME,
        );
        if (nextPkg.dsh.profile.bundles.length !== before) {
          packageUpdated = true;
        }
      }
      if (packageUpdated && !dryRun) {
        fs.writeFileSync(packageJsonPath, `${JSON.stringify(nextPkg, null, 2)}\n`, "utf8");
      }
    }
    const symlinkRemoved = removeSymlink(linkPath, dryRun);
    return {
      action: "removed",
      profile,
      profileDir,
      packageJsonPath,
      linkPath,
      packageUpdated,
      symlinkRemoved,
      dryRun,
    };
  }

  const pkg = readJsonOrDefault(packageJsonPath, profile);
  const nextPkg = structuredClone(pkg);
  if (!nextPkg.dependencies || typeof nextPkg.dependencies !== "object" || Array.isArray(nextPkg.dependencies)) {
    nextPkg.dependencies = {};
  }
  nextPkg.dependencies[DSH_PACKAGE_NAME] = `link:${absPluginDir}`;

  if (!nextPkg.dsh || typeof nextPkg.dsh !== "object" || Array.isArray(nextPkg.dsh)) {
    nextPkg.dsh = {};
  }
  if (!nextPkg.dsh.profile || typeof nextPkg.dsh.profile !== "object" || Array.isArray(nextPkg.dsh.profile)) {
    nextPkg.dsh.profile = {};
  }
  if (!Array.isArray(nextPkg.dsh.profile.bundles)) {
    nextPkg.dsh.profile.bundles = ["@deepseek-ai/dsh-base"];
  }
  if (!nextPkg.dsh.profile.bundles.includes(DSH_PACKAGE_NAME)) {
    nextPkg.dsh.profile.bundles.push(DSH_PACKAGE_NAME);
  }

  if (!dryRun) {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(nextPkg, null, 2)}\n`, "utf8");
  }
  ensureSymlink(absPluginDir, linkPath, dryRun);

  return {
    action: "configured",
    profile,
    profileDir,
    packageJsonPath,
    linkPath,
    pluginDir: absPluginDir,
    dryRun,
    packageJson: nextPkg,
  };
}

export function configureDsh({
  dshHome,
  profiles = [],
  pluginDir = DEFAULT_PLUGIN_DIR,
  remove = false,
  dryRun = false,
} = {}) {
  const existing = listDshProfiles(dshHome);
  const targets =
    Array.isArray(profiles) && profiles.length > 0
      ? profiles
      : existing.length > 0
        ? existing
        : remove
          ? []
          : ["desktop"];

  const results = targets.map((profile) =>
    configureDshProfile({ dshHome, profile, pluginDir, remove, dryRun }),
  );
  return {
    dshHome: resolveDshHome(dshHome),
    action: remove ? "removed" : "configured",
    profiles: targets,
    results,
    dryRun,
  };
}

function parseCliArgs(argv) {
  const args = {
    dshHome: undefined,
    profiles: [],
    pluginDir: DEFAULT_PLUGIN_DIR,
    remove: false,
    dryRun: false,
    listProfiles: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--dsh-home" && argv[i + 1]) {
      args.dshHome = argv[++i];
    } else if (token === "--profile" && argv[i + 1]) {
      for (const p of argv[++i].split(",").map((s) => s.trim()).filter(Boolean)) {
        args.profiles.push(p);
      }
    } else if (token === "--plugin-dir" && argv[i + 1]) {
      args.pluginDir = argv[++i];
    } else if (token === "--remove" || token === "--uninstall") {
      args.remove = true;
    } else if (token === "--dry-run") {
      args.dryRun = true;
    } else if (token === "--list-profiles") {
      args.listProfiles = true;
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "-h" || token === "--help") {
      args.help = true;
    }
  }
  return args;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "Usage: node setup-dsh.mjs [options]",
        "",
        "Options:",
        "  --dsh-home <dir>     DeepSeek Harness home directory (default: $DSH_HOME or ~/.dsh)",
        "  --profile <name>     Target profile name (repeatable or comma-separated; default: all existing profiles or desktop)",
        "  --plugin-dir <dir>   Path to deepseek-harness/plugins/agi",
        "  --remove             Remove @local/dsh-agi bundle & symlink from target profiles",
        "  --dry-run            Preview changes without modifying files",
        "  --list-profiles      Print detected DeepSeek Harness profiles",
        "  --json               Output machine-readable JSON",
      ].join("\n"),
    );
    return;
  }

  if (args.listProfiles) {
    const profiles = listDshProfiles(args.dshHome);
    console.log(JSON.stringify({ dshHome: resolveDshHome(args.dshHome), profiles }, null, 2));
    return;
  }

  const result = configureDsh(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[agy-dsh-setup] ${result.action} profiles: ${result.profiles.join(", ") || "(none)"} (home=${result.dshHome})`,
    );
  }
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main();
}
