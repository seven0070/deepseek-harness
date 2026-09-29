---
description: "Web「自主」页面：停止开关、主人审批、目标与计划进度、最近动作和花费。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-autonomy

[English](README.md) | 中文

## 概述

主人通过「自主」页面查看并引导自主能力组件。页面包含停止开关、等待决定的事项、目标及其计划进度、最近动作和花费。它是侧栏中的一级页面，位于「任务」之后。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

随发行版交付的 Web 组合不含 `ui-autonomy` 行。要添加它，请在插件管理页的“官方”分组中启用可选 bundle `@deepseek-ai/dsh-experimental-autonomy-bundle`，或把它列进 profile 的 `dsh.profile.bundles`。这会把本页面与其读取的 Host `@deepseek-ai/dsh-autonomy` 组件一起挂载。

页头显示智能体名称及其运行或停止状态。**全部停止**需要按两次：第一次进入待确认状态，几秒内再按一次才会拉下停止开关。**恢复**解除停止。未连接模型时，提示说明只会执行已写好的计划。

**等待你决定**按时间先后列出所有需要主人处理的事项：
- 有风险的操作，附风险等级
- 智能体提出的目标
- 新工作流，以及停在审批步骤的工作流运行
- 自我改进候选

每项都有**批准**和**拒绝**。决定失败时显示错误，事项仍留在列表中。

**目标**列出各目标的状态和“已完成/总步数”。顶部输入框可添加让智能体追求的目标。**最近动作**列出近期步骤及其是否成功。**花费**根据运行日志显示费用、输入与输出令牌数，以及模型和工具调用次数；日志未启用时会加以说明。

Host 发出变更信号或连接恢复时，页面会刷新。缺少 Host 服务时，页面会说明情况并提供**重试**。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

浏览器入口注册 `autonomy` 主面板及其 `sidebar.panellist` 入口（`order: 11`），位于「任务」（`order: 10`）之后。它注入 `remote.autonomyControl`，使用其中四个调用：`snapshot`、`decide`、`setStopped` 和 `addGoal`，并监听 `autonomy/changed` 事件。`source.ts` 把这些调用封装为可观察数据源：有观察者时读取快照，收到 `autonomy/changed` 或连接重置时重新读取。最后一个观察者退订时，它移除监听器并忽略迟到的响应。页面只保存可丢弃的状态：待确认的停止、目标草稿和进行中的决定，其余内容都来自 Host 快照。

Host 端是 `@deepseek-ai/dsh-autonomy` 中的 `AutonomyControl`（`src/remote.ts`）。该插件的 `controlPage` 开启时（默认开启）会挂载它。它返回一份 JSON 快照，并通过智能体所用的同一套审批、目标和工作流服务执行主人的决定。

本页面渲染 Host 拥有的状态，只持有可丢弃的交互状态，因此不发布运行时不变量配套模块。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [自主 bundle](../../autonomy/autonomy/README.zh.md)：本页面读取的 Host 组件。
- [实验性自主 bundle](../../experimental/autonomy-bundle/README.zh.md)：如何开启本页面。
- [Slots](../../../docs/subsystems/slots.zh.md)：面板与侧栏贡献。

<a id="model-experience"></a>
## 模型体验

本包不添加任何工具、提示词文本或上下文。在此添加的目标和做出的决定只通过 Host 自主组件到达模型。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 页面显示最近动作和花费汇总，不显示完整运行日志或审计日志。
- 准则、工作流和记忆在对话中或其文件里管理，不在本页面。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
