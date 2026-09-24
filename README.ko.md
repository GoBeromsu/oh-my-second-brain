# Oh My Second Brain

Oh My Second Brain(`oms`)은 기존 Obsidian·Markdown 볼트를 AI 호스트와 연결하되 노트의 소유권은 가져가지 않는다. 볼트는 계속 평문 Markdown이고, Obsidian이 사령탑으로 남는다. OMS가 꺼져 있어도 노트는 사람이 읽고 고칠 수 있는 파일이다. OMS는 속성·폴더·heading의 의미를 스스로 만들어내지 않는다.

## 템플릿·온톨로지 볼트 모델

의미는 사용자에게 남는다. `.oms/template-policy.json` version 5가 게시된 구조이자 의미다. 속성 pool이 type, format, intent를 기록한다. 항상 켜져 있는 공통 계약은 자체 Markdown 파일이 없고 모든 노트와 등록된 모든 템플릿에 적용된다. OMS가 공통 필드를 스스로 선언하지 않으므로, 공통 계약은 게시된 문서가 적은 것만 담는다. 명시적으로 등록된 템플릿은 이 계약을 상속하고 필드·heading·의미 기준을 추가하거나 좁힐 수 있으며, 사용자가 승인한 완화는 약화할 수도 있다. 등록된 템플릿이 없는 노트는 공통 계약 아래의 정상 노트다. 관리되지 않는 frontmatter는 보존하며 검사하지 않는다. 값 집합은 문서에 `valuePolicy: "closed"`를 선언한 경우에만 닫혀 있으며, `allowedValues` 목록만으로는 제안에 머문다.

제품은 속성 이름·폴더·페르소나를 하드코딩하지 않고 Inbox fallback도 없다. 폐기된 것은 노트 정체성으로서의 `concept`와 번들 runtime 기본값이지, 사용자가 서술하는 의미 계층으로서의 온톨로지가 아니다. `.oms/taxonomy.json`은 배치와 폴더·링크의 의미를 기록한다. `.obsidian/types.json`은 읽기 전용 관측값이다. `.oms/types.json`은 version 4 시절의 파생 파일이다. 게시된 version 5 계약은 그것을 만들지도 읽지도 않으며 다시 생성하지도 않는다. version 3·4 정책은 계속 읽을 수 있으며, 값을 바꾸는 선택에서만 기록된 의미를 보존하며 제자리 이전된다. 보류되었거나 증명되지 않은 이전 계약은 다시 쓰지 않고 `review-required`로 보고한다.

노트 파일을 쓰고 고치는 주체는 에이전트다. 쓰기 전에 `guide`가 하나의 명시적 노트 경로에 적용할 계약을 선택하고 세션 locator를 돌려준다. 그다음 그 locator로 디스크에 저장된 바이트를 읽어 선언된 속성과 heading을 보고하고 `semantic: "not-evaluated"`를 돌려준다. OMS에는 완료 호출도 별도 리뷰어 대화도 없다. 계약 설정은 사용자가 정확한 diff를 승인할 때만 compare-and-swap으로 바뀐다. 자동 보정은 사용자가 `.oms/settings.json`에서 켜지 않는 한 꺼져 있다. 그 파일은 계약이 아니라 이동 가능한 저장소 설정이다. OMS는 재시도 예산을 선언하지 않고 시도 횟수도 세지 않는다. 검색은 그 판정을 기다리지 않는다.

등록된 각 소스는 경로와 내용 hash로 기록되는 사용자의 Markdown 파일 그대로 남는다. OMS는 그 소스를 다시 쓰거나 복사하거나 스냅샷하지 않고, 관리 draft나 `.oms/templates/` 디렉터리도 없으며 정책에 승인된 Markdown 바이트를 저장하지 않는다. OMS는 Templater, JavaScript, 전용 token 언어를 해석하거나 실행하지 않는다.

ADR-015는 ADR-014를 대체하고, ADR-014는 ADR-013을 대체했다. [ACKNOWLEDGMENTS](./ACKNOWLEDGMENTS.md)는 Ouroboros와 Gajae Code의 deep-interview를 설계 아이디어로 밝힌다. 이는 runtime 복제도 연구 결과도 아니다. 저장소의 도식은 설명용 스케치이며 G002 Excalidraw 산출물이 아니다. 이 문서들은 승인된 아키텍처 기록이지 host smoke 결과나 제품 gate 통과가 아니다.

권위 모델은 [아키텍처](./docs/architecture.md), 볼트 파일은 [컨벤션](./docs/conventions.md), leaf 목록은 [CLI 맵](./docs/cli-map.md)에 있다.

## 설정

`oms setup`은 저장소를 연결한다. dry-run이 출력한 digest를 승인하면 이동 가능한 `.oms/settings.json` 신원과 호스트 연결을 기록하고, 같은 흐름에서 모델을 선택할 수도 있다. 계약은 게시하지 않으며 노트도 수정하지 않는다. 계약 게시는 interview가 합의한 뒤 `oms template publish`가 한다. 모델 수명주기는 `oms model install|select|waive|status`로도 따로 존재한다.

```bash
oms setup --vault /path/to/vault --dry-run
oms setup --vault /path/to/vault --yes --approval-token <token> --approved-digest <digest>
```

interview 스킬은 결정을 사용자와 하나씩 합의하고, 명시적 계약 문서를 작성하고, `oms template publish`로 미리 보여준 뒤 사용자가 승인한 것만 게시한다. 변경된 등록 소스는 drift 증거다. `oms template review-sources`가 이를 검토하고, `oms template acknowledge-source`는 live reviewed digest로 기록된 hash만 전진시키며, `oms template relink-source`는 실제로 없어진 원본과 사용자가 정확히 지정한 candidate path를 요구한다. 그 자체로 계약을 바꾸지 않는다. OMS는 interview 상태를 보관하지 않으므로 전달할 question id·census digest·서버 발급 approval digest가 없다. 일반 질문, 알 수 없는 노트 값, 노트 오류, 관리되지 않는 속성, 검색은 interview를 시작하지 않는다.

호스트 알림 문구는 정확히 `템플릿에 변경이 있습니다`이고 동작은 `확인하기`와 `나중에` 둘뿐이다. 처음 알림에는 템플릿 이름·hash·change class를 표시하지 않는다. `나중에`는 host-only이며 서버를 호출하지 않는다. `확인하기`는 interview 스킬을 시작하고, 그 스킬은 게시 전에 `write { op: "template", mode: "review-sources" }`로 변경된 소스를 먼저 검토한다.

## CLI

```text
oms bridge add|remove|status                   저장소-볼트 target bridge 관리
oms graph build|status                         노트 그래프 생성 또는 조회
oms hook pre|post                              pre/post-tool-use hook 실행
oms host install|remove|sync|status            호스트 asset과 MCP 등록 관리
oms index sync|embed|repair|status|clean       파생 검색 상태 관리
oms link suggest|check                         노트 wikilink 제안·점검
oms model install|select|waive|status          로컬 모델 선택 관리
oms note guide|check|audit|get                계약 선택·저장된 노트 검사·감사·조회
oms package check|update                       OMS 패키지 확인 또는 업데이트
oms search query|context                       명시적 query 실행 또는 구조화 context 조회
oms serve mcp|http                             stdio MCP 또는 로컬 HTTP 서버 시작
oms setup                                      저장소 연결과 이동 가능한 신원 기록
oms status                                     읽기 전용 종합 상태 표시
oms template list|show|scan|check|publish|review-sources|acknowledge-source|relink-source
```

`oh-my-second-brain`은 전체 명령이고 `oms`는 짧은 별칭이다. 이 열네 개 family, 여덟 개 skill, 다섯 개 MCP 도구는 서로 다른 세 집합이다. leaf 대응은 [CLI 맵](./docs/cli-map.md)에 있다.

### 도움말 계약

인식된 모든 명령은 `--help`와 `-h`를 받아들이며, exit 0으로 종료하고 부작용을 수행하지 않는다. 알 수 없는 명령에 `--help`를 함께 주면 exit 1로 종료한다.

`oms search query <text>`는 lexical-only다. `--vec`와 `--hyde`는 각각의 channel을 선택하고, `--expand`는 G004 expansion을 명시적으로 켜며, `--max-queries`는 1부터 32까지의 정수만 받는다. `--rerank`도 opt-in이다. `oms search context`는 별도의 구조화 context 표면이다. Embedding은 `oms index embed`이며 sync와 repair는 서로 다른 index mode다. `oms index status --view status|collections|contexts`는 세 읽기 전용 view를 모두 보존하고, `oms index clean`은 제거 가능한 파생 상태를 정리한다.

lexical, vector, HyDE, typed-axis 질의는 템플릿에 결속되지 않았거나 계약을 어겼거나 미완성인 노트도 계속 포함한다. 계약이 없거나 손상되어도 검색은 멈추지 않는다. Vector 검색에는 완전한 `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL` 쌍이 필요하다. HyDE에는 `OMS_GENERATE_PROVIDER`/`OMS_GENERATE_MODEL`이, reranking에는 `OMS_RERANK_PROVIDER`/`OMS_RERANK_MODEL`이 추가로 필요하다. 누락되거나 불완전하거나 설치되지 않은 선택은 크게 실패한다. G004 expansion은 명시적으로 선택할 때만 쓰이며 교체·parity·outperformance를 주장하지 않는다.

`guide`는 노트를 쓰지 않는다. 계약을 선택하고 세션 locator를 돌려준다. 에이전트가 파일을 저장한 뒤 `check`가 그 locator로 파일을 읽어 선언된 필드와 heading을 보고하고 `semantic: "not-evaluated"`를 돌려주며, 완료 판정은 내리지 않는다. create, append, update, backfill은 폐기된 노트 동작이다. link apply도 동작이 아니다. template add, update, move, remove, default도 동작이 아니다. 폐기된 그 동작들을 위한 노트 renderer나 호환 경로는 없다.

## MCP 도구

`oms serve mcp`는 정확히 다섯 개의 공개 도구를 노출한다:

`write` · `search` · `link` · `status` · `doctor`

여덟 skill(`distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, `write`)은 호스트 워크플로다. `interview`와 `template`은 도구가 없다.

다섯 도구는 그 skill의 부분집합이고, 어느 쪽도 열네 개 CLI family와 같지 않다. 세부 기능은 다섯 도구의 `op` 값으로 남는다.

`write`는 명시적 계약 게시와 소스 검토가 관리 상태를 바꾸기 때문에 쓰기 posture를 유지한다. `guide`와 `check`는 노트 바이트를 쓰지 않는다. 관리 상태에 대한 유일한 예외는 세 개의 `migration` id를 받은 `guide`이며, 이 경우 역사적 저장소의 version 5 계약을 제자리에 게시한 뒤 선택한다. 계약 변경은 `op: "template"`의 `publish-contract`, `review-sources`, `acknowledge-source`, `relink-source` mode만 사용한다. `status`와 모든 검색 동작은 읽기 전용이며 완료를 대신 판정하지 않는다. `doctor` 도구는 control과 index를 진단하며 노트를 backfill하지 않는다.

## 설치

Node.js 20 이상이 필요하다.

```bash
npm install -g oh-my-second-brain
oms host install --runtime all --vault /path/to/vault --yes
```

Gajae-Code에서는 npm 패키지를 marketplace plugin으로 설치한다: `gjc plugin install oms@oms`. GJC는 패키지 루트의 `skills/` convention path에서 여덟 개 OMS skill을 발견한다.

호스트 설치는 canonical 볼트를 `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json`에 기록하고 각 관리형 등록에 `oms serve mcp --vault /path/to/vault`를 넣는다. `oms host install|remove|sync|status`만 이 서명된 포인터로 호스트 통합을 관리한다. `oms package update`는 패키지만 업데이트하고 호스트를 암묵적으로 동기화하지 않는다. `oms host sync`는 별도로 실행한다.

런타임 target 해석은 호스트 관리 포인터를 읽지 않는다. 우선순위는 명시적 target, 로컬 볼트 control, bridge, `OMS_VAULT`, 그리고 읽기 전용 fallback으로서의 cwd 순서다. control과 파생 상태 변경은 이 fallback을 사용할 수 없다. 노트 `guide`와 `check`는 일반 노트를 쓰지 않고 읽으며, 계약 게시, 확인된 소스 변경, 파생 상태 보정에는 계속 검증된 target이 필요하다.

`OMS_VAULT`는 명시적·로컬·bridge target이 없을 때 사용하는 환경변수 fallback이다.

자세한 내용은 [설치](./docs/install.md), [아키텍처](./docs/architecture.md), [컨벤션](./docs/conventions.md), [검증된 target](./docs/verified-target.md)을 참고한다.
