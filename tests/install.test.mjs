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

  // Escape / q cancels cleanly
  const cancelled = applyKey(emptyEnter.state, "escape");
  assert.equal(cancelled.done, true);
  assert.equal(cancelled.cancelled, true);
});

test("install.sh --dry-run honors -a/--agent, --dsh, --all, and --uninstall", () => {
  const outSelected = execFileSync("bash", [INSTALL_SH, "--dry-run", "-a", "opencode,dsh"], {
    encoding: "utf8",
    env: { ...process.env, AGY_BIN: MOCK_AGY_BIN },
  });
  assert.match(outSelected, /Setting up OpenCode V2 plugin/);
  assert.match(outSelected, /Setting up DeepSeek Harness plugin/);
  assert.doesNotMatch(outSelected, /Setting up Claude Code plugin/);
  assert.doesNotMatch(outSelected, /Setting up Codex plugin/);

  const outAll = execFileSync("bash", [INSTALL_SH, "--dry-run", "--all", "--yes"], {
    encoding: "utf8",
    env: { ...process.env, AGY_BIN: MOCK_AGY_BIN },
  });
  assert.match(outAll, /Setting up Claude Code plugin/);
  assert.match(outAll, /Setting up Codex plugin/);
  assert.match(outAll, /Setting up OpenCode V2 plugin/);
  assert.match(outAll, /Setting up DeepSeek Harness plugin/);

  const outUninstallDsh = execFileSync(
    "bash",
    [INSTALL_SH, "--dry-run", "--uninstall", "--dsh", "--dsh-profile", "desktop"],
    {
      encoding: "utf8",
      env: { ...process.env, AGY_BIN: MOCK_AGY_BIN },
    },
  );
  assert.match(outUninstallDsh, /Removing DeepSeek Harness configuration/);
  assert.doesNotMatch(outUninstallDsh, /Removing Claude Code configuration/);
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

    // 1. Persisted isolated ACP profile
    const acpCfg = JSON.parse(fs.readFileSync(path.join(agiHome, "acp.json"), "utf8"));
    assert.equal(acpCfg.geminiDir, path.join(agiHome, "antigravity"));
    assert.equal(acpCfg.appDataDir, "antigravity-acp");

    // 2. Claude Code settings written
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
    assert.equal(claudeSettings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43110");

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
