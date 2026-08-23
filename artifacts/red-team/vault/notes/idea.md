---
title: "Idea: convention-as-data for knowledge graphs"
created: 2026-05-31
---

What if the metadata schema for a knowledge base were itself stored as structured data inside
the vault, rather than being hardcoded into a tool?

The user could evolve the schema incrementally — adding a field at a time — and any tool that
reads the vault would automatically pick up the new convention.

This feels like the right inversion: the data defines the rules, not the other way around.
