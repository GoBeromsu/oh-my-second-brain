# Oh My Second Brain

Oh My Second Brain(`oms`)은 기존 Obsidian·Markdown 볼트를 AI 호스트와 연결하되 노트의 소유권은 가져가지 않는다. 볼트는 계속 평문 Markdown이고, Obsidian이 사령탑으로 남는다. OMS가 꺼져 있어도 노트는 사람이 읽고 고칠 수 있는 파일이다. OMS는 속성·폴더·heading의 의미를 스스로 만들어내지 않는다.

## 템플릿·온톨로지 볼트 모델

의미는 사용자에게 남는다. `.oms/template-policy.json` version 4가 승인된 구조이자 의미다. 속성 pool이 type, format, intent를 기록한다. 항상 켜져 있는 default 계층은 비어 있는 상태로 시작해 모든 노트에 적용된다. 선택적인 개별 템플릿은 필드·heading·의미 기준을 추가하거나 좁힐 수만 있고, default를 제거하거나 약화시킬 수 없다. 개별 템플릿이 없는 노트는 그 default 아래의 정상 노트다. 관리되지 않는 frontmatter는 보존하며 검사하지 않는다.

제품은 속성 이름·폴더·페르소나를 하드코딩하지 않고 Inbox fallback도 없다. 폐기된 것은 노트 정체성으로서의 `concept`와 번들 runtime 기본값이지, 사용자가 서술하는 의미 계층으로서의 온톨로지가 아니다. `.oms/taxonomy.json`은 배치와 폴더·링크의 의미를 기록한다. `.obsidian/types.json`은 읽기 전용 관측값이다. `.oms/types.json`(`oms.types.v2`)은 파생 projection이며 두 번째 권위가 아니다. version 3은 지원하지 않는다. 자동 변환도, 호환 reader도 없다.

노트 파일을 쓰고 고치는 주체는 에이전트다. 쓰기 전에 OMS는 승인된 Markdown, 유효 계약, task binding을 돌려준다. 그다음 디스크에 저장된 바이트를 검사한다. 완료 판정에는 같은 입력에 대한 호스트의 별도 리뷰가 필요하다. 지시 기반(instruction-only) 별도 리뷰도 유효하다. 리뷰어 파일의 바이트가 일치한다는 사실은 호스트가 그 역할을 실제로 실행했다는 증거가 아니다. 기계 검사 통과, 스스로 발급한 PASS, digest는 그 리뷰가 아니며, digest는 인증이 아니라 내용 무결성이다. 계약 설정은 사용자가 정확한 diff를 승인할 때만 compare-and-swap으로 바뀐다. 자동 보정은 사용자가 켜지 않는 한 꺼져 있다. 재시도 예산은 사용자가 정하는 유한한 0 이상의 정수이며 기본값은 2, 0도 허용하고 별도의 상한 3은 없다. 검색은 그 판정을 기다리지 않는다.

승인된 Markdown은 BOM과 원래 줄바꿈을 포함한 정확한 UTF-8 스냅샷이다. 관리 draft를 편집해도 그 스냅샷은 대체되지 않는다. OMS는 Templater, JavaScript, 전용 token 언어를 해석하거나 실행하지 않는다.

ADR-014는 ADR-013을 대체한다. [ACKNOWLEDGMENTS](./ACKNOWLEDGMENTS.md)는 Ouroboros와 Gajae Code의 deep-interview를 설계 아이디어로 밝힌다. 이는 runtime 복제도 연구 결과도 아니다. 저장소의 도식은 설명용 스케치이며 G002 Excalidraw 산출물이 아니다. 이 문서들은 승인된 아키텍처 기록이지 host smoke 결과나 제품 gate 통과가 아니다.

권위 모델은 [아키텍처](./docs/architecture.md), 볼트 파일은 [컨벤션](./docs/conventions.md), leaf 목록은 [CLI 맵](./docs/cli-map.md)에 있다.

## 설정

`oms setup`은 비어 있는 version 4 policy를 제안한다. 노트 타입 기본값을 번들로 넣지 않고 노트를 수정하지도 않는다. 게시는 설정 interview를 거쳐 사용자가 승인한 diff만 기록한다. 모델 수명주기는 setup 시절 플래그가 아니라 `oms model install|select|waive|status`다.

```bash
oms setup --vault /path/to/vault --dry-run
oms setup --vault /path/to/vault --yes --approved-digest <digest>
```

interview leaf는 `oms template review --proposals`, `oms template answer`, `oms template commit`이다. 서버가 돌려준 question과 compare-and-swap 값을 그대로 전달하고, 세 호출 모두에 같은 `proposals`를 보낸다. parameter 이름을 만들어내지 않는다. 일반 질문, 알 수 없는 노트 값, 노트 오류, 관리되지 않는 속성, 검색은 그 interview를 시작하지 않는다.

호스트 알림 문구는 정확히 `템플릿에 변경이 있습니다`이고 동작은 `확인하기`와 `나중에` 둘뿐이다. 처음 알림에는 템플릿 이름·hash·change class를 표시하지 않는다. `나중에`는 host-only이며 서버를 호출하지 않는다. `확인하기`는 `write { op: "template", mode: "interview-next", proposals }`로 한 번에 한 질문씩 진행하는 resumable interview를 시작한다.

## CLI

```text
oms bridge add|remove|status                   저장소-볼트 target bridge 관리
oms graph build|status                         노트 그래프 생성 또는 조회
oms hook pre|post                              pre/post-tool-use hook 실행
oms host install|remove|sync|status            호스트 asset과 MCP 등록 관리
oms index sync|embed|repair|status|clean       파생 검색 상태 관리
oms link suggest|check                         노트 wikilink 제안·점검
oms model install|select|waive|status          로컬 모델 선택 관리
oms note guide|check|complete|audit|get        노트 안내·검사·완료·감사·조회
oms package check|update                       OMS 패키지 확인 또는 업데이트
oms search query|context                       명시적 query 실행 또는 구조화 context 조회
oms serve mcp|http                             stdio MCP 또는 로컬 HTTP 서버 시작
oms setup                                      비어 있는 version 4 policy 제안
oms status                                     읽기 전용 종합 상태 표시
oms template scan|list|show|check|regenerate-types|review|answer|commit
```

`oh-my-second-brain`은 전체 명령이고 `oms`는 짧은 별칭이다. 이 열네 개 family, 여덟 개 skill, 다섯 개 MCP 도구는 서로 다른 세 집합이다. leaf 대응은 [CLI 맵](./docs/cli-map.md)에 있다.

### 도움말 계약

인식된 모든 명령은 `--help`와 `-h`를 받아들이며, exit 0으로 종료하고 부작용을 수행하지 않는다. 알 수 없는 명령에 `--help`를 함께 주면 exit 1로 종료한다.

`oms search query <text>`는 lexical-only다. `--vec`와 `--hyde`는 각각의 channel을 선택하고, `--expand`는 G004 expansion을 명시적으로 켜며, `--max-queries`는 1부터 32까지의 정수만 받는다. `--rerank`도 opt-in이다. `oms search context`는 별도의 구조화 context 표면이다. Embedding은 `oms index embed`이며 sync와 repair는 서로 다른 index mode다. `oms index status --view status|collections|contexts`는 세 읽기 전용 view를 모두 보존하고, `oms index clean`은 제거 가능한 파생 상태를 정리한다.

lexical, vector, HyDE, typed-axis 질의는 템플릿에 결속되지 않았거나 계약을 어겼거나 미완성인 노트도 계속 포함한다. 계약이 없거나 손상되어도 검색은 멈추지 않는다. Vector 검색에는 완전한 `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL` 쌍이 필요하다. HyDE에는 `OMS_GENERATE_PROVIDER`/`OMS_GENERATE_MODEL`이, reranking에는 `OMS_RERANK_PROVIDER`/`OMS_RERANK_MODEL`이 추가로 필요하다. 누락되거나 불완전하거나 설치되지 않은 선택은 크게 실패한다. G004 expansion은 명시적으로 선택할 때만 쓰이며 교체·parity·outperformance를 주장하지 않는다.

`guide`는 노트를 쓰지 않는다. 에이전트가 파일을 저장한 뒤 `check`가 그 파일을 읽고, 별도 리뷰 후 `complete`가 같은 입력을 다시 읽는다. create, append, update, backfill은 노트 동작이 아니다. link apply도 동작이 아니다. template add, update, move, remove, default도 동작이 아니다. 폐기된 그 동작들을 위한 version 3 변환, 노트 renderer, 호환 경로는 없다.

## MCP 도구

`oms serve mcp`는 정확히 다섯 개의 공개 도구를 노출한다:

`write` · `search` · `link` · `status` · `doctor`

여덟 skill(`distill`, `doctor`, `interview`, `link`, `search`, `status`, `template`, `write`)은 호스트 워크플로다. `interview`와 `template`은 도구가 없다.

다섯 도구는 그 skill의 부분집합이고, 어느 쪽도 열네 개 CLI family와 같지 않다. 세부 기능은 다섯 도구의 `op` 값으로 남는다.

`write`는 interview 답변과 승인된 계약 게시가 관리 상태를 바꾸기 때문에 쓰기 posture를 유지한다. `guide`, `check`, `complete`는 볼트 바이트를 쓰지 않는다. 계약 review는 `op: "template"`의 `interview-next`, `interview-answer`, `commit-contracts` mode만 사용한다. `status`와 모든 검색 동작은 읽기 전용이며 완료를 대신 판정하지 않는다. `doctor` 도구는 control과 index를 진단하며 노트를 backfill하지 않는다.

## 설치

Node.js 20 이상이 필요하다.

```bash
npm install -g oh-my-second-brain
oms host install --runtime all --vault /path/to/vault --yes
```

Gajae-Code에서는 npm 패키지를 marketplace plugin으로 설치한다: `gjc plugin install oms@oms`. GJC는 패키지 루트의 `skills/` convention path에서 여덟 개 OMS skill을 발견한다.

호스트 설치는 canonical 볼트를 `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json`에 기록하고 각 관리형 등록에 `oms serve mcp --vault /path/to/vault`를 넣는다. `oms host install|remove|sync|status`만 이 서명된 포인터로 호스트 통합을 관리한다. `oms package update`는 패키지만 업데이트하고 호스트를 암묵적으로 동기화하지 않는다. `oms host sync`는 별도로 실행한다.

런타임 target 해석은 호스트 관리 포인터를 읽지 않는다. 우선순위는 명시적 target, 로컬 볼트 control, bridge, `OMS_VAULT`, 그리고 읽기 전용 fallback으로서의 cwd 순서다. cwd fallback에서는 계약 게시와 파생 상태 보정을 할 수 없다.

`OMS_VAULT`는 명시적·로컬·bridge target이 없을 때 사용하는 환경변수 fallback이다.

자세한 내용은 [설치](./docs/install.md), [아키텍처](./docs/architecture.md), [컨벤션](./docs/conventions.md), [검증된 target](./docs/verified-target.md)을 참고한다.
