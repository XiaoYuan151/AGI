import { claudeInstaller } from "./claude-installer.mjs";
import { codexInstaller } from "./codex-installer.mjs";
import { opencodeInstaller } from "./opencode-installer.mjs";
import { dshInstaller } from "./dsh-installer.mjs";

/**
 * Open/Closed registry of harness installers (OCP + LSP).
 */
export class HarnessRegistry {
  constructor(installers = []) {
    this._byId = new Map();
    for (const installer of installers) {
      this.register(installer);
    }
  }

  register(installer) {
    if (!installer?.id) {
      throw new Error("Harness installer must have an 'id'.");
    }
    this._byId.set(installer.id, installer);
  }

  get(id) {
    return this._byId.get(id) || null;
  }

  ids() {
    return Array.from(this._byId.keys());
  }

  list() {
    return Array.from(this._byId.values());
  }

  detect(env = process.env) {
    return this.list()
      .filter((inst) => inst.detect(env))
      .map((inst) => inst.id);
  }
}

export const DEFAULT_HARNESS_REGISTRY = new HarnessRegistry([
  claudeInstaller,
  codexInstaller,
  opencodeInstaller,
  dshInstaller,
]);
