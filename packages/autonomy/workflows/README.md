---
description: "Agent-proposed, owner-approved durable workflows with tool, agent, condition, approval and delay nodes, schedules, and resume after pause or restart."
kind: "package"
---

# @deepseek-ai/dsh-workflows

English | [中文](README.zh.md)

## Summary

Provides `ctx.workflows`. The agent drafts a reusable workflow with `workflow_propose`: a graph of tool, agent, condition, approval and delay nodes, where tool arguments can use earlier outputs as `{{nodeId}}` and run input as `{{input.key}}`. A draft cannot run until the owner turns it on with `workflow_activate`, which always needs approval. Runs are saved after every node, so they survive restarts. Approval nodes pause a run until the owner answers through `workflow_approve`, delay nodes resume on their own, and workflows can run on a schedule. `workflow_run`, `workflow_status` and `workflow_disable` cover the rest. Every tool a workflow calls still passes the authorization gate. The idea comes from OpenHuman; the code is written for dsh.
