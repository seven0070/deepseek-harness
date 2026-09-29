---
description: "Cognee 记忆后端：通过 Cognee REST API 提供知识图谱记忆。"
kind: "package"
---

# @deepseek-ai/dsh-memory-cognee

[English](README.md) | 中文

## 概述

在 `ctx.memory` 上注册 [Cognee](https://github.com/topoteretes/cognee)。保存的记忆先发送到 Cognee 的 `add` 接口，短暂延迟后通过一次 `cognify` 调用构建知识图谱，从而把多次保存合并处理。反思使用基于图谱的检索。可用 `services/memory/docker-compose.yml` 启动服务，或使用 Cognee Cloud。
