# Deferred Graph Connect: 검증된 관찰 기록

> 이 문서는 2026-08 기준의 **검증된 관찰**을 기록한다. 설계 결정이 아니며, 인용한 좌표는 이후 커밋에서 이동할 수 있다.

1. **그래프 실행 프로브(P0-P4).** 여섯 `assemble*()` 조립 함수 모두에 `graphTraverse`가 없어 그래프 채널은 배선되어 있지 않다. MCP 타입 enum에는 `"graph"`가 없고, BFS 시드에는 `docPath` 위치로 자연어 문자열이 전달된다. 따라서 golden-set 그래프 점수는 도달할 수 없는 경로를 측정한다. 희소 재빌드는 실제 엣지를 `unknown-ref`(가중치 0)로 강등한다. 출처: `engine/graph/builder.ts:161,187-188,235-253`, `engine/mcp/types.ts:26`, `st_01a036ee.txt` §1.1–§1.5.
2. **Tier-4 엣지 폭증 행렬.** 20k 노트/10 폴더는 39,980,000개, 20k 노트/30 폴더는 13,326,660개, PARA-편중은 118,480,000개, 1k 노트/10 폴더는 99,000개의 엣지를 측정했다. JSON 직렬화 전에 메모리 부족(OOM)이 발생한다. 출처: `st_01a036ee.txt` §1.3 측정 표.
3. **BFS 동점 측정.** `1 / (1 + depth)` 점수에서 깊이 1의 43개, 깊이 2의 522개, 깊이 3의 4,846개 노드는 세 가지 점수값으로 수렴한다. 이는 RRF에 대한 순수한 노이즈다. 출처: `st_01a036ee.txt` §1.5, `traverse.ts:71`.
4. **PPR 지연시간 측정.** push-PPR은 ε=1e-4에서 2.1ms, 206개 노드, 319회 push를 기록했고, ε=1e-5에서 4.2ms와 1,599개 노드를 기록했다. 전체 power iteration은 20k에서 14.5ms를 기록했다. 출처: `st_01a036ee.txt` §2(1).
5. **sqlite-vec 제약.** 메타데이터 KNN 사전 필터는 0.1.9에서 실증되었으며, 반대를 주장한 주석은 틀렸다. `IN`은 조용히 무시되어 OR로 컴파일되어야 하고, `LIKE`와 `GLOB`는 예외를 발생시킨다. 출처: `engine/embed/store.ts:582-584`, `wave-1-lane-frontmatter-axis.md`.
6. **EAV와 JSON 노드 인덱스 벤치마크.** EAV는 모든 연산이 4ms 미만인 20k 노트 기준 18MB였다(범위 0.47ms, facet 2.84ms). JSON 노드 인덱스는 36MB였고 호출마다 318ms 파싱, 미스 시 5.4초가 걸려 실용적이지 않았다. 출처: `wave-1-lane-frontmatter-axis.md` (`st_01a036ed` 요약).
7. **FTS5 한국어 측정.** 토크나이저를 지정하지 않은 unicode61에서는 한국어 어절이 통째 토큰이 되고 prefix-star는 접두사만 처리하므로, 조사 결합 질의는 완전히 실패한다. trigram으로 전환하면 두 글자 질의가 0건이 되는 함정이 있다. 출처: `engine/embed/store.ts:82-90,133-137`, `verify-fts5-korean.md` V001–V005.
8. **출처 부스트 및 업데이트 결함 측정.** 가산 +0.02는 최대 RRF 점수 0.0328의 61%이며 top-10 분산의 9.5배다. 지배 효과는 약 15–20위에서 사라진다. 네 업데이트 결함 좌표는 yes gate `update.ts:213`, SemVer `update.ts:95-106`, vault 해석 `cli/oms.ts:45-54`, exit 0 `host-commands.ts:156`이다. 출처: `dispatcher.ts:101-104,256`, `rrf.ts:25`, `verify-provenance-boost.md`, `SYNTHESIS.md` T10.

항목 8의 가산 부스트 측정으로 인해, 출하된 랭킹 기본값은 사전등록된 C040 실험이 보류 중인 현재 `boost-additive`로 유지된다.
