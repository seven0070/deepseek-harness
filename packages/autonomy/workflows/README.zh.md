---
description: "由智能体起草、所有者批准的持久化工作流，包含工具、智能体、条件、审批和延时节点，支持定时运行，暂停或重启后可继续。"
kind: "package"
---

# @deepseek-ai/dsh-workflows

[English](README.md) | 中文

## 概述

提供 `ctx.workflows`。智能体用 `workflow_propose` 起草可复用的工作流：由工具、智能体、条件、审批和延时节点组成的图，工具参数可以用 `{{nodeId}}` 引用前面节点的输出，用 `{{input.key}}` 引用运行输入。草稿在所有者通过 `workflow_activate` 启用之前不能运行，启用始终需要批准。每个节点执行后都会保存运行状态，因此重启后仍可继续。审批节点会暂停运行，直到所有者通过 `workflow_approve` 作答；延时节点会自动继续；工作流也可以定时运行。`workflow_run`、`workflow_status` 和 `workflow_disable` 负责其余操作。工作流调用的每个工具仍要经过授权关卡。这个想法来自 OpenHuman，代码为 dsh 重新编写。
