---
description: "Memory seam: one retain / recall / reflect service over pluggable backends, a built-in local store, and model tools."
kind: "package"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

## Summary

Provides `ctx.memory`. It sends each save and search to every registered backend, merges and de-duplicates the results, and skips any backend that fails or times out. A built-in local store (keyword search, optionally saved as JSON Lines) means the agent remembers even with no external service. The model tools are `memory_retain`, `memory_recall` and `memory_reflect`, and each memory has a kind: `experience`, `fact`, `self` or `skill`.
