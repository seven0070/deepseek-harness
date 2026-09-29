---
description: "Autonomy system prompt: a fixed constitution for the autonomous agent plus owner-approved guidelines the agent learns while chatting."
kind: "package"
---

# @deepseek-ai/dsh-autonomy-prompt

English | [中文](README.zh.md)

## Summary

Adds two sections to the system prompt. The constitution is a fixed set of rules for the autonomous agent: who it is, what it may do, how it plans and verifies, and how it handles uncertainty and honesty. It is filled in with live facts (identity, active goals, kill-switch state) and belongs to the protected core, so the agent cannot edit it. The learned-guidelines section is built by the agent while chatting: when the owner corrects it or a task teaches it something, it calls `prompt_propose` to add, replace or remove a short guideline. Each change needs owner approval, is refused if it would weaken the safety rules, and is versioned, so `prompt_revert` can restore any earlier version. `prompt_guidelines` shows the current list and history.
