import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  applyKey,
  createSelectorState,
  decodeKeyChunk,
  normalizeAgentId,
  parseAgentCsv,
  renderSelectorFrame,
} from "../scripts/select-agents.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const INSTALL_SH = path.join(REPO_ROOT, "install.sh");
const MOCK_AGY_BIN = path.join(__dirname, "fixtures", "mock-agy");

test("select-agents.mjs normalizes agent names, handles key transitions, and renders frames", () => {
  assert.equal(AGENTS.length, 4);
  assert.equal(normalizeAgentId("claude-code"), "claude");
  assert.equal(normalizeAgentId("deepseek-harness"), "dsh");
  assert.equal(normalizeAgentId("unknown"), null);
  assert.deepEqual(parseAgentCsv("claude,deepseek-harness,opencode,claude"), [
    "claude",
    "dsh",
    "opencode",
  ]);
  assert.deepEqual(parseAgentCsv("all"), ["claude", "codex", "opencode", "dsh"]);

  assert.equal(decodeKeyChunk("\x1b[A"), "up");
  assert.equal(decodeKeyChunk("\x1b[B"), "down");
  assert.equal(decodeKeyChunk(" "), "space");
  assert.equal(decodeKeyChunk("\r"), "enter");
  assert.equal(decodeKeyChunk("\x03"), "ctrl-c");
  assert.equal(decodeKeyChunk("\x1b"), "escape");

  // Detected agents pre-selected
  let state = createSelectorState({ detectedIds: ["opencode", "dsh"], action: "install" });
  assert.deepEqual(Array.from(state.selected), ["opencode", "dsh"]);

  // Toggle first (claude) on, move down to codex, move down to opencode and toggle off
  state = applyKey(state, "space").state;
  assert.equal(state.selected.has("claude"), true);
  state = applyKey(state, "down").state;
  assert.equal(state.cursor, 1);
  state = applyKey(state, "j").state;
  assert.equal(state.cursor, 2);
  state = applyKey(state, "space").state;
  assert.equal(state.selected.has("opencode"), false);

  const confirm = applyKey(state, "enter");
  assert.equal(confirm.done, true);
  assert.equal(confirm.cancelled, false);
  assert.deepEqual(confirm.selected, ["claude", "dsh"]);

  // Toggle all on, then toggle all off -> enter shows validation error
  let allState = applyKey(state, "a").state;
  assert.equal(allState.selected.size, 4);
  allState = applyKey(allState, "a").state;
  assert.equal(allState.selected.size, 0);
  const emptyEnter = applyKey(allState, "enter");
  assert.equal(emptyEnter.done, false);
  assert.match(emptyEnter.state.error, /Select at least one agent/);

  const frame = renderSelectorFrame(emptyEnter.state, { useColor: false }).join("\n");
  assert.match(frame, /Which agents would you like to install AGI to\?/);
  assert.match(frame, /DeepSeek Harness/);
  assert.match(frame, /Select at least one agent/);

  const updateFrame = renderSelectorFrame(
    { ...emptyEnter.state, action: "update" },
    { useColor: false },
  ).join("\n");
  assert.match(updateFrame, /Which agents would you like to update AGI for\?/);

  // Escape / q cancels cleanly
  const cancelled = applyKey(emptyEnter.state, "escape");
  assert.equal(cancelled.done, true);
  assert.equal(cancelled.cancelled, true);
});

test("install.sh --dry-run honors -a/--agent, --dsh, --all, --update, and --uninstall", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-install-dry-"));
  const fakeHome = path.join(tmpRoot, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: fakeHome,
    AGI_HOME: path.join(fakeHome, ".agi"),
    AGY_BIN: MOCK_AGY_BIN,
    CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude"),
    CODEX_HOME: path.join(fakeHome, ".codex"),
    OPENCODE_CONFIG_DIR: path.join(fakeHome, ".config", "opencode"),
    DSH_HOME: path.join(fakeHome, ".dsh"),
  };

  try {
    const outSelected = execFileSync("bash", [INSTALL_SH, "--dry-run", "-a", "opencode,dsh"], {
      encoding: "utf8",
      env,
    });
    assert.match(outSelected, /Setting up OpenCode V2 plugin/);
    assert.match(outSelected, /Setting up DeepSeek Harness plugin/);
    assert.doesNotMatch(outSelected, /Setting up Claude Code plugin/);
    assert.doesNotMatch(outSelected, /Setting up Codex plugin/);

    const outAll = execFileSync("bash", [INSTALL_SH, "--dry-run", "--all", "--yes"], {
      encoding: "utf8",
      env,
    });
    assert.match(outAll, /Setting up Claude Code plugin/);
    assert.match(outAll, /Setting up Codex plugin/);
    assert.match(outAll, /Setting up OpenCode V2 plugin/);
    assert.match(outAll, /Setting up DeepSeek Harness plugin/);

    const outUpdate = execFileSync("bash", [INSTALL_SH, "--dry-run", "--update", "-a", "claude"], {
      encoding: "utf8",
      env,
    });
    assert.match(outUpdate, /Would update AGI checkout/);
    assert.match(outUpdate, /Setting up Claude Code plugin/);

    const outUninstallDsh = execFileSync(
      "bash",
      [INSTALL_SH, "--dry-run", "--uninstall", "--dsh", "--dsh-profile", "desktop"],
      {
        encoding: "utf8",
        env,
      },
    );
    assert.match(outUninstallDsh, /Removing DeepSeek Harness configuration/);
    assert.doesNotMatch(outUninstallDsh, /Removing Claude Code configuration/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("install.sh performs isolated end-to-end install and uninstall across all 4 harnesses", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-install-e2e-"));
  const fakeHome = path.join(tmpRoot, "home");
  const fakeTmp = path.join(tmpRoot, "tmp");
  const agiHome = path.join(fakeHome, ".agi");
  const claudeDir = path.join(fakeHome, ".claude");
  const codexHome = path.join(fakeHome, ".codex");
  const opencodeDir = path.join(fakeHome, ".config", "opencode");
  const dshHome = path.join(fakeHome, ".dsh");
  const nodeBinDir = path.dirname(process.execPath);

  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeTmp, { recursive: true });

  // Sanitized PATH with node + core POSIX utils only (avoids invoking host claude/codex CLIs)
  const safePath = `${nodeBinDir}:/usr/bin:/bin`;
  const env = {
    PATH: safePath,
    HOME: fakeHome,
    TMPDIR: fakeTmp,
    AGI_HOME: agiHome,
    AGY_BIN: MOCK_AGY_BIN,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexHome,
    OPENCODE_CONFIG_DIR: opencodeDir,
    DSH_HOME: dshHome,
    AGY_CLAUDE_STATE_DIR: path.join(fakeTmp, "claude-bridge-state"),
    AGY_CODEX_STATE_DIR: path.join(fakeTmp, "codex-bridge-state"),
  };

  try {
    const installOut = execFileSync(
      "/bin/bash",
      [INSTALL_SH, "--all", "--yes", "--skip-login", "--no-start-bridge"],
      { encoding: "utf8", env },
    );
    assert.match(installOut, /\[agi-install\] Done!/);

    // 1. Persisted isolated ACP profile (v2 schema with legacy top-level keys)
    const acpCfg = JSON.parse(fs.readFileSync(path.join(agiHome, "acp.json"), "utf8"));
    assert.equal(acpCfg.version, 2);
    assert.equal(acpCfg.activeAccount, "default");
    assert.equal(acpCfg.geminiDir, path.join(agiHome, "antigravity"));
    assert.equal(acpCfg.appDataDir, "antigravity-acp");

    const installState = JSON.parse(fs.readFileSync(path.join(agiHome, "install.json"), "utf8"));
    assert.deepEqual(installState.agents, ["claude", "codex", "opencode", "dsh"]);

    // 2. Claude Code settings written without pinning AGY_GEMINI_DIR
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
    assert.equal(claudeSettings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43110");
    assert.equal(claudeSettings.env.AGY_GEMINI_DIR, undefined);

    // 3. Codex profile & catalog written
    assert.ok(fs.existsSync(path.join(codexHome, "agy.config.toml")));
    assert.ok(fs.existsSync(path.join(codexHome, "agy-models.json")));

    // 4. OpenCode plugin symlinked
    const ocLink = path.join(opencodeDir, "plugins", "agi");
    assert.ok(fs.lstatSync(ocLink).isSymbolicLink());

    // 5. DeepSeek Harness bundle configured & symlinked
    const dshPkg = JSON.parse(
      fs.readFileSync(path.join(dshHome, "profiles", "desktop", "package.json"), "utf8"),
    );
    assert.ok(dshPkg.dsh.profile.bundles.includes("@local/dsh-agi"));
    assert.ok(
      fs
        .lstatSync(path.join(dshHome, "profiles", "desktop", "node_modules", "@local", "dsh-agi"))
        .isSymbolicLink(),
    );

    // Uninstall all with --purge
    const uninstallOut = execFileSync(
      "/bin/bash",
      [INSTALL_SH, "--uninstall", "--all", "--yes", "--purge"],
      { encoding: "utf8", env },
    );
    assert.match(uninstallOut, /Uninstall complete\./);

    assert.equal(fs.existsSync(agiHome), false);
    assert.equal(fs.existsSync(ocLink), false);
    assert.equal(fs.existsSync(path.join(codexHome, "agy-models.json")), false);
    const dshPkgAfter = JSON.parse(
      fs.readFileSync(path.join(dshHome, "profiles", "desktop", "package.json"), "utf8"),
    );
    assert.equal(dshPkgAfter.dsh.profile.bundles.includes("@local/dsh-agi"), false);
    const claudeAfter = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
    assert.equal(claudeAfter.env?.ANTHROPIC_BASE_URL, undefined);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("install.sh --update pulls updates from remote git repo while preserving accounts and saved options", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-install-update-"));
  const bareRemote = path.join(tmpRoot, "remote.git");
  const seedRepo = path.join(tmpRoot, "seed");
  const managedDir = path.join(tmpRoot, "managed-repo");
  const bootstrapSh = path.join(tmpRoot, "bootstrap.sh");
  const fakeHome = path.join(tmpRoot, "home");
  const agiHome = path.join(fakeHome, ".agi");
  const claudeDir = path.join(fakeHome, ".claude");
  const codexHome = path.join(fakeHome, ".codex");
  const opencodeDir = path.join(fakeHome, ".config", "opencode");
  const dshHome = path.join(fakeHome, ".dsh");
  const workDataDir = path.join(tmpRoot, "custom-work-account");

  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(seedRepo, { recursive: true });
  fs.cpSync(REPO_ROOT, seedRepo, {
    recursive: true,
    filter: (p) => {
      const base = path.basename(p);
      return base !== ".git" && base !== "node_modules";
    },
  });
  fs.copyFileSync(INSTALL_SH, bootstrapSh);
  fs.chmodSync(bootstrapSh, 0o755);

  const env = {
    PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
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
    execFileSync("git", ["init", "--bare", "-b", "main", bareRemote], { env });
    execFileSync("git", ["-C", seedRepo, "init", "-b", "main"], { env });
    execFileSync("git", ["-C", seedRepo, "config", "user.name", "AGI Test"], { env });
    execFileSync("git", ["-C", seedRepo, "config", "user.email", "agi@example.com"], { env });
    execFileSync("git", ["-C", seedRepo, "add", "-A"], { env });
    execFileSync("git", ["-C", seedRepo, "commit", "-m", "v1"], { env });
    execFileSync("git", ["-C", seedRepo, "remote", "add", "origin", bareRemote], { env });
    execFileSync("git", ["-C", seedRepo, "push", "-u", "origin", "main"], { env });

    const remoteUrl = `file://${bareRemote}`;

    // 1. Initial bootstrap install selecting claude + opencode with --copy and --local-token
    execFileSync(
      "/bin/bash",
      [
        bootstrapSh,
        "--install-dir",
        managedDir,
        "--repo-url",
        remoteUrl,
        "--ref",
        "main",
        "-a",
        "claude,opencode",
        "--copy",
        "--local-token",
        "--yes",
        "--skip-login",
        "--no-start-bridge",
      ],
      { cwd: tmpRoot, env, encoding: "utf8" },
    );

    // 2. Add a second account saved to custom data folder
    execFileSync(
      "/bin/bash",
      [
        bootstrapSh,
        "--install-dir",
        managedDir,
        "--add-account",
        "work",
        "--data-dir",
        workDataDir,
      ],
      { cwd: tmpRoot, env, encoding: "utf8" },
    );

    // 3. Push a new commit (v2) to the remote bare repository
    const markerSrc = path.join(seedRepo, "opencode", "plugins", "agi", "UPDATED_MARKER.txt");
    fs.writeFileSync(markerSrc, "v2-updated\n", "utf8");
    execFileSync("git", ["-C", seedRepo, "add", "-A"], { env });
    execFileSync("git", ["-C", seedRepo, "commit", "-m", "v2"], { env });
    execFileSync("git", ["-C", seedRepo, "push", "origin", "main"], { env });

    // 4. Run --update --check first (read-only)
    const checkOut = execFileSync(
      "/bin/bash",
      [
        path.join(managedDir, "install.sh"),
        "--update",
        "--check",
        "--repo-url",
        remoteUrl,
        "--ref",
        "main",
      ],
      { cwd: tmpRoot, env, encoding: "utf8" },
    );
    assert.match(checkOut, /update available/);

    // 5. Run --update without repeating -a, --copy, or --local-token
    const updateOut = execFileSync(
      "/bin/bash",
      [
        bootstrapSh,
        "--update",
        "--install-dir",
        managedDir,
        "--repo-url",
        remoteUrl,
        "--ref",
        "main",
        "--yes",
        "--no-start-bridge",
      ],
      { cwd: tmpRoot, env, encoding: "utf8" },
    );
    assert.match(updateOut, /Updated AGI checkout/);
    assert.match(updateOut, /\[agi-install\] Done!/);

    // 6. Verify copied OpenCode plugin got the v2 update
    const copiedMarker = path.join(opencodeDir, "plugins", "agi", "UPDATED_MARKER.txt");
    assert.equal(fs.existsSync(copiedMarker), true);
    assert.equal(fs.readFileSync(copiedMarker, "utf8").trim(), "v2-updated");

    // 7. Verify Claude settings retained saved --local-token and did NOT pin AGY_GEMINI_DIR
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
    assert.equal(claudeSettings.env.ANTHROPIC_AUTH_TOKEN, "agy-acp-local");
    assert.equal(claudeSettings.env.AGY_GEMINI_DIR, undefined);

    // 8. Verify multi-account acp.json stayed intact with 'work' still active
    const acpCfg = JSON.parse(fs.readFileSync(path.join(agiHome, "acp.json"), "utf8"));
    assert.equal(acpCfg.activeAccount, "work");
    assert.ok(acpCfg.accounts.default);
    assert.equal(acpCfg.accounts.work.geminiDir, workDataDir);

    // 9. Verify codex/dsh were NOT spuriously installed
    assert.equal(fs.existsSync(path.join(codexHome, "agy.config.toml")), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("install.sh multi-account flags and subcommands manage separate data folders", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-install-acct-"));
  const fakeHome = path.join(tmpRoot, "home");
  const agiHome = path.join(fakeHome, ".agi");
  const workDir = path.join(tmpRoot, "acct-work");
  const personalDir = path.join(tmpRoot, "acct-personal");
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: fakeHome,
    AGI_HOME: agiHome,
    AGY_BIN: MOCK_AGY_BIN,
    CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude"),
  };

  try {
    fs.mkdirSync(fakeHome, { recursive: true });
    execFileSync(
      "/bin/bash",
      [INSTALL_SH, "--add-account", "work", "--data-dir", workDir],
      { env, encoding: "utf8" },
    );
    execFileSync(
      "/bin/bash",
      [INSTALL_SH, "account", "add", "personal", "--data-dir", personalDir, "--no-activate"],
      { env, encoding: "utf8" },
    );

    const listOut = execFileSync("/bin/bash", [INSTALL_SH, "--list-accounts"], {
      env,
      encoding: "utf8",
    });
    assert.match(listOut, /\* work/);
    assert.match(listOut, /personal/);

    execFileSync("/bin/bash", [INSTALL_SH, "--use-account", "personal"], {
      env,
      encoding: "utf8",
    });
    const currentOut = execFileSync(
      "/bin/bash",
      [INSTALL_SH, "account", "current", "--json"],
      { env, encoding: "utf8" },
    );
    const currentJson = JSON.parse(currentOut);
    assert.equal(currentJson.activeAccount, "personal");
    assert.equal(currentJson.account.geminiDir, personalDir);

    execFileSync(
      "/bin/bash",
      [INSTALL_SH, "--remove-account", "personal", "--purge"],
      { env, encoding: "utf8" },
    );
    assert.equal(fs.existsSync(personalDir), false);
    const acpCfg = JSON.parse(fs.readFileSync(path.join(agiHome, "acp.json"), "utf8"));
    assert.equal(acpCfg.activeAccount, "work");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
