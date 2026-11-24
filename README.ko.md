# Anti-Gravity Integration (AGI)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | **한국어** | [Español](README.es.md)

Anti-Gravity Integration (AGI)은 Claude Code, Codex, OpenCode, DeepSeek Harness, Neuro SDK 등 다양한 하네스에 최신 Gemini 모델을 통합해 주는 플러그인입니다.

한 번 설치한 뒤 각 도구의 기본 연결 명령으로 로그인하면 `/model`에서 Antigravity 모델을 바로 선택할 수 있으며, 대화 도중에도 기존 모델로 자유롭게 전환할 수 있습니다.

| 하네스 | 연결 명령 | `/model` 모델 ID | 플러그인 경로 |
| --- | --- | --- | --- |
| Claude Code | `/agi:connect` | `anthropic-agy/<model>` | [`claude-code/plugins/agi/`](claude-code/plugins/agi) |
| Codex | `$agy-connect` | `agy/<model>` | [`codex/plugins/agi/`](codex/plugins/agi) |
| OpenCode | `/connect` → **Antigravity (ACP)** | `agy/<model>` | [`opencode/plugins/agi/`](opencode/plugins/agi) |
| DeepSeek Harness | `/agy-connect` | `agy/<model>` | [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) |

---

## 설치

사전 요구사항: **Node.js 18+** 및 `PATH`에 등록된 공식 **Antigravity CLI (`agy`)**.

### 빠른 설치

설치 스크립트를 실행하면 다중 선택 UI(화살표 또는 `j`/`k`로 이동, `Space`로 선택, `a`로 전체 선택, `Enter`로 확정)가 열리며 원하는 하네스를 고를 수 있습니다.

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

저장소를 직접 클론해 실행하려면:

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

주요 옵션 (`curl` 사용 시 `bash -s --` 뒤에 전달):

```bash
./install.sh -a opencode,dsh              # 특정 하네스만 설치 (claude | codex | opencode | dsh | all)
./install.sh --all --yes                  # 프롬프트 없이 모두 설치
./install.sh --claude --local-token       # Anthropic 계정 없이 Claude Code 사용
./install.sh --codex --codex-mode default # `-p agy` 없이 기본 설정에 병합
./install.sh --dsh --dsh-profile desktop  # 특정 DeepSeek Harness 프로필 지정
./install.sh --dry-run                    # 실제 변경 없이 미리보기
./install.sh --uninstall                  # 제거할 하네스 선택 (`--purge`로 ~/.agi도 삭제)
```

---

## 인증

AGI는 공식 `agy acp` CLI를 통해서만 연결되며 인증 정보는 `~/.agi/` 아래에 별도로 보관합니다.

다음 두 가지 방식 중 하나를 사용할 수 있습니다:

- **Gemini API 키 (권장):** `GEMINI_API_KEY`를 설정하거나 각 도구의 연결 화면에서 입력합니다. 엔터프라이즈 계정(`oauth-business` / `agent-platform`)도 `--method`로 지원됩니다.
- **Google 대화형 로그인:** 각 도구의 연결 명령을 실행하거나 `agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login`을 직접 실행합니다.

로그인하지 않은 상태에서도 `/model`에 기본 Gemini 모델 목록이 표시되며, 로그인 후 새로고침하면 계정의 전체 모델 목록으로 자동 전환됩니다.

---

## 하네스별 사용법

### Claude Code

`./install.sh`로 설치했다면 이미 구성되어 있습니다. 수동 설정:

```bash
claude --plugin-dir ./claude-code/plugins/agi
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

`claude`를 재시작한 뒤 `/agi:connect`로 로그인하거나 상태를 확인하고 `/model`에서 `anthropic-agy/...`를 선택하세요. 기존 Anthropic 키와 `claude-*` 모델도 그대로 함께 사용할 수 있습니다.

목록 갱신은 `/agi:agy-models`, 설정 제거는 `./claude-code/plugins/agi/bin/agy-claude-setup --scope user --remove`를 실행하면 됩니다.

> Anthropic 계정이 없다면 `agy-claude-setup`에 `--auth-mode local-token`(`install.sh`에서는 `--local-token`)을 추가하세요.

### Codex

수동 설정:

```bash
cd codex
codex plugin marketplace add .
codex plugin add agi@local-repo
node ./plugins/agi/scripts/setup-codex.mjs --start-bridge
```

`codex -p agy`로 실행한 뒤 `$agy-connect`로 로그인하거나 모델을 새로고침하고 `/model`에서 `agy/*`와 OpenAI 모델을 전환하세요. 매번 `-p agy`를 붙이기 번거롭다면 `setup-codex.mjs`에 `--mode default`를 전달하면 됩니다.

### OpenCode

프로젝트의 `.opencode/plugins/agi/`에 `opencode/plugins/agi`를 복사하거나 `opencode.jsonc`에 추가하세요:

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

OpenCode 안에서 `/connect` → **Antigravity (ACP)**를 선택해 `agy acp --login` 또는 `GEMINI_API_KEY`로 로그인할 수 있습니다. 모델은 `/model`과 `opencode models`에 자동으로 나타나며 `/agy-connect`(`status` | `refresh` | `logout`)와 `/agy-models`도 함께 제공됩니다.

### DeepSeek Harness

수동 연결:

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

DeepSeek Harness를 다시 시작한 뒤 `/agy-connect`로 상태를 확인하거나 로그인하고(예: `/agy-connect method gemini-api-key` 또는 `node ./deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs`) 모델 선택기에서 `agy/<model>`을 고르세요. `/agy-models`와 `/agy-status`도 사용할 수 있습니다.

---

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AGY_BIN` | `agy` | `agy` 실행 파일 경로 |
| `GEMINI_API_KEY` | — | 선택적 Gemini API 키 |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` | ACP 전용 분리 설정 디렉터리 |
| `AGY_CLAUDE_PORT` | `43110` | Claude Code 로컬 브리지 포트 |
| `AGY_CODEX_PORT` | `43111` | Codex 로컬 브리지 포트 |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness 데이터 디렉터리 |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
