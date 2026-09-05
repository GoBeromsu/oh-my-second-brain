# Oh My Second Brain

Oh My Second Brain(`oms`)은 기존 Obsidian/Markdown 볼트를 노트 소유권을 빼앗지 않고 AI 호스트에 연결한다. 볼트는 계속 평범한 Markdown이다.

## 템플릿·온톨로지 볼트 모델

- 볼트에 실제로 존재하는 Obsidian `.md` 템플릿이 관리 노트의 frontmatter 형태와 본문 골격을 소유한다.
- 각 템플릿은 경로·digest와 독립적인 안정적 `templateId`를 가지며, 볼트 전체의 `BaseContract` 하나를 상속한다.
- `.obsidian/types.json`은 읽기 전용 타입 권위다.
- 사용자 소유 온톨로지는 계속 활성 상태다. `.oms/template-policy.json`은 노트·필드 의미와 필수값, 형식, 허용값, 기본값, 이름 규칙, 정체성, 바인딩을 기록한다.
- `.oms/taxonomy.json`은 폴더·링크 의미와 배치를 소유하며, 작성된 폴더 의미는 `folder-ontology` 검색 축으로 노출된다. runtime의 유일한 권위이며, setup이 레거시 YAML을 한 번 변환한다.
- `.oms/types.json`은 쓰기·검색용 검증된 파생 projection이다. 직접 편집하지 않는다.

제거된 것은 노트 정체성으로서의 `concept`와 번들 runtime 기본값이지, 의미 계층으로서의 온톨로지가 아니다.

## 설정

Setup은 기존 템플릿을 재귀 탐색하고 migration을 제안한다. 노트 타입 기본값을 번들로 강요하지 않으며 노트를 수정하지 않는다.

```bash
oms setup --vault /path/to/vault --dry-run
oms setup --vault /path/to/vault --yes --approved-digest <표시된-digest>
```

관리 템플릿 변경도 dry-run, 호출자가 검토한 정확한 digest, CAS, transaction, 사후조건 receipt를 거친다.

## CLI

```text
oms setup                                      기존 볼트 템플릿 탐색 및 채택
oms template scan|list|show|add|update|move|remove|default|check|regenerate-types
oms note create|append|update|audit|backfill|get
oms link check|suggest|apply                   노트 wikilink 점검·제안·적용
oms bridge add|remove|status                   저장소-볼트 target bridge 관리
oms search query|context                       명시적 query 실행 또는 구조화 context 조회
oms index sync|embed|repair|status|clean       파생 검색 상태 관리
oms graph build|status                         노트 그래프 생성 또는 조회
oms host install|remove|sync|status            호스트 asset과 MCP 등록 관리
oms package check|update                       OMS 패키지 확인 또는 업데이트
oms model install|select|waive|status          로컬 모델 선택 관리
oms serve mcp|http                             stdio MCP 또는 로컬 HTTP 서버 시작
oms hook pre|post                              pre/post-tool-use 볼트 가드 실행
oms status                                     읽기 전용 종합 상태 표시
```

`oh-my-second-brain`은 전체 명령이고 `oms`는 짧은 별칭이다.

`oms template add`에는 세 형태가 있다. 폴더를 넘기면 그 안의 템플릿을
등록하고, 파일과 `--id`를 넘기면 기존 템플릿을 등록하며, `--id`와
`--from`을 함께 쓰면 새 템플릿을 만든다. `--from` 형태는 등록된
`templateFolders[].default` 위치에 쓰며, 이 템플릿 폴더는 노트 배치
위치를 제한하지 않는다. `oms template default <id>`가 기본 바인딩을
선언한다. 명시적 템플릿 없이 노트를 만들 때는 이 바인딩만 사용하며,
없으면 첫 템플릿을 임의 선택하지 않고 `TEMPLATE_DEFAULT_UNDECLARED`로
실패한다.

### 도움말 계약

인식된 모든 명령은 `--help`와 `-h`를 받아들이며, exit 0으로 종료하고
부작용을 수행하지 않는다. 알 수 없는 명령에 `--help`를 함께 주면 exit 1로 종료한다.

`oms search query <text>`는 lexical-only다. `--vec`, `--hyde`는 각각의
typed channel을 선택하고, `--expand`는 G004 expansion을 명시적으로
켜며, `--max-queries`는 1부터 32까지의 정수만 받는다. `--rerank`도
opt-in이다. `oms search context`는 별도의 구조화 context 표면이다.
Embedding은 명시적으로 `oms index embed`를 사용하며 sync와 repair는
서로 다른 index mode다. `oms index status --view status|collections|contexts`는
세 읽기 전용 view를 모두 보존하고, `oms index clean`은 제거 가능한 파생
상태를 정리한다.

Vector 검색에는 검증된 로컬 embedding capability가 필요하다. 선택 경로는
완전한 `OMS_EMBEDDING_PROVIDER`/`OMS_EMBEDDING_MODEL` 쌍, vault의
`.oms/models.json`과 검증된 설치 receipt, 또는 setup-installed default다.
HyDE에는 resolved generate capability가, reranking에는 resolved rerank
capability가 필요하다. 각각의 완전한 환경변수 쌍은
`OMS_GENERATE_PROVIDER`/`OMS_GENERATE_MODEL`과
`OMS_RERANK_PROVIDER`/`OMS_RERANK_MODEL`이다. 누락되거나 불완전하거나
설치되지 않은 선택은 크게 실패한다. G004
expansion은 명시적으로 사용할 수 있는 기능이며, 교체·parity·outperformance를
주장하지 않는다.
Setup에서는 로컬 검증 acquisition 정책 하나를 선택한다:
`--models-default`, `--models-descriptor <path>`, `--models-no-default`.

## MCP 도구

`oms serve mcp`는 정확히 다섯 개의 공개 도구를 노출한다:

`write` · `search` · `link` · `status` · `doctor`

일곱 스킬(`write`, `search`, `link`, `distill`, `status`, `doctor`, `template`)은 워크플로 안내이며 MCP 도구와 같은 집합이 아니다. 세부 기능은 다섯 도구의 `op` 값으로 제공한다.

쓰기는 하나의 `ResolvedTemplate`을 해석해 create, append, update를 수행한다. 템플릿 변경, projection 재생성, 한 노트 정체성 backfill은 검증된 target과 명시적 승인 digest가 필요하다. `status`와 모든 검색 동작은 읽기 전용이다.

일반 lexical 검색은 projection과 독립적이다. 템플릿·선언 필드·폴더·링크 축은 쓰기와 같은 projection을 사용하며 누락·stale 상태를 크게 실패시킨다. 관리 템플릿 원본은 검색 대상에서 제외한다. Vector/HyDE는 provider와 model이 모두 설정되지 않으면 가짜 대체 없이 실패한다.

## 설치

Node.js 20 이상이 필요하다.

```bash
npm install -g oh-my-second-brain
oms host install --runtime all --vault /path/to/vault --yes
```

Gajae-Code에서는 npm 패키지를 marketplace plugin으로 설치한다: `gjc plugin install oms@oms`. GJC는 패키지 루트의 `skills/` convention path에서 일곱 OMS skill을 발견한다.

호스트 설치는 canonical 볼트를
`${XDG_CONFIG_HOME:-~/.config}/oms/vault.json`에 기록하고 각 관리형
등록에 `oms serve mcp --vault /path/to/vault`를 넣는다.
`oms host install|remove|sync|status`만 이 서명된 포인터로 호스트 통합을
관리한다.
`oms package update`는 패키지만 업데이트하고 호스트를 암묵적으로
동기화하지 않는다. `oms host sync`는 별도로 실행한다.

런타임 쓰기·검색 target 해석은 호스트 관리 포인터를 읽지 않는다.
우선순위는 명시적 target, 로컬 볼트 control, bridge, `OMS_VAULT`, 그리고
안전한 읽기 전용 fallback으로서의 cwd 순서다. 변경 작업은 cwd fallback을
사용할 수 없다.

`OMS_VAULT`는 명시적·로컬·bridge target이 없을 때 사용하는 지원 환경변수 fallback이다.

자세한 내용은 [설치](./docs/install.md), [아키텍처](./docs/architecture.md), [컨벤션](./docs/conventions.md), [검증된 target](./docs/verified-target.md)을 참고한다.
