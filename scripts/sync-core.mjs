#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const CORE_SOURCE_DIR = path.join(REPO_ROOT, "src", "core");

export const PLUGIN_CORE_TARGETS = Object.freeze([
  path.join(REPO_ROOT, "claude-code", "plugins", "agi", "scripts", "lib", "core"),
  path.join(REPO_ROOT, "codex", "plugins", "agi", "scripts", "lib", "core"),
  path.join(REPO_ROOT, "deepseek-harness", "plugins", "agi", "src", "lib", "core"),
]);

export const PLUGIN_BARREL_PATHS = Object.freeze([
  path.join(REPO_ROOT, "claude-code", "plugins", "agi", "scripts", "lib", "agy-acp-client.mjs"),
  path.join(REPO_ROOT, "codex", "plugins", "agi", "scripts", "lib", "agy-acp-client.mjs"),
  path.join(REPO_ROOT, "deepseek-harness", "plugins", "agi", "src", "lib", "agy-acp-client.mjs"),
]);

export const EXPECTED_BARREL_CONTENT =
  `// Generated mirror barrel — canonical implementation lives in src/core/.\nexport * from "./core/index.mjs";\n`;

function listCoreFiles() {
  return fs
    .readdirSync(CORE_SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)
    .sort();
}

export function checkCoreSync() {
  const coreFiles = listCoreFiles();
  const drift = [];

  for (const targetDir of PLUGIN_CORE_TARGETS) {
    for (const fileName of coreFiles) {
      const srcPath = path.join(CORE_SOURCE_DIR, fileName);
      const dstPath = path.join(targetDir, fileName);
      if (!fs.existsSync(dstPath)) {
        drift.push(`Missing mirror file: ${path.relative(REPO_ROOT, dstPath)}`);
        continue;
      }
      const srcContent = fs.readFileSync(srcPath, "utf8");
      const dstContent = fs.readFileSync(dstPath, "utf8");
      if (srcContent !== dstContent) {
        drift.push(`Out-of-sync mirror file: ${path.relative(REPO_ROOT, dstPath)}`);
      }
    }
    if (fs.existsSync(targetDir)) {
      const expectedSet = new Set(coreFiles);
      for (const existing of fs.readdirSync(targetDir)) {
        if (!expectedSet.has(existing)) {
          drift.push(`Extra stale mirror file: ${path.relative(REPO_ROOT, path.join(targetDir, existing))}`);
        }
      }
    }
  }

  for (const barrelPath of PLUGIN_BARREL_PATHS) {
    if (!fs.existsSync(barrelPath)) {
      drift.push(`Missing barrel file: ${path.relative(REPO_ROOT, barrelPath)}`);
      continue;
    }
    const content = fs.readFileSync(barrelPath, "utf8");
    if (content !== EXPECTED_BARREL_CONTENT) {
      drift.push(`Barrel mismatch: ${path.relative(REPO_ROOT, barrelPath)}`);
    }
  }

  return { ok: drift.length === 0, drift, filesCount: coreFiles.length };
}

export function syncCoreMirrors() {
  const coreFiles = listCoreFiles();
  const expectedSet = new Set(coreFiles);
  let copiedCount = 0;

  for (const targetDir of PLUGIN_CORE_TARGETS) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const existing of fs.readdirSync(targetDir)) {
      if (!expectedSet.has(existing)) {
        fs.rmSync(path.join(targetDir, existing), { recursive: true, force: true });
      }
    }
    for (const fileName of coreFiles) {
      const srcPath = path.join(CORE_SOURCE_DIR, fileName);
      const dstPath = path.join(targetDir, fileName);
      const srcContent = fs.readFileSync(srcPath, "utf8");
      const prevContent = fs.existsSync(dstPath) ? fs.readFileSync(dstPath, "utf8") : null;
      if (prevContent !== srcContent) {
        fs.writeFileSync(dstPath, srcContent, "utf8");
        copiedCount++;
      }
    }
  }

  for (const barrelPath of PLUGIN_BARREL_PATHS) {
    fs.mkdirSync(path.dirname(barrelPath), { recursive: true });
    const prev = fs.existsSync(barrelPath) ? fs.readFileSync(barrelPath, "utf8") : null;
    if (prev !== EXPECTED_BARREL_CONTENT) {
      fs.writeFileSync(barrelPath, EXPECTED_BARREL_CONTENT, "utf8");
      copiedCount++;
    }
  }

  return { ok: true, filesCount: coreFiles.length, updated: copiedCount };
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  const isCheck = process.argv.includes("--check");
  if (isCheck) {
    const res = checkCoreSync();
    if (!res.ok) {
      console.error("[sync-core] Core mirrors are out of sync:");
      for (const line of res.drift) {
        console.error(`  - ${line}`);
      }
      process.exit(1);
    }
    console.log(`[sync-core] All ${res.filesCount} core modules are in sync across plugins.`);
  } else {
    const res = syncCoreMirrors();
    console.log(`[sync-core] Synced ${res.filesCount} core modules (${res.updated} files updated).`);
  }
}
