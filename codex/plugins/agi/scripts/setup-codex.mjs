#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_FALLBACK_MODELS, normalizeModelId } from "./lib/agy-acp-client.mjs";
import { AGY_CODEX_PREFIX, buildCodexModelCatalog } from "./lib/responses-adapter.mjs";
import {
  DEFAULT_CODEX_BRIDGE_HOST,
  DEFAULT_CODEX_BRIDGE_PORT,
  ensureCodexBridgeRunning,
} from "./agy-codex-bridge.mjs";

const TOP_START = "# >>> agy-acp-bridge >>>";
const TOP_END = "# <<< agy-acp-bridge <<<";
const PROV_START = "# >>> agy-acp-bridge-provider >>>";
const PROV_END = "# <<< agy-acp-bridge-provider <<<";
const BACKUP_PREFIX = "# [agy-backup] ";

export function resolveCodexHome(codexHome) {
  return path.resolve(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

export function readBundledCodexModels(codexBin = "codex") {
  try {
    const out = execFileSync(codexBin, ["debug", "models", "--bundled"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed?.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMarkedBlock(text, startMarker, endMarker) {
  const pattern = new RegExp(
    `(?:\\r?\\n)?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}(?:\\r?\\n)?`,
    "g",
  );
  return text.replace(pattern, "\n");
}

function stripExistingProviderSection(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[model_providers\.agy\]$/.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[/.test(trimmed)) {
      skipping = false;
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join("\n");
}

function restoreBackedUpTopKeys(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith(BACKUP_PREFIX) ? line.slice(BACKUP_PREFIX.length) : line))
    .join("\n");
}

function commentTopLevelManagedKeys(text) {
  const lines = text.split(/\r?\n/);
  let inTable = false;
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (/^\[/.test(trimmed)) {
        inTable = true;
        return line;
      }
      if (!inTable && /^(model|model_provider|model_catalog_json)\s*=/.test(trimmed)) {
        return `${BACKUP_PREFIX}${line}`;
      }
      return line;
    })
    .join("\n");
}

function insertTopLevelBlockBeforeFirstTable(text, block) {
  const lines = text.split(/\r?\n/);
  const firstTableIdx = lines.findIndex((line) => /^\[/.test(line.trim()));
  const blockLines = block.split("\n");
  if (firstTableIdx === -1) {
    const body = text.trim();
    return body ? `${block}\n\n${body}\n` : `${block}\n`;
  }
  const before = lines.slice(0, firstTableIdx).join("\n").trimEnd();
  const after = lines.slice(firstTableIdx).join("\n").trimStart();
  const parts = [];
  if (before) parts.push(before);
  parts.push(blockLines.join("\n"));
  if (after) parts.push(after);
  return `${parts.join("\n\n")}\n`;
}

function buildProviderTableToml(host, port) {
  const baseUrl = `http://${host}:${port}/v1`;
  const catalogUrl = `http://${host}:${port}/v1/models-catalog`;
  return [
    `[model_providers.agy]`,
    `name = "Antigravity (ACP)"`,
    `base_url = ${JSON.stringify(baseUrl)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `model_catalog_url = ${JSON.stringify(catalogUrl)}`,
  ].join("\n");
}

export function configureCodex({
  codexHome,
  mode = "profile",
  profileName = "agy",
  host = DEFAULT_CODEX_BRIDGE_HOST,
  port = DEFAULT_CODEX_BRIDGE_PORT,
  defaultModel = DEFAULT_FALLBACK_MODELS[0].id,
  includeBundled = true,
  bundledModels = null,
  models = DEFAULT_FALLBACK_MODELS,
  remove = false,
  dryRun = false,
} = {}) {
  const homeDir = resolveCodexHome(codexHome);
  const catalogPath = path.join(homeDir, "agy-models.json");
  const profilePath = path.join(homeDir, `${profileName}.config.toml`);
  const configTomlPath = path.join(homeDir, "config.toml");

  if (remove) {
    const removedFiles = [];
    if (mode === "profile") {
      if (!dryRun && fs.existsSync(profilePath)) {
        fs.unlinkSync(profilePath);
      }
      removedFiles.push(profilePath);
    } else if (fs.existsSync(configTomlPath)) {
      const prev = fs.readFileSync(configTomlPath, "utf8");
      let next = stripMarkedBlock(prev, TOP_START, TOP_END);
      next = stripMarkedBlock(next, PROV_START, PROV_END);
      next = restoreBackedUpTopKeys(next).replace(/\n{3,}/g, "\n\n").trim();
      const finalText = next ? `${next}\n` : "";
      if (!dryRun) {
        fs.writeFileSync(configTomlPath, finalText, "utf8");
      }
    }

    if (!dryRun && fs.existsSync(catalogPath)) {
      fs.unlinkSync(catalogPath);
    }
    removedFiles.push(catalogPath);

    return {
      action: "removed",
      mode,
      codexHome: homeDir,
      removedFiles,
      dryRun,
    };
  }

  const normalizedDefault = normalizeModelId(defaultModel) || DEFAULT_FALLBACK_MODELS[0].id;
  const fullDefaultSlug = `${AGY_CODEX_PREFIX}${normalizedDefault}`;
  const effectiveBundled = includeBundled
    ? Array.isArray(bundledModels)
      ? bundledModels
      : readBundledCodexModels()
    : [];

  const catalog = buildCodexModelCatalog(models, {
    bundledModels: effectiveBundled,
    includeBundled,
  });

  if (!dryRun) {
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  }

  const providerToml = buildProviderTableToml(host, port);

  if (mode === "profile") {
    const profileToml = [
      `# Generated by agi (agy acp integration)`,
      `model = ${JSON.stringify(fullDefaultSlug)}`,
      `model_provider = "agy"`,
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      ``,
      providerToml,
      ``,
    ].join("\n");

    if (!dryRun) {
      fs.writeFileSync(profilePath, profileToml, "utf8");
    }

    return {
      action: "configured",
      mode,
      codexHome: homeDir,
      profileName,
      profilePath,
      catalogPath,
      bridgeUrl: `http://${host}:${port}/v1`,
      defaultModel: fullDefaultSlug,
      modelsCount: catalog.models.length,
      dryRun,
      tomlPreview: profileToml,
    };
  }

  const existingToml = fs.existsSync(configTomlPath)
    ? fs.readFileSync(configTomlPath, "utf8")
    : "";
  let cleaned = stripMarkedBlock(existingToml, TOP_START, TOP_END);
  cleaned = stripMarkedBlock(cleaned, PROV_START, PROV_END);
  cleaned = restoreBackedUpTopKeys(cleaned);
  cleaned = stripExistingProviderSection(cleaned);
  cleaned = commentTopLevelManagedKeys(cleaned);

  const topBlock = [
    TOP_START,
    `model = ${JSON.stringify(fullDefaultSlug)}`,
    `model_provider = "agy"`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    TOP_END,
  ].join("\n");

  const provBlock = [PROV_START, providerToml, PROV_END].join("\n");
  let nextToml = insertTopLevelBlockBeforeFirstTable(cleaned, topBlock).trimEnd();
  nextToml = `${nextToml}\n\n${provBlock}\n`.replace(/\n{3,}/g, "\n\n");

  if (!dryRun) {
    fs.writeFileSync(configTomlPath, nextToml, "utf8");
  }

  return {
    action: "configured",
    mode,
    codexHome: homeDir,
    configTomlPath,
    catalogPath,
    bridgeUrl: `http://${host}:${port}/v1`,
    defaultModel: fullDefaultSlug,
    modelsCount: catalog.models.length,
    dryRun,
    tomlPreview: nextToml,
  };
}

function parseCliArgs(argv) {
  const opts = {
    codexHome: undefined,
    mode: "profile",
    profileName: "agy",
    port: Number(process.env.AGY_CODEX_PORT || DEFAULT_CODEX_BRIDGE_PORT),
    host: process.env.AGY_CODEX_HOST || DEFAULT_CODEX_BRIDGE_HOST,
    defaultModel: DEFAULT_FALLBACK_MODELS[0].id,
    includeBundled: true,
    remove: false,
    dryRun: false,
    startBridge: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--codex-home" && argv[i + 1]) opts.codexHome = argv[++i];
    else if (t === "--mode" && argv[i + 1]) opts.mode = argv[++i];
    else if (t === "--profile-name" && argv[i + 1]) opts.profileName = argv[++i];
    else if (t === "--port" && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (t === "--host" && argv[i + 1]) opts.host = argv[++i];
    else if (t === "--default-model" && argv[i + 1]) opts.defaultModel = argv[++i];
    else if (t === "--include-bundled") opts.includeBundled = true;
    else if (t === "--no-include-bundled") opts.includeBundled = false;
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
        "Usage: setup-codex.mjs [options]",
        "",
        "Options:",
        "  --codex-home <dir>     Target CODEX_HOME (default: ~/.codex)",
        "  --mode profile|default Write <profile>.config.toml (default) or update config.toml",
        "  --profile-name <name>  Profile name for profile mode (default: agy)",
        "  --port <n>             Bridge port (default: 43111)",
        "  --default-model <id>   Default AGY model ID",
        "  --no-include-bundled   Exclude bundled OpenAI models from agy-models.json",
        "  --start-bridge         Ensure the background bridge is running",
        "  --remove               Remove plugin-managed config & catalog",
        "  --dry-run              Preview changes without writing disk",
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
      // Fallback models used when bridge is offline.
    }
  }

  const result = configureCodex({ ...opts, models });
  if (opts.startBridge && !opts.remove && !opts.dryRun) {
    result.bridge = await ensureCodexBridgeRunning({
      host: opts.host,
      port: opts.port,
      catalogPath: result.catalogPath,
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
