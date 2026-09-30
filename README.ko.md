<p align="center">
  <img src="./assets/readme/hero.svg" alt="Oh My Second Brain. 흩어진 생각이 연결되는 별자리." width="100%" />
</p>

<h1 align="center">Oh My Second Brain</h1>

<p align="center">
  <strong>흩어진 지식이, 다시 하나의 별자리로.</strong><br />
  Obsidian, Markdown, AI 에이전트를 잇는 사용자 소유의 지식·컨벤션 레이어.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/oh-my-second-brain"><img src="https://img.shields.io/npm/v/oh-my-second-brain?style=flat-square&amp;color=8b9daa&amp;label=npm" alt="npm 버전" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A520-80b89b?style=flat-square" alt="Node.js 20 이상" /></a>
  <a href="#mcp-도구와-에이전트-연결"><img src="https://img.shields.io/badge/MCP-4_tools-97a8b1?style=flat-square" alt="MCP 도구 4개" /></a>
  <a href="https://github.com/GoBeromsu/oh-my-second-brain/blob/main/package.json"><img src="https://img.shields.io/badge/license-MIT-d7c7a8?style=flat-square" alt="패키지 라이선스 MIT" /></a>
</p>

<p align="center">
  <a href="#빠른-시작"><strong>빠른 시작</strong></a> ·
  <a href="#동작-방식">동작 방식</a> ·
  <a href="#문서">문서</a> ·
  <a href="https://github.com/GoBeromsu/oh-my-second-brain/releases">릴리스</a> ·
  <a href="./README.md">English</a>
</p>

---

볼트에는 이미 아이디어, 결정, 배운 것들이 쌓여 있다. **OMS는 에이전트가 그 지식을 되찾고, 내가 정한 규칙 안에서 노트를 쓰도록 돕는다.** 새 노트 형식도, 정해진 폴더 체계도, 특정 호스트로의 지식 이전도 필요 없다.

Obsidian은 사령탑으로 남는다. OMS가 꺼져 있어도 노트는 사람이 읽고 고칠 수 있는 Markdown 파일이다. Claude Code, Codex, Hermes를 각 호스트의 통합 기능으로 같은 볼트에 연결할 수 있다.

## 왜 OMS인가?

<table>
<tr>
<td width="50%" valign="top">
<h3>이미 아는 것을 다시 찾기</h3>
기존 노트를 lexical 검색으로 찾는다. 필요할 때 vector, HyDE, 질의 확장, reranking을 명시적으로 선택한다.
</td>
<td width="50%" valign="top">
<h3>내 볼트의 언어 그대로</h3>
폴더와 속성의 의미는 내가 정한다. OMS가 제시하는 체계를 따르는 대신, 내 컨벤션을 기록한다.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>에이전트가 공유하는 계약</h3>
setup으로 볼트 규약을 봉인한다. 지원되는 쓰기 경로는 저장 전에 노트 전체가 그 계약에 맞는지 확인한다.
</td>
<td width="50%" valign="top">
<h3>파일의 소유권은 그대로</h3>
기존 Markdown 노트와 템플릿을 계속 쓴다. setup은 이 파일들을 다시 쓰지 않으며, 봉인된 계약은 볼트 밖에 둔다.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>호스트를 넘어 연결하기</h3>
Claude Code, Codex, Hermes의 네이티브 통합을 사용한다. MCP 도구 4개와 공통 워크플로 스킬 6개를 제공한다.
</td>
<td width="50%" valign="top">
<h3>추측 대신 상태 확인</h3>
계약 상태, 노트 규약 준수, 색인, wikilink 제안을 확인한다. 검색과 상태 조회는 읽기 전용이다.
</td>
</tr>
</table>

## 빠른 시작

**Node.js 20 이상과 기존 Obsidian 또는 Markdown 볼트가 필요하다.** `/path/to/vault`를 볼트의 절대 경로로 바꾼다.

### 1. 설치

```bash
npm install -g oh-my-second-brain
oms --help
```

### 2. 볼트 규약 정의

터미널에서 setup을 실행한다. 폴더와 속성을 인터뷰한 뒤 계약을 봉인한다. 기존 노트는 수정하지 않는다.

```bash
oms setup --vault /path/to/vault
oms setup status --vault /path/to/vault
```

### 3. 에이전트 연결

사용하는 호스트의 통합 기능을 설치한다.

```bash
oms setup host install --runtime claude --vault /path/to/vault --yes
```

`claude` 대신 `codex` 또는 `hermes`를 쓸 수 있다. 세 호스트를 모두 설치하려면 `all`을 쓴다. Claude Code에서 `--execute`를 붙이면 OMS가 plugin marketplace를 추가하고 `claude plugin install oms@oh-my-second-brain` 명령을 실행해 `/oms:*` 스킬을 설치한다. 붙이지 않으면 직접 실행할 명령을 그대로 보여준다. CLI만 사용한다면 호스트 설치는 선택 사항이다. Hermes 프로필, 모델 설정, 제거 방법은 [설치 가이드](./docs/install.md)를 참고한다.

### 4. 지식 꺼내 쓰기

```bash
# 파생 검색 색인을 명시적으로 만든다.
oms doctor sync-embeddings --mode sync --vault /path/to/vault

# vector 모델 없이 lexical 검색부터 시작한다.
oms search "프로젝트 결정" --vault /path/to/vault
```

**연결한 에이전트에게 이렇게 요청할 수 있다.**

> 이 프로젝트와 관련된 내 노트를 찾아서, 이전에 내린 결정을 보여줘.

> 이 노트가 내 볼트 계약에 맞는지 검사하고, 확인할 부분을 알려줘.

> 파일은 바꾸지 말고, 함께 연결하면 좋을 노트를 제안해줘.

실행 결과를 캡처한 것이 아니라 요청 예시다. 워크플로와 쓰기 검사 범위는 아래의 호스트별 설명을 따른다.

## 동작 방식

**의미는 사용자가 정한다. 내용은 에이전트가 쓴다. 구조는 OMS가 검사한다.**

| 레이어 | 맡는 것 |
| :--- | :--- |
| **나의 볼트** | Markdown 노트, 폴더, 속성, 원본 템플릿. Obsidian이 사령탑으로 남는다. |
| **나의 계약** | `oms setup`에서 확인한 규약. 볼트 밖 `~/.oms/vaults/<vault-id>/`에 봉인한다. |
| **OMS** | 검색, 지원되는 쓰기의 계약 판정, 링크 검사, 명시적인 색인 유지보수. |
| **에이전트** | 맥락을 읽고 노트를 작성하며 호스트에 맞는 워크플로를 쓴다. 보존할 가치는 사용자와 에이전트가 판단한다. |

> [!IMPORTANT]
> **쓰기 검사를 신뢰하기 전에 계약부터 설정한다.** 이 기기에 봉인이 없는 볼트는 계약 판정을 하지 않는다. 일반적인 경로·입력 보호는 그대로 적용된다. 계약을 위반하는 쓰기는 파일을 바꾸지 않는다. 쓰기 허용은 구조 준수를 뜻하며, 사실의 정확성이나 품질 승인이 아니다.

<details>
<summary><strong>볼트 계약 자세히 보기</strong></summary>

- **의미는 사용자 소유다.** 폴더와 속성 pool을 함께 인터뷰한다. 속성 이름·폴더·페르소나를 하드코딩하지 않고 Inbox fallback도 없다.
- **볼트 안의 제어 파일은 하나다.** `.oms/settings.json`에 `version`, `vaultId`, `templateFolder`, `embedding`, `agentRepair`를 둔다. 다른 `.oms/` 항목은 무시하고 `oms doctor contract`가 예상하지 않은 제어 파일로 보고한다. `.obsidian/types.json`은 읽기 전용 관측값이며 봉인을 덮어쓰지 않는다.
- **템플릿은 원본으로 남는다.** 템플릿은 `templateFolder`에 있으며 봉인하거나 판정하지 않는다. 새 노트는 살아 있는 템플릿으로 뼈대를 채운다. 쓰기가 이름을 준 템플릿, 없으면 basename이나 `folder:` 키가 대상 폴더와 맞는 유일한 템플릿이다. 템플릿 파일을 다시 쓰거나 복사하지 않으며, Templater·JavaScript·전용 token 언어를 해석하거나 실행하지 않는다. 쓰기는 작성 중인 노트의 기계적인 부분만 채운다. `{{title}}`·`{{date}}`·`{{time}}` 변수, 새 노트의 date·datetime 기본값, 선택한 템플릿의 frontmatter 기본값과 빠진 heading이다. 노트에 이미 있는 값이 우선한다. 필수 값을 대신 채우지는 않는다.
- **이전 봉인도 읽힌다.** 새 봉인은 폴더와 속성만 저장한다. 이전 릴리스가 만든 봉인도 그대로 읽히며, `oms setup status`는 그 템플릿 제약을 `legacyTemplates` 개수로 보고할 뿐 강제하지 않는다.
- **판정자는 하나다.** 거부 시 `{field, kind}` 위반과 안내 명령 하나만 반환한다. 규칙 값, 저장소 경로, 계약 본문은 반환하지 않는다.
- **봉인 증거가 맞지 않으면 쓰기를 거부한다.** 이 기기의 증거가 볼트와 어긋나면 `contract-unreadable`로 거부하고 소유자가 `oms setup`을 다시 실행해야 한다. 봉인이 아예 없는 기기에서는 판정하지 않는 것과 구별한다.

[아키텍처](./docs/architecture.md), [컨벤션](./docs/conventions.md), [ADR-007](https://github.com/GoBeromsu/oh-my-second-brain/blob/main/docs/decisions/ADR-007-vault-contract-ontology.md)을 참고한다.

</details>

<details>
<summary><strong>설정, 템플릿 뼈대, 복구</strong></summary>

터미널에서 `oms setup`을 실행하면 대화형 인터뷰를 거쳐 계약을 봉인한다. `oms interview`는 같은 터미널 인터뷰를 독립 명령으로 제공하며, 터미널이 필요하고 `OMS_NON_INTERACTIVE=1`이면 실행을 거부한다.

`setup` 스킬은 `oms setup --questions`로 질문을 받아 소유자에게 하나씩 묻고, `oms setup --answers <file|->`로 답을 제출한다. 이 경로는 첫 봉인이나 더 엄격한 계약만 봉인하며, 계약을 느슨하게 하는 재봉인은 소유자의 터미널에서 한다. MCP `interview` 도구는 여러 호출에 걸쳐 인터뷰를 이어 간다. `op: questions`는 읽기 전용이고, `answer`, `confirm`, `seal`은 검증된 대상의 인터뷰 로그에 기록한다. 소유자가 확인한 제안만 봉인하며 오래된 seal lock을 회수하지 않는다.

setup과 인터뷰는 폴더와 속성만 묻는다. `oms setup extract --template <name>`은 `templateFolder`의 템플릿이 채울 뼈대(원본 경로, `folder:` 선택자, 속성 이름, heading)를 미리 보여 준다. 템플릿을 고치면 재봉인 없이 다음 쓰기부터 반영된다.

`oms doctor contract`는 봉인, 오래된 lock, 고아 generation, 예상하지 않은 제어 파일, hook 전송 실패를 진단한다. `--fix`는 이동했거나 색인되지 않은 볼트를 다시 색인할 뿐이다. 다른 봉인 문제는 `oms setup`으로 복구한다.

모델 수명주기는 별도다: `oms setup model install|select|waive|status`.

</details>

## MCP 도구와 에이전트 연결

**하나의 도메인 커널, 호스트에 맞는 연결 방식.**

`write` · `search` · `interview` · `doctor`

| MCP 도구 | 역할 |
| :--- | :--- |
| `write` | 노트 전체를 봉인된 계약으로 판정하고 허용된 쓰기를 저장한다. |
| `search` | 볼트를 바꾸지 않고 노트, 구조화된 맥락, wikilink 제안을 찾는다. |
| `interview` | 볼트 인터뷰 질문과 봉인 상태를 보여 준다. 아무것도 봉인하지 않는다. |
| `doctor` | 읽기 전용 `status`, 계약 진단, 노트 감사, 링크 검사, 명시적인 색인 유지보수를 수행한다. |

6개 스킬은 `distill`, `doctor`, `interview`, `search`, `setup`, `write`다.

`distill`과 `setup`은 대응 MCP 도구가 없는 워크플로다. 봉인에는 MCP 작업이 없고, 세부 기능은 네 도구 아래의 `op` 값으로 제공한다. 도구 annotation은 도구별로 정한다. `write`와 `doctor` 복구는 변경을 일으키고 `interview`는 보수적으로 두므로 읽기 전용으로 표시한 도구는 `search`뿐이다.

| 호스트 | 통합 방식 | 쓰기 검사 |
| :--- | :--- | :--- |
| **Claude Code** | 네이티브 plugin asset, 스킬, MCP | MCP `write`와 기본 Write·Edit·MultiEdit·NotebookEdit용 `oms hook pre`. |
| **Codex** | 네이티브 plugin asset, 가이드, MCP | MCP `write`만 검사. 기본 쓰기 hook은 없다. |
| **Hermes** | 프로필별 스킬, 가이드, MCP | MCP `write`만 검사. 기본 쓰기 hook은 없다. |

> [!NOTE]
> Claude hook은 판정된 계약 위반을 거부하지만, hook 자체를 실행할 수 없으면 경고와 함께 쓰기를 허용한다. Codex와 Hermes의 기본 파일 쓰기는 OMS 판정자를 거치지 않는다. 파일시스템 전체를 통제하는 sandbox가 아니다.

<details>
<summary><strong>호스트 유지보수와 볼트 선택</strong></summary>

호스트 설치는 `${XDG_CONFIG_HOME:-~/.config}/oms/vault.json`에 서명된 유지보수 포인터를 기록하고, 관리하는 호스트 항목에 `oms serve mcp --vault /path/to/vault`를 설정한다. `oms setup host install|remove|sync|status`만 이 포인터로 통합을 유지보수한다.

런타임은 이 포인터를 읽지 않는다. 우선순위는 **명시적 target → 로컬 볼트 제어 파일 → bridge → `OMS_VAULT` → 현재 디렉터리**다. 현재 디렉터리 fallback은 읽기 전용으로, 봉인·노트 쓰기·파생 상태 복구에는 쓸 수 없다.

`oms setup package update`는 패키지만 갱신한다. 설치된 호스트 asset은 `oms setup host sync`로 따로 동기화한다. [검증된 target](./docs/verified-target.md)을 참고한다.

</details>

## 필요한 방식으로 검색

**기본은 lexical. 추가 검색 채널은 직접 선택한다.** 계약을 통과하지 못하는 노트도 검색에 포함한다. 계약이 없거나 손상되어도 검색은 멈추지 않는다.

| 기능 | 선택 방법 | 필요 조건 |
| :--- | :--- | :--- |
| Lexical 검색 | `oms search <text>` | vector 모델 불필요. |
| Vector 검색 | `--vec <text>` | 완전한 `OMS_EMBEDDING_PROVIDER` / `OMS_EMBEDDING_MODEL` 쌍. |
| HyDE | `--hyde <text>` | embedding 쌍과 `OMS_GENERATE_PROVIDER` / `OMS_GENERATE_MODEL`. |
| 질의 확장 | `--expand` | 명시적인 G004 확장. `--max-queries`는 1–32. |
| Reranking | `--rerank` | 완전한 `OMS_RERANK_PROVIDER` / `OMS_RERANK_MODEL` 쌍. |

모델 선택이 없거나 불완전하거나 설치되지 않았다면 다른 기능으로 조용히 대체하지 않고 오류를 알린다. 사용 가능한 검색 선택지이며, 다른 엔진과의 동등성이나 우월성을 주장하지 않는다.

구조화된 맥락은 `oms search --context`, 노트 하나를 정확히 읽을 때는 `oms search --path <note>`를 쓴다. 색인 작업은 명시적으로 실행하며 `oms doctor sync-embeddings --mode sync|embed|repair`는 서로 다른 세 모드 중 하나를 고른다. 전체 작업은 [CLI 맵](./docs/cli-map.md)을 참고한다.

## CLI 레퍼런스

`oms`는 `oh-my-second-brain`의 짧은 별칭이며 CLI family는 7개다. 0.19에서 0.18 family를 교체했다. [0.19 마이그레이션 가이드](./docs/migration-0.19.md)를 참고한다.

```text
oms search <text>                               노트 검색. 기본은 lexical
oms search --path|--context|--link              노트 하나 읽기, 맥락 조회, 링크 제안
oms interview                                   터미널에서 볼트 소유자를 인터뷰하고 봉인
oms write <path>                                계약이 허용하면 stdin의 노트를 저장
oms setup                                       계약 봉인 (에이전트는 --questions/--answers)
oms setup extract|status                        템플릿 뼈대 미리보기 또는 계약 상태 표시
oms setup host install|remove|sync|status       호스트 asset과 MCP 등록 관리
oms setup model install|select|waive|status     로컬 모델 선택 관리
oms setup package check|update                  OMS 패키지 확인 또는 갱신
oms setup bridge add|remove|status              저장소-볼트 bridge 관리
oms doctor status                               읽기 전용 볼트 상태 표시
oms doctor contract|audit|link-check            계약, 노트, wikilink 진단
oms doctor sync-embeddings|cleanup|build-graph  파생 색인과 그래프 유지보수
oms serve mcp|http                              MCP 또는 로컬 HTTP 서버 시작
oms hook pre                                    Claude 쓰기를 계약으로 판정
```

<details>
<summary><strong>명령 동작과 폐기된 작업</strong></summary>

인식되는 모든 명령은 `--help`와 `-h`를 받으며 exit 0, 부작용 없음으로 끝난다. 알 수 없는 명령과 `--help`를 함께 쓰면 exit 1이다. 0.19에서 제거된 family는 exit 1로 끝나며 대체 명령을 알려 준다.

`oms doctor audit`는 노트를 다시 쓰지 않고 `{path, field, kind}` 항목을 보고한다. 노트는 `oms write <path> < note.md` 또는 MCP `write {path, content, template?, ifMatch?, check?}`로 전체 내용을 쓴다. 둘 다 같은 쓰기 파이프라인을 거친다. 선택 사항인 `template`은 새 노트의 뼈대를 채울 `templateFolder`의 템플릿 이름이다. 기존 노트를 덮어쓰려면 현재 `sha256:` revision을 `ifMatch`(`--if-match`)로 넘겨야 하고, `check`(`--check`)는 디스크를 건드리지 않고 판정만 한다. 허용된 쓰기는 새 revision이 담긴 receipt를 돌려주고, 엔진 저장소가 있으면 같은 호출에서 키워드 인덱스를 갱신하므로 노트를 바로 검색할 수 있다. 완료 호출이나 리뷰어 대화는 없다.

`oms doctor cleanup`은 제거 가능한 파생 상태를 지운다. `oms doctor build-graph`는 노트 그래프를 다시 만든다.

노트 `create`, `append`, `update`, `backfill`은 폐기된 작업이다. `link apply`, 노트 렌더러, 폐기된 작업을 위한 호환 경로는 없다.

</details>

## 문서

| 시작하기 | 더 알아보기 |
| :--- | :--- |
| [설치](./docs/install.md): 설치, setup, 모델, 제거 | [아키텍처](./docs/architecture.md): 권위와 도메인 경계 |
| [볼트 컨벤션](./docs/conventions.md): 설정과 봉인된 계약 | [CLI 맵](./docs/cli-map.md): 명령과 MCP 작업 매핑 |
| [호스트 통합](./docs/adapters.md): Claude Code, Codex, Hermes | [검증된 target](./docs/verified-target.md): 안전한 볼트 선택 |
| [릴리스](https://github.com/GoBeromsu/oh-my-second-brain/releases): 배포 버전 | [변경 이력](./CHANGELOG.md): 무엇이 왜 달라졌는가 |

## 기여와 크레딧

[기여 가이드](https://github.com/GoBeromsu/oh-my-second-brain/blob/main/CONTRIBUTING.md)를 읽거나, 재현 가능한 문제와 구체적인 제안을 [이슈](https://github.com/GoBeromsu/oh-my-second-brain/issues)로 남길 수 있다.

[ACKNOWLEDGMENTS](./ACKNOWLEDGMENTS.md)는 [Ouroboros](./ACKNOWLEDGMENTS.md#ouroboros), [Gajae Code](./ACKNOWLEDGMENTS.md#gajae-code)의 deep-interview 등 설계에 영향을 준 아이디어를 기록한다. runtime 복제나 연구 결과를 뜻하지 않는다. 별자리 배너는 [beomsukoh.com](https://beomsukoh.com/)의 연결된 노트 풍경에서 착안한 자체 제작 일러스트다. 이미지는 개념을 설명하는 도식이며 제품 화면, host smoke 증거, 제품 gate 통과 결과가 아니다.

---

<p align="center">
  <strong>노트의 주인은 계속 나다.</strong><br />
  Built by <a href="https://github.com/GoBeromsu">Beomsu Koh</a> · Package licensed MIT
</p>
