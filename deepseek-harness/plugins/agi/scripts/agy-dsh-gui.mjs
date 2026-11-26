#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDshGuiServer } from "../src/gui-server.mjs";

export function parseGuiArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: Number(process.env.AGY_DSH_GUI_PORT || 0),
    open: true,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--host" && argv[i + 1]) args.host = argv[++i];
    else if (t === "--port" && argv[i + 1]) args.port = Number(argv[++i]);
    else if (t === "--no-open") args.open = false;
    else if (t === "--open") args.open = true;
    else if (t === "--json") args.json = true;
    else if (t === "-h" || t === "--help") args.help = true;
  }
  return args;
}

function openBrowserBestEffort(url) {
  try {
    if (process.platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.unref();
    } else if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
      child.unref();
    } else {
      const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      child.unref();
    }
  } catch {
    // ignore if headless
  }
}

async function main() {
  const args = parseGuiArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        "Usage: agy-dsh-gui [options]",
        "",
        "Starts the local DeepSeek Harness Antigravity ACP Account & Login Web GUI.",
        "",
        "Options:",
        "  --port <n>      Listen port (default: ephemeral free port)",
        "  --host <addr>   Loopback bind host (default: 127.0.0.1)",
        "  --no-open       Do not automatically open the default browser",
        "  --json          Print startup info as JSON",
      ].join("\n"),
    );
    return;
  }

  const gui = createDshGuiServer({ host: args.host, port: args.port });
  const info = await gui.start();
  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...info }));
  } else {
    console.log(`[agy-dsh-gui] Listening on ${info.url}`);
    console.log("[agy-dsh-gui] Press Ctrl+C to stop.");
  }

  if (args.open) {
    openBrowserBestEffort(info.url);
  }

  const shutdown = async () => {
    await gui.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
  main().catch((err) => {
    console.error(`[agy-dsh-gui] Error: ${err.message}`);
    process.exit(1);
  });
}
