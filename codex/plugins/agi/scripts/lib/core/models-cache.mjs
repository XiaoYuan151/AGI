import fs from "node:fs";
import path from "node:path";
import { resolveAcpConfigPath, resolveAgiHome } from "./account-store.mjs";
import { parseFallbackModels } from "./model-catalog.mjs";

export function resolveModelsCachePath(env = process.env) {
  if (!resolveAcpConfigPath(env)) return "";
  return path.join(resolveAgiHome(env), "models-cache.json");
}

/**
 * File-backed cache for discovered live Antigravity ACP model catalogs per account profile.
 */
export class FileModelsCache {
  constructor({ env = process.env, fs: fsImpl = fs } = {}) {
    this.env = env;
    this.fs = fsImpl;
  }

  resolvePath() {
    return resolveModelsCachePath(this.env);
  }

  _readFile() {
    const cachePath = this.resolvePath();
    if (!cachePath) return { version: 1, entries: {} };
    try {
      if (!this.fs.existsSync(cachePath)) return { version: 1, entries: {} };
      const raw = this.fs.readFileSync(cachePath, "utf8").trim();
      if (!raw) return { version: 1, entries: {} };
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        parsed.entries &&
        typeof parsed.entries === "object" &&
        !Array.isArray(parsed.entries)
      ) {
        return { version: 1, entries: parsed.entries };
      }
    } catch {
      // Ignore corrupt cache files
    }
    return { version: 1, entries: {} };
  }

  _writeFile(cache) {
    const cachePath = this.resolvePath();
    if (!cachePath) return false;
    let tmpPath = "";
    try {
      const dir = path.dirname(cachePath);
      this.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        this.fs.chmodSync(dir, 0o700);
      } catch {
        // ignore
      }
      tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      this.fs.writeFileSync(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.fs.renameSync(tmpPath, cachePath);
      tmpPath = "";
      try {
        this.fs.chmodSync(cachePath, 0o600);
      } catch {
        // ignore
      }
      return true;
    } catch {
      if (tmpPath) {
        try {
          this.fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
      return false;
    }
  }

  read(cacheKey) {
    if (!cacheKey) return null;
    const cache = this._readFile();
    const entry = cache.entries?.[cacheKey];
    if (!entry || typeof entry !== "object") return null;
    if (!Array.isArray(entry.models) || entry.models.length === 0) {
      return null;
    }
    const hasRealEntry = entry.models.every(
      (m) => m && typeof m === "object" && typeof m.id === "string",
    );
    if (!hasRealEntry) return null;
    const models = parseFallbackModels(entry.models);
    if (!Array.isArray(models) || models.length === 0) return null;

    return {
      models: models.map((m) => ({ ...m, efforts: [...(m.efforts || [])] })),
      source: "acp",
      authenticated: entry.authenticated === true ? true : null,
      modelConfigId: typeof entry.modelConfigId === "string" ? entry.modelConfigId : null,
      currentModelId:
        typeof entry.currentModelId === "string" ? entry.currentModelId : models[0]?.id || null,
      effortConfig:
        entry.effortConfig && typeof entry.effortConfig === "object" ? entry.effortConfig : null,
      agentInfo: entry.agentInfo && typeof entry.agentInfo === "object" ? entry.agentInfo : null,
      authMethods: Array.isArray(entry.authMethods) ? entry.authMethods : [],
    };
  }

  write(cacheKey, discovery) {
    if (
      !cacheKey ||
      !discovery ||
      discovery.source !== "acp" ||
      !Array.isArray(discovery.models) ||
      discovery.models.length === 0
    ) {
      return false;
    }
    const cache = this._readFile();
    cache.entries[cacheKey] = {
      updatedAt: Date.now(),
      authenticated: discovery.authenticated === true,
      modelConfigId: discovery.modelConfigId || null,
      currentModelId: discovery.currentModelId || discovery.models[0]?.id || null,
      effortConfig: discovery.effortConfig || null,
      agentInfo: discovery.agentInfo || null,
      authMethods: Array.isArray(discovery.authMethods) ? discovery.authMethods : [],
      models: discovery.models.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        supportsImages: m.supportsImages,
        efforts: [...(m.efforts || [])],
      })),
    };
    return this._writeFile(cache);
  }

  clear(cacheKey) {
    if (!cacheKey) return false;
    const cachePath = this.resolvePath();
    if (!cachePath || !this.fs.existsSync(cachePath)) return false;
    const cache = this._readFile();
    if (!cache.entries?.[cacheKey]) return false;
    delete cache.entries[cacheKey];
    return this._writeFile(cache);
  }
}

export function readCachedDiscovery(cacheKey, env = process.env) {
  return new FileModelsCache({ env }).read(cacheKey);
}

export function writeCachedDiscovery(cacheKey, discovery, env = process.env) {
  return new FileModelsCache({ env }).write(cacheKey, discovery);
}

export function clearCachedDiscoveryEntry(cacheKey, env = process.env) {
  return new FileModelsCache({ env }).clear(cacheKey);
}
