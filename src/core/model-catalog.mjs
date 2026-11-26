export const DEFAULT_FALLBACK_MODELS = Object.freeze([
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    description: "Antigravity ACP default reasoning and coding model",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsImages: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description: "Fast Antigravity ACP coding and chat model",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsImages: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    description: "Lightweight high-throughput Antigravity ACP model",
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    supportsImages: true,
    efforts: ["low", "medium"],
  },
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    description: "Balanced Antigravity ACP multimodal model",
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    supportsImages: true,
    efforts: ["low", "medium"],
  },
]);

export function normalizeModelId(rawId) {
  if (typeof rawId !== "string") return "";
  let id = rawId.trim();
  for (const prefix of ["anthropic-agy/", "antigravity/", "agy/"]) {
    if (id.toLowerCase().startsWith(prefix)) {
      id = id.slice(prefix.length);
      break;
    }
  }
  return id.trim();
}

export function parseFallbackModels(rawValue) {
  if (Array.isArray(rawValue) && rawValue.length > 0) {
    const mapped = rawValue
      .map((item) => {
        if (typeof item === "string") {
          const id = normalizeModelId(item);
          return id
            ? {
                id,
                name: id,
                description: "Antigravity ACP model",
                contextWindow: 1000000,
                maxOutputTokens: 65536,
                supportsImages: true,
                efforts: ["low", "medium", "high"],
              }
            : null;
        }
        if (item && typeof item === "object" && typeof item.id === "string") {
          const id = normalizeModelId(item.id);
          if (!id) return null;
          return {
            id,
            name: typeof item.name === "string" && item.name ? item.name : id,
            description:
              typeof item.description === "string"
                ? item.description
                : "Antigravity ACP model",
            contextWindow:
              typeof item.contextWindow === "number" ? item.contextWindow : 1000000,
            maxOutputTokens:
              typeof item.maxOutputTokens === "number" ? item.maxOutputTokens : 65536,
            supportsImages: item.supportsImages !== false,
            efforts: Array.isArray(item.efforts)
              ? item.efforts.map(String)
              : ["low", "medium", "high"],
          };
        }
        return null;
      })
      .filter(Boolean);
    if (mapped.length > 0) return mapped;
  }

  if (!rawValue || typeof rawValue !== "string" || !rawValue.trim()) {
    return DEFAULT_FALLBACK_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }));
  }
  const trimmed = rawValue.trim();
  if (trimmed.startsWith("[")) {
    try {
      return parseFallbackModels(JSON.parse(trimmed));
    } catch {
      // Fall through to comma-separated parser
    }
  }

  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return DEFAULT_FALLBACK_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }));
  }

  return parts.map((entry) => {
    const colonIdx = entry.indexOf(":");
    const id = normalizeModelId(colonIdx === -1 ? entry : entry.slice(0, colonIdx));
    const name = colonIdx === -1 ? id : entry.slice(colonIdx + 1).trim() || id;
    return {
      id,
      name,
      description: "Antigravity ACP model",
      contextWindow: 1000000,
      maxOutputTokens: 65536,
      supportsImages: true,
      efforts: ["low", "medium", "high"],
    };
  });
}

function flattenSelectOptions(options) {
  if (!Array.isArray(options)) return [];
  const out = [];
  for (const item of options) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item.options)) {
      for (const nested of item.options) {
        if (nested && typeof nested === "object" && nested.value != null) {
          out.push(nested);
        }
      }
    } else if (item.value != null) {
      out.push(item);
    }
  }
  return out;
}

export function extractEffortConfigFromSessionResult(result) {
  const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
  const opt = configOptions.find(
    (entry) =>
      entry &&
      entry.type === "select" &&
      (entry.category === "thought_level" ||
        ["thought_level", "reasoning_effort", "effort", "thinking"].includes(
          String(entry.id || "").toLowerCase(),
        )),
  );
  if (!opt) return null;
  const values = flattenSelectOptions(opt.options).map((o) => ({
    value: String(o.value),
    name: typeof o.name === "string" && o.name ? o.name : String(o.value),
    description: typeof o.description === "string" ? o.description : "",
  }));
  return {
    configId: String(opt.id),
    currentValue: opt.currentValue != null ? String(opt.currentValue) : undefined,
    options: values,
  };
}

export function extractModelsFromSessionResult(result) {
  const byId = new Map();
  let modelConfigId = null;
  let currentModelId = null;

  const effortConfig = extractEffortConfigFromSessionResult(result);
  const effortValues = effortConfig
    ? effortConfig.options.map((o) => o.value)
    : ["low", "medium", "high"];

  const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
  const modelOpt = configOptions.find(
    (entry) =>
      entry &&
      entry.type === "select" &&
      (entry.category === "model" || String(entry.id || "").toLowerCase() === "model"),
  );

  if (modelOpt) {
    modelConfigId = String(modelOpt.id);
    if (modelOpt.currentValue != null) {
      currentModelId = normalizeModelId(String(modelOpt.currentValue));
    }
    for (const item of flattenSelectOptions(modelOpt.options)) {
      const id = normalizeModelId(String(item.value));
      if (!id) continue;
      const meta = item._meta && typeof item._meta === "object" ? item._meta : {};
      byId.set(id, {
        id,
        name: typeof item.name === "string" && item.name ? item.name : id,
        description:
          typeof item.description === "string" && item.description
            ? item.description
            : "Antigravity ACP model",
        contextWindow:
          typeof meta.contextWindow === "number" ? meta.contextWindow : 1000000,
        maxOutputTokens:
          typeof meta.maxOutputTokens === "number" ? meta.maxOutputTokens : 65536,
        supportsImages: meta.supportsImages !== false,
        efforts: Array.isArray(meta.efforts)
          ? meta.efforts.map(String)
          : [...effortValues],
      });
    }
  }

  const hasConfigOptionModels = byId.size > 0;
  const knownEffortSuffixes = Array.from(
    new Set([
      ...effortValues.map((v) => String(v).toLowerCase()),
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
  ).sort((a, b) => b.length - a.length);
  const matchedEffortsByBase = new Map();

  const legacyModels = result?.models;
  if (legacyModels && typeof legacyModels === "object") {
    if (!currentModelId && typeof legacyModels.currentModelId === "string") {
      currentModelId = normalizeModelId(legacyModels.currentModelId);
    }
    const available = Array.isArray(legacyModels.availableModels)
      ? legacyModels.availableModels
      : [];
    for (const item of available) {
      if (!item || typeof item !== "object") continue;
      const rawId = item.modelId ?? item.id ?? item.value;
      if (typeof rawId !== "string") continue;
      const id = normalizeModelId(rawId);
      if (!id || byId.has(id)) continue;

      if (hasConfigOptionModels) {
        const lowerId = id.toLowerCase();
        let matchedBaseId = "";
        let matchedSuffix = "";
        for (const suffix of knownEffortSuffixes) {
          if (lowerId.endsWith(`-${suffix}`) && id.length > suffix.length + 1) {
            const candidateBase = id.slice(0, id.length - suffix.length - 1);
            if (byId.has(candidateBase)) {
              matchedBaseId = candidateBase;
              matchedSuffix = suffix;
              break;
            }
          }
        }
        if (matchedBaseId) {
          let set = matchedEffortsByBase.get(matchedBaseId);
          if (!set) {
            set = new Set();
            matchedEffortsByBase.set(matchedBaseId, set);
          }
          set.add(matchedSuffix);
          continue;
        }
      }

      byId.set(id, {
        id,
        name: typeof item.name === "string" && item.name ? item.name : id,
        description:
          typeof item.description === "string" && item.description
            ? item.description
            : "Antigravity ACP model",
        contextWindow:
          typeof item.contextWindow === "number" ? item.contextWindow : 1000000,
        maxOutputTokens:
          typeof item.maxOutputTokens === "number" ? item.maxOutputTokens : 65536,
        supportsImages: item.supportsImages !== false,
        efforts: [...effortValues],
      });
    }
  }

  for (const [baseId, matchedSet] of matchedEffortsByBase) {
    const model = byId.get(baseId);
    if (!model || matchedSet.size === 0) continue;
    const ordered = effortValues.filter((e) => matchedSet.has(String(e).toLowerCase()));
    const seenLower = new Set(ordered.map((e) => String(e).toLowerCase()));
    for (const extra of matchedSet) {
      if (!seenLower.has(extra)) {
        ordered.push(extra);
        seenLower.add(extra);
      }
    }
    if (ordered.length > 0) {
      model.efforts = ordered;
    }
  }

  return {
    modelConfigId,
    currentModelId,
    effortConfig,
    models: Array.from(byId.values()),
  };
}
