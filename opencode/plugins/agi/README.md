# OpenCode sample plugin + Antigravity ACP (`agy acp`)

OpenCode V2 server plugin. No build step: OpenCode loads `src/index.ts` directly.

- `agy` native provider — registered via `ctx.provider.transform` + `ctx.aisdk.hook("sdk" | "language")` backed directly by `agy acp` over stdio (`LanguageModelV3`, no local HTTP daemon needed)
- `/model` integration — all discovered (or fallback) Antigravity models appear natively under `agy/<model-id>` (with reasoning effort variants)
- `/agy-models`, `/agy-status` slash commands and `agy_status`, `agy_refresh_models` tools
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
- `appDataDir` (string, optional `--app-data-dir` passed to `agy acp`)
- `authMethod` (string, optional e.g. `"oauth-personal"` or `"gemini-api-key"`)
- `autoApprove` (boolean, default `true`)
- `sandbox` (boolean, default `false`)
- `showToolActivity` (boolean, default `true`)
- `discoveryTimeoutMs` (number, default `2500`)
- `fallbackModels` (array or comma-separated string, used before live ACP discovery or when unauthenticated)

## Test

1. Make sure `agy` is authenticated (`agy acp --login` or `GEMINI_API_KEY`).
2. Run `opencode models` to verify `agy/*` models appear natively, or open OpenCode and switch models with `/model`.
3. Use `/agy-models` to refresh models from `agy acp`, `/agy-status` to inspect ACP status, or call `hello_greet` inside Code Mode:

```js
await tools.hello.greet({ name: "XiaoYuan" })
```

Edits to the file are picked up by the config watcher; use `/reload` to force a full plugin reload.
