---
description: "从插件管理页添加自主能力组件及其「自主」页面。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-autonomy-bundle

[English](README.md) | 中文

## 概述

这个可选 bundle 插入随发行版交付的 Web 组合所不含的两行：`autonomy` 与 `ui-autonomy`。随发行版交付的 profile 默认将其关闭。

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

在 Web 侧栏打开插件，启用「自主」。这会挂载自主能力组件：安全核心、记忆、执行循环、效率、自主提示词、工作流和学习。其状态存放在 `<dsh home>/autonomy` 下，并由智能体的默认模型负责规划与执行步骤。它还会在侧栏「任务」之后添加「自主」页面，显示停止开关、待主人批准事项、目标及计划进度、最近动作和花费。演化和研究层保持关闭，需在 `autonomy` 行的配置中开启。停用 bundle 即恢复随发行版交付的组合，已存储的状态仍保留在磁盘上。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

`cordis.patch.yml` 插入这两行，`package.json` 依赖对应的包，使每一行都能从本 bundle 解析。`packages/boot/app-boot/src/profile.ts` 中的 `OPTIONAL_BUNDLES` 列出本包，`apps/cli` 依赖它，因此每个安装都会附带它并默认关闭，插件管理页在“官方”分组中提供它。本包仅含配置、不拥有可变运行时状态，因此不发布运行时不变量配套模块。

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 插入 `autonomy` 与 `ui-autonomy` 两行 |
| [`package.json`](package.json) | 把各行对应的包列为依赖 |
| [`locale/en.json`](locale/en.json)、[`locale/zh.json`](locale/zh.json) | 插件管理页的标题与描述 |
| [`icon.svg`](icon.svg) | 插件管理页图标 |
| [`src/index.ts`](src/index.ts) | 空模块入口；运行时内容就是补丁本身 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [自主 bundle](../../autonomy/autonomy/README.zh.md)：各部分的作用与配置方式。
- [自主页面](../../client/ui-autonomy/README.zh.md)：本 bundle 添加的 Web 页面。
- [Web bundle](../../bundle/web-app/README.zh.md)：本 bundle 向其添加各行的组合。

-----

<a id="model-experience"></a>
## 模型体验

### 自主工具与提示词

#### 模型看到的内容

活跃的根 Agent 获得自主工具（目标、计划、信念、记忆、工具搜索、工作流、学习和准则提议），系统提示词中加入自主宪章及已学到的准则。

#### Token 影响

选择本 bundle 后，每个活跃根 Agent 请求都会带上这些工具 schema 和宪章文本。工具输出压缩可缩短嘈杂工具的长输出。

#### KV Cache 影响

bundle 挂载时，工具 schema 和提示词文本会改变一次请求前缀。接受一条准则修改后，下一次请求的提示词会再次改变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- bundle 开启时，其页面与所有 bundle 一样为每一行提供开关。关闭 `autonomy` 会让「自主」页面失去 Host 服务。
- 未选择本 bundle 时，按 id 指向 `autonomy` 或 `ui-autonomy` 的 profile 补丁匹配不到任何行。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

无。

</details>
