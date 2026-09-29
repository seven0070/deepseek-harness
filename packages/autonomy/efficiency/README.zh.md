---
description: "效率：带校准概率的工具检索、嘈杂工具输出的压缩，以及可回放的运行日志与逐次调用的费用统计。"
kind: "package"
---

# @deepseek-ai/dsh-efficiency

[English](README.md) | 中文

## 概述

提供 `ctx.efficiency`，包含三项功能，默认全部开启，可在配置中单独关闭。`tool_search` 根据描述的需求为可用工具排序，并给出每个工具的概率，或说明不需要工具；可以通过 `ctx.efficiency.setChooser()` 用模型驱动的选择器替换内置排序。压缩功能会在模型看到之前缩短 shell、命令执行器和抓取工具等嘈杂工具的长输出：去掉颜色代码、合并重复行，对很长的日志保留开头、结尾以及所有错误或警告行。读取文件的结果从不压缩。运行日志记录每次模型调用和工具调用的耗时、令牌数和费用（按模型价格表计算）；`run_journal` 可回放一次运行并汇总花费。加载 `@deepseek-ai/dsh-autonomy-core` 时，令牌和费用也会计入自主预算。这些想法来自 OpenHuman，代码为 dsh 重新编写。
