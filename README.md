# Just Orca

[Orca](https://www.onorca.dev)를 위한 커뮤니티 플러그인 마켓플레이스입니다.
지원 앱은 **플러그인별로** 정합니다. 각 앱의 카탈로그에는 그 앱에서 지원하는 플러그인만 등록합니다.

## 플러그인

| 플러그인 | 기능 | 지원 앱 |
| --- | --- | --- |
| [orca](plugins/orca) | 워크트리·터미널·브라우저 조작, 에이전트 오케스트레이션 | Claude Code, Codex |

`orca`에는 `orca-cli`, `orchestration` 스킬이 포함됩니다.
설치된 Orca CLI의 `skills get` 명령으로 해당 버전의 사용 가이드를 읽습니다.
Orca 앱과 CLI는 별도로 설치해야 합니다. [Orca 설치 안내](https://www.onorca.dev/docs/install)를 참고하세요.

## 설치

아래 GitHub 명령은 이 구성이 원격 레포에 푸시된 뒤 사용할 수 있습니다.
설치 후 새 세션에서 플러그인을 사용하세요.

### Claude Code

Claude Code 안에서 실행합니다.

```text
/plugin marketplace add Sn-Kinos/just-orca
/plugin install orca@just-orca
```

### Codex

터미널에서 실행합니다.

```sh
codex plugin marketplace add Sn-Kinos/just-orca
codex plugin add orca@just-orca
```

### 로컬 레포에서 설치

이 레포의 루트에서 사용할 앱의 명령을 실행합니다. 푸시하지 않은 변경도 확인할 수 있습니다.

```sh
# Claude Code
claude plugin marketplace add .
claude plugin install orca@just-orca

# Codex
codex plugin marketplace add .
codex plugin add orca@just-orca
```

## 플러그인 추가

1. `plugins/<플러그인명>/` 안에 스킬 등 플러그인 파일을 넣습니다.
2. 지원하는 앱의 매니페스트만 만듭니다.
   Claude Code는 `.claude-plugin/plugin.json`, Codex는 `.codex-plugin/plugin.json`을 사용합니다.
3. 해당 앱의 카탈로그에만 등록합니다. 두 앱을 모두 지원할 필요는 없습니다.
4. 위 목록에 기능과 지원 앱을 적고, 각 지원 앱에서 설치를 확인합니다.

| 앱 | 레포 루트의 카탈로그 | 플러그인 경로 형식 |
| --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json` | `"source": "./plugins/<플러그인명>"` |
| Codex | `.agents/plugins/marketplace.json` | `"source": {"source": "local", "path": "./plugins/<플러그인명>"}` |

다른 앱을 지원하는 플러그인은 해당 앱의 배포 형식과 설치 방법을 함께 추가합니다.
플러그인 이름은 폴더·매니페스트·카탈로그에서 동일하게 유지하고, 업데이트할 때 해당 플러그인의 매니페스트 버전을 올립니다.
여러 앱을 지원하면 그 플러그인의 버전을 함께 올립니다.

Claude Code 매니페스트와 스킬은 다음 명령으로 검사할 수 있습니다.

```sh
claude plugin validate .
claude plugin validate plugins/orca
```

## 출처

`orca`의 두 스킬은 [stablyai/orca의 공개 스킬](https://github.com/stablyai/orca/tree/4b4acf26a4775cfdde4258566683e41a6c276f5b/skills)을 그대로 포함합니다.
원본의 MIT 라이선스는 [plugins/orca/LICENSE](plugins/orca/LICENSE)에 보존했습니다.
이 레포는 Sn-Kinos가 관리하며 Orca 공식 마켓플레이스가 아닙니다.

- [Orca 스킬과 버전별 가이드](https://www.onorca.dev/docs/cli/skills)
- [Claude Code 마켓플레이스 형식](https://code.claude.com/docs/en/plugin-marketplaces)
- [Codex 플러그인 안내](https://developers.openai.com/codex/plugins)
