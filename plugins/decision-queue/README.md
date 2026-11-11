# 결정 대기 (decision-queue)

오케스트레이터 에이전트(예: 류드)가 사람에게 받아야 할 결정을 한곳에 모아, Orca 오른쪽 사이드바에서 처리하는 플러그인입니다.

- 에이전트가 항목을 폴더에 쓰면, 사이드바에 카드가 생기고 macOS 알림이 뜹니다. 상태 표시줄에는 기다리는 개수가 보입니다.
- 사람이 카드에서 답하면(승인·반려·고르기·지시), 플러그인이 답 파일을 쓰고 에이전트 터미널에 항목 ID 한 줄을 입력해 알립니다.
- 에이전트는 그 줄을 믿지 않고 답 파일을 직접 읽습니다.

이 플러그인은 아무것도 대신 보내지 않습니다. 「발송 준비」 항목은 초안을 보여 주고 사람이 직접 보낸 뒤 「보냈음」을 누릅니다.

## 처음 켜기

설치 직후에는 아무 폴더도 읽지 않고 아무 터미널에도 입력하지 않습니다. 사이드바의 「이 Mac에서 쓰기 시작」을 누르면 다음 기본값이 저장됩니다.

| 설정 | 기본값 |
| --- | --- |
| 큐 폴더 | `~/.local/state/ryude/decisions` |
| 알릴 터미널 | `~/.config/ryude/handle` 파일에 적힌 터미널 ID |

## 폴더 구조

항목마다 폴더 하나를 쓰고, 파일마다 쓰는 쪽이 하나뿐입니다.

```
<큐 폴더>/<항목 ID>/
  item.json    에이전트가 한 번 쓴다
  answer.json  이 플러그인만 쓴다
  state.json   에이전트만 쓴다
```

항목 ID는 `DQ-YYYYMMDD-HHMMSS-xxxx` 꼴(영문·숫자·하이픈, 64자 이내)입니다. 이 꼴이 아닌 폴더는 무시합니다.

### item.json

| 필드 | 필수 | 내용 |
| --- | --- | --- |
| `id` | 예 | 폴더 이름과 같은 ID |
| `createdAt` | 예 | ISO 8601 시각 |
| `project` | 예 | 프로젝트 이름 |
| `kind` | 예 | `approve` 승인 요청, `decide` 결정, `review` 검토, `send-ready` 발송 준비 |
| `title` | 예 | 한 줄 제목 |
| `body` | 아니요 | 무엇을 왜 묻는지 |
| `proposal` | 아니요 | 에이전트의 제안 |
| `options` | `decide`만 | 고를 수 있는 안(문자열 목록, 2개 이상) |
| `evidence` | 아니요 | `[{ "label": "녹화", "path": "/절대/경로.mp4" }]` |
| `draft` | `send-ready`만 | 그대로 복사해 보낼 글 |
| `sender` | `send-ready`만 | 보낼 사람 |

### answer.json

```json
{ "itemHash": "<item.json 바이트의 sha256>", "verdict": "approve", "note": "", "at": "2026-11-11T21:40:00+09:00", "relayed": true }
```

| 종류 | 고를 수 있는 `verdict` |
| --- | --- |
| `approve` | `approve`, `reject`, `instruct` |
| `decide` | `choose`(이때 `choice`는 `options` 중 하나), `instruct` |
| `review` | `accept`, `revise`, `instruct` |
| `send-ready` | `sent`, `revise`, `instruct` |

`reject`·`revise`·`instruct`는 `note`(한 줄 지시)가 있어야 합니다. `itemHash`가 지금의 item.json과 다르면 그 답은 무효이고 카드는 다시 「답 기다림」이 됩니다. 에이전트가 처리를 시작하기 전까지는 사람이 답을 바꿀 수 있습니다.

`relayed`는 에이전트 터미널에 알림 줄을 넣었는지입니다. `false`면 카드에 「알리지 못함」이 보입니다. 에이전트는 이 알림에 기대지 말고 턴을 시작할 때 답이 달린 항목을 직접 확인합니다.

### state.json

```json
{ "status": "taken", "answerHash": "<처리하기로 한 answer.json의 sha256>", "at": "...", "note": "" }
```

`status`는 `taken`(처리 시작) 또는 `done`(끝)입니다. `taken`이 된 뒤에는 사이드바에서 답을 바꿀 수 없습니다.

## 카드 상태

| 상태 | 조건 |
| --- | --- |
| 답 기다림 | state.json이 없고, answer.json이 없거나 `itemHash`가 맞지 않음 |
| 답함 | state.json이 없고, `itemHash`가 맞는 answer.json이 있음 |
| 처리 중 | state.json의 `status`가 `taken` |
| 끝남 | state.json의 `status`가 `done` (최근 10개만 보임) |

## 안전

- 증거 파일은 항목에 적힌 절대 경로만 엽니다. 영상·그림·PDF·문서 확장자(`mp4 mov m4v png jpg jpeg gif webp heic pdf txt md csv html json docx xlsx pptx hwp hwpx`)는 기본 앱으로 열고, 그 밖의 파일과 폴더는 Finder에서 위치만 보여 줍니다. 셸을 거치지 않습니다.
- 답 파일은 이 플러그인만 쓴다는 약속으로 지킵니다. 같은 Mac 사용자 계정의 다른 프로그램은 파일을 쓸 수 있으므로, 에이전트에게 다른 세션이 보내는 메시지와 같은 수준의 신뢰입니다.
- 에이전트 터미널에는 `[결정 대기] <ID> 답 있음` 한 줄만 입력합니다. 답의 내용은 넣지 않습니다.

## 시험

```sh
orca plugin test .
orca plugin check .
```

시험과 `check`는 `test/fixtures` 아래의 지어낸 항목만 읽고, 터미널 입력·파일 열기는 기록만 합니다.
