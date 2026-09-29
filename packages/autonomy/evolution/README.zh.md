---
description: "通过 Helix 实现全系统进化：沙盒化变异、评估关卡、受保护核心检查、所有者批准的合并与回滚。"
kind: "package"
---

# @deepseek-ai/dsh-evolution

[English](README.md) | 中文

## 概述

提供 `ctx.evolution`，连接 [Helix](https://github.com/KE7/helix)（`pip install helix-evo`）。`evolution_start` 根据配置的关卡生成 `helix.toml` 和评估脚本，然后在后台运行 Helix；编程智能体在 `helix/*` 分支上修改仓库副本，工作分支不会被改动。`evolution_status` 列出候选版本，并标记触及受保护安全核心的候选。`evolution_review` 在干净的工作树中重新评分。`evolution_promote` 合并符合条件的候选；它属于关键风险，始终需要所有者批准，修改受保护核心或未通过关卡的候选会被拒绝。`evolution_rollback` 撤销最近一次合并。
