---
title: "gajae-code 코드 패턴 마이닝"
slug: gajae-code-patterns-mining
date: 2026-06-13
type: research
status: active
tags: [research, patterns, engineering, reference]
---

# gajae-code 코드 패턴 마이닝

> 파쿠리(破り) 노트 — 제품을 복사하는 것이 아니라, 그들이 해결한 엔지니어링 문제와 그 방법을 흡수한다.

---

## §1 Repo 개요 + 라이선스 + 서비스 차이

### 라이선스 (VERIFIED)

**MIT License** — `vendor/reference-repos/gajae-code/LICENSE`

```
Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
```

NOTICE.md 에 명시된 lineage: `oh-my-pi` → `oh-my-codex` → `oh-my-claudecode` → `gajae-code`.
저자 Yeachan-Heo 는 contributor 이며, 원본 저작권자는 Can Bölük (can1357).
MIT이므로 아이디어/패턴 흡수 및 코드 참조 모두 가능. Attribution은 §5 참조.

### 서비스 정체

gajae-code (`gjc`)는 **GitHub 이슈 자동 처리 봇 + 외부 coding-agent harness**이다.

```
GitHub Webhook → FastAPI server
  → SQLite 큐 → WorkerPool dispatcher
    → sandbox (slot UID isolation)
      → gjc subprocess (stdio JSON-RPC)
        → LLM (Anthropic/OpenAI/Gemini…)
```

주요 구성:
- `python/robogjc/` — Python 오케스트레이터 (webhook 수신, 큐, 워커, sandbox)
- `python/gjc_rpc/` — Python RPC client (gjc 프로세스 stdio 제어)
- `packages/coding-agent/` — TypeScript CLI (`gjc` binary)
- `packages/ai/` — 멀티 프로바이더 스트리밍 추상화
- `packages/agent/` — stateful agent loop + compaction
- `crates/` — Rust N-API native layer (shell, PTY, grep, AST)

### 우리와의 차이

| 항목 | gajae-code | 우리 엔진 (oh-my-secondbrain) |
|------|-----------|-------------------------------|
| 도메인 | GitHub 이슈 자동 처리 | 개인 지식 ingest/index/retrieve/distill |
| 입력 | GitHub webhook 이벤트 | 파일/메모/문서 ingest |
| 상태 모델 | **stateful** — per-issue 세션, JSONL transcript | **stateless** — 각 invocation 독립 |
| 저장소 | SQLite 이벤트 큐 + worktree sandbox | pgvector / sqlite-vec + Obsidian vault |
| 실행 모델 | long-running daemon, subprocess 관리 | MCP stdio server, manual invocation |
| 동시성 | OS-uid slot pool (sandbox isolation) | 배치 처리 (embedding pipeline) |
| LLM 역할 | agent (코드 작성, PR 오픈) | retrieval + distillation |

**결론**: 제품은 전혀 다르다. 하지만 **비동기 큐, 취소 토큰, content-addressed 캐시, retry policy, config 패턴, 스트리밍 추상화** 등 엔지니어링 레이어는 직접 흡수 가능하다.

---

## §2 흡수할 코드 패턴

### P-01 | asyncio 단일 dispatcher + per-task 병렬화

**[SHIPPED-IN-CODE @ python/robogjc/src/queue.py:130-170]**

```python
# 단일 dispatch loop, 동시성은 SlotPool/Semaphore가 게이팅
async def _dispatch_loop(self) -> None:
    while not self._stop.is_set():
        row = await self._claim_next_unique()
        if row is None:
            self._wakeup.clear()
            try:
                await asyncio.wait_for(self._wakeup.wait(), timeout=10.0)
            except TimeoutError:
                pass
            continue
        task = asyncio.create_task(self._run_event(row), ...)
        self._inflight_tasks[task] = row.delivery_id
        task.add_done_callback(lambda t: self._inflight_tasks.pop(t, None))
```

- N개 worker thread 대신 **단일 dispatcher + asyncio.create_task** 패턴
- `_wakeup: asyncio.Event`로 폴링 없이 새 작업 시그널 수신
- 10초 timeout으로 stuck 방지

**우리 적용**: embedding batch pipeline에서 단일 dispatcher가 ingest 큐를 드레인하고 embed/store를 asyncio.create_task로 병렬 처리.

---

### P-02 | SlotPool — asyncio.Queue 기반 리소스 풀

**[SHIPPED-IN-CODE @ python/robogjc/src/slot_pool.py:1-43]**

```python
class SlotPool:
    def __init__(self, slot_uids: Iterable[int] = ()) -> None:
        self._available: asyncio.Queue[int] = asyncio.Queue()
        for slot_uid in self._slot_uids:
            self._available.put_nowait(slot_uid)

    async def acquire(self) -> int | None:
        slot_uid = await self._available.get()  # blocks until available
        self._checked_out.add(slot_uid)
        return slot_uid

    def release(self, slot_uid: int | None) -> None:
        self._checked_out.remove(slot_uid)
        self._available.put_nowait(slot_uid)
```

- `asyncio.Queue` 하나로 bounded pool 구현 — semaphore보다 explicit (어떤 슬롯인지 알 수 있음)
- `_checked_out: set` 으로 double-release 검출

**우리 적용**: embedding worker pool (EmbeddingGemma 병렬 슬롯 제한), pgvector upsert connection pool.

---

### P-03 | ContextVar 취소 토큰 — thread-safe 비동기 취소

**[SHIPPED-IN-CODE @ python/robogjc/src/cancellation.py:1-68]**

```python
_current_event: contextvars.ContextVar[tuple[_CancelSink, str] | None] = \
    contextvars.ContextVar("robogjc_current_event", default=None)

def register_cancel_hook(hook: Callable[[], None]) -> None:
    ctx = _current_event.get()
    if ctx is None:
        return  # safe no-op
    sink, delivery_id = ctx
    sink._arm_cancel(delivery_id, hook)
```

- `asyncio.to_thread()` 는 현재 context를 복사하므로 ContextVar가 worker thread에도 전파됨
- dispatcher가 `set_current_event(pool, delivery_id)`로 스코프 오픈 → worker가 `register_cancel_hook(fn)`으로 취소 hook 등록 → API가 `cancel_event(delivery_id)` 호출
- hook 등록 전에 취소 요청이 오면 즉시 실행하는 late-arm 패턴 (queue.py:212-220)

**우리 적용**: long-running embedding/retrieval 작업에서 MCP 클라이언트 disconnection 시 진행 중인 작업 취소.

---

### P-04 | 3단계 graceful shutdown (drain → kill → mark-for-requeue)

**[SHIPPED-IN-CODE @ python/robogjc/src/queue.py:72-130]**

```python
async def stop(self, *, drain_timeout: float = 25.0, kill_timeout: float = 5.0) -> None:
    self._shutting_down = True
    self._stop.set()
    # 1. dispatcher 중지
    for worker in self._workers:
        worker.cancel()
    # 2. in-flight drain
    _, still_running = await asyncio.wait(pending, timeout=drain_timeout)
    if not still_running:
        return
    # 3. kill + mark shutdown-cancelled (not failed!)
    for task in still_running:
        self._shutdown_cancelled.add(delivery_id)
        hook = self._cancel_hooks.pop(delivery_id, None)
        if hook:
            await asyncio.to_thread(hook)  # subprocess kill
        else:
            task.cancel()
```

**핵심 insight**: shutdown으로 중단된 row는 `failed`가 아니라 `running` 상태 유지 → 재시작 시 `reset_stuck_running()`이 `queued`로 되돌림. 일반 실패와 shutdown 중단을 `_shutdown_cancelled` set으로 구분.

**우리 적용**: MCP server SIGTERM 처리 — 진행 중인 embed/index 작업을 graceful하게 중단하고 checkpoint 저장.

---

### P-05 | SQLite WAL + IMMEDIATE 트랜잭션 큐

**[SHIPPED-IN-CODE @ python/robogjc/src/db.py:35-45, 175-210]**

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;  -- durability without write stall
PRAGMA foreign_keys = ON;
```

```python
@contextmanager
def _txn(self) -> Iterator[sqlite3.Connection]:
    with self._lock:  # threading.RLock
        self._conn.execute("BEGIN IMMEDIATE")
        try:
            yield self._conn
            self._conn.execute("COMMIT")
        except BaseException:
            self._conn.execute("ROLLBACK")
            raise
```

- `claim_next_event()` 가 `BEGIN IMMEDIATE`로 atomic dequeue (FIFO by `received_at`)
- `attempts` 컬럼으로 재시도 횟수 추적
- 스키마 migration: `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` (idempotent forward-only)
- `tool_calls` 테이블로 모든 tool 호출 audit trail 기록

**우리 적용 (stateless 버전)**: sqlite-vec 기반 job 큐 (ingest checkpoint, incremental indexing). WAL mode는 동일 적용. 단, stateless이므로 `attempts` 같은 per-session 상태는 불필요.

---

### P-06 | pydantic-settings Config + 비밀값 정규화

**[SHIPPED-IN-CODE @ python/robogjc/src/config.py:1-100]**

```python
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    github_token: SecretStr | None = Field(None, alias="GITHUB_TOKEN")

    @field_validator("github_token", mode="before")
    @classmethod
    def _blank_token_disables(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None  # empty string → None (not SecretStr(""))
        ...

    @model_validator(mode="after")
    def _validate_proxy_or_pat(self) -> Settings:
        # 상호 배타적 설정 검증 (PAT vs proxy — not both)
        ...
```

```python
@cache
def get_settings() -> Settings:
    return Settings()

def reset_settings_cache() -> None:
    get_settings.cache_clear()  # for tests
```

**핵심 패턴들**:
- 빈 문자열 env var → None 정규화 (empty `GITHUB_TOKEN=""` 가 `SecretStr("")` 로 남으면 보안 버그)
- `@model_validator`로 cross-field 상호 배타 검증
- `@cache` singleton + 테스트용 `cache_clear()`
- `model_pool: tuple[str, ...]` = 콤마 구분 env var, `pick_model()` random 선택으로 load balancing
- 별도 `_ProxyEnvLoader` + `model_construct()` 패턴: 서브셋 설정을 validator 우회해서 생성

**우리 적용**: `OMS_EMBEDDING_MODEL`, `OMS_PG_DSN` 등 MCP server 설정에 동일 패턴 적용. 빈 문자열 → None 정규화 필수.

---

### P-07 | content-addressed 캐시 (git tree-hash 기반)

**[SHIPPED-IN-CODE @ python/robogjc/src/natives_cache.py:80-130]**

```python
CACHE_KEY_PATHS: tuple[str, ...] = (
    "crates", "Cargo.lock", "Cargo.toml",
    "rust-toolchain.toml", "packages/natives",
)

def compute_key(repo_dir: Path, *, target: str | None = None) -> str:
    stdin = "".join(f"HEAD:{p}\n" for p in CACHE_KEY_PATHS)
    proc = subprocess.run(
        ["git", "cat-file", "--batch-check"],
        input=stdin, cwd=str(repo_dir), text=True, capture_output=True, check=True
    )
    h = hashlib.sha256()
    for path, line in zip(CACHE_KEY_PATHS, lines):
        tree_hash = _NULL_TREE_HASH if "missing" in line else line.split()[0]
        h.update(f"{path}\t{tree_hash}\n".encode())
    h.update(f"TARGET\t{tgt}\n".encode())
    return h.hexdigest()
```

**atomic 파일 연산 패턴** [SHIPPED-IN-CODE @ natives_cache.py:185-230]:

```python
def _atomic_link(src: Path, dst: Path) -> None:
    tmp = dst.with_suffix(dst.suffix + f".tmp.{os.getpid()}")
    try:
        try:
            os.link(src, tmp)   # hardlink (COW-safe)
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise
            shutil.copy2(src, tmp)  # cross-filesystem fallback
        os.replace(tmp, dst)    # atomic rename
    finally:
        try: tmp.unlink()       # best-effort cleanup
        except FileNotFoundError: pass
```

**fcntl.flock 협동 잠금** [SHIPPED-IN-CODE @ natives_cache.py:240-255]:
```python
@contextmanager
def _flock(path: Path) -> Generator[IO[bytes]]:
    fh = open(path, "ab+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield fh
    finally:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        fh.close()
```

**hardlink vs copy 구분**: `.node` 바이너리는 hardlink (rename으로 교체되므로 캐시 안전), `.js`/`.d.ts`는 copy (in-place truncate-write로 교체되므로 hardlink 위험).

**우리 적용**: EmbeddingGemma 모델 가중치 캐시, pre-computed embedding 캐시 (document hash → embedding vector). `os.replace` + temp 파일 패턴은 embedding store upsert에도 동일 적용.

---

### P-08 | 두 계층 retry policy (세션-레벨 + 프로바이더-레벨)

**[SHIPPED-IN-CODE @ docs/non-compaction-retry-policy.md — VERIFIED]**

```yaml
# Provider budget (stream/request level)
retry:
  requestMaxRetries: 4    # stream 확립 전 요청 재시도
  streamMaxRetries: 100   # replay-safe transient stream 재시도

# Session budget (turn level)  
retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000
  maxDelayMs: 300000
```

**두 계층 명확한 분리**:
1. **Provider budget**: 네트워크/transport 레벨 (SDK가 처리, stream 확립 전)
2. **Session budget**: turn 레벨 (agent 재시작, context 유지)

**retry 분류 방식**: typed error code가 아닌 **regex string pattern matching** (provider마다 에러 포맷이 달라서). 대상: 429, 500-504, "overloaded", "rate limit", "socket hang up", "timeout" 등.

**context overflow는 retry에서 제외** → 별도 compaction 경로로 분기.

**credential/model fallback**: usage limit 감지 시 다른 model/credential로 전환 후 delay=0으로 즉시 재시도.

**AbortController로 취소 가능한 backoff sleep** [SHIPPED-IN-CODE @ non-compaction-retry-policy.md]:
```typescript
// backoff sleep은 AbortController로 취소 가능
// abort() 가 abortRetry()를 먼저 호출하여 sleep 해제
```

**우리 적용**: `OMS` MCP server의 embedding API 호출 retry. 두 계층 분리 필수 (Gemma local inference timeout vs API rate limit 구분).

---

### P-09 | 스트리밍 이벤트 통합 추상화

**[SHIPPED-IN-CODE @ docs/provider-streaming-internals.md — VERIFIED]**

```
AssistantMessageEvent 통합 형식:
  start
  text_start → text_delta* → text_end
  thinking_start → thinking_delta* → thinking_end
  toolcall_start → toolcall_delta* → toolcall_end
  done(reason: stop|length|toolUse) | error(reason: aborted|error)
```

**delta throttling** [docs/provider-streaming-internals.md]:
- ~50ms 배칭으로 high-frequency delta 이벤트 평탄화
- `type + contentIndex` 매치할 때만 병합 (다른 content block 섞이지 않음)
- non-delta 이벤트는 즉시 flush

**partial tool-call JSON 복구** [SHIPPED-IN-CODE @ packages/ai/src/utils/json-parse.ts — referenced]:
```typescript
// parseStreamingJson():
// 1. JSON.parse 시도
// 2. partial-json 라이브러리 fallback
// 3. 둘 다 실패 → {} (crash 방지)
// 이후 delta 도착시 재시도 → 복구 가능
```

**우리 적용**: 우리의 `oms_semantic_query` MCP tool에서 LLM 스트리밍 응답을 동일한 event triplet 모델로 추상화하면 프로바이더 교체가 투명해짐.

---

### P-10 | Pragma 시스템 — 런타임 오버라이드 DSL

**[SHIPPED-IN-CODE @ python/robogjc/src/pragmas.py:1-140]**

```
@robogjc-bot /model gpt /thinking low
fix the off-by-one in foo()
```

- `/key value` 또는 `/key=value` 형식
- **순수 command line만 파싱** (혼합 라인은 무시) — prose의 `/path/to/file` 이 실수로 파싱되지 않음
- `resolve_model_alias()`: exact match → short-name-after-slash → substring 우선순위
- `resolve_thinking_level()`: alias normalization (`lo`→`low`, `xhi`→`xhigh` 등)
- 파싱된 pragma는 body에서 제거 → agent에게 보이지 않음

**우리 적용**: `oms_retrieve_context` 호출 시 `/model gemma /k 20` 형식의 inline override. MCP tool argument로 전달해도 되지만, 자연어 쿼리 내 pragma가 더 ergonomic.

---

### P-11 | 세션 resumption 패턴 (JSONL append-only)

**[SHIPPED-IN-CODE @ docs/session.md — VERIFIED]**

```python
def _has_prior_session(session_dir: Path) -> bool:
    try:
        return any(session_dir.glob("*.jsonl"))
    except OSError:
        return False

# 세션 존재 시 --continue 플래그로 재시작
extra_args: tuple[str, ...] = ("--continue",) if resuming else ()
```

**JSONL format** [docs/session.md]:
- Line 1: session header (version, id, cwd, timestamp)
- 나머지: `SessionEntry` (type, id, parentId, timestamp)
- **append-only** + `parentId` 트리로 branch navigation
- `leafId` 포인터 이동으로 branch 전환 (파일 수정 없음)
- terminal breadcrumb 파일: `continueRecent()` 가 terminal-scoped 포인터 우선

**compaction entry** [docs/compaction.md]:
- `firstKeptEntryId`로 압축 경계 기록
- 이전 메시지는 summary로 대체, kept entries는 재포함
- context overflow → 자동 compaction (retry 경로와 분리)

**우리 엔진과의 관련성**: 우리는 stateless지만, OMS의 `oms_lazy_load_note`와 `oms_capture_commit` 간의 "in-progress capture" 상태 관리에 checkpoint 파일 패턴 적용 가능.

---

### P-12 | 환경변수 scrubbing (subprocess 보안)

**[SHIPPED-IN-CODE @ python/robogjc/src/worker.py:90-115]**

```python
_SCRUBBED_ENV_KEYS: tuple[str, ...] = (
    "GITHUB_TOKEN",
    "GITHUB_WEBHOOK_SECRET",
    "ROBGJC_REPLAY_TOKEN",
    "ROBGJC_GH_PROXY_HMAC_KEY",
)

def _build_extra_env(settings: Settings) -> dict[str, str]:
    # dict.fromkeys(keys, "") — 빈 문자열로 override (del이 아님!)
    # gjc_rpc가 os.environ 위에 merge하므로 empty string이 실제로 마스킹
    env = dict.fromkeys(_SCRUBBED_ENV_KEYS, "")
    if _AGENT_HOME.is_dir():
        env["HOME"] = str(_AGENT_HOME)
    return env
```

**핵심**: subprocess env에서 비밀값을 삭제하려면 `del`이 아니라 빈 문자열로 **override** 해야 함 (parent env를 merge하는 방식이면 del은 무효).

**우리 적용**: `oms_capture_commit` 이 external tool subprocess를 spawn할 때 OMS_API_KEY 등 scrubbing.

---

### P-13 | 중복 방지 in-flight 세트

**[SHIPPED-IN-CODE @ python/robogjc/src/queue.py:175-200]**

```python
async def _claim_next_unique(self) -> EventRow | None:
    async with self._inflight_lock:
        row = await asyncio.to_thread(self.db.claim_next_event)
        if row is None:
            return None
        key = row.issue_key or row.delivery_id
        if key in self._inflight:
            # 같은 issue가 이미 처리 중 → requeue + 0.5초 sleep
            await asyncio.to_thread(self.db.requeue_event, row.delivery_id, ...)
            await asyncio.sleep(0.5)
            return None
        self._inflight.add(key)
    return row
```

- 동일 issue에 대한 concurrent 처리 방지
- "naive but fine for v1 (small queue)" — 저자 주석
- Lock scope 최소화: claim + inflight check만 lock 내부에서

**우리 적용**: OMS document capture 중 동일 document URL에 대한 중복 ingest 방지.

---

## §3 설계 고민/고려사항

### D-01 | Stateful-or-not 선택 (저자가 명시적으로 고민)

저자는 per-issue JSONL session을 유지한다. `_has_prior_session()`으로 transcript 존재 여부 확인 후 `--continue` 플래그로 이전 세션 재개. 핵심 근거:
- LLM 컨텍스트를 이전 작업의 코드 변경 이력과 함께 재사용
- 실패 시 재시작이 아닌 이어서 진행

**우리의 대응**: 우리는 deliberately stateless. 각 MCP 호출이 독립적이어야 함. 단, `oms_capture_prepare` + `oms_capture_commit` 의 2-phase 패턴은 짧은 session-local 상태가 필요 → 이것은 `prepare`의 반환값에 token으로 인코딩해서 stateless 유지.

### D-02 | SlotPool vs Semaphore 이중 전략

robogjc 는 root 여부에 따라 전략이 분기된다:
```python
if os.geteuid() == 0:
    self._slot_pool = SlotPool(range(2001, 2001 + settings.max_concurrency))
else:
    self._semaphore = asyncio.Semaphore(settings.max_concurrency)
```

Root면 OS uid-level sandbox isolation (각 worker가 다른 uid로 실행), 비root면 단순 semaphore. 이 이분법이 명확하게 코드에 드러남.

**우리의 고민**: local embedding (EmbeddingGemma)는 GPU/CPU 메모리 제한이 실질적 병렬도 cap이다. Semaphore로 충분하지만, 향후 multi-tenant 지원 시 SlotPool 모델 참고.

### D-03 | Retry 분류를 typed error code가 아닌 regex로

저자 주석: *"This is string-pattern classification, not typed provider error codes."*

이유: 프로바이더마다 에러 포맷이 달라서 통합 typed system 만들기 어려움. Regex 분류는 새 프로바이더 추가 시 패턴 추가만으로 확장 가능.

트레이드오프: false positive 가능성 (정상 응답에 "timeout" 단어 포함 시). 실제로는 드물어서 허용.

**우리의 고민**: 우리도 Gemma local + Anthropic API + (미래) Gemini API를 혼용할 예정. 동일하게 regex 분류를 쓰되, local inference (Gemma OOM)는 별도 exception type으로 분류해서 retry 불가 표시.

### D-04 | Context overflow와 retry의 명확한 분리

*"Context-overflow errors are hard-excluded from retry classification"* — context overflow는 retry해도 같은 결과이므로, 별도 compaction 경로로 반드시 분기.

우리 엔진은 LLM에 긴 컨텍스트를 보내지 않으므로 직접적 문제는 없지만, embedding batch size overflow (토큰 제한)와 유사한 문제가 있음 → 동일하게 retry 경로에서 분리, 청킹 경로로 분기.

### D-05 | Shutdown race: "failed" vs "running" 상태 의도적 구분

robogjc 는 shutdown으로 중단된 이벤트를 `failed`가 아닌 `running`으로 둔다. 이유: `reset_stuck_running()`이 재시작 시 `queued`로 복구하여 자동으로 재시도하게 하기 위함.

반면 실제 실패는 `failed`로 명확히 기록하여 대시보드에서 구분 가능.

**우리의 고민**: OMS ingest pipeline crash 시 "어디까지 인덱싱했는가" checkpoint 관리에 동일 철학 적용. 인덱싱 중 crash → `indexing` 상태 유지 → 재시작 시 해당 document 재처리. `failed` 는 진짜 실패만.

### D-06 | Hardlink vs Copy 캐시 전략

`_atomic_link` (hardlink) vs `_atomic_copy` (copy) 선택 기준:
- **hardlink**: 대상 파일이 rename으로 교체됨 (temp + replace) → 캐시 안전
- **copy**: 대상 파일이 in-place truncate-write로 수정됨 → hardlink하면 캐시 파일이 함께 수정됨

저자가 napi build의 각 파일 교체 메커니즘을 분석해서 파일별로 다른 전략을 적용한 것. 꼼꼼한 파일 시스템 시맨틱 분석.

**우리의 고민**: embedding 캐시에서 `.safetensors` (모델 가중치, rename-safe) vs `.json` 설정 (in-place 편집될 수 있음) 구분에 동일 패턴 적용.

### D-07 | 두 가지 완전히 다른 성격의 컴포넌트 (TypeScript CLI vs Python orchestrator)

gajae-code는 TypeScript CLI (사용자 인터랙션, TUI)와 Python orchestrator (서버사이드 자동화)를 완전히 분리했다. 두 컴포넌트는 `gjc --mode rpc` → stdio JSON-RPC로 통신.

**장점**: TS CLI는 TUI/UX에 집중, Python은 비동기 서버에 집중. 각자 언어 강점 활용.
**우리와의 연관**: OMS MCP server (TypeScript/Python?) + Obsidian vault 간의 경계 설계에 참고.

### D-08 | Tool call audit trail을 별도 테이블에 기록

```sql
CREATE TABLE IF NOT EXISTS tool_calls (
  issue_key TEXT, tool TEXT,
  args_json TEXT, result_json TEXT, error TEXT, ts TEXT
);
```

모든 tool 호출을 DB에 기록 → 디버깅, 재현, 비용 분석 가능.

**우리의 고민**: OMS의 각 retrieve/embed 호출을 audit log로 저장하면 "왜 이 결과가 나왔는가" 추적 가능. 현재 없는 기능.

---

## §4 우리 엔진 매핑 + 안 가져올 것

### 매핑 테이블

| gajae-code 패턴 | 우리 엔진 적용 대상 | 우선순위 |
|----------------|---------------------|---------|
| P-01 단일 dispatcher | embedding batch pipeline | 높음 |
| P-02 SlotPool | Gemma 병렬 슬롯 제한 | 중간 |
| P-03 ContextVar 취소 | MCP client disconnect → 작업 취소 | 높음 |
| P-04 3단계 shutdown | MCP server SIGTERM 처리 | 높음 |
| P-05 SQLite WAL 큐 | incremental ingest checkpoint | 중간 |
| P-06 pydantic-settings | OMS config module | 높음 (즉시) |
| P-07 content-addressed cache | embedding 결과 캐시 | 중간 |
| P-08 두 계층 retry | LLM API 호출 retry | 높음 |
| P-09 스트리밍 추상화 | provider-agnostic stream | 낮음 (나중에) |
| P-10 pragma DSL | MCP tool inline override | 낮음 |
| P-11 JSONL session | capture checkpoint | 낮음 |
| P-12 env scrubbing | subprocess 보안 | 중간 |
| P-13 in-flight 중복 방지 | document ingest 중복 | 높음 |

### 안 가져올 것 (명시)

**A-01 | Per-issue stateful session (JSONL transcript)**
이유: 우리는 deliberately stateless. per-document session을 유지하면 메모리 footprint와 복잡도가 폭증. 각 MCP 호출은 독립적이어야 함.

**A-02 | OS uid-level sandbox (SlotPool + setuid)**
이유: 우리는 GitHub issue bot이 아니라 신뢰된 개인 환경. OS-level sandbox isolation 불필요. asyncio.Semaphore로 충분.

**A-03 | GitHub webhook 파이프라인 전체**
이유: 서비스가 다름. webhook receiver, issue classifier, PR opener 등 전체 workflow는 불필요.

**A-04 | compaction (JSONL session 기반)**
이유: stateless 모델에서는 long conversation을 유지할 필요 없음. 단, 나중에 "multi-turn distillation session"을 도입하면 이 패턴 재검토.

**A-05 | TUI framework (packages/tui/)**
이유: 우리는 MCP stdio server. terminal UI 불필요.

**A-06 | rate limiter (per-submitter rolling window)**
이유: 개인 second-brain. external user rate limiting 불필요.

**A-07 | Question auto-close (`pending_closures` 테이블)**
이유: GitHub 이슈 관리 기능. 우리 도메인 밖.

### 우선순위 행동 계획

1. **즉시**: P-06 (pydantic-settings 패턴) — OMS config.py에 적용. SecretStr + blank-string 정규화 + `@cache` singleton.
2. **다음 sprint**: P-08 (두 계층 retry) — Gemma local + API 호출에 각각 다른 retry budget 설정.
3. **인덱서 구현 시**: P-01 + P-13 (dispatcher + in-flight dedup) — batch embedding pipeline.
4. **MCP server 안정화 시**: P-03 + P-04 (취소 토큰 + graceful shutdown).

---

## §5 라이선스/귀속

### 라이선스 결론

**MIT License** (확인됨). 아이디어/패턴 흡수 및 코드 참조 모두 허용.

MIT 요구사항: "above copyright notice and this permission permission notice shall be included in all copies or substantial portions of the Software."

**우리의 경우**: 패턴을 참고하여 독자적으로 구현하는 것이므로 copyright notice 표기 의무 없음. 단, 코드를 substantially copy한 경우 (특히 복잡한 유틸리티 함수들) ACKNOWLEDGMENTS에 표기 권장.

### ACKNOWLEDGMENTS.md 표기 권장 항목

`NativesCache._atomic_link`, `_flock` contextmanager, `WorkerPool` 구조를 실질적으로 포팅하는 경우:

```markdown
## gajae-code
- Source: https://github.com/Yeachan-Heo/gajae-code
- License: MIT (Copyright 2025 Mario Zechner, 2025-2026 Can Bölük)
- Patterns: content-addressed cache (atomic link/copy), async worker pool,
  ContextVar cancellation token, SQLite WAL event queue
```

아이디어/설계 참고만 하는 경우: 표기 의무 없음이나 내부 노트로 출처 기록 권장.

---

## References

- [gajae-code repo](https://github.com/Yeachan-Heo/gajae-code) — MIT, shallow clone at `vendor/reference-repos/gajae-code`
- `vendor/reference-repos/gajae-code/python/robogjc/src/queue.py` — WorkerPool
- `vendor/reference-repos/gajae-code/python/robogjc/src/slot_pool.py` — SlotPool
- `vendor/reference-repos/gajae-code/python/robogjc/src/worker.py` — RPC worker
- `vendor/reference-repos/gajae-code/python/robogjc/src/cancellation.py` — ContextVar cancel
- `vendor/reference-repos/gajae-code/python/robogjc/src/natives_cache.py` — content-addressed cache
- `vendor/reference-repos/gajae-code/python/robogjc/src/config.py` — pydantic-settings
- `vendor/reference-repos/gajae-code/python/robogjc/src/db.py` — SQLite WAL queue
- `vendor/reference-repos/gajae-code/python/robogjc/src/pragmas.py` — pragma DSL
- `vendor/reference-repos/gajae-code/docs/non-compaction-retry-policy.md` — retry policy
- `vendor/reference-repos/gajae-code/docs/provider-streaming-internals.md` — streaming abstraction
- `vendor/reference-repos/gajae-code/docs/session.md` — JSONL session format
- `vendor/reference-repos/gajae-code/docs/compaction.md` — compaction pipeline
- `vendor/reference-repos/gajae-code/docs/codebase-overview.md` — architecture overview

---

*검토 파일: 13개 소스 파일 직접 읽음 + 5개 architecture 문서. 라이선스 파일 직접 확인 완료. 패턴 13개 추출, 설계 고민 8개 분석, 비채택 항목 7개 명시.*
