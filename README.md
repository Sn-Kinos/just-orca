# Just Orca 카탈로그 (catalog 브랜치)

`main`의 `plugins/` 아래 플러그인 중 새 매니페스트 형식(2)인 것을 Orca 카탈로그로 내놓는 브랜치입니다.

```sh
orca plugin catalog add Sn-Kinos/just-orca --ref catalog
orca plugin install sn-kinos.ryude-desk
```

새 버전을 낼 때는 `main`에 커밋·푸시한 뒤 그 플러그인 폴더에서 `orca plugin release-entry .`를 실행해, 출력된 항목을 `orca-catalog.json`의 `releases` 맨 앞에 넣고 이 브랜치를 푸시합니다.
