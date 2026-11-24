# Anti-Gravity Integration (AGI)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | **Español**

**Anti-Gravity Integration (AGI)** es un plugin para **Claude Code**, **Codex**, **OpenCode**, **DeepSeek Harness**, **Neuro SDK** y otros harnesses que integra los modelos avanzados de Gemini mediante el protocolo oficial stdio `agy acp` de Google.

Cada carpeta de este repositorio es un plugin `agi` independiente adaptado a su harness. Una vez instalado, puedes iniciar sesión con el comando nativo de conexión de cada herramienta, abrir **`/model`**, elegir un modelo Antigravity (o volver a tus modelos nativos a mitad de conversación) y seguir trabajando sin salir de tu terminal. Cada plugin es autocontenido: cero pasos de compilación y cero dependencias npm de terceros en tiempo de ejecución.

| Plugin | Harness | Cómo se conecta a `agy acp` | Inicio de sesión nativo | IDs en `/model` |
| --- | --- | --- | --- | --- |
| [`claude-code/plugins/agi/`](claude-code/plugins/agi) | Claude Code | Puente local compatible con Anthropic (`127.0.0.1:43110`) + herramientas MCP + hook `SessionStart` | `/agi:connect` (`agy-claude-connect`) | `anthropic-agy/<model>` |
| [`codex/plugins/agi/`](codex/plugins/agi) | Codex | Puente local OpenAI Responses API (`127.0.0.1:43111`) + herramientas MCP + catálogo de modelos | `$agy-connect` (`agy-codex-connect.mjs`) | `agy/<model>` |
| [`opencode/plugins/agi/`](opencode/plugins/agi) | OpenCode V2 | Proveedor nativo en proceso `LanguageModelV3` + Integration API (sin demonio HTTP) | Nativo `/connect` → **Antigravity (ACP)** (`/agy-connect`) | `agy/<model>` |
| [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) | DeepSeek Harness (`dsh`) | Paquete nativo en proceso Cordis `LlmAdapter` (sin demonio HTTP) | `/agy-connect` (`agy-dsh-connect.mjs`) | `agy/<model>` |

---

## Instalación rápida (`curl | bash` o `./install.sh`)

Ejecuta el instalador para abrir un **selector interactivo estilo `npx skills`** (`↑/↓` mover, `Espacio` alternar, `a` seleccionar todos, `Enter` confirmar) y elegir en qué agentes instalar o desinstalar:

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

O selecciona agentes directamente mediante flags:

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- -a opencode,dsh
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --all --yes
./install.sh --uninstall --all --purge
```

---

## Cumplimiento oficial de Google y Términos de Servicio (modelo T3 Code)

- **Solo subproceso oficial sin modificar `agy acp`:** Toda la comunicación utiliza el servidor oficial `agy acp` stdio JSON-RPC 2.0, `agy acp [--gemini-dir ...] [--app-data-dir ...] --login` y los RPC oficiales `authenticate` / `logout`. Nunca extrae tokens OAuth ni modifica cabeceras User-Agent.
- **Autenticación recomendada para harnesses externos/automatizados:** Usa **`GEMINI_API_KEY` (`gemini-api-key`)** o **Gemini Enterprise (`oauth-business` / `agent-platform`)**.
- **Perfil ACP aislado (`--gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp`):** Evita colisiones con tu `agy` CLI o Antigravity IDE, con protección contra bucles de reintentos (`403` / `429` / `-32000`).

---

## Comandos de conexión por harness

- **Claude Code:** `/agi:connect` (o `./claude-code/plugins/agi/bin/agy-claude-connect`)
- **Codex:** `$agy-connect` (o `node ./codex/plugins/agi/scripts/agy-codex-connect.mjs`)
- **OpenCode V2:** `/connect` nativo → **Antigravity (ACP)** (y `/agy-connect`)
- **DeepSeek Harness (`dsh`):** `/agy-connect`, `/agy-models` y `/agy-status` (configuración con `node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs`)

---

## Ejecutar las pruebas

```bash
node --test tests/acp-client.test.mjs tests/claude-bridge.test.mjs tests/codex-bridge.test.mjs tests/dsh-plugin.test.mjs tests/install.test.mjs
bun test tests/opencode-plugin.test.mjs
```

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
