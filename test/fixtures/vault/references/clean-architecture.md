---
title: "Clean Architecture: A Craftsman's Guide to Software Structure and Design"
source-url: https://www.oreilly.com/library/view/clean-architecture-a/9780134494272/
author:
  - Robert C. Martin
tags:
  - software-architecture
  - design
  - clean-code
---

## Summary

Robert C. Martin's *Clean Architecture* argues that the primary value of software is its
ability to change — not its current behavior. The book presents the SOLID principles and
shows how they compose into architectural patterns that keep the cost of change low.

## Key Ideas

- **Dependency Rule**: source code dependencies must point inward toward higher-level policies.
- **Screaming Architecture**: the architecture should declare the intent of the system, not its
  framework choices.
- **Use Cases as first-class citizens**: the application's use cases should be visible at the
  top level of the source tree.

## Synthesis

The boundary between "what changes together" and "what changes for different reasons" is the
fundamental organizing principle. Components that are deployed together should be designed
together; those with different rates of change or different owners should be separated.
