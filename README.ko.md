# Anti-Gravity Integration (AGI)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | **한국어** | [Español](README.es.md)

**Anti-Gravity Integration (AGI)** 는 Google 공식 `agy acp` stdio 프로토콜을 사용하여 **Claude Code**, **Codex**, **OpenCode**, **DeepSeek Harness**, **Neuro SDK** 및 기타 하네스에 최신 Gemini 모델을 통합하는 플러그인 모음입니다.

이 저장소의 각 폴더는 해당 에이전트 하네스에 맞춘 독립형 `agi` 플러그인입니다. 설치 후 각 하네스의 기본 연결 명령으로 로그인하고 **`/model`**을 열어 Antigravity 모델을 선택하거나 대화 도중 기본 모델로 전환하며 터미널을 벗어나지 않고 작업할 수 있습니다. 모든 플러그인은 빌드 단계와 서드파티 npm 런타임 의존성이 없는 자체 완결형 구조입니다.

| 플러그인 | 하네스 | `agy acp` 연결 방식 | 기본 로그인 명령 | `/model` 모델 ID |
| --- | --- | --- | --- | --- |
| [`claude-code/plugins/agi/`](claude-code/plugins/agi) | Claude Code | 로컬 Anthropic 호환 브리지 (`127.0.0.1:43110`) + MCP 도구 + `SessionStart` 훅 | `/agi:connect` (`agy-claude-connect`) | `anthropic-agy/<model>` |
| [`codex/plugins/agi/`](codex/plugins/agi) | Codex | 로컬 OpenAI Responses API 브리지 (`127.0.0.1:43111`) + MCP 도구 + 모델 카탈로그 | `$agy-connect` (`agy-codex-connect.mjs`) | `agy/<model>` |
| [`opencode/plugins/agi/`](opencode/plugins/agi) | OpenCode V2 | 네이티브 인프로세스 `LanguageModelV3` 프로바이더 + Integration API (데몬 불필요) | 기본 `/connect` → **Antigravity (ACP)** (`/agy-connect`) | `agy/<model>` |
| [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) | DeepSeek Harness (`dsh`) | 네이티브 인프로세스 Cordis `LlmAdapter` 번들 (데몬 불필요) | `/agy-connect` (`agy-dsh-connect.mjs`) | `agy/<model>` |

---

## 동작 원리

내부적으로 각 플러그인은 Google의 공식 무수정 **`agy acp`** (stdio JSON-RPC 2.0 기반 Antigravity Agent Client Protocol 서버)를 실행하고, 계정에서 사용 가능한 모델과 추론 강도(effort)를 탐색하며, 턴 간 대화별 ACP 세션을 유지합니다.

- **OpenCode V2**는 `@opencode/plugin`을 통해 커스텀 프로바이더와 `/connect` 통합(`ctx.provider.transform`, `ctx.integration.transform`, `ctx.aisdk.hook`)을 직접 지원하므로 `agi`가 완전히 인프로세스로 동작합니다.
- **DeepSeek Harness (`dsh`)** 는 커스텀 Cordis `LlmAdapter` 번들(`ctx.llm.registerAdapter` + `ctx.commands.register`)을 지원하므로 `@local/dsh-agi` 역시 실시간 스트리밍 및 `/agy-connect`, `/agy-models`, `/agy-status` 명령과 함께 완전히 인프로세스로 동작합니다.
- **Claude Code**와 **Codex**는 HTTP 모델 엔드포인트(각각 Anthropic Messages API, OpenAI Responses API)를 사용하므로, 해당 `agi` 플러그인에는 요청을 `agy acp`로 변환하고 네이티브 `claude-*` 또는 `gpt-*` 요청을 Anthropic/OpenAI로 투명하게 전달하는 경량 로컬호스트 브리지가 포함되어 있습니다.

---

## 빠른 설치 (`curl | bash` 또는 `./install.sh`)

### 대화형 에이전트 선택기를 이용한 원라인 설치 (수동 클론 불필요)

설치 스크립트를 실행하면 **`npx skills` 스타일의 다중 선택 피커**(`↑/↓` 이동, `Space` 토글, `a` 전체 선택/해제, `Enter` 확인)가 실행되어 설치할 하네스(**Claude Code**, **Codex**, **OpenCode V2**, **DeepSeek Harness**)를 고를 수 있습니다. 저장소는 `~/.agi/repo`에 클론되며 T3 Code의 안전한 격리 ACP 프로필 모델로 구성됩니다.

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

비대화형 또는 대상 지정 설치 시 `bash -s --`로 플래그를 전달합니다:

```bash
# 특정 에이전트 직접 지정 (`npx skills -a ...`와 동일)
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- -a opencode,dsh

# 4개 하네스 모두 비대화형 설치
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --all --yes

# Anthropic 계정 없이 Claude Code 설정 (게이트웨이 /v1/models 탐색 활성화)
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --claude --local-token

# 파일 변경 없이 미리보기 또는 깔끔하게 제거
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --dry-run
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --uninstall --purge
```

### 로컬 클론에서 설치

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

### Google 공식 프로토콜 및 서비스 약관(ToS) 준수 (T3 Code 모델)

- **공식 무수정 `agy acp` 서브프로세스만 사용:** 모든 통신은 Google 공식 `agy acp` stdio JSON-RPC 2.0 서버, 공식 `agy acp [--gemini-dir ...] [--app-data-dir ...] --login`, 공식 ACP `authenticate` / `logout` RPC만 사용합니다. `~/.gemini`, 키체인, Antigravity IDE에서 OAuth 토큰을 추출하거나 `cloudcode-pa` HTTP 엔드포인트를 직접 프록시/스푸핑하지 않으며 User-Agent 헤더를 변조하지 않습니다.
- **서드파티 / 자동화 하네스 권장 인증 방식:** Google 서비스 약관(ToS)을 준수하기 위해 개인 소비자용 OAuth 대신 **Gemini API 키 (`GEMINI_API_KEY` → `gemini-api-key`)** 또는 **Gemini Enterprise (`oauth-business` / `agent-platform`)** 사용을 권장합니다.
- **격리된 ACP 프로필 (`--gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp`):** T3 Code의 `antigravity-acp` 격리 방식에 맞춰 ACP 세션 및 자격 증명이 일반 `agy` CLI나 Antigravity 데스크톱 IDE와 충돌하지 않도록 보호합니다. 설정은 `~/.agi/acp.json`에 저장되어 4개 플러그인이 공유합니다.
- **재시도 폭주 방지:** 인증 오류(`-32000`) 및 정책/할당량 오류(`403` / `429` / `PERMISSION_DENIED`) 발생 시 즉시 로컬 쿨다운이 작동하여 `session/new` 반복 호출을 차단합니다.

주요 설치 옵션:

```bash
./install.sh                               # 대화형 다중 선택 에이전트 피커 (TTY)
./install.sh -a claude,opencode            # 대상 선택 설치: claude | codex | opencode | dsh | all
./install.sh --all --yes                   # 4개 플러그인 모두 비대화형 설치
./install.sh --dsh --dsh-profile desktop   # 특정 DeepSeek Harness 프로필에 설치
./install.sh --claude --local-token        # Anthropic 계정 없이 Claude Code 설정
./install.sh --codex --codex-mode default  # ~/.codex/config.toml에 직접 병합
./install.sh --dry-run                     # 파일 수정 없이 동작 미리보기
./install.sh --uninstall                   # 제거할 에이전트 대화형 선택 (또는 -a / --all)
./install.sh --uninstall --all --purge     # 4개 모두 제거 및 ~/.agi 격리 상태 삭제
```

---

## 1. 사전 요구사항

1. **Node.js** (18 이상)
2. **Antigravity CLI (`agy`)** (`PATH`에 설치되거나 `AGY_BIN=/path/to/agy` 설정)
3. **`agy` 인증 설정** (각 하네스의 기본 연결 명령 또는 CLI):
   - **권장 (서드파티/자동화 하네스용 Google ToS 친화적 방식): Gemini API 키 또는 Gemini Enterprise:**
     ```bash
     export GEMINI_API_KEY="your-api-key"
     ```
     또는 OpenCode 기본 `/connect` → **Antigravity (ACP)**에서 **Gemini API Key**를 선택하거나 `--method gemini-api-key` / `--method oauth-business` / `--method agent-platform`을 사용하세요.
   - **대화형 Google 로그인 (공식 `agy acp --login`):**
     ```bash
     agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login
     ```
     또는 각 하네스 명령(OpenCode `/connect`, Claude Code `/agi:connect`, Codex `$agy-connect`, DeepSeek Harness `/agy-connect`)을 실행하세요.

> **참고:** 아직 로그인하지 않은 상태에서도 각 플러그인은 기본 Gemini 폴백 목록으로 오류 없이 시작됩니다. 인증 후 새로고침(또는 재시작)하면 실시간 Antigravity 모델 목록이 반영됩니다.

---

## 2. Claude Code 설정

```bash
claude plugin validate ./claude-code/plugins/agi
claude --plugin-dir ./claude-code/plugins/agi
```

세션이 시작되면 `SessionStart` 훅이 `http://127.0.0.1:43110`에서 로컬 브리지(`agy-claude-bridge`)를 자동으로 실행합니다. `/model` 등록을 위해 다음을 실행하세요:

```bash
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

- `claude` 재시작 후 **`/agi:connect`**(또는 `./claude-code/plugins/agi/bin/agy-claude-connect`)로 ACP 인증 상태 확인, 공식 `agy acp ... --login` / `GEMINI_API_KEY` 로그인, 모델 새로고침 또는 공식 ACP `logout`을 수행할 수 있습니다.
- **`/model`**에서 `AGY · ...` (`anthropic-agy/<model-id>`) 모델을 선택하거나 `/agi:agy-models`로 모델을 새로고침하세요. 제거하려면 `--remove` 옵션을 사용하세요.

---

## 3. Codex 설정

```bash
cd codex
codex plugin marketplace add .
codex plugin add agi@local-repo
node ./plugins/agi/scripts/setup-codex.mjs --start-bridge
codex -p agy
```

Codex 내에서 **`$agy-connect`**(또는 `node ./codex/plugins/agi/scripts/agy-codex-connect.mjs`)로 로그인·새로고침·로그아웃을 수행하고 **`/model`**에서 `agy/*` 모델과 기본 Codex 모델을 전환할 수 있습니다.

---

## 4. OpenCode V2 설정

OpenCode는 TypeScript 플러그인을 직접 로드하므로 별도의 브리지 프로세스나 포트가 필요하지 않습니다. `opencode/plugins/agi`를 `.opencode/plugins/agi/`에 링크/복사하거나 `opencode.jsonc`에 추가하세요.

- OpenCode 기본 **`/connect`** → **Antigravity (ACP)**에서 공식 `agy acp ... --login`, **Gemini API Key**(ToS 준수 권장), 또는 `GEMINI_API_KEY` 환경 변수로 인증할 수 있으며 `credential.updated` 이벤트가 자동으로 `/model`을 갱신합니다.
- **`/agy-connect`** (`status` | `refresh` | `logout`), **`/agy-models`**, **`/agy-status`** 및 **`/model`**을 사용할 수 있습니다.

---

## 5. DeepSeek Harness (`dsh`) 설정

DeepSeek Harness는 Cordis 번들을 직접 로드하므로 HTTP 데몬이 필요하지 않습니다.

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

1. DeepSeek Harness를 재시작하여 `@local/dsh-agi` 번들을 로드합니다.
2. **`/agy-connect`**(또는 `node ./deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs`)로 상태 확인, 공식 로그인, `/agy-connect method gemini-api-key`, 또는 `/agy-connect logout`을 실행합니다.
3. 모델 선택기에서 **`agy/<model-id>`**를 선택하고 **`/agy-models`**, **`/agy-status`**를 활용하세요.

---

## 테스트 실행

```bash
node --test tests/acp-client.test.mjs tests/claude-bridge.test.mjs tests/codex-bridge.test.mjs tests/dsh-plugin.test.mjs tests/install.test.mjs
bun test tests/opencode-plugin.test.mjs
```

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
