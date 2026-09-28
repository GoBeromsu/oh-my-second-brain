---
template: knowledge
status: 완료
tags:
  - 지식
  - unicode
  - 한글
aliases:
  - Hangul Normalization
---

# 한글 정규화 NFC NFD

macOS 파일 시스템은 한글 파일 이름을 NFD(자모 분리)로 저장하는 경우가 있다. 같은 "낙상"이라도 NFC와 NFD는 바이트가 다르다.
검색 색인과 파일 경로 비교 전에 NFC로 정규화해야 한다.

예시 노트: [[낙상 위험 평가]]
