---
description: "智能体专属的持久计算机：独立的 Docker 机器，带持久磁盘、可选桌面、快照和模型工具。"
kind: "package"
---

# @deepseek-ai/dsh-agent-computer

[English](README.md) | 中文

## 概述

本包为智能体提供一台专属的 Linux 机器，而不是借用用户的机器。机器在首次使用时创建，已安装的软件和主目录在会话之间保留，并可创建检查点和恢复。

## 工具

| 工具 | 用途 |
|---|---|
| `computer_exec` | 在智能体的计算机上运行 bash 命令 |
| `computer_write_file` / `computer_read_file` | 写入或读取文本文件 |
| `computer_status` | 报告机器是否存在、是否在运行，以及桌面地址 |
| `computer_snapshot` | 以标签保存系统和磁盘的检查点 |
| `computer_restore` | 回滚到某个快照；仅在 `modelRestore: true` 时注册 |

其他插件可以通过 `ctx.agentComputer` 使用同一台机器。

## 隔离

- **不访问宿主机：**从不挂载宿主机文件系统；唯一的存储是挂载在 `/home/agent` 的命名卷。
- **受限容器：**从不以特权模式运行，启用 `no-new-privileges`，并限制 CPU、内存和进程数。
- **网络：**`network: none` 可让机器完全离线。
- **桌面：**只能通过 `127.0.0.1:6080` 访问。

## 依赖

宿主机需要安装 Docker 或 Podman。
