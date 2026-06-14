---
title: "qmd 임베딩 파이프라인 패턴 마이닝 (파쿠리)"
slug: embedding-pipeline-patterns-mining
date: 2026-06-13
type: research
status: active
source_repo: github.com/tobi/qmd
source_license: MIT
files_reviewed: 6
patterns_absorbed: 8
---

# qmd 임베딩 파이프라인 패턴 마이닝

> MIT © tobi — 코드 흡수(vendored) 합법. 귀속 의무: ACKNOWLEDGMENTS.md 표기 필수.
> See [[ACKNOWLEDGMENTS.md]] for attribution record.

---

## §1 qmd 임베딩 파이프라인 아키텍처

### 전체 흐름

```
[CLI: qmd embed]
    ↓
vectorIndex() → generateEmbeddings(store, options)
    ↓
getPendingEmbeddingDocs()   ← LEFT JOIN으로 미임베딩 문서 쿼리
    ↓
buildEmbeddingBatches()     ← 문서 단위 outer batch (64 docs / 64MB)
    ↓
for each outer batch:
  getEmbeddingDocsForBatch() ← content 본문 로드
  chunkDocumentByTokens()    ← 문서 → chunk 배열
  for batchStart += 32:      ← inner chunk batch
    session.embedBatch()     ← LlamaCpp.embedBatch()
      → Promise.all([ctx0.getEmbeddingFor(...), ctx1...])   ← 병렬 컨텍스트
    insertEmbedding()        ← content_vectors + vectors_vec 동시 기록
    retryFailedChunks()      ← 64 성공 후 retry pass
  retryFailedChunks(force)   ← outer batch 종료 시 강제 재시도
  removeIncompleteEmbeddings() ← 불완전 청크 정리
```

### 핵심 파일 목록

| 파일 | 역할 | 라인 수 |
|------|------|---------|
| `src/llm.ts` | LlamaCpp 클래스 — 모델/컨텍스트 생명주기, embedBatch, 병렬화 계산 | 2059 |
| `src/store.ts` | generateEmbeddings, 배칭, retry, 증분 sync, DB write | 5234 |
| `src/cli/qmd.ts` | CLI 커맨드 파싱 및 dispatch | ~4500 |
| `src/collections.ts` | 컬렉션 설정 관리 | 539 |
| `src/db.ts` | SQLite 연결 (better-sqlite3) | 103 |
| `src/index.ts` | 공개 SDK API 진입점 | 547 |

---

## §2 흡수할 패턴

### 패턴 1: 하드웨어 적응형 병렬 컨텍스트 풀

**[SHIPPED-IN-CODE @ `src/llm.ts`:1000–1027]**

```typescript
// GPU 모드: free VRAM의 25%를 컨텍스트당 MB로 나눔, 상한 8
const freeMB = vram.free / (1024 * 1024);
const maxByVram = Math.floor((freeMB * 0.25) / perContextMB);  // perContextMB=150 (embed)
const computed = Math.max(1, Math.min(8, maxByVram));

// CPU 모드: math cores / 4, 상한 4 (컨텍스트당 최소 4 threads 확보)
const cores = llama.cpuMathCores || 4;
const maxContexts = Math.floor(cores / 4);
const computed = Math.max(1, Math.min(4, maxContexts));

// Windows CUDA는 강제 1 (ggml-cuda.cu:98 불안정성)
if (platform === "win32" && gpu === "cuda") return 1;

// 환경변수 오버라이드: QMD_EMBED_PARALLELISM (1–8)
return Math.min(8, parsed);   // src/llm.ts:612
```

**컨텍스트 풀 생성 (`src/llm.ts`:1056–1081):**
```typescript
// embedContextsCreatePromise — promise guard로 race condition 방지
this.embedContextsCreatePromise = (async () => {
  const model = await this.ensureEmbedModel();
  const n = await this.computeParallelism(150);   // 150MB per embed ctx
  const threads = await this.threadsPerContext(n); // cores / n (CPU), 0 (GPU)
  for (let i = 0; i < n; i++) {
    try {
      this.embedContexts.push(await model.createEmbeddingContext({
        contextSize: LlamaCpp.EMBED_CONTEXT_SIZE,  // 2048, env: QMD_EMBED_CONTEXT_SIZE
        ...(threads > 0 ? { threads } : {}),
      }));
    } catch {
      if (this.embedContexts.length === 0) throw new Error("Failed to create any embedding context");
      break; // 1개라도 성공하면 계속
    }
  }
})();
```

**우리 엔진 적용:** 로컬 GGUF 모델 사용 시 동일 패턴 채택 — GPU free VRAM 25% 규칙 + CPU math-cores/4 규칙으로 컨텍스트 풀 크기 자동 결정; `OMS_EMBED_PARALLELISM` 환경변수 오버라이드 지원.

---

### 패턴 2: Promise.all 기반 컨텍스트 분산 병렬 임베딩

**[SHIPPED-IN-CODE @ `src/llm.ts`:1306–1371]**

```typescript
async embedBatch(texts: string[], options = {}): Promise<(EmbeddingResult | null)[]> {
  const contexts = await this.ensureEmbedContexts();
  const n = contexts.length;

  if (n === 1) {
    // 단일 컨텍스트: sequential (분산 의미 없음)
    for (const text of texts) { ... }
  }

  // N 컨텍스트: texts를 N 청크로 분할, Promise.all 병렬 실행
  const chunkSize = Math.ceil(texts.length / n);
  const chunks = Array.from({ length: n }, (_, i) =>
    texts.slice(i * chunkSize, (i + 1) * chunkSize)
  );

  const chunkResults = await Promise.all(
    chunks.map(async (chunk, i) => {
      const ctx = contexts[i]!;
      for (const text of chunk) {
        const embedding = await ctx.getEmbeddingFor(safeText);
        results.push({ embedding: Array.from(embedding.vector), model: ... });
      }
      return results;
    })
  );
  return chunkResults.flat();
}
```

**우리 엔진 적용:** `embedBatch(texts[])` API를 동일하게 설계 — 컨텍스트 수에 따라 내부에서 자동으로 sequential vs. parallel 전환.

---

### 패턴 3: 2단계 배치 구조 (Outer Doc-Batch + Inner Chunk-Batch)

**[SHIPPED-IN-CODE @ `src/store.ts`:1448–1555, 1750–1816]**

```typescript
// Outer batch 상수
export const DEFAULT_EMBED_MAX_DOCS_PER_BATCH = 64;            // store.ts:50
export const DEFAULT_EMBED_MAX_BATCH_BYTES = 64 * 1024 * 1024; // 64MB, store.ts:51

// Outer batch 빌드: docs-count OR bytes 중 먼저 초과하는 시점에서 분할
function buildEmbeddingBatches(docs, maxDocsPerBatch, maxBatchBytes) {
  const wouldExceedDocs = currentBatch.length >= maxDocsPerBatch;
  const wouldExceedBytes = currentBatch.length > 0 && (currentBytes + docBytes) > maxBatchBytes;
  if (wouldExceedDocs || wouldExceedBytes) { batches.push(currentBatch); currentBatch = []; }
}

// Inner chunk batch (store.ts:1614, 1750)
const BATCH_SIZE = 32;  // 청크 단위 inner batch
for (let batchStart = 0; batchStart < batchChunks.length; batchStart += BATCH_SIZE) {
  const texts = chunkBatch.map(c => formatDocForEmbedding(c.text, c.title, modelUri));
  const embeddings = await session.embedBatch(texts, { model });
  // ... insert each embedding
}
```

**우리 엔진 적용:** outer batch(메모리 관리) + inner batch(API/모델 호출 최적화) 2단계 구조 채택; outer는 `maxDocs`/`maxBytes` 듀얼 가드, inner는 32 고정(튜닝 가능).

---

### 패턴 4: 청크 단위 Retry — 성공 카운터 기반 지연 재시도

**[SHIPPED-IN-CODE @ `src/store.ts`:1614–1684]**

```typescript
const BATCH_SIZE = 32;
const RETRY_AFTER_SUCCESSFUL_CHUNKS = 64;  // 64 성공 후 retry pass
const MAX_RETRY_ATTEMPTS = 3;
const failures = new Map<string, EmbedFailure>();   // key = "hash:seq"
const retryQueue = new Map<string, ChunkItem>();

const recordFailure = (chunk, reason) => {
  failures.set(key, { path, hash, seq, attempts: (prev?.attempts ?? 0) + 1, reason });
  retryQueue.set(key, chunk);
};

// Normal retry: 64 성공마다 1회 pass
const retryFailedChunks = async (force = false) => {
  if (!force && successesSinceRetry < RETRY_AFTER_SUCCESSFUL_CHUNKS) return;
  do {
    for (const [key, chunk] of [...retryQueue]) {
      if (failure.attempts >= MAX_RETRY_ATTEMPTS) continue;
      await tryEmbedChunk(chunk);
    }
    if (!force || retried === 0) break;
  } while (retryQueue에 재시도 가능한 chunk 남음);
};

// Batch 실패 → 청크별 개별 fallback (store.ts:1788–1802)
} catch (error) {
  if (!session.isValid) {
    for (const chunk of chunkBatch) recordFailure(chunk, `batch failed and session expired`);
  } else {
    for (const chunk of chunkBatch) await tryEmbedChunk(chunk);  // 개별 재시도
  }
}

// 에러율 > 80% 조기 중단 (store.ts:1759–1766)
if (processed >= BATCH_SIZE && activeErrorCount() > processed * 0.8) {
  console.warn(`⚠ Error rate too high (${activeErrorCount()}/${processed}) — aborting`);
  break;
}
```

**Force retry at end (`src/store.ts`:1818):**
```typescript
await retryFailedChunks(true);  // outer batch 종료 시 강제 전수 재시도
```

**우리 엔진 적용:** `Map<"hash:seq", FailureRecord>` 구조로 청크 단위 실패 추적; 성공 N개 후 retry pass(exponential 대신 success-count 기반); 배치 실패 시 청크별 fallback; 에러율 임계값(80%) 초과 시 abort.

---

### 패턴 5: 컨텐츠 해시 기반 증분 동기화

**[SHIPPED-IN-CODE @ `src/store.ts`:1329–1374]**

```typescript
// 변경 감지: 파일 읽기 → SHA-256 해시 → DB 기존 해시와 비교
const hash = await hashContent(content);  // SHA-256, store.ts:2368
const existing = findOrMigrateLegacyDocument(db, collectionName, path);

if (existing) {
  if (existing.hash === hash) {
    // 해시 동일: 제목만 변경됐으면 title update, 아니면 skip (unchanged)
    if (existing.title !== title) { updateDocumentTitle(...); updated++; }
    else { unchanged++; }
  } else {
    // 해시 다름: 새 content insert + document update (mtime 포함)
    insertContent(db, hash, content, now);
    updateDocument(db, existing.id, title, hash, new Date(stat.mtime).toISOString());
    updated++;
  }
}

// 삭제 감지: seenPaths Set — 스캔에서 사라진 경로를 deactivate
for (const path of allActive) {
  if (!seenPaths.has(path)) { deactivateDocument(db, collectionName, path); removed++; }
}
```

**임베딩 fingerprint (`src/store.ts`:53–76):**
```typescript
// 모델 URI + 쿼리/문서 포맷 prefix → SHA-256 앞 6자리
const EMBED_FINGERPRINT_PROBE_QUERY = "__qmd_embedding_query_probe__";
export function getEmbeddingFingerprint(model: string): string {
  return createHash("sha256").update(
    `query:${formatQueryForEmbedding(PROBE_QUERY, model)}` +
    `doc:${formatDocForEmbedding(PROBE_DOC, PROBE_TITLE, model)}`
  ).digest("hex").slice(0, 6);  // store.ts:76
}
// 포맷 변경 → fingerprint 변경 → 자동 재임베딩 트리거
```

**미임베딩 문서 쿼리 (`src/store.ts`:1503–1524):**
```sql
SELECT d.hash, MIN(d.path) as path, length(CAST(c.doc AS BLOB)) as bytes
FROM documents d JOIN content c ON d.hash = c.hash
LEFT JOIN (
  SELECT hash, model, COUNT(*) AS chunk_count, MAX(total_chunks) AS expected_chunks
  FROM content_vectors
  WHERE model = ? AND embed_fingerprint = ?
  GROUP BY hash, model, embed_fingerprint
) v ON d.hash = v.hash
WHERE d.active = 1
  AND (v.hash IS NULL OR v.chunk_count < v.expected_chunks)
-- v.hash IS NULL → 아직 임베딩 없음
-- chunk_count < expected_chunks → 부분 임베딩 (재시도 필요)
```

**우리 엔진 적용:** content SHA-256으로 변경 감지(mtime 대신 해시 우선); embedding fingerprint(모델명+포맷 prefix의 해시 앞 6자)로 포맷 변경 시 자동 재임베딩; LEFT JOIN으로 partial-embed 복구.

---

### 패턴 6: 모델 지연 로딩 + 비활성 타이머 언로드

**[SHIPPED-IN-CODE @ `src/llm.ts`:714–837, 973–997]**

```typescript
// Lazy load — promise guard로 중복 로드 방지 (VRAM 절약)
private async ensureEmbedModel(): Promise<LlamaModel> {
  if (this.embedModel) return this.embedModel;
  if (this.embedModelLoadPromise) return await this.embedModelLoadPromise;  // 진행 중인 로드 재사용

  this.embedModelLoadPromise = (async () => {
    const modelPath = await this.resolveModel(this.embedModelUri);
    this.embedModel = await llama.loadModel(modelPath);
    this.touchActivity();   // 활동 타이머 리셋
    return this.embedModel;
  })();
  try { return await this.embedModelLoadPromise; }
  finally { this.embedModelLoadPromise = null; }  // in-flight 프로미스만 클리어; 모델 캐시 유지
}

// 비활성 타이머 (DEFAULT_INACTIVITY_TIMEOUT_MS = 5분, src/llm.ts:590)
private touchActivity(): void {
  clearTimeout(this.inactivityTimer);
  if (this.inactivityTimeoutMs > 0 && this.hasLoadedContexts()) {
    this.inactivityTimer = setTimeout(() => {
      if (!canUnloadLLM()) { this.touchActivity(); return; }  // active session 있으면 연기
      this.unloadIdleResources();
    }, this.inactivityTimeoutMs);
    this.inactivityTimer.unref();  // 타이머가 프로세스를 alive로 유지하지 않음
  }
}

// 언로드: context dispose (기본) + 선택적 model dispose
async unloadIdleResources(): Promise<void> {
  for (const ctx of this.embedContexts) await ctx.dispose();
  this.embedContexts = [];
  if (this.disposeModelsOnInactivity) {
    await this.embedModel?.dispose();
    this.embedModel = null;
    this.embedModelLoadPromise = null;  // 다음 사용 시 재로드 허용
  }
  // llama 인스턴스는 유지 (lightweight)
}
```

**컨텍스트 크기 (`src/llm.ts`:1165–1173):**
```typescript
private static readonly EMBED_CONTEXT_SIZE: number = (() => {
  const v = parseInt(process.env.QMD_EMBED_CONTEXT_SIZE ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 2048;
})();
```

**우리 엔진 적용:** 로컬 모델 lazy-load + promise guard 패턴; 5분 비활성 타이머로 contexts 해제(모델 weights는 유지 옵션); `timer.unref()`로 프로세스 종료 방해 방지.

---

### 패턴 7: 벡터 테이블 쓰기 경로 — sqlite-vec + Lazy Migration

**[SHIPPED-IN-CODE @ `src/store.ts`:880–910, 1169, 1488–1501, 1653]**

```typescript
// vec0 가상 테이블 — 차원은 첫 임베딩 시 동적 결정
db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(
  hash_seq TEXT PRIMARY KEY,        // "hash:seq" 복합키
  embedding float[${dimensions}]    // 차원 수 런타임 결정
  distance_metric=cosine
)`);  // store.ts:1169

// content_vectors 테이블 — 메타데이터 포함
// hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at

// 쓰기: insertEmbedding
insertEmbedding(db, hash, seq, pos, new Float32Array(result.embedding),
  model, now, chunk.expectedTotalChunks, fingerprint);
// store.ts:1653, 1778 (batch 경로)

// Lazy column migration — 컬럼 누락 시 자동 ALTER TABLE (멱등)
function withLazyContentVectorMigration<T>(db, operation: () => T): T {
  let repaired = false;
  while (true) {
    try { return operation(); }
    catch (error) {
      if (repaired || !isContentVectorColumnError(error)) throw error;
      runContentVectorColumnRepairs(db);  // ALTER TABLE ADD COLUMN (idempotent)
      repaired = true;
    }
  }
}  // store.ts:1488–1501

// 불완전 임베딩 정리 — batch 끝에서 호출
removeIncompleteEmbeddings(db, expectedChunksByHash, model);
// expected_chunks != actual chunk_count → 해당 hash의 모든 vectors 삭제 후 재임베딩 대기
```

**우리 엔진 적용:** `hash:seq` PRIMARY KEY로 upsert; 첫 임베딩 시 차원 동적 확정 후 vec table 생성; partial embedding 정리를 batch 끝에서 실행; lazy column migration으로 스키마 진화 무중단.

---

### 패턴 8: LLM 세션 최대 지속 시간 가드

**[SHIPPED-IN-CODE @ `src/store.ts`:1609, 1830]**

```typescript
const result = await withLLMSessionForLlm(llm, async (session) => {
  // ... 전체 임베딩 루프
  // session.isValid 를 매 inner batch 전 체크 (store.ts:1752, 1690)
  if (!session.isValid) {
    console.warn(`⚠ Session expired — skipping remaining chunks`);
    break;
  }
}, { maxDuration: 30 * 60 * 1000, name: 'generateEmbeddings' });
// 30분 초과 시 session.isValid = false → 루프 조기 종료
```

**우리 엔진 적용:** 장시간 임베딩 작업에 세션 최대 지속 시간(기본 30분) 가드 적용; 만료 시 처리된 청크까지는 커밋, 미처리 청크는 다음 실행에서 재처리(증분 sync와 연계).

---

## §3 명령 표면 매핑

### qmd CLI 커맨드 → 우리 `emb`/`sync`/`st` 매핑

**qmd embed 서브커맨드 (`src/cli/qmd.ts`:4405–4425):**

```
qmd embed [options]
  -f, --force              전체 재임베딩 (fingerprint 무시)
  --model <uri>            임베딩 모델 URI (env: QMD_EMBED_MODEL)
  -c, --collection <name>  특정 컬렉션만 임베딩
  --max-docs-per-batch <n> outer batch 문서 수 상한 (기본 64)
  --max-batch-mb <n>       outer batch 메모리 상한 MB (기본 64)
  --chunk-strategy <s>     청킹 전략 (ast / token / etc.)
```

**전체 커맨드 표면:**

| qmd 커맨드 | 역할 | 우리 커맨드 매핑 |
|-----------|------|-----------------|
| `qmd embed` | 벡터 임베딩 생성 | `emb` / `oms embed` |
| `qmd embed -f` | 강제 전체 재임베딩 | `emb --force` |
| `qmd update` | 문서 재인덱싱 (no embed) | `sync` |
| `qmd status` | 인덱스 상태 (pending count 포함) | `st` / `oms status` |
| `qmd pull` | 모델 다운로드 | `oms pull` |
| `qmd doctor` | 헬스체크 + 진단 | `oms doctor` |
| `qmd search / vsearch` | BM25 / 벡터 검색 | `oms query` |

**ADR-002 통합 포인트 (`embed`: 벡터+그래프 동시 빌드):**

qmd는 `update`(인덱싱)와 `embed`(벡터화)를 분리한다. 우리는 ADR-002에 따라
`oms capture` 시 벡터+그래프를 동시 빌드하되, `emb` 단독 커맨드로도 벡터만
재빌드 가능하게 설계해야 한다.

```
oms capture   → sync(파일 해시 비교) + embed(벡터) + graph(관계) 동시
oms emb       → embed 단독 (이미 sync된 문서 대상)
oms emb -f    → 강제 전체 재임베딩 (fingerprint 초기화)
oms sync      → 파일 해시 비교만 (벡터 없음)
oms st        → pending embed 수 + 마지막 sync 시각 + 모델 정보
```

---

## §4 라이선스 / 귀속

```
qmd — MIT License © tobi (github.com/tobi/qmd)

코드 흡수 범위:
  - 임베딩 병렬화 패턴 (llm.ts:1000–1371)
  - retry/배치 로직 (store.ts:1527–1839)
  - 증분 sync 패턴 (store.ts:1295–1374)
  - 비활성 언로드 패턴 (llm.ts:714–837)

의무:
  1. ACKNOWLEDGMENTS.md에 qmd 저작권 고지 표기
  2. vendored 코드 파일 상단에 원본 저작권 주석 보존
  3. MIT 라이선스 전문 포함 (or 링크)
```

> 실행: `ACKNOWLEDGMENTS.md`에 아래 항목 추가 필요.
>
> ```markdown
> ## qmd
> - Repository: https://github.com/tobi/qmd
> - License: MIT
> - Copyright: © tobi
> - Absorbed patterns: embedding parallelism, retry logic, incremental sync,
>   model lifecycle management
> - Files: src/llm.ts, src/store.ts
> ```

---

## References

| 항목 | 경로 / URL |
|------|-----------|
| 병렬화 계산 | `vendor/reference-repos/qmd/src/llm.ts:1000–1027` |
| 컨텍스트 풀 생성 | `vendor/reference-repos/qmd/src/llm.ts:1044–1081` |
| embedBatch Promise.all | `vendor/reference-repos/qmd/src/llm.ts:1306–1371` |
| 비활성 타이머 | `vendor/reference-repos/qmd/src/llm.ts:754–837` |
| lazy model load | `vendor/reference-repos/qmd/src/llm.ts:973–997` |
| 컨텍스트 크기 상수 | `vendor/reference-repos/qmd/src/llm.ts:1165–1173` |
| outer batch 빌드 | `vendor/reference-repos/qmd/src/store.ts:1527–1555` |
| 배치 상수 | `vendor/reference-repos/qmd/src/store.ts:50–51` |
| retry 로직 | `vendor/reference-repos/qmd/src/store.ts:1614–1684` |
| 에러율 조기중단 | `vendor/reference-repos/qmd/src/store.ts:1759–1766` |
| inner batch + fallback | `vendor/reference-repos/qmd/src/store.ts:1750–1816` |
| 세션 최대 지속 시간 | `vendor/reference-repos/qmd/src/store.ts:1609, 1830` |
| 증분 sync (해시비교) | `vendor/reference-repos/qmd/src/store.ts:1329–1374` |
| embedding fingerprint | `vendor/reference-repos/qmd/src/store.ts:53–76` |
| 미임베딩 문서 쿼리 | `vendor/reference-repos/qmd/src/store.ts:1503–1524` |
| vec0 테이블 생성 | `vendor/reference-repos/qmd/src/store.ts:1169` |
| lazy column migration | `vendor/reference-repos/qmd/src/store.ts:1488–1501` |
| CLI embed 커맨드 | `vendor/reference-repos/qmd/src/cli/qmd.ts:4405–4425` |
| GitHub 저장소 | https://github.com/tobi/qmd |

---

*검토 파일 수: 6개 (`llm.ts`, `store.ts`, `index.ts`, `cli/qmd.ts`, `collections.ts`, `db.ts`)*
*흡수 패턴 수: 8개 (병렬화, embedBatch, 2단계 배치, retry, 증분sync, 모델생명주기, 벡터쓰기, 세션가드)*
