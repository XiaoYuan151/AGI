import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(__dirname, "..");

const pkgMeta = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
);
export const VERSION = pkgMeta.version || "0.3.0";

export {
  AgyAcpClient,
  AgyAuthRequiredError,
  AgyPolicyCooldownError,
  CooldownPolicy,
  DEFAULT_FALLBACK_MODELS,
  FileAccountStore,
  FileModelsCache,
  InteractiveLoginManager,
  JsonRpcStdioTransport,
  buildLoginCommandArgs,
  clearAccountApiKey,
  clearCachedDiscoveryEntry,
  expandHomePath,
  extractAuthUrlFromOutput,
  extractEffortConfigFromSessionResult,
  extractModelsFromSessionResult,
  listPersistedAccounts,
  normalizeAuthMethodId,
  normalizeModelId,
  normalizePersistedAcpConfig,
  parseFallbackModels,
  readAccountApiKey,
  readCachedDiscovery,
  readPersistedAcpConfig,
  removePersistedAccount,
  resolveAccountProfile,
  resolveAcpConfigPath,
  resolveAgiHome,
  resolveDefaultAccountDataDir,
  runAgyInteractiveLogin,
  setActivePersistedAccount,
  upsertPersistedAccount,
  validateAccountName,
  writeAccountApiKey,
  writeCachedDiscovery,
  writePersistedAcpConfig,
} from "./core/index.mjs";

export { AccountService, BridgeNotifier } from "./services/account-service.mjs";
export { DEFAULT_HARNESS_REGISTRY, HarnessRegistry } from "./installers/registry.mjs";

export {
  accountStatus,
  addAccount,
  listAccounts,
  loginAccount,
  logoutAccount,
  notifyBridgesAccountSwitch,
  notifyBridgesRefresh,
  removeAccount,
  runAccountCli,
  syncClaudeSettingsAccountDir,
  useAccount,
} from "../scripts/accounts.mjs";

export {
  ALL_AGENT_IDS,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  detectInstalledAgents,
  getAgiStatus,
  installHarnesses,
  isEphemeralPackagePath,
  materializeRuntimePackage,
  readInstallState,
  stopBridges,
  uninstallAgi,
  updateAgi,
  writeInstallState,
} from "./installer.mjs";

export {
  DEFAULT_CLAUDE_BRIDGE_HOST,
  DEFAULT_CLAUDE_BRIDGE_PORT,
  createClaudeBridgeServer,
  ensureClaudeBridgeRunning,
} from "../claude-code/plugins/agi/scripts/agy-claude-bridge.mjs";
export { configureClaudeSettings } from "../claude-code/plugins/agi/scripts/setup-claude.mjs";
export { runClaudeConnect } from "../claude-code/plugins/agi/scripts/agy-claude-connect.mjs";

export {
  DEFAULT_CODEX_BRIDGE_HOST,
  DEFAULT_CODEX_BRIDGE_PORT,
  createCodexBridgeServer,
  ensureCodexBridgeRunning,
} from "../codex/plugins/agi/scripts/agy-codex-bridge.mjs";
export { configureCodex } from "../codex/plugins/agi/scripts/setup-codex.mjs";
export { runCodexConnect } from "../codex/plugins/agi/scripts/agy-codex-connect.mjs";

export {
  configureDsh,
  configureDshProfile,
  listDshProfiles,
} from "../deepseek-harness/plugins/agi/scripts/setup-dsh.mjs";
export { runDshConnect } from "../deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs";
export { AgyDshGuiService } from "../deepseek-harness/plugins/agi/src/gui-service.mjs";
export { createDshGuiServer } from "../deepseek-harness/plugins/agi/src/gui-server.mjs";
