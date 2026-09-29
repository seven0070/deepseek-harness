---
description: "记忆接口：在可插拔后端之上提供统一的保存 / 检索 / 反思服务，内置本地存储和模型工具。"
kind: "package"
---

# @deepseek-ai/dsh-memory

[English](README.md) | 中文

## 概述

提供 `ctx.memory`。每次保存和检索都会发送到所有已注册的后端，结果合并去重，失败或超时的后端会被跳过。内置的本地存储（关键词检索，可选保存为 JSON Lines）让智能体在没有外部服务时也能记忆。模型工具为 `memory_retain`、`memory_recall` 和 `memory_reflect`，每条记忆有一个类型：`experience`、`fact`、`self` 或 `skill`。
