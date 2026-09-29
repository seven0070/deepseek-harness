---
description: "通用模型路由：自动识别任意 API key 所属的提供商并通过 pi-ai 适配器挂载，同时提供基于策略的模型选择。"
kind: "package"
---

# @deepseek-ai/dsh-llm-router

[English](README.md) | 中文

## 概述

导出任意 API key，路由器会自动发现它、判断它属于哪个提供商，并通过 `@deepseek-ai/dsh-llm-pi-ai` 挂载该提供商。配置中无需指定提供商。

## 识别

1. **Key 形态**：`src/rules.ts` 中的规则，例如 Anthropic 的 `sk-ant-`、Groq 的 `gsk_`。
2. **变量名**：例如 `OPENAI_API_KEY`。
3. **在线探测**：可选。对于多个提供商共用的形态（例如单纯的 `sk-`），路由器会调用每个候选提供商的只读模型列表接口，不消耗 token。

新增提供商只需在 `src/rules.ts` 中加一行。

## 路由

`route(models, { policy, prefer, exclude, minContext, needsReasoning, needsImages })` 返回按优先级从高到低排列的模型；第一个为首选，其余为回退。策略可选 `balanced`、`quality`、`cost` 或 `speed`。
