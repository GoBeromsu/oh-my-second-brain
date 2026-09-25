# Oh My Second Brain

Oh My Second Brain(`oms`)은 기존 Obsidian·Markdown 볼트를 AI 호스트와 연결하되 노트의 소유권은 가져가지 않는다. 볼트는 계속 평문 Markdown이고, Obsidian이 사령탑으로 남는다. OMS가 꺼져 있어도 노트는 사람이 읽고 고칠 수 있는 파일이다. OMS는 속성·폴더·heading의 의미를 스스로 만들어내지 않는다.

## 볼트 계약

의미는 사용자에게 남는다. 사용자는 터미널에서 대화형 `oms setup`을 한 번 실행해 볼트 계약을 봉인한다. 인터뷰는 세 부분을 함께 다룬다. 폴더(각 폴더의 의미와 배치 가능 대상), 속성 pool(각 속성의 type과 intent), 템플릿(템플릿 폴더의 각 템플릿이 선언하는 것)이다. 제품은 속성 이름·폴더·페르소나를 하드코딩하지 않고 Inbox fallback도 없다.

봉인된 계약은 볼트 밖 `~/.oms/vaults/<vault-id>/`에 있다. 볼트 안의 OMS 파일은 `.oms/settings.json` 하나이며 `version`, `vaultId`, `templateFolder`, `embedding`, `agentRepair`를 담는다. `.oms/`의 다른 항목은 `oms contract doctor`가 예상하지 않은 제어 파일로 보고하고, 그 밖에는 무시한다. `.obsidian/types.json`은 읽기 전용 관측값이며 봉인을 덮어쓰지 않는다.

템플릿은 `templateFolder` 안의 사용자 Markdown 파일 그대로 남는다. 봉인은 템플릿이 선언한 것을 기록할 뿐이며, OMS는 템플릿을 다시 쓰거나 복사하거나 노트에 적용하지 않는다. `oms contract status`는 봉인된 각 템플릿을 live 파일과 비교해 `active`, `drift`, `missing`으로 보고한다. drift는 보고만 하고 조용히 재봉인하지 않는다. 재봉인은 사용자가 `oms setup`으로 한다. OMS는 Templater, JavaScript, 전용 token 언어를 해석하거나 실행하지 않는다.

노트를 쓰는 주체는 에이전트다. 하나의 판정자가 모든 쓰기를 봉인에 비추어 판정한다. 거부된 쓰기는 파일을 바꾸지 않고 `{field, kind}` 위반과 안내 명령 하나만 돌려주며, 규칙 값·저장소 경로·계약 본문은 돌려주지 않는다. 이 기기에 봉인이 없는 볼트는 판정하지 않는다. 이 기기의 봉인 증거가 볼트와 맞지 않으면 사용자가 `oms setup`을 다시 실행할 때까지 쓰기를 `contract-unreadable`로 거부한다. OMS에는 완료 호출도 리뷰어 대화도 없다. 허용된 쓰기는 노트가 봉인된 구조에 맞는다는 뜻이지 보존할 가치가 있다는 뜻이 아니다.

볼트 계약은 ADR-007(소스 저장소의 `docs/decisions/`)에 기록되며, 구 ADR-013–016을 대체한다. [ACKNOWLEDGMENTS](./ACKNOWLEDGMENTS.md)는 Ouroboros와 Gajae Code의 deep-interview를 설계 아이디어로 밝힌다. 이는 runtime 복제도 연구 결과도 아니다. 저장소의 도식은 설명용 스케치다. 이 문서들은 승인된 아키텍처 기록이지 host smoke 결과나 제품 gate 통과가 아니다.

권위 모델은 [아키텍처](./docs/architecture.md), 볼트 파일은 [컨벤션](./docs/conventions.md), leaf 목록은 [CLI 맵](./docs/cli-map.md)에 있다.

## 설정

`oms setup`은 `oms contract setup`과 같은 명령이다. 볼트 전체를 인터뷰해 계약을 봉인한다. 볼트 안에는 `.oms/settings.json`만 쓰고 노트는 수정하지 않는다. 대화형 터미널이 없거나 `OMS_NON_INTERACTIVE=1`이면 실행을 거부하므로 에이전트는 실행하지 않는다. 언제든 다시 실행해 재봉인할 수 있다.

```bash
oms setup --vault /path/to/vault
oms contract status --vault /path/to/vault
```

`oms contract extract --template <path>`는 템플릿 하나가 선언하는 것을 값 없이 보여준다. `oms contract doctor`는 봉인, 오래된 lock, 고아 generation, 예상하지 않은 제어 파일, hook 전송 실패를 진단한다. `--fix`는 이동했거나 색인되지 않은 볼트를 다시 색인할 뿐이다. 그 밖의 깨진 봉인은 `oms setup`을 다시 실행해 복구한다. 모델 수명주기는 `oms model install|select|waive|status`로 따로 존재한다.

## CLI

```text
oms bridge add|remove|status                   저장소-볼트 target bridge 관리
oms contract setup|extract|status|doctor       볼트 계약 봉인, 조회, 진단
oms graph build|status                         노트 그래프 생성 또는 조회
oms hook pre                                   Claude 쓰기를 vault 계약으로 판정
oms host install|remove|sync|status            호스트 asset과 MCP 등록 관리
oms index sync|embed|repair|status|clean       파생 검색 상태 관리
oms link suggest|check                         노트 wikilink 제안 또는 검사
oms model install|select|waive|status          로컬 모델 선택 관리
oms note audit|get                             노트를 계약으로 감사하거나 읽기
oms package check|update                       OMS 패키지 확인 또는 업데이트
oms search query|context                       명시적 질의 실행 또는 구조화 context 조회
oms serve mcp|http                             stdio MCP 또는 로컬 HTTP 서버 시작
oms setup                                      볼트를 인터뷰하고 계약 봉인
oms status                                     읽기 전용 통합 상태 표시
```

`oh-my-second-brain`이 전체 명령이고 `oms`는 짧은 별칭이다. 이 14개 family, 6개 스킬, 5개 MCP 도구는 서로 다른 집합이다. leaf 목록은 [CLI 맵](./docs/cli-map.md)에 있다.

### 도움말 계약

인식되는 모든 명령은 `--help`와 `-h`를 받으며, exit 0으로 끝나고 부작용이 없다. 알 수 없는 명령에 `--help`를 붙이면 exit 1이다.

일반 `oms search query <text>`는 lexical 전용이다. `--vec`와 `--hyde`는 각 채널을 선택하고, `--expand`는 G004 확장을 명시적으로 켜며, `--max-queries`는 1부터 32까지의 정수를 받고, `--rerank`는 opt-in이다. `oms search context`는 별도의 구조화 context 표면이다. embedding은 `oms index embed`이고 sync와 repair는 서로 다른 index 모드다. `oms index status --view status|collections|contexts`는 세 가지 읽기 전용 view를 유지하고, `oms index clean`은 제거 가능한 파생 상태를 지운다.

lexical, vector, HyDE, typed-axis 질의는 계약을 통과하지 못할 노트도 계속 포함한다. 계약이 없거나 손상되어도 검색은 멈추지 않는다. vector 검색에는 완전한 `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL` 쌍이 필요하다. HyDE에는 `OMS_GENERATE_PROVIDER`/`OMS_GENERATE_MODEL`도 필요하다. reranking에는 `OMS_RERANK_PROVIDER`/`OMS_RERANK_MODEL`이 필요하다. 없거나 불완전하거나 설치되지 않은 선택은 크게 실패한다. G004 확장은 명시적으로 쓸 수 있는 기능이며 대체·동등·우월을 주장하지 않는다.

`oms note audit`는 기존 노트를 봉인에 비추어 판정하고 `{path, field, kind}` 항목을 보고한다. 노트를 다시 쓰지 않는다. create, append, update, backfill은 폐기된 노트 작업이다. link apply는 작업이 아니다. 폐기된 작업을 위한 노트 렌더러나 호환 경로는 없다.

## MCP 도구

`oms serve mcp`는 정확히 다섯 개의 공개 도구를 노출한다.

`write` · `search` · `link` · `status` · `doctor`

6개 스킬(`distill`, `doctor`, `link`, `search`, `status`, `write`)은 호스트 workflow다. `distill`은 도구가 없다.

다섯 도구는 스킬의 부분집합이며, 두 집합 모두 14개 CLI family와 다르다. 세부 기능은 다섯 도구 아래의 `op` 값으로 남는다. 봉인에는 MCP 작업도 스킬도 없다.

`write {path, content, template?}`는 노트 전체를 판정해 허용될 때만 저장한다. `template`은 선택 사항이며 노트가 따르는 봉인된 템플릿을 가리킨다. `status`와 모든 search 작업은 읽기 전용이다. `doctor` 도구는 봉인을 검증하고 노트를 감사하며 명시적인 index 유지보수를 실행한다. 노트를 backfill하지 않는다. 볼트 안에서 Claude의 기본 Write, Edit, MultiEdit, NotebookEdit는 `oms hook pre`를 통해 같은 판정자에 도달한다. Codex와 Hermes에는 쓰기 hook이 없으므로 MCP `write`로 쓴 노트만 판정된다.

## 설치

Node.js 20 이상이 필요하다.

```bash
npm install -g oh-my-second-brain
oms host install --runtime all --vault /path/to/vault --yes
```

Gajae-Code에서는 npm 패키지를 marketplace plugin으로 설치한다: `gjc plugin install oms@oms`. GJC는 패키지 루트의 `skills/` 관례 경로에서 여섯 OMS 스킬을 찾는다.

호스트 설치는 정식 볼트를 `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json`에 기록하고, 관리하는 각 호스트 항목에 `oms serve mcp --vault /path/to/vault`를 새긴다. `oms host install|remove|sync|status`는 그 서명된 pointer를 호스트 통합 유지보수에만 쓴다. `oms package update`는 패키지를 업데이트하지만 호스트를 암묵적으로 sync하지 않는다. `oms host sync`를 따로 실행한다.

runtime target 해석은 호스트 유지보수 pointer를 읽지 않는다. 우선순위는 명시적 target, 로컬 볼트 제어 파일, bridge, `OMS_VAULT`, 그리고 안전한 읽기 전용 fallback으로서의 현재 디렉터리다. 봉인, 노트 쓰기, 파생 상태 repair는 그 fallback을 쓸 수 없다.

`OMS_VAULT`는 명시적·로컬·bridge target이 없을 때 지원되는 환경 변수 fallback이다.

[설치](./docs/install.md), [아키텍처](./docs/architecture.md), [컨벤션](./docs/conventions.md), [CLI 맵](./docs/cli-map.md), [호스트 asset](./docs/adapters.md), [검증 대상](./docs/verified-target.md)을 참고한다.
