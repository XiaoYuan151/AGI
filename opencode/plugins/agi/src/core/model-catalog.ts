export interface AgyModelSpec {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  efforts: string[];
}

export interface AgyEffortOption {
  value: string;
  name: string;
  description: string;
}

export interface AgyEffortConfig {
  configId: string;
  currentValue?: string;
  options: AgyEffortOption[];
}

export interface AgyDiscoveryResult {
  models: AgyModelSpec[];
  source: "acp" | "fallback";
  authenticated: boolean | null;
  modelConfigId: string | null;
  currentModelId: string | null;
  effortConfig: AgyEffortConfig | null;
  agentInfo: Record<string, unknown> | null;
  authMethods: Array<Record<string, unknown>>;
  error?: string;
}

export const DEFAULT_FALLBACK_MODELS: readonly AgyModelSpec[] = Object.freeze([
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

export function normalizeModelId(rawId: unknown): string {
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

export function parseFallbackModels(rawValue: unknown): AgyModelSpec[] {
  if (Array.isArray(rawValue) && rawValue.length > 0) {
    const mapped = rawValue
      .map((item): AgyModelSpec | null => {
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
        if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
          const obj = item as Record<string, unknown>;
          const id = normalizeModelId(obj.id);
          if (!id) return null;
          return {
            id,
            name: typeof obj.name === "string" && obj.name ? obj.name : id,
            description:
              typeof obj.description === "string" ? obj.description : "Antigravity ACP model",
            contextWindow:
              typeof obj.contextWindow === "number" ? obj.contextWindow : 1000000,
            maxOutputTokens:
              typeof obj.maxOutputTokens === "number" ? obj.maxOutputTokens : 65536,
            supportsImages: obj.supportsImages !== false,
            efforts: Array.isArray(obj.efforts)
              ? obj.efforts.map(String)
              : ["low", "medium", "high"],
          };
        }
        return null;
      })
      .filter((x): x is AgyModelSpec => x !== null);
    if (mapped.length > 0) return mapped;
  }

  if (typeof rawValue === "string" && rawValue.trim()) {
    const trimmed = rawValue.trim();
    if (trimmed.startsWith("[")) {
      try {
        return parseFallbackModels(JSON.parse(trimmed));
      } catch {
        // fall through
      }
    }
    const parts = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
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
  }

  return DEFAULT_FALLBACK_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }));
}

function flattenSelectOptions(options: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(options)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of options) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (Array.isArray(obj.options)) {
      for (const nested of obj.options) {
        if (nested && typeof nested === "object" && (nested as { value?: unknown }).value != null) {
          out.push(nested as Record<string, unknown>);
        }
      }
    } else if (obj.value != null) {
      out.push(obj);
    }
  }
  return out;
}

export function extractEffortConfigFromSessionResult(
  result: Record<string, unknown> | null | undefined,
): AgyEffortConfig | null {
  const configOptions = Array.isArray(result?.configOptions)
    ? (result.configOptions as Array<Record<string, unknown>>)
    : [];
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
  const values: AgyEffortOption[] = flattenSelectOptions(opt.options).map((o) => ({
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

export function extractModelsFromSessionResult(
  result: Record<string, unknown> | null | undefined,
): {
  modelConfigId: string | null;
  currentModelId: string | null;
  effortConfig: AgyEffortConfig | null;
  models: AgyModelSpec[];
} {
  const byId = new Map<string, AgyModelSpec>();
  let modelConfigId: string | null = null;
  let currentModelId: string | null = null;

  const effortConfig = extractEffortConfigFromSessionResult(result);
  const effortValues = effortConfig
    ? effortConfig.options.map((o) => o.value)
    : ["low", "medium", "high"];

  const configOptions = Array.isArray(result?.configOptions)
    ? (result.configOptions as Array<Record<string, unknown>>)
    : [];
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
      const meta =
        item._meta && typeof item._meta === "object"
          ? (item._meta as Record<string, unknown>)
          : {};
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
  const matchedEffortsByBase = new Map<string, Set<string>>();

  const legacyModels = result?.models as Record<string, unknown> | undefined;
  if (legacyModels && typeof legacyModels === "object") {
    if (!currentModelId && typeof legacyModels.currentModelId === "string") {
      currentModelId = normalizeModelId(legacyModels.currentModelId);
    }
    const available = Array.isArray(legacyModels.availableModels)
      ? (legacyModels.availableModels as Array<Record<string, unknown>>)
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
            set = new Set<string>();
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
