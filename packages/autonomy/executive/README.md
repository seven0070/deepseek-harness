---
description: "Executive: goal hierarchy, world model with calibrated beliefs, plan graphs with verification and recovery, and an autonomous loop."
kind: "package"
---

# @deepseek-ai/dsh-executive

English | [中文](README.zh.md)

## Summary

Provides `ctx.executive`. Goals form a tree with priorities and statuses. The world model stores beliefs as log-odds that are updated by evidence, decay over time, and report a calibration score, so the agent knows how sure it is and when to verify. Plans are dependency graphs of tool steps, each with an optional check; transient failures are retried with backoff and a circuit breaker stops repeated failing tools. The loop picks the top goal, recalls memory, plans, acts through the authorization gate and records the result. Tools: `goal_add`, `goal_list`, `goal_update`, `plan_set`, `plan_status`, `belief_observe`, `belief_query`.
