---
description: "Hindsight 记忆后端：通过 Hindsight REST API 提供会学习的经验记忆。"
kind: "package"
---

# @deepseek-ai/dsh-memory-hindsight

[English](README.md) | 中文

## 概述

在 `ctx.memory` 上注册 [Hindsight](https://github.com/vectorize-io/hindsight)。Hindsight 会从保存的内容中提取事实、实体和时间信息，并同时使用语义、关键词、图谱和时间策略进行检索。它的反思操作为 `memory_reflect` 生成综合回答。可用 `services/memory/docker-compose.yml` 启动服务，或使用 Hindsight Cloud。
