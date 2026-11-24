#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_FALLBACK_MODELS, normalizeModelId } from "./lib/agy-acp-client.mjs";
import { AGY_MODEL_PREFIX, LOCAL_PLACEHOLDER_TOKEN } from "./lib/anthropic-adapter.mjs";
import {
  DEFAULT_CLAUDE_BRIDGE_HOST,
  DEFAULT_CLAUDE_BRIDGE_PORT,
  ensureClaudeBridgeRunning,
} from "./agy-claude-bridge.mjs";

export function resolveClaudeSettingsPath({
  scope = "user",
  settingsPath,
  projectDir = process.cwd(),
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
} = {}) {
  if (settingsPath) return path.resolve(settingsPath);
  if (scope === "local") {
    return path.join(path.resolve(projectDir), ".claude", "settings.local.json");
  }
  return path.join(path.resolve(claudeConfigDir), "settings.json");
}

function readJsonOrEmpty(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed;
}

export function configureClaudeSettings({
  scope = "user",
  settingsPath,
  projectDir = process.cwd(),
  claudeConfigDir,
  host = DEFAULT_CLAUDE_BRIDGE_HOST,
  port = DEFAULT_CLAUDE_BRIDGE_PORT,
  authMode = "auto",
  defaultModel = DEFAULT_FALLBACK_MODELS[0].id,
  setDefault = false,
  includeModelPicker = false,
  account,
  acpConfig,
  geminiDir,
  appDataDir,
  models = DEFAULT_FALLBACK_MODELS,
  remove = false,
  dryRun = false,
} = {}) {
  const targetPath = resolveClaudeSettingsPath({
    scope,
    settingsPath,
    projectDir,
    claudeConfigDir,
  });
  const current = readJsonOrEmpty(targetPath);
  const next = structuredClone(current);
  const bridgeUrl = `http://${host}:${port}`;

  if (remove) {
    if (next.env && typeof next.env === "object") {
      if (
        typeof next.env.ANTHROPIC_BASE_URL === "string" &&
        next.env.ANTHROPIC_BASE_URL.startsWith(`http://${host}:`)
      ) {
        delete next.env.ANTHROPIC_BASE_URL;
      }
      if (next.env.ANTHROPIC_AUTH_TOKEN === LOCAL_PLACEHOLDER_TOKEN) {
        delete next.env.ANTHROPIC_AUTH_TOKEN;
      }
      for (const key of [
        "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
        "ANTHROPIC_CUSTOM_MODEL_OPTION",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
        "AGY_ACCOUNT",
        "AGY_ACP_CONFIG",
        "AGY_GEMINI_DIR",
        "AGY_APP_DATA_DIR",
      ]) {
        delete next.env[key];
      }
      if (Object.keys(next.env).length === 0) {
        delete next.env;
      }
    }
    if (
      typeof next.model === "string" &&
      next.model.toLowerCase().startsWith(AGY_MODEL_PREFIX)
    ) {
      delete next.model;
    }
    if (next.modelPicker && Array.isArray(next.modelPicker.options)) {
      const remaining = next.modelPicker.options.filter(
        (opt) =>
          typeof opt?.model !== "string" ||
          !opt.model.toLowerCase().startsWith(AGY_MODEL_PREFIX),
      );
      if (remaining.length === 0) {
        delete next.modelPicker;
      } else {
        next.modelPicker.options = remaining;
      }
    }

    if (!dryRun) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    }
    return {
      action: "removed",
      settingsPath: targetPath,
      bridgeUrl,
      dryRun,
      settings: next,
    };
  }

  const normalizedDefault = normalizeModelId(defaultModel) || DEFAULT_FALLBACK_MODELS[0].id;
  const matchedModel =
    models.find((m) => normalizeModelId(m.id) === normalizedDefault) || {
      id: normalizedDefault,
      name: normalizedDefault,
      description: "Antigravity ACP model",
    };

  if (!next.env || typeof next.env !== "object" || Array.isArray(next.env)) {
    next.env = {};
  }

  next.env.ANTHROPIC_BASE_URL = bridgeUrl;
  next.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  const rawDesc = matchedModel.description || "Antigravity ACP";
  next.env.ANTHROPIC_CUSTOM_MODEL_OPTION = `${AGY_MODEL_PREFIX}${normalizedDefault}`;
  next.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = `AGY · ${matchedModel.name || normalizedDefault}`;
  next.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = rawDesc.endsWith(`(${normalizedDefault})`)
    ? rawDesc
    : `${rawDesc} (${normalizedDefault})`;
  if (typeof acpConfig === "string" && acpConfig.trim()) {
    next.env.AGY_ACP_CONFIG = acpConfig.trim();
  }
  if (typeof account === "string" && account.trim()) {
    next.env.AGY_ACCOUNT = account.trim();
  }
  if (typeof geminiDir === "string" && geminiDir.trim()) {
    next.env.AGY_GEMINI_DIR = geminiDir.trim();
  }
  if (typeof appDataDir === "string" && appDataDir.trim()) {
    next.env.AGY_APP_DATA_DIR = appDataDir.trim();
  }

  const hasExistingCredential = Boolean(
    next.env.ANTHROPIC_API_KEY ||
      (next.env.ANTHROPIC_AUTH_TOKEN &&
        next.env.ANTHROPIC_AUTH_TOKEN !== LOCAL_PLACEHOLDER_TOKEN) ||
      next.apiKeyHelper ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN,
  );

  let authNote = "preserved";
  if (authMode === "local-token") {
    next.env.ANTHROPIC_AUTH_TOKEN = LOCAL_PLACEHOLDER_TOKEN;
    authNote = "local-token";
  } else if (authMode === "preserve") {
    if (next.env.ANTHROPIC_AUTH_TOKEN === LOCAL_PLACEHOLDER_TOKEN) {
      delete next.env.ANTHROPIC_AUTH_TOKEN;
    }
    authNote = "preserved";
  } else {
    // auto: preserve any existing Anthropic key or claude.ai subscription;
    // do not inject placeholder token automatically unless requested.
    authNote = hasExistingCredential
      ? "preserved-existing-key"
      : "preserved-subscription-or-none";
  }

  if (setDefault) {
    next.model = `${AGY_MODEL_PREFIX}${normalizedDefault}`;
  }

  if (includeModelPicker && scope === "user") {
    const existingOpts = Array.isArray(next.modelPicker?.options)
      ? next.modelPicker.options.filter(
          (opt) =>
            typeof opt?.model !== "string" ||
            !opt.model.toLowerCase().startsWith(AGY_MODEL_PREFIX),
        )
      : [];
    const agyRows = models.map((m) => {
      const id = normalizeModelId(m.id);
      return {
        model: `${AGY_MODEL_PREFIX}${id}`,
        label: `AGY · ${m.name || id}`,
        description: `${m.description || "Antigravity ACP"} (${id})`,
      };
    });
    next.modelPicker = {
      ...(next.modelPicker && typeof next.modelPicker === "object"
        ? next.modelPicker
        : {}),
      options: [...existingOpts, ...agyRows],
    };
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return {
    action: "configured",
    settingsPath: targetPath,
    bridgeUrl,
    authNote,
    customModelOption: next.env.ANTHROPIC_CUSTOM_MODEL_OPTION,
    dryRun,
    settings: next,
  };
}

function parseCliArgs(argv) {
  const opts = {
    scope: "user",
    settingsPath: undefined,
    port: Number(process.env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_BRIDGE_PORT),
    host: process.env.AGY_CLAUDE_HOST || DEFAULT_CLAUDE_BRIDGE_HOST,
    authMode: "auto",
    defaultModel: DEFAULT_FALLBACK_MODELS[0].id,
    setDefault: false,
    includeModelPicker: false,
    account: undefined,
    acpConfig: undefined,
    geminiDir: undefined,
    appDataDir: undefined,
    remove: false,
    dryRun: false,
    startBridge: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--scope" && argv[i + 1]) opts.scope = argv[++i];
    else if (t === "--settings-path" && argv[i + 1]) opts.settingsPath = argv[++i];
    else if (t === "--port" && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (t === "--host" && argv[i + 1]) opts.host = argv[++i];
    else if (t === "--auth-mode" && argv[i + 1]) opts.authMode = argv[++i];
    else if (t === "--default-model" && argv[i + 1]) opts.defaultModel = argv[++i];
    else if (t === "--account" && argv[i + 1]) opts.account = argv[++i];
    else if (t === "--acp-config" && argv[i + 1]) opts.acpConfig = argv[++i];
    else if (t === "--gemini-dir" && argv[i + 1]) opts.geminiDir = argv[++i];
    else if (t === "--app-data-dir" && argv[i + 1]) opts.appDataDir = argv[++i];
    else if (t === "--set-default") opts.setDefault = true;
    else if (t === "--model-picker") opts.includeModelPicker = true;
    else if (t === "--remove") opts.remove = true;
    else if (t === "--dry-run") opts.dryRun = true;
    else if (t === "--start-bridge") opts.startBridge = true;
    else if (t === "--help" || t === "-h") opts.help = true;
  }
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        "Usage: agy-claude-setup [options]",
        "",
        "Options:",
        "  --scope user|local          Target ~/.claude/settings.json or .claude/settings.local.json",
        "  --settings-path <path>      Explicit settings JSON file path",
        "  --port <n>                  Bridge port (default: 43110)",
        "  --auth-mode auto|preserve|local-token",
        "                              Credential handling for gateway discovery",
        "  --default-model <id>        AGY model for ANTHROPIC_CUSTOM_MODEL_OPTION",
        "  --account <name>            Pin a named AGI account profile (AGY_ACCOUNT)",
        "  --acp-config <path>         Pin persisted acp.json path (AGY_ACP_CONFIG)",
        "  --gemini-dir <dir>          Isolated --gemini-dir passed to agy acp",
        "  --app-data-dir <name>       --app-data-dir passed to agy acp (e.g. antigravity-acp)",
        "  --set-default               Also set settings.model to anthropic-agy/<id>",
        "  --model-picker              Add AGY entries to user settings modelPicker (Claude >= 2.1.242)",
        "  --start-bridge              Ensure the background bridge is running",
        "  --remove                    Remove plugin-managed keys",
        "  --dry-run                   Print resulting JSON without writing",
      ].join("\n"),
    );
    return;
  }

  let models = DEFAULT_FALLBACK_MODELS;
  if (!opts.remove) {
    try {
      const res = await fetch(`http://${opts.host}:${opts.port}/v1/models`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.data) && data.data.length > 0) {
          models = data.data.map((m) => ({
            id: normalizeModelId(m.id),
            name: m.display_name?.replace(/^AGY\s*·\s*/, "") || normalizeModelId(m.id),
            description: m.description || "Antigravity ACP model",
          }));
        }
      }
    } catch {
      // Fallback models are used if bridge is not yet running.
    }
  }

  const result = configureClaudeSettings({ ...opts, models });
  if (opts.startBridge && !opts.remove && !opts.dryRun) {
    result.bridge = await ensureClaudeBridgeRunning({
      host: opts.host,
      port: opts.port,
    });
  }
  console.log(JSON.stringify(result, null, 2));
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
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
