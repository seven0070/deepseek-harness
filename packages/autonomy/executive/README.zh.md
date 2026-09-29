---
description: "执行层：目标层级、带校准信念的世界模型、带验证与恢复的计划图，以及自主循环。"
kind: "package"
---

# @deepseek-ai/dsh-executive

[English](README.md) | 中文

## 概述

提供 `ctx.executive`。目标组成带优先级和状态的树。世界模型以对数几率存储信念，随证据更新、随时间衰减，并给出校准分数，让智能体知道自己有多确定、何时需要验证。计划是由工具步骤组成的依赖图，每一步可带检查；临时性失败会退避重试，断路器会阻止反复失败的工具。循环会选择最重要的目标、检索记忆、制定计划、经授权关卡执行并记录结果。工具：`goal_add`、`goal_list`、`goal_update`、`plan_set`、`plan_status`、`belief_observe`、`belief_query`。
