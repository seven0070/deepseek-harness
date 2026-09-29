---
description: "One-switch autonomy bundle: mounts the whole autonomy stack and connects it to the model as planner and step worker."
kind: "package"
---

# @deepseek-ai/dsh-autonomy

English | [中文](README.zh.md)

## Summary

Loading this plugin starts the whole autonomy stack with one setting. It mounts the safety core, memory, the executive loop, efficiency, the autonomy prompt, workflows, learning, evolution and the research layer, all sharing one `stateDir`. Each part has its own `enabled` switch; evolution and the research layer are off by default. The bundle then connects the model to the executive: the planner asks the model for a JSON plan, checks every tool name against the known list and falls back to a simple sequence when the plan has repeated ids or cycles. The step worker lets the model call tools one at a time, for at most six turns. Every tool call still goes through the normal tool runtime, so authorization, approvals, budgets and the audit log all apply. Workflow agent nodes use the same model. The model comes from `model` in config, or from the agent's default model. The planner sees at most `plannerTools` tools, ranked by tool search.
