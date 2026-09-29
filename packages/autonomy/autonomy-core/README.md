---
description: "Autonomy safety core: persistent identity and self-model, intent authorization, budgets, kill switch and a tamper-evident audit log."
kind: "package"
---

# @deepseek-ai/dsh-autonomy-core

English | [中文](README.zh.md)

## Summary

Provides `ctx.autonomy`. Every tool call passes an authorization gate that classifies its risk (`read` to `critical`); anything above `autoApprove` needs owner approval, and protected actions (changing the safety core itself) are never approved automatically. It also enforces budgets for tokens, cost, actions and wall time, and has a kill switch that also responds to a `STOP` file. Every decision is written to a hash-chained audit log. Only the owner can change the agent's identity; the agent keeps a versioned self-model with calibrated confidence per capability. Tools: `self_describe`, `self_note`, `self_record_outcome`.
