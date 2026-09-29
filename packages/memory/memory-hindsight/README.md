---
description: "Hindsight memory backend: experience memory that learns, over the Hindsight REST API."
kind: "package"
---

# @deepseek-ai/dsh-memory-hindsight

English | [中文](README.zh.md)

## Summary

Registers [Hindsight](https://github.com/vectorize-io/hindsight) on `ctx.memory`. Hindsight extracts facts, entities and time information from what it saves, and searches with semantic, keyword, graph and time-based strategies at once. Its reflect operation writes the synthesized answers used by `memory_reflect`. Start the server with `services/memory/docker-compose.yml`, or use Hindsight Cloud.
