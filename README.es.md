# Anti-Gravity Integration (AGI)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | **Español**

Anti-Gravity Integration (AGI) es un plugin para Claude Code, Codex, OpenCode, DeepSeek Harness, Neuro SDK y otros harnesses que lleva los modelos avanzados de Gemini a todos ellos.

Instala el plugin una vez, inicia sesión con el comando nativo de tu herramienta y elige un modelo Antigravity desde `/model`. Puedes alternar entre modelos de Antigravity y tus modelos habituales en medio de una conversación, actualizar todo con un solo comando y gestionar múltiples cuentas en carpetas de datos separadas.

| Harness | Comando de conexión | IDs en `/model` | Carpeta del plugin |
| --- | --- | --- | --- |
| Claude Code | `/agi:connect` | `anthropic-agy/<model>` | [`claude-code/plugins/agi/`](claude-code/plugins/agi) |
| Codex | `$agy-connect` | `agy/<model>` | [`codex/plugins/agi/`](codex/plugins/agi) |
| OpenCode | `/connect` → **Antigravity (ACP)** | `agy/<model>` | [`opencode/plugins/agi/`](opencode/plugins/agi) |
| DeepSeek Harness | `/agy-connect` | `agy/<model>` | [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) |

---

## Instalación y actualización

Requisitos: **Node.js 18+** y el CLI oficial **Antigravity (`agy`)** en tu `PATH`.

### Instalación rápida

**Vía npx / GitHub (sin instalación global):**

```bash
npx xiaoyuan151/agi install
```

O instala globalmente con npm:

```bash
npm install -g @xiaoyuan151/agi
agi install
# o ejecuta directamente desde npm:
npx @xiaoyuan151/agi install
```

**Vía script de shell:**

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

O clona el repositorio y ejecútalo en local:

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

El instalador abre un selector interactivo (flechas o `j`/`k` para moverte, `Espacio` para marcar, `a` para seleccionar todo, `Enter` para confirmar) para elegir qué herramientas configurar.

Opciones útiles (con `curl`, pásalas después de `bash -s --`):

```bash
agi install -a opencode,dsh              # instalar solo ciertos harnesses (claude | codex | opencode | dsh | all)
agi install --all --yes                  # instalar todos sin preguntar
agi install --claude --local-token       # Claude Code sin cuenta de Anthropic
agi install --codex --codex-mode default # añadir agy a tu config por defecto en lugar de `-p agy`
agi install --dsh --dsh-profile desktop  # apuntar a un perfil concreto de DeepSeek Harness
agi install --dry-run                    # ver qué cambiaría sin tocar archivos
agi uninstall --purge                    # desinstalar plugins y borrar ~/.agi
```

(Todas las opciones anteriores también funcionan con `./install.sh`.)

### Actualización

Actualiza el repositorio o paquete npm, refresca los plugins/configuraciones instalados y reinicia los puentes conservando tus herramientas elegidas, opciones y todas tus cuentas:

```bash
agi update                  # actualiza plugins y config (añade --self para actualizar el paquete global)
agi update --check          # comprueba si hay actualizaciones disponibles
./install.sh --update       # actualiza desde git/remoto y refresca los harnesses configurados
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --update
```

---

## Autenticación y múltiples cuentas

AGI usa únicamente el CLI oficial `agy acp` y guarda el estado de cada cuenta en su propia carpeta de datos aislada (`--gemini-dir`), registrada en `~/.agi/acp.json`.

Puedes iniciar sesión con cualquiera de las dos opciones:

- **Clave de API de Gemini (recomendado):** define `GEMINI_API_KEY` o introdúcela cuando el flujo de conexión te lo pida. Las cuentas Enterprise (`oauth-business` / `agent-platform`) también funcionan mediante `--method`.
- **Inicio de sesión interactivo con Google:** usa el comando de conexión de tu herramienta o ejecuta `agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login`.

Si aún no has iniciado sesión, `/model` mostrará una lista base de Gemini. Al autenticarte y actualizar, aparecerá el catálogo completo de tu cuenta.

### Gestión de múltiples cuentas (carpetas separadas)

Añade cuentas independientes en carpetas de datos separadas (por defecto `~/.agi/accounts/<name>`, o especifica cualquier ruta con `--data-dir`):

```bash
agi account add work --data-dir ~/agy-accounts/work --login
agi account add personal --login
agi account list --probe
agi account use work        # cambia la cuenta activa y actualiza los puentes en ejecución
agi account remove work --purge
```

También funciona con `./install.sh account ...` (o `--add-account`, `--list-accounts`, `--use-account`, `--remove-account`). Dentro de cada herramienta puedes gestionarlas con:

- **Claude Code / Codex**: herramienta MCP `agy_accounts` (`list` | `add` | `switch` | `remove`)
- **OpenCode / DeepSeek Harness**: comando `/agy-accounts` (`list` | `add <name> --data-dir <dir>` | `use <name>` | `remove <name>`)

---

## Uso por herramienta

### Claude Code

Si usaste `agi install` o `./install.sh`, el plugin y el puente local ya quedan configurados. Para hacerlo manualmente:

```bash
claude --plugin-dir ./claude-code/plugins/agi
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

Reinicia `claude`, ejecuta `/agi:connect` para iniciar sesión o revisar el estado y abre `/model` para elegir `anthropic-agy/...`. Tus claves de Anthropic y modelos `claude-*` siguen funcionando con normalidad.

Para actualizar la lista de modelos usa `/agi:agy-models`, y para revertir los cambios ejecuta `agy-claude-setup --scope user --remove`.

> ¿Sin cuenta de Anthropic? Añade `--auth-mode local-token` a `agy-claude-setup` (o `--local-token` a `agi install` / `install.sh`).

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

Dentro de OpenCode, ejecuta `/connect`, selecciona **Antigravity (ACP)** e inicia sesión con `agy acp --login` o `GEMINI_API_KEY`. Los modelos aparecerán en `/model` y `opencode models`. También tienes `/agy-connect` (`status` | `refresh` | `logout`), `/agy-models` y `/agy-accounts`.

### DeepSeek Harness

Para enlazarlo manualmente:

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

Reinicia DeepSeek Harness, usa `/agy-connect` para revisar el estado o iniciar sesión (por ejemplo, `/agy-connect method gemini-api-key` o `agy-dsh-connect`) y elige `agy/<model>` en el selector. También incluye `/agy-models`, `/agy-status` y `/agy-accounts`.

---

## Variables de entorno

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `AGI_HOME` | `~/.agi` | Directorio de estado compartido (`acp.json`, `install.json`, `accounts/`) |
| `AGY_ACCOUNT` | cuenta activa en `acp.json` | Nombre del perfil de cuenta activo |
| `AGY_BIN` | `agy` | Ruta al binario `agy` |
| `GEMINI_API_KEY` | — | Clave de API de Gemini opcional |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` | Carpeta separada para ACP |
| `AGY_CLAUDE_PORT` | `43110` | Puerto del puente local de Claude Code |
| `AGY_CODEX_PORT` | `43111` | Puerto del puente local de Codex |
| `DSH_HOME` | `~/.dsh` | Directorio de DeepSeek Harness |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
