---
description: "The autonomy package group: safety core, executive loop, learning, evolution, efficiency, workflows, prompt and the research layer, plus a one-switch bundle."
kind: "package-group"
---

# autonomy/: autonomous executive agent

English | [中文](README.zh.md)

## Summary

The autonomy group turns the harness into an agent that can pursue goals on its own, safely. Every part is a separate Cordis plugin, so each can be loaded, replaced or removed alone; `autonomy` loads them all at once. The safety core is always loaded first and cannot be changed by the agent.

## Packages

| Package | What it does |
| --- | --- |
| `autonomy` | One-switch bundle; connects the model as planner and step worker. |
| `autonomy-core` | Safety core: identity, kill switch, authorization and approvals, budgets, audit log. |
| `executive` | Goals, plans, beliefs and the autonomous loop with checks and retries. |
| `efficiency` | Tool search, output compression, run journal with per-call cost. |
| `autonomy-prompt` | Constitution plus learned guidelines, editable in chat. |
| `workflows` | Agent-proposed workflows that run only after owner review. |
| `learning` | Skill optimisation, experiments, new capabilities with approval. |
| `evolution` | Sandboxed self-improvement with evaluation gates and approved promotion. |
| `subjectivity` | Research-only measurements; off by default. |
