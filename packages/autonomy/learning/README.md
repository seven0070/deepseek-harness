---
description: "Learning and growth: validation-gated skill optimization, controlled experiments and approval-gated capability acquisition."
kind: "package"
---

# @deepseek-ai/dsh-learning

English | [中文](README.zh.md)

## Summary

Provides `ctx.learning`. `optimizeSkill` trains a skill document in the style of Microsoft SkillOpt: it proposes bounded add, delete and replace edits from failed runs, keeps an edit only if the held-out score strictly improves, and remembers rejected edits. `skillOptCommand` runs the upstream SkillOpt CLI on the agent's computer. `experiment_run` compares variants over repeated, interleaved trials and reports whether the difference is significant. New capabilities (skills or scripts) go through `capability_propose`, `capability_test` and `capability_install`; installing is high risk, so it always needs owner approval, and untested proposals cannot be installed.
