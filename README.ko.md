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
- `.oms/cache/`(파생 그래프/임베딩 아티팩트)는 gitignore된다.

`setup`은 `.oms/taxonomy.yaml`을 작성하고 기존 `.oms/concepts/`를 보존하며, 노트는 절대 수정하지 않는다.

## 시맨틱 검색 (선택)

시맨틱 검색에는 실제 임베딩 모델이 필요하다 — 프로덕션 경로에 가짜/해시 폴백은 없다(ADR-007). 가장 간단한 경로는 핀 고정된 로컬 기본 모델이다:

```bash
oms setup --vault /path/to/vault --yes --embedding-default
oms embed  --vault /path/to/vault
oms semantic vsearch "무엇을 찾아야 하나?" --vault /path/to/vault
```

`--embedding-default`는 EmbeddingGemma-300M(약 318 MB)을 내려받아 핀 고정된 SHA-256으로 검증한 뒤, 볼트가 아니라 사용자 캐시 디렉터리에 설치한다. `node-llama-cpp`로 로컬 실행되므로 API 키가 필요 없고, 모델 원본 768차원을 폴딩 없이 그대로 사용한다. 이후 `oms embed`와 벡터 검색은 환경변수 없이 동작한다.

의존하기 전에 알아둘 점이 하나 있다. 이 모델과 프롬프트 형식은 [qmd](https://github.com/tobi/qmd)가 기본으로 쓰는 것과 동일하지만, 이 프로젝트의 자체 검색 하네스에서 측정된 적은 한 번도 없다. 여기서의 랭킹 품질은 대안과의 측정 비교가 아니라 그 동일성에 근거한다. 그 이유와, 해당 측정이 단순히 '보류 중'이 아닌 이유는 [결정 기록](https://github.com/GoBeromsu/oh-my-second-brain/blob/main/docs/measurements/model-default-deferral.md)에 적혀 있다.

직접 고른 모델을 쓰려면 `OMS_EMBEDDING_PROVIDER`와 `OMS_EMBEDDING_MODEL`을 함께 지정한다(`gguf`에 로컬 GGUF 경로, 또는 `upstage`에 모델 id와 `UPSTAGE_API_KEY`). 둘 중 하나만 지정하면 두 변수 이름을 모두 알려주며 실패한다. 조용한 폴백은 없다.

모델이 없어도 어휘 검색, 그래프 기반 검색, 컨벤션 검증은 그대로 동작한다. 벡터와 HyDE 요청만 거부되며, 그때 어떤 변수를 설정해야 하는지 알려준다.

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
