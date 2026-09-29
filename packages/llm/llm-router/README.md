---
description: "Universal model routing: detect the provider of any API key and mount it through the pi-ai adapter, plus policy-based model selection."
kind: "package"
---

# @deepseek-ai/dsh-llm-router

English | [中文](README.zh.md)

## Summary

Export any API key and the router finds it, works out which provider it belongs to, and mounts that provider through `@deepseek-ai/dsh-llm-pi-ai`. No provider has to be named in configuration.

## Detection

1. **Key shape**: rules in `src/rules.ts`, such as `sk-ant-` for Anthropic or `gsk_` for Groq.
2. **Variable name**: for example `OPENAI_API_KEY`.
3. **Live probe**: optional. For shapes several providers share, such as a bare `sk-`, the router calls each candidate's read-only model listing endpoint. This costs no tokens.

To add a provider, add a row to `src/rules.ts`.

## Routing

`route(models, { policy, prefer, exclude, minContext, needsReasoning, needsImages })` returns the models ranked best first; the first is the primary choice and the rest are fallbacks. The policy is one of `balanced`, `quality`, `cost` or `speed`.
