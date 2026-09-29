---
description: "Cognee memory backend: knowledge-graph memory over the Cognee REST API."
kind: "package"
---

# @deepseek-ai/dsh-memory-cognee

English | [中文](README.zh.md)

## Summary

Registers [Cognee](https://github.com/topoteretes/cognee) on `ctx.memory`. Saved memories are sent to Cognee's `add` endpoint and then turned into a knowledge graph with one `cognify` call after a short delay, so several saves are processed together. Reflect uses graph-aware search. Start the server with `services/memory/docker-compose.yml`, or use Cognee Cloud.
