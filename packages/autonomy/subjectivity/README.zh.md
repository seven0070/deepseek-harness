---
description: "可选启用、仅做测量的研究层：与机器意识理论相关的指标探针，不声称已实现意识。"
kind: "package"
---

# @deepseek-ai/dsh-subjectivity

[English](README.md) | 中文

## 概述

默认关闭；`enabled: false` 时插件不做任何事。启用后提供 `ctx.subjectivity`，这是一个被动记录器，其他插件可以向它提供数据，并提供只读工具 `subjectivity_report`。它大致参照 Butlin、Long 等人（2023）的方法测量四项指标：元认知（置信度是否与准确率一致）、自我模型稳定性、焦点内容的全局可用性（全局工作空间理论）以及能动性。它从不改变智能体的行为、提示词或目标。每份报告都会声明这些只是研究指标，而不是系统具有意识或体验的证据。
