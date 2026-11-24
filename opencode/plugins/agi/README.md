# OpenCode sample plugin + Antigravity ACP (`agy acp`)

OpenCode V2 server plugin. No build step: OpenCode loads `src/index.ts` directly.

- `agy` native provider — registered via `ctx.provider.transform` + `ctx.aisdk.hook("sdk" | "language")` backed directly by `agy acp` over stdio (`LanguageModelV3`, no local HTTP daemon needed)
- Native `/connect` integration — registered via `ctx.integration.transform` with official `agy acp --login` (`type: "command"`), `GEMINI_API_KEY` (`type: "key"`), and `GEMINI_API_KEY` env (`type: "env"`), automatically refreshing models when credentials update
- `/model` integration — all discovered (or fallback) Antigravity models appear natively under `agy/<model-id>` (with reasoning effort variants)
- `/agy-connect`, `/agy-models`, `/agy-status` slash commands and `agy_connect`, `agy_status`, `agy_refresh_models` tools
- Preserves the original `hello_greet` tool and `context` hook

## Load

Either copy this folder to `.opencode/plugins/agi/` in a project (it is
auto-discovered), or point at it explicitly in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode/plugins/agi",
      "options": {
        "greeting": "Hey",
        "providerId": "agy",
        "providerName": "Antigravity (ACP)",
        "autoApprove": true
      }
    }
  ]
}
```

### Supported options

- `greeting` (string, default `"Hello"`)
- `providerId` (string, default `"agy"`)
- `providerName` (string, default `"Antigravity (ACP)"`)
- `agyBin` (string, default `"agy"`)
- `geminiDir` (string, optional `--gemini-dir` passed to `agy acp`; defaults to `AGY_GEMINI_DIR` or `~/.agi/acp.json`)
- `appDataDir` (string, optional `--app-data-dir` passed to `agy acp`, e.g. `"antigravity-acp"`)
- `authMethod` (string, optional e.g. `"oauth-personal"` or `"gemini-api-key"`)
- `autoApprove` (boolean, default `true`)
- `sandbox` (boolean, default `false`)
- `showToolActivity` (boolean, default `true`)
- `discoveryTimeoutMs` (number, default `2500`)
- `fallbackModels` (array or comma-separated string, used before live ACP discovery or when unauthenticated)

## Test

1. Inside OpenCode, run `/connect`, pick **Antigravity (ACP)**, and authenticate using official `agy acp --login` or a `GEMINI_API_KEY` (recommended for Google ToS compliance in third-party harnesses).
2. Run `opencode models` to verify `agy/*` models appear natively, or open OpenCode and switch models with `/model`.
3. Use `/agy-connect` (or `/agy-connect refresh`, `/agy-connect logout`), `/agy-models`, `/agy-status`, or call `hello_greet` inside Code Mode:

```js
await tools.hello.greet({ name: "XiaoYuan" })
```

Edits to the file are picked up by the config watcher; use `/reload` to force a full plugin reload.
