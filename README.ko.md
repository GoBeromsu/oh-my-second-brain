# Oh My Second Brain

> Obsidian 및 일반 마크다운 지식 볼트를 위한, 호스트에 종속되지 않고 사용자가 소유하는 컨벤션 레이어.

[English](./README.md) · **한국어**

[![npm](https://img.shields.io/npm/v/oh-my-second-brain)](https://www.npmjs.com/package/oh-my-second-brain)
![license](https://img.shields.io/npm/l/oh-my-second-brain)

Oh My Second Brain(`oms`)은 기존 Obsidian/마크다운 볼트를 에이전트가 읽을 수 있는 지식 베이스로 만든다. 볼트가 가진 고유한 폴더/프론트매터 컨벤션을 로드하고, 그에 맞게 노트를 검증하고, 로컬 링크 그래프를 만들고, 이 모든 것을 단일 MCP 서버를 통해 AI 코딩 호스트(Claude Code, Codex, Hermes)에 노출한다. 특정 호스트에 종속되지 않으며 노트를 다른 곳으로 옮기지도 않는다.

**컨벤션 우선, 사용자 소유**가 원칙이다. 볼트는 그대로 일반 마크다운으로 남고, 온톨로지는 사용자가 통제하는 커밋된 `.oms/` 폴더에 살며, 어떤 것도 독점 저장소 뒤에 숨지 않는다.

## 동작 방식

```
core (한 번만 작성)                        adapters (호스트마다 하나)
  온톨로지 로딩                              claude-code  .claude-plugin + CLAUDE.md   /sigil
  컨벤션 검증                    +           codex        .codex-plugin + AGENTS.md    $sigil
  그래프 + 시맨틱 런타임                      hermes       manifest.json + SOUL.md      (MCP/tools)
  MCP 서버 (capture/retrieve/validate)
```

- **core**는 호스트에 독립적이다: 온톨로지, 검증, 그래프/시맨틱 엔진, MCP 서버.
- 각 **adapter**는 호스트 하나의 구조적 차이(매니페스트 스키마, 컨벤션 파일, 호출 sigil)만 흡수한다. 호스트를 추가한다는 건 core를 건드리는 게 아니라 adapter 디렉터리 하나를 더하는 일이다.
- 호스트 간 연결 메커니즘은 모든 호스트가 함께 쓰는 단일 **MCP 서버**(`oms mcp`)다.

## 요구 사항

- Node.js 20 이상
- `PATH`에 `npm`
- Obsidian 볼트 또는 마크다운 노트 폴더
- (선택) 호스트 CLI: `claude`, `codex`, `hermes`
- (선택) [시맨틱 검색](#시맨틱-검색-선택)용 임베딩 백엔드

## 설치

원라인 설치(게시된 npm 패키지 사용):

```bash
curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash
```

호스트를 선택하고 볼트를 지정:

```bash
curl -fsSL https://raw.githubusercontent.com/GoBeromsu/oh-my-second-brain/main/scripts/install.sh | bash -s -- --runtime all --vault /path/to/vault
```

또는 npm으로:

```bash
npm install -g oh-my-second-brain
oms install --runtime all --vault /path/to/vault --dry-run   # 미리보기
oms install --runtime all --vault /path/to/vault --yes       # 적용
```

전체 가이드: [docs/install.md](./docs/install.md).

## 호스트

| 호스트 | 매니페스트 | 컨벤션 파일 | Sigil | 상태 |
|------|----------|-----------|-------|--------|
| **claude-code** | `.claude-plugin/plugin.json` | `CLAUDE.md` | `/` | 설치 가능 |
| **codex** | `.codex-plugin/plugin.json` | `AGENTS.md` | `$` | 네이티브 스킬 + MCP |
| **hermes** | `manifest.json` | `SOUL.md` | (MCP/tools) | 네이티브 스킬 + MCP |

`oms install`은 호스트 네이티브 규칙/스킬과 관리형 `oms` MCP 등록을 작성하며, `oms uninstall`로 되돌릴 수 있다.

## CLI

```
oms setup      기존 볼트를 컨벤션으로 채택 (.oms/taxonomy.yaml 작성, 노트는 수정하지 않음)
oms install    호스트 어댑터 + MCP 등록 설치
oms uninstall  호스트 어댑터 + MCP 등록 제거
oms update     패키지 업데이트 확인/적용 후 어댑터 재조정
oms doctor     온톨로지 기준으로 노트 frontmatter 검증 (필드/컨셉별 집계)
oms lint       볼트 링크 건강도 점검: 깨진 [[wikilink]] + 고아 노트
oms semantic   네이티브 마크다운 시맨틱 인덱스 / 검색 / 조회
oms mcp        stdio MCP 서버 시작
oms hook       볼트 가드 훅 (Claude Code pre/post tool-use)
```

`oh-my-second-brain`이 정식 명령이고, `oms`는 짧은 별칭이다.

## MCP 도구

`oms mcp`는 정확히 다섯 개의 공개 도구를 노출한다:

`oms_write` · `oms_search` · `oms_link` · `oms_status` · `oms_doctor`

`oms_write`는 경로 안전성, 볼트 격리, 커널이 소유한 컨셉 계약으로 게이트된다.

## 볼트 구조 (`.oms/`)

`oms setup`은 볼트를 커밋된 `.oms/` 폴더로 채택하며, 두 개의 레이어를 둔다(ADR-006):

- **Contract (기계 검증)** — `taxonomy.yaml`(폴더 → intent → concept)와 `concepts/*.yaml`(노트 타입별 프론트매터 선언). `vault-lint`와 `oms_validate_contract`가 강제한다.
- **Governance (사람 의도)** — `governance/`의 ADR과 규칙. 기계가 파싱하지 않는다.
- `.oms/cache/`에는 파생 그래프/임베딩 아티팩트가 들어간다. 정식 파생 SQLite 저장소는 `.oms/engine-store.sqlite`이며, 프로덕션 기본값은 이 커널 소유 단일 경로를 사용한다.
- `setup`은 `/engine-store.sqlite*` 항목으로 `.oms/.gitignore`를 멱등적으로 관리하면서 기존 항목과 줄 끝을 보존한다. 이는 저장소 DB와 WAL/SHM 사이드카만 무시하며 `.oms/` 전체를 무시하지 않는다. dry-run을 포함한 setup 영수증은 이 파일을 작성했는지 또는 작성할지를 알린다.

`setup`은 `.oms/taxonomy.yaml`을 작성하고 기존 `.oms/concepts/`를 보존하며, 노트는 절대 수정하지 않는다. 저장소 마이그레이션, 이중 읽기, 호환 별칭은 없으므로 기존 파생 저장소를 다시 만들어야 하면 `oms embed`를 실행한다.

## 시맨틱 검색 (선택)

시맨틱 검색에는 실제로 구성된 모델 아티팩트가 필요하다 — 프로덕션 경로에 가짜/해시 폴백은 없다(ADR-007). 가장 간단한 경로는 핀 고정된 로컬 기본 모델이다:

```bash
oms setup --vault /path/to/vault --yes --models-default
oms embed  --vault /path/to/vault
oms semantic vsearch "무엇을 찾아야 하나?" --vault /path/to/vault
```

`--models-default`는 편의용으로 핀 고정된 EmbeddingGemma-300M 기본 모델(약 318 MB)을 내려받아 불변 revision과 SHA-256으로 검증한 뒤, 볼트가 아니라 사용자 캐시 디렉터리에 설치한다. `node-llama-cpp`로 로컬 실행되므로 API 키가 필요 없고, 모델 원본 768차원을 폴딩 없이 그대로 사용한다. 이후 `oms embed`와 벡터 검색은 환경변수 없이 동작한다.

`oms setup --models-descriptor <path>`는 사용자 지정 SHA-256 검증 모델 세트를 설치한다. 이 descriptor는 Qwen3 임베딩 모델과 선택적 rerank/generate capability를 제공할 수 있다. setup은 portable한 `.oms/models.json` schema version 1을 작성한다. 여기에는 필수 `embed`와 선택 `rerank`/`generate` 선택 항목의 provider, model, revision, SHA-256, 적용되는 prompt scheme만 들어간다. 절대 경로를 포함한 아티팩트 경로, 다운로드 URL, 가중치, 설치된 아티팩트 영수증은 사용자 캐시에 남으며 볼트 설정에는 들어가지 않는다.

capability 해석 순서는 엄격하다: request, 완전한 환경변수 쌍, 볼트 설정, setup 기본값, unavailable 순이다. 환경변수 쌍은 `OMS_EMBEDDING_PROVIDER` + `OMS_EMBEDDING_MODEL`, `OMS_RERANK_PROVIDER` + `OMS_RERANK_MODEL`, `OMS_GENERATE_PROVIDER` + `OMS_GENERATE_MODEL`이다. 환경변수의 model 값은 임의의 로컬 경로가 아니라 검증된 설치 아티팩트를 식별해야 한다. 반쪽짜리 쌍 또는 더 높은 우선순위의 잘못된 소스는 필요한 조치를 알리며 실패하고, 폴백하지 않는다.

Qwen3 임베딩은 원본 문서 텍스트를 사용하고, 제목이 있으면 `title\ntext`를 사용한다. 쿼리는 정확히 `Instruct: Retrieve relevant documents for the given query\nQuery: <query>` 형식을 사용한다. EmbeddingGemma는 별도의 기존 프롬프트 형식을 유지한다. reranking은 계속 명시적 opt-in이다. 생략하거나 `false`이면 reranker를 불러오지 않고, opt-in 요청에서는 구성된 reranker를 지연 해석하며 capability가 없으면 명확히 실패한다.

일반 `oms semantic query`와 `oms semantic search`는 lexical-only이므로 모델 없는 어휘 검색도 계속 가능하다. `--vec`와 `vsearch`는 embed capability를 요구한다. `--hyde`는 두 capability를 요구한다 — 가설 문서를 작성할 generate 모델과 그것을 임베딩할 embed 모델이다. 원본 질의를 그대로 임베딩하는 폴백은 없다. 일반 벡터 검색을 HyDE 이름으로 보고하는 것은 실행된 내용을 잘못 알리는 일이기 때문이다. 사용할 수 없는 capability는 각자의 구성 방법을 알리며, 명시적인 rerank 요청도 rerank remedy를 알린다. 벡터 마이그레이션은 없다. 모델 identity, prompt scheme, revision, checksum을 바꾸면 벡터를 삭제하고 `oms embed`로 다시 빌드해야 한다.

## 개발

```bash
npm install
npm run build
npm test
npm run release:check   # lint + build + test + audit + pack + artifact-smoke + plugin 검증
```

릴리스 절차: [docs/release.md](https://github.com/GoBeromsu/oh-my-second-brain/blob/main/docs/release.md).

## 라이선스

MIT. 상위 출처 크레딧은 [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md) 참고.
