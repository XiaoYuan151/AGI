import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as agiSdk from "../src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MOCK_AGY_BIN = path.join(__dirname, "fixtures", "mock-agy");

test("root package exports public API and npm pack includes all plugin files & dotfiles", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "@xiaoyuan151/agi");
  assert.equal(agiSdk.VERSION, pkg.version);
  assert.equal(typeof agiSdk.AgyAcpClient, "function");
  assert.equal(typeof agiSdk.installHarnesses, "function");
  assert.equal(typeof agiSdk.updateAgi, "function");
  assert.equal(typeof agiSdk.uninstallAgi, "function");
  assert.equal(typeof agiSdk.addAccount, "function");
  assert.equal(typeof agiSdk.useAccount, "function");

  const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), "agi-npm-cache-"));
  try {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: tmpCache },
    });
    const [packInfo] = JSON.parse(out);
    const packedPaths = new Set(packInfo.files.map((f) => f.path));

    const requiredFiles = [
      "package.json",
      "bin/agi.mjs",
      "src/index.mjs",
      "src/core/acp-client.mjs",
      "src/core/index.mjs",
      "src/installer.mjs",
      "src/installers/registry.mjs",
      "src/services/account-service.mjs",
      "scripts/accounts.mjs",
      "scripts/select-agents.mjs",
      "install.sh",
      "claude-code/.claude-plugin/marketplace.json",
      "claude-code/plugins/agi/.claude-plugin/plugin.json",
      "claude-code/plugins/agi/.mcp.json",
      "claude-code/plugins/agi/scripts/agy-claude-bridge.mjs",
      "codex/.agents/plugins/marketplace.json",
      "codex/.codex/config.toml",
      "codex/plugins/agi/plugin.json",
      "opencode/plugins/agi/package.json",
      "opencode/plugins/agi/src/index.ts",
      "deepseek-harness/plugins/agi/package.json",
      "deepseek-harness/plugins/agi/src/index.mjs",
      "deepseek-harness/plugins/agi/src/client/index.js",
      "deepseek-harness/plugins/agi/locale/en.json",
      "deepseek-harness/plugins/agi/scripts/agy-dsh-gui.mjs",
    ];
    for (const rel of requiredFiles) {
      assert.ok(packedPaths.has(rel), `Expected packed tarball to include '${rel}'`);
    }
    for (const packed of packedPaths) {
      assert.equal(
        packed.startsWith("tests/"),
        false,
        `Tarball must not include test file '${packed}'`,
      );
    }
  } finally {
    fs.rmSync(tmpCache, { recursive: true, force: true });
  }
});

test("packed npm tarball CLI executes install, multi-account, status, update, and uninstall end-to-end", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-npm-e2e-"));
  const packDir = path.join(tmpRoot, "pack");
  const extractDir = path.join(tmpRoot, "extract");
  const npmCache = path.join(tmpRoot, "npm-cache");
  const fakeHome = path.join(tmpRoot, "home");
  const agiHome = path.join(fakeHome, ".agi");
  const claudeDir = path.join(fakeHome, ".claude");
  const codexHome = path.join(fakeHome, ".codex");
  const opencodeDir = path.join(fakeHome, ".config", "opencode");
  const dshHome = path.join(fakeHome, ".dsh");
  const workDataDir = path.join(tmpRoot, "work-folder");

  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });

  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: fakeHome,
    TMPDIR: tmpRoot,
    AGI_HOME: agiHome,
    AGY_BIN: MOCK_AGY_BIN,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexHome,
    OPENCODE_CONFIG_DIR: opencodeDir,
    DSH_HOME: dshHome,
    AGY_CLAUDE_STATE_DIR: path.join(tmpRoot, "claude-bridge"),
    AGY_CODEX_STATE_DIR: path.join(tmpRoot, "codex-bridge"),
  };

  try {
    const packOut = execFileSync(
      "npm",
      ["pack", "--pack-destination", packDir, "--json"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: npmCache },
      },
    );
    const [packMeta] = JSON.parse(packOut);
    const tgzPath = path.join(packDir, packMeta.filename);
    assert.ok(fs.existsSync(tgzPath));

    execFileSync("tar", ["-xzf", tgzPath, "-C", extractDir]);
    const pkgRoot = path.join(extractDir, "package");
    const agiBin = path.join(pkgRoot, "bin", "agi.mjs");

    // 1. --version
    const verOut = execFileSync(process.execPath, [agiBin, "--version"], {
      env,
      encoding: "utf8",
    });
    assert.equal(verOut.trim(), packMeta.version);

    // 2. install --all --yes --skip-login --no-start-bridge
    const installJson = JSON.parse(
      execFileSync(
        process.execPath,
        [agiBin, "install", "--all", "--yes", "--skip-login", "--no-start-bridge", "--json"],
        { env, encoding: "utf8" },
      ),
    );
    assert.equal(installJson.ok, true);
    assert.equal(installJson.activeAccount, "default");
    assert.deepEqual(installJson.agents, ["claude", "codex", "opencode", "dsh"]);
    assert.ok(fs.existsSync(path.join(agiHome, "install.json")));

    // 3. Multi-account CLI lifecycle: add, list, use, status
    const addWorkJson = JSON.parse(
      execFileSync(
        process.execPath,
        [agiBin, "account", "add", "work", "--data-dir", workDataDir, "--json"],
        { env, encoding: "utf8" },
      ),
    );
    assert.equal(addWorkJson.ok, true);
    assert.equal(addWorkJson.activeAccount, "work");
    assert.ok(fs.existsSync(path.join(workDataDir, ".agi-account.json")));

    const listJson = JSON.parse(
      execFileSync(process.execPath, [agiBin, "account", "list", "--json"], {
        env,
        encoding: "utf8",
      }),
    );
    assert.equal(listJson.accounts.length, 2);

    const switchDefault = JSON.parse(
      execFileSync(process.execPath, [agiBin, "account", "use", "default", "--json"], {
        env,
        encoding: "utf8",
      }),
    );
    assert.equal(switchDefault.activeAccount, "default");

    const statusJson = JSON.parse(
      execFileSync(process.execPath, [agiBin, "status", "--json"], {
        env,
        encoding: "utf8",
      }),
    );
    assert.equal(statusJson.accounts.activeAccount, "default");
    assert.equal(statusJson.installState.version, packMeta.version);

    // 4. agi update preserves both accounts & installed agents
    const updateJson = JSON.parse(
      execFileSync(
        process.execPath,
        [agiBin, "update", "--yes", "--no-start-bridge", "--json"],
        { env, encoding: "utf8" },
      ),
    );
    assert.equal(updateJson.ok, true);
    assert.equal(updateJson.action, "update");
    assert.equal(updateJson.activeAccount, "default");
    assert.deepEqual(updateJson.agents, ["claude", "codex", "opencode", "dsh"]);

    const listAfterUpdate = JSON.parse(
      execFileSync(process.execPath, [agiBin, "account", "list", "--json"], {
        env,
        encoding: "utf8",
      }),
    );
    assert.equal(listAfterUpdate.accounts.length, 2);

    // 5. Remove work with --purge and uninstall --all --purge
    const rmWork = JSON.parse(
      execFileSync(
        process.execPath,
        [agiBin, "account", "remove", "work", "--purge", "--json"],
        { env, encoding: "utf8" },
      ),
    );
    assert.equal(rmWork.purgedData, true);
    assert.equal(fs.existsSync(workDataDir), false);

    execFileSync(
      process.execPath,
      [agiBin, "uninstall", "--all", "--yes", "--purge", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(fs.existsSync(agiHome), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("ephemeral npx package path detection materializes runtime assets into $AGI_HOME/package", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-npx-materialize-"));
  const agiHome = path.join(tmpRoot, ".agi");
  const fakeNpxPkg = path.join(tmpRoot, "npm-cache", "_npx", "99999", "node_modules", "@xiaoyuan151", "agi");
  fs.mkdirSync(fakeNpxPkg, { recursive: true });
  fs.cpSync(REPO_ROOT, fakeNpxPkg, {
    recursive: true,
    filter: (p) => path.basename(p) !== ".git" && path.basename(p) !== "node_modules",
  });

  try {
    assert.equal(agiSdk.isEphemeralPackagePath(fakeNpxPkg), true);
    assert.equal(agiSdk.isEphemeralPackagePath("/tmp/dlx-123/@xiaoyuan151/agi"), true);
    assert.equal(agiSdk.isEphemeralPackagePath("/tmp/npm-exec-abc/@xiaoyuan151/agi"), true);
    assert.equal(agiSdk.isEphemeralPackagePath(REPO_ROOT), false);

    const mat = agiSdk.materializeRuntimePackage(fakeNpxPkg, { agiHome });
    assert.equal(mat.materialized, true);
    assert.equal(mat.runtimeRoot, path.join(agiHome, "package"));
    assert.ok(fs.existsSync(path.join(mat.runtimeRoot, "opencode", "plugins", "agi", "package.json")));
    assert.ok(fs.existsSync(path.join(mat.runtimeRoot, "claude-code", "plugins", "agi", ".mcp.json")));
    assert.equal(fs.existsSync(path.join(mat.runtimeRoot, "tests")), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("npx github/local git shorthand runs agi install, bin supports install.sh flags, and workflow is valid", () => {
  const workflowPath = path.join(REPO_ROOT, ".github", "workflows", "publish-npm.yml");
  assert.ok(fs.existsSync(workflowPath));
  const workflowSrc = fs.readFileSync(workflowPath, "utf8");
  // Publishing is triggered only by a published GitHub release (or manual dispatch);
  // tag pushes must not publish on their own.
  const triggersBlock = workflowSrc.slice(0, workflowSrc.indexOf("permissions:"));
  assert.doesNotMatch(triggersBlock, /^\s*push:/m);
  assert.doesNotMatch(triggersBlock, /tags:/);
  assert.match(workflowSrc, /release:\s*\n\s*types:\s*\[published\]/);
  assert.match(workflowSrc, /workflow_dispatch:/);
  assert.match(workflowSrc, /id-token:\s*write/);
  assert.match(workflowSrc, /npm test/);
  assert.match(workflowSrc, /npm run test:opencode/);
  assert.match(workflowSrc, /npm run pack:check/);
  assert.match(workflowSrc, /npm publish/);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-npx-git-"));
  const gitRepo = path.join(tmpRoot, "repo");
  const npmCache = path.join(tmpRoot, "npm-cache");
  const fakeHome = path.join(tmpRoot, "home");
  const agiHome = path.join(fakeHome, ".agi");
  const workDataDir = path.join(tmpRoot, "work-account");
  const agiBin = path.join(REPO_ROOT, "bin", "agi.mjs");

  fs.mkdirSync(gitRepo, { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });

  fs.cpSync(REPO_ROOT, gitRepo, {
    recursive: true,
    filter: (p) => {
      const base = path.basename(p);
      return base !== ".git" && base !== "node_modules" && base !== "tests";
    },
  });

  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: fakeHome,
    TMPDIR: tmpRoot,
    npm_config_cache: npmCache,
    AGI_HOME: agiHome,
    AGY_BIN: MOCK_AGY_BIN,
    CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude"),
    CODEX_HOME: path.join(fakeHome, ".codex"),
    OPENCODE_CONFIG_DIR: path.join(fakeHome, ".config", "opencode"),
    DSH_HOME: path.join(fakeHome, ".dsh"),
    AGY_CLAUDE_STATE_DIR: path.join(tmpRoot, "claude-bridge"),
    AGY_CODEX_STATE_DIR: path.join(tmpRoot, "codex-bridge"),
  };
  delete env.AGY_ACP_CONFIG;

  try {
    execFileSync("git", ["-C", gitRepo, "init", "-q"], { env });
    execFileSync("git", ["-C", gitRepo, "config", "user.email", "test@example.com"], { env });
    execFileSync("git", ["-C", gitRepo, "config", "user.name", "AGI Test"], { env });
    execFileSync("git", ["-C", gitRepo, "add", "-A"], { env });
    execFileSync("git", ["-C", gitRepo, "commit", "-q", "-m", "init"], { env });

    const verOut = execFileSync(
      "npx",
      ["--yes", `git+file://${gitRepo}`, "--version"],
      { env, encoding: "utf8" },
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(verOut.trim(), pkg.version);

    const npxInstallJson = JSON.parse(
      execFileSync(
        "npx",
        [
          "--yes",
          `git+file://${gitRepo}`,
          "install",
          "--dry-run",
          "--yes",
          "--all",
          "--no-start-bridge",
          "--json",
        ],
        { env, encoding: "utf8" },
      ),
    );
    assert.equal(npxInstallJson.ok, true);
    assert.equal(npxInstallJson.activeAccount, "default");
    assert.equal(npxInstallJson.materialized, true);
    assert.equal(npxInstallJson.account?.geminiDir, path.join(agiHome, "antigravity"));
    assert.deepEqual(npxInstallJson.agents, ["claude", "codex", "opencode", "dsh"]);

    // Verify install.sh-compatible flags on bin/agi.mjs
    const addRes = JSON.parse(
      execFileSync(
        process.execPath,
        [agiBin, "--add-account", "work", "--data-dir", workDataDir, "--json"],
        { env, encoding: "utf8" },
      ),
    );
    assert.equal(addRes.ok, true);
    assert.equal(addRes.activeAccount, "work");

    const listRes = JSON.parse(
      execFileSync(process.execPath, [agiBin, "--list-accounts", "--json"], {
        env,
        encoding: "utf8",
      }),
    );
    assert.equal(listRes.activeAccount, "work");

    const useRes = JSON.parse(
      execFileSync(process.execPath, [agiBin, "--use-account", "work", "--json"], {
        env,
        encoding: "utf8",
      }),
    );
    assert.equal(useRes.activeAccount, "work");

    const updateDry = JSON.parse(
      execFileSync(
        process.execPath,
        [agiBin, "-u", "--yes", "--no-start-bridge", "--dry-run", "--json"],
        { env, encoding: "utf8" },
      ),
    );
    assert.equal(updateDry.action, "update");
    assert.equal(updateDry.dryRun, true);

    const uninstallDry = JSON.parse(
      execFileSync(
        process.execPath,
        [agiBin, "--uninstall", "--all", "--yes", "--purge", "--dry-run", "--json"],
        { env, encoding: "utf8" },
      ),
    );
    assert.equal(uninstallDry.action, "uninstall");
    assert.equal(uninstallDry.purge, true);

    const rmRes = JSON.parse(
      execFileSync(
        process.execPath,
        [agiBin, "--remove-account", "work", "--purge", "--json"],
        { env, encoding: "utf8" },
      ),
    );
    assert.equal(rmRes.purgedData, true);
    assert.equal(fs.existsSync(workDataDir), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
