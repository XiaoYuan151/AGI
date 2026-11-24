# Anti-Gravity Integration (AGI)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | **Español**

Anti-Gravity Integration (AGI) es un plugin para Claude Code, Codex, OpenCode, DeepSeek Harness, Neuro SDK y otros harnesses que lleva los modelos avanzados de Gemini a todos ellos.

Instala el plugin una vez, inicia sesión con el comando nativo de tu herramienta y elige un modelo Antigravity desde `/model`. Puedes alternar entre modelos de Antigravity y tus modelos habituales en medio de una conversación.

| Harness | Comando de conexión | IDs en `/model` | Carpeta del plugin |
| --- | --- | --- | --- |
| Claude Code | `/agi:connect` | `anthropic-agy/<model>` | [`claude-code/plugins/agi/`](claude-code/plugins/agi) |
| Codex | `$agy-connect` | `agy/<model>` | [`codex/plugins/agi/`](codex/plugins/agi) |
| OpenCode | `/connect` → **Antigravity (ACP)** | `agy/<model>` | [`opencode/plugins/agi/`](opencode/plugins/agi) |
| DeepSeek Harness | `/agy-connect` | `agy/<model>` | [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) |

---

## Instalación

Requisitos: **Node.js 18+** y el CLI oficial **Antigravity (`agy`)** en tu `PATH`.

### Instalación rápida

Ejecuta el instalador para abrir un selector interactivo (flechas o `j`/`k` para moverte, `Espacio` para marcar, `a` para seleccionar todo, `Enter` para confirmar) y elegir qué herramientas configurar:

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

O clona el repositorio y ejecútalo en local:

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

Opciones útiles (con `curl`, pásalas después de `bash -s --`):

```bash
./install.sh -a opencode,dsh              # instalar solo ciertos harnesses (claude | codex | opencode | dsh | all)
./install.sh --all --yes                  # instalar todos sin preguntar
./install.sh --claude --local-token       # Claude Code sin cuenta de Anthropic
./install.sh --codex --codex-mode default # añadir agy a tu config por defecto en lugar de usar `-p agy`
./install.sh --dsh --dsh-profile desktop  # apuntar a un perfil concreto de DeepSeek Harness
./install.sh --dry-run                    # ver qué cambiaría sin tocar archivos
./install.sh --uninstall                  # elegir qué desinstalar (añade --purge para borrar ~/.agi)
```

---

## Autenticación

AGI usa únicamente el CLI oficial `agy acp` y guarda su sesión por separado en `~/.agi/`.

Puedes iniciar sesión con cualquiera de las dos opciones:

- **Clave de API de Gemini (recomendado):** define `GEMINI_API_KEY` o introdúcela cuando el flujo de conexión te lo pida. Las cuentas Enterprise (`oauth-business` / `agent-platform`) también funcionan mediante `--method`.
- **Inicio de sesión interactivo con Google:** usa el comando de conexión de tu herramienta o ejecuta `agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login`.

Si aún no has iniciado sesión, `/model` mostrará una lista base de Gemini. Al autenticarte y actualizar, aparecerá el catálogo completo de tu cuenta.

---

## Uso por herramienta

### Claude Code

Si usaste `./install.sh`, el plugin y el puente local ya quedan configurados. Para hacerlo manualmente:

```bash
claude --plugin-dir ./claude-code/plugins/agi
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

Reinicia `claude`, ejecuta `/agi:connect` para iniciar sesión o revisar el estado y abre `/model` para elegir `anthropic-agy/...`. Tus claves de Anthropic y modelos `claude-*` siguen funcionando con normalidad.

Para actualizar la lista de modelos usa `/agi:agy-models`, y para revertir los cambios ejecuta `./claude-code/plugins/agi/bin/agy-claude-setup --scope user --remove`.

> ¿Sin cuenta de Anthropic? Añade `--auth-mode local-token` a `agy-claude-setup` (o `--local-token` a `install.sh`).

### Codex

Configuración manual:

```bash
cd codex
codex plugin marketplace add .
codex plugin add agi@local-repo
node ./plugins/agi/scripts/setup-codex.mjs --start-bridge
```

Inicia Codex con el perfil `agy` (`codex -p agy`), ejecuta `$agy-connect` para iniciar sesión o refrescar modelos y cambia entre `agy/*` y modelos OpenAI desde `/model`. Usa `--mode default` en `setup-codex.mjs` si prefieres no escribir `-p agy` cada vez.

### OpenCode

Copia `opencode/plugins/agi` a `.opencode/plugins/agi/` en tu proyecto o añádelo en `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode/plugins/agi",
      "options": {
        "providerId": "agy",
        "providerName": "Antigravity (ACP)"
      }
    }
  ]
}
```

Dentro de OpenCode, ejecuta `/connect`, selecciona **Antigravity (ACP)** e inicia sesión con `agy acp --login` o `GEMINI_API_KEY`. Los modelos aparecerán en `/model` y `opencode models`. También tienes `/agy-connect` (`status` | `refresh` | `logout`) y `/agy-models`.

### DeepSeek Harness

Para enlazarlo manualmente:

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

Reinicia DeepSeek Harness, usa `/agy-connect` para revisar el estado o iniciar sesión (por ejemplo, `/agy-connect method gemini-api-key` o `node ./deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs`) y elige `agy/<model>` en el selector. También incluye `/agy-models` y `/agy-status`.

---

## Variables de entorno

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `AGY_BIN` | `agy` | Ruta al binario `agy` |
| `GEMINI_API_KEY` | — | Clave de API de Gemini opcional |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` | Carpeta separada para ACP |
| `AGY_CLAUDE_PORT` | `43110` | Puerto del puente local de Claude Code |
| `AGY_CODEX_PORT` | `43111` | Puerto del puente local de Codex |
| `DSH_HOME` | `~/.dsh` | Directorio de DeepSeek Harness |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
