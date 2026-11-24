#!/usr/bin/env node
import fs from "node:fs";
import tty from "node:tty";
import { fileURLToPath } from "node:url";

export const AGENTS = Object.freeze([
  {
    id: "claude",
    name: "Claude Code",
    hint: "Anthropic bridge + /agi:connect & /model",
  },
  {
    id: "codex",
    name: "Codex",
    hint: "OpenAI Responses bridge + $agy-connect & /model",
  },
  {
    id: "opencode",
    name: "OpenCode V2",
    hint: "Native provider + /connect & /model",
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    hint: "Native Cordis LlmAdapter + /agy-connect",
  },
]);

const ALIASES = new Map([
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["claudecode", "claude"],
  ["codex", "codex"],
  ["openai-codex", "codex"],
  ["opencode", "opencode"],
  ["opencode-v2", "opencode"],
  ["dsh", "dsh"],
  ["deepseek", "dsh"],
  ["deepseek-harness", "dsh"],
  ["all", "all"],
]);

export function normalizeAgentId(raw) {
  if (typeof raw !== "string") return null;
  return ALIASES.get(raw.trim().toLowerCase()) || null;
}

export function parseAgentCsv(csv) {
  if (!csv || typeof csv !== "string") return [];
  const out = [];
  for (const part of csv.split(",")) {
    const id = normalizeAgentId(part);
    if (!id) continue;
    if (id === "all") {
      return AGENTS.map((a) => a.id);
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function createSelectorState({
  agents = AGENTS,
  detectedIds = [],
  action = "install",
} = {}) {
  const detectedSet = new Set(detectedIds);
  const initialSelected =
    detectedSet.size > 0
      ? agents.filter((a) => detectedSet.has(a.id)).map((a) => a.id)
      : agents.map((a) => a.id);

  return {
    agents,
    detected: detectedSet,
    action,
    cursor: 0,
    selected: new Set(initialSelected),
    error: "",
  };
}

export function applyKey(state, key) {
  const count = state.agents.length;
  if (key === "up" || key === "k") {
    return {
      state: {
        ...state,
        cursor: (state.cursor - 1 + count) % count,
        error: "",
      },
      done: false,
      cancelled: false,
    };
  }
  if (key === "down" || key === "j") {
    return {
      state: {
        ...state,
        cursor: (state.cursor + 1) % count,
        error: "",
      },
      done: false,
      cancelled: false,
    };
  }
  if (key === "space") {
    const current = state.agents[state.cursor];
    const nextSelected = new Set(state.selected);
    if (nextSelected.has(current.id)) {
      nextSelected.delete(current.id);
    } else {
      nextSelected.add(current.id);
    }
    return {
      state: { ...state, selected: nextSelected, error: "" },
      done: false,
      cancelled: false,
    };
  }
  if (key === "a") {
    const allSelected = state.agents.every((a) => state.selected.has(a.id));
    const nextSelected = allSelected
      ? new Set()
      : new Set(state.agents.map((a) => a.id));
    return {
      state: { ...state, selected: nextSelected, error: "" },
      done: false,
      cancelled: false,
    };
  }
  if (key === "enter") {
    if (state.selected.size === 0) {
      return {
        state: {
          ...state,
          error: "Select at least one agent (press Space to toggle, or q to cancel).",
        },
        done: false,
        cancelled: false,
      };
    }
    const ordered = state.agents
      .filter((a) => state.selected.has(a.id))
      .map((a) => a.id);
    return {
      state,
      done: true,
      cancelled: false,
      selected: ordered,
    };
  }
  if (key === "escape" || key === "q" || key === "ctrl-c") {
    return {
      state,
      done: true,
      cancelled: true,
      selected: [],
    };
  }
  return { state, done: false, cancelled: false };
}

export function decodeKeyChunk(chunk) {
  const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (s === "\x03") return "ctrl-c";
  if (s === "\r" || s === "\n") return "enter";
  if (s === " ") return "space";
  if (s === "\x1b[A" || s === "\x1bOA") return "up";
  if (s === "\x1b[B" || s === "\x1bOB") return "down";
  if (s === "\x1b") return "escape";
  const lower = s.toLowerCase();
  if (lower === "k" || lower === "j" || lower === "a" || lower === "q") {
    return lower;
  }
  return null;
}

export function renderSelectorFrame(state, { useColor = true } = {}) {
  const c = useColor
    ? {
        cyan: "\x1b[36m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        red: "\x1b[31m",
        dim: "\x1b[2m",
        bold: "\x1b[1m",
        reset: "\x1b[0m",
      }
    : { cyan: "", green: "", yellow: "", red: "", dim: "", bold: "", reset: "" };

  const verb = state.action === "uninstall" ? "uninstall AGI from" : "install AGI to";
  const lines = [
    `${c.cyan}◆${c.reset}  ${c.bold}Which agents would you like to ${verb}?${c.reset}`,
    `${c.dim}│  Official Google Antigravity ACP (agy acp) · ToS-compliant stdio protocol${c.reset}`,
  ];

  for (let i = 0; i < state.agents.length; i++) {
    const agent = state.agents[i];
    const isFocused = i === state.cursor;
    const isSelected = state.selected.has(agent.id);
    const isDetected = state.detected.has(agent.id);
    const pointer = isFocused ? `${c.cyan}❯${c.reset}` : " ";
    const box = isSelected ? `${c.green}◉${c.reset}` : `${c.dim}◯${c.reset}`;
    const label = isFocused
      ? `${c.bold}${agent.name}${c.reset}`
      : agent.name;
    const badge = isDetected
      ? ` ${c.green}(detected)${c.reset}`
      : ` ${c.dim}(not detected)${c.reset}`;
    const hint = `${c.dim}— ${agent.hint}${c.reset}`;
    lines.push(`${c.dim}│${c.reset}  ${pointer} ${box} ${label}${badge} ${hint}`);
  }

  if (state.error) {
    lines.push(`${c.dim}│${c.reset}  ${c.red}${state.error}${c.reset}`);
  }
  lines.push(
    `${c.dim}└  ↑/↓ move · space toggle · a toggle all · enter confirm · esc cancel${c.reset}`,
  );
  return lines;
}

function parseCliArgs(argv) {
  const args = {
    detected: [],
    action: "install",
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--detected" && argv[i + 1] !== undefined) {
      args.detected = parseAgentCsv(argv[++i]);
    } else if (token === "--action" && argv[i + 1]) {
      args.action = argv[++i];
    }
  }
  return args;
}

async function runInteractive(args) {
  let inStream = null;
  let outStream = null;
  let openedInFd = null;
  let openedOutFd = null;

  try {
    if (fs.existsSync("/dev/tty")) {
      openedInFd = fs.openSync("/dev/tty", "r");
      openedOutFd = fs.openSync("/dev/tty", "w");
      inStream = new tty.ReadStream(openedInFd);
      outStream = new tty.WriteStream(openedOutFd);
    } else if (process.stdin.isTTY && process.stderr.isTTY) {
      inStream = process.stdin;
      outStream = process.stderr;
    } else {
      const fallback = createSelectorState({
        detectedIds: args.detected,
        action: args.action,
      });
      process.stdout.write(`${Array.from(fallback.selected).join(",")}\n`);
      return 0;
    }

    let state = createSelectorState({
      detectedIds: args.detected,
      action: args.action,
    });
    let renderedLines = 0;

    const clearFrame = () => {
      if (renderedLines <= 0) return;
      outStream.write(`\x1b[${renderedLines}A`);
      for (let i = 0; i < renderedLines; i++) {
        outStream.write("\x1b[2K\x1b[1B");
      }
      outStream.write(`\x1b[${renderedLines}A`);
      renderedLines = 0;
    };

    const draw = () => {
      clearFrame();
      const lines = renderSelectorFrame(state, { useColor: true });
      outStream.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };

    outStream.write("\x1b[?25l");
    inStream.setRawMode(true);
    inStream.resume();
    draw();

    const result = await new Promise((resolve) => {
      const onData = (buf) => {
        const key = decodeKeyChunk(buf);
        if (!key) return;
        const step = applyKey(state, key);
        state = step.state;
        if (step.done) {
          inStream.off("data", onData);
          resolve(step);
          return;
        }
        draw();
      };
      inStream.on("data", onData);
    });

    clearFrame();
    if (result.cancelled) {
      outStream.write("\x1b[33m✖\x1b[0m  Selection cancelled.\n");
      return 130;
    }

    const chosenNames = AGENTS.filter((a) => result.selected.includes(a.id))
      .map((a) => a.name)
      .join(", ");
    outStream.write(`\x1b[32m✔\x1b[0m  Selected agents: \x1b[1m${chosenNames}\x1b[0m\n`);
    process.stdout.write(`${result.selected.join(",")}\n`);
    return 0;
  } finally {
    try {
      if (inStream && typeof inStream.setRawMode === "function") {
        inStream.setRawMode(false);
      }
      if (inStream) inStream.pause();
    } catch {
      // ignore
    }
    try {
      if (outStream) outStream.write("\x1b[?25h");
    } catch {
      // ignore
    }
    if (openedInFd !== null) {
      try {
        inStream?.destroy();
      } catch {
        // ignore
      }
    }
    if (openedOutFd !== null) {
      try {
        outStream?.destroy();
      } catch {
        // ignore
      }
    }
  }
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
  runInteractive(parseCliArgs(process.argv.slice(2)))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(`[select-agents] ${err.message}`);
      process.exit(1);
    });
}
