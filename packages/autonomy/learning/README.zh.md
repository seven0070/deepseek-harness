---
description: "学习与成长：经验证把关的技能优化、对照实验，以及需批准的能力获取。"
kind: "package"
---

# @deepseek-ai/dsh-learning

[English](README.md) | 中文

## 概述

提供 `ctx.learning`。`optimizeSkill` 仿照 Microsoft SkillOpt 训练技能文档：根据失败的运行提出有限的添加、删除和替换修改，只有在留出集得分严格提升时才保留，并记住被拒绝的修改。`skillOptCommand` 在智能体的计算机上运行上游 SkillOpt 命令行。`experiment_run` 通过多次交替试验比较不同方案，并报告差异是否显著。新能力（技能或脚本）需经过 `capability_propose`、`capability_test` 和 `capability_install`；安装属于高风险操作，始终需要所有者批准，未经测试的提案无法安装。
