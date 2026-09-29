---
description: "自主安全核心：持久身份与自我模型、意图授权、预算、紧急停止开关和防篡改审计日志。"
kind: "package"
---

# @deepseek-ai/dsh-autonomy-core

[English](README.md) | 中文

## 概述

提供 `ctx.autonomy`。每次工具调用都要经过授权关卡，按风险分级（`read` 到 `critical`）；高于 `autoApprove` 的操作需要所有者批准，受保护的操作（修改安全核心本身）永远不会被自动批准。它还限制令牌、费用、操作次数和运行时间的预算，并提供紧急停止开关，也响应 `STOP` 文件。每个决定都写入哈希链式审计日志。只有所有者可以修改智能体的身份；智能体维护一个带版本的自我模型，并为每项能力记录校准后的置信度。工具：`self_describe`、`self_note`、`self_record_outcome`。
