# Just Orca

[Orca](https://www.onorca.dev)를 위한 커뮤니티 플러그인 마켓플레이스입니다.
지원 앱은 **플러그인별로** 정합니다. 각 앱의 카탈로그에는 그 앱에서 지원하는 플러그인만 등록합니다.

## 플러그인

| 플러그인 | 기능 | 지원 앱 |
| --- | --- | --- |
| [git-log-graph](plugins/git-log-graph) | 워크트리와 모든 서브모듈의 커밋 그래프를 Orca 브라우저 탭에서 보기 (`⌘⌥L`) | Orca |

## 설치

설치 방법은 플러그인별 지원 앱에 따라 다릅니다.

### Orca (앱 플러그인)

`git-log-graph`는 Orca 앱 자체의 플러그인(`orca-plugin.json`)입니다. Orca의 마켓플레이스 형식은 플러그인이 git 레포 루트에 있어야 해서 이 레포의 하위 폴더는 직접 등록할 수 없습니다. 대신 로컬 경로로 설치합니다.

1. 이 레포를 클론합니다.
2. Orca → **Settings → Plugins**에서 플러그인 시스템을 켭니다.
3. **플러그인 설치 → 로컬 경로**에 `<클론 경로>/plugins/git-log-graph`를 지정하거나, 개발 중이면 **Development → 경로 추가**에 같은 경로를 넣습니다.
4. 권한(`workspace:read`, `notifications:show`)을 검토하고 활성화합니다.

자세한 사용법은 [plugins/git-log-graph/README.md](plugins/git-log-graph/README.md)를 참고하세요.

### Claude Code · Codex

현재 Claude Code와 Codex 카탈로그에는 등록된 플러그인이 없습니다.
지원 플러그인이 추가되면 해당 카탈로그에 등록합니다.
마켓플레이스 자체는 다음 명령으로 추가할 수 있습니다.

```sh
# Claude Code
claude plugin marketplace add Sn-Kinos/just-orca

# Codex
codex plugin marketplace add Sn-Kinos/just-orca
```

로컬 구성을 확인하려면 레포 루트에서 `Sn-Kinos/just-orca` 대신 `.`을 지정합니다.

## 플러그인 추가

1. `plugins/<플러그인명>/` 안에 스킬 등 플러그인 파일을 넣습니다.
2. 지원하는 앱의 매니페스트만 만듭니다.
   Claude Code는 `.claude-plugin/plugin.json`, Codex는 `.codex-plugin/plugin.json`을 사용합니다.
   Orca 앱 플러그인은 `orca-plugin.json`을 사용하며, 카탈로그 없이 로컬 경로로 설치합니다.
3. 해당 앱의 카탈로그에만 등록합니다. 두 앱을 모두 지원할 필요는 없습니다.
4. 위 목록에 기능과 지원 앱을 적고, 각 지원 앱에서 설치를 확인합니다.

| 앱 | 레포 루트의 카탈로그 | 플러그인 경로 형식 |
| --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json` | `"source": "./plugins/<플러그인명>"` |
| Codex | `.agents/plugins/marketplace.json` | `"source": {"source": "local", "path": "./plugins/<플러그인명>"}` |

다른 앱을 지원하는 플러그인은 해당 앱의 배포 형식과 설치 방법을 함께 추가합니다.
플러그인 이름은 폴더·매니페스트·카탈로그에서 동일하게 유지하고, 업데이트할 때 해당 플러그인의 매니페스트 버전을 올립니다.
여러 앱을 지원하면 그 플러그인의 버전을 함께 올립니다.

Claude Code 카탈로그는 다음 명령으로 검사할 수 있습니다.

```sh
claude plugin validate .
```

## 참고

이 레포는 Sn-Kinos가 관리하며 Orca 공식 마켓플레이스가 아닙니다.

- [Claude Code 마켓플레이스 형식](https://code.claude.com/docs/en/plugin-marketplaces)
- [Codex 플러그인 안내](https://developers.openai.com/codex/plugins)
